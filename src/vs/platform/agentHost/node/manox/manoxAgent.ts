/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentHostManoxApprovalModeEnvVar, AgentHostManoxHomeEnvVar, AgentHostManoxSdkRootEnvVar } from '../../common/agentService.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import { createSchema, schemaProperty } from '../../common/agentHostSchema.js';
import { getReasoningEffortDescription, getReasoningEffortLabel } from '../../common/reasoningEffort.js';
import { AgentSession, resolveAgentChatContext, type AgentChatMigrationResult, type AgentProvider, type AgentSignal, type IActiveClient, type IAgent, type IAgentCapabilities, type IAgentChatConfigCompletionsParams, type IAgentChatContext, type IAgentChatDataChange, type IAgentChatMetadata, type IAgentChats, type IAgentCreateChatOptions, type IAgentCreateChatResult, type IAgentDescriptor, type IAgentDiscoveredChat, type IAgentHostCapabilities, type IAgentKnownSessionsFilter, type IAgentModelInfo, type IAgentResolveChatConfigParams, type IAgentTurnTokenUsage } from '../../common/agent.js';
import { ActionType, type SessionAction } from '../../common/state/sessionActions.js';
import type { ChatAction } from '../../common/state/protocol/channels-chat/actions.js';
import { ToolCallContributorKind, ChatInputResponseKind, ResponsePartKind, ToolCallConfirmationReason, ToolResultContentType, createErrorResponsePart, parseChatUri, ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputQuestionKind, MessageAttachmentKind, ToolCallStatus, type ChatInputAnswer, type ChatInputOption, type ChatInputQuestion, buildDefaultChatUri, CustomizationType, type ChatInputRequest, type ClientPluginCustomization, type Customization, type PromptCustomization, type SkillCustomization, type MessageAttachment, type ModelSelection, type PendingMessage, type ToolCallResult, type ToolCallPendingConfirmationState, type ToolDefinition, type Turn } from '../../common/state/sessionState.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { ConfigSchema, ProtectedResourceMetadata } from '../../common/state/protocol/state.js';
import { buildTurnsFromJournal, manoxAnswerText, manoxPermissionKind, manoxPermissionPath } from './manoxMapping.js';
import { ManoxNapiTransport, type IManoxClientToolSpec, type IManoxCommandInfo, type IManoxImageAttachment, type IManoxTokenUsageData, type ManoxFromServer, type ManoxJournalEntry, type ManoxJournalEvent } from './manoxNapiTransport.js';

const MANOX_AGENT_PROVIDER_ID: AgentProvider = 'manox';

/** The manox permission vocabulary on the wire (kebab-case). */
type ManoxApprovalMode = 'read-only' | 'workspace-write' | 'danger-full-access';

const MANOX_APPROVAL_MODES: readonly ManoxApprovalMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

function isManoxApprovalMode(value: unknown): value is ManoxApprovalMode {
	return typeof value === 'string' && (MANOX_APPROVAL_MODES as readonly string[]).includes(value);
}

/** Session-default approval mode: the env override, else `workspace-write`
 * (tool calls outside the granted-root fence surface as approval cards). */
function manoxDefaultApprovalMode(): ManoxApprovalMode {
	const raw = process.env[AgentHostManoxApprovalModeEnvVar];
	return isManoxApprovalMode(raw) ? raw : 'workspace-write';
}



const execFileAsync = promisify(execFile);

/** Read the system clipboard as UTF-8 text (manox accepts text/* only). */
async function readSystemClipboardText(): Promise<string> {
	const platform = process.platform;
	const command = platform === 'darwin'
		? { file: 'pbpaste', args: [] as string[] }
		: platform === 'win32'
			? { file: 'powershell.exe', args: ['-NoProfile', '-Command', 'Get-Clipboard'] }
			: { file: 'xclip', args: ['-o', '-selection', 'clipboard'] };
	const { stdout } = await execFileAsync(command.file, command.args, { timeout: 3000 });
	return stdout;
}

/** Schemes the external opener accepts (the agent-host process has no
 * renderer-side trusted-link prompt, so the scheme list IS the guard). */
const MANOX_OPENABLE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'file:']);

async function openExternalUrl(url: string): Promise<void> {
	const parsed = URI.parse(url);
	if (!MANOX_OPENABLE_SCHEMES.has(parsed.scheme)) {
		throw new Error(`refusing to open URL with scheme '${parsed.scheme}'`);
	}
	const command = process.platform === 'darwin'
		? { file: 'open', args: [url] }
		: process.platform === 'win32'
			? { file: 'cmd.exe', args: ['/c', 'start', '', url] }
			: { file: 'xdg-open', args: [url] };
	await execFileAsync(command.file, command.args, { timeout: 5000 });
}

/** Reasoning-effort key in `ModelSelection.config` — the shared picker
 * contract (mirrors Claude's `thinkingLevel` and Copilot's
 * `ThinkingLevelConfigKey`) so one picker drives every provider. */
const MANOX_THINKING_LEVEL_KEY = 'thinkingLevel';

/** The manox wire's closed reasoning-effort vocabulary. */
type ManoxReasoningEffort = 'high' | 'max';

function manoxThinkingLevelSchema(): ConfigSchema {
	return {
		type: 'object',
		properties: {
			[MANOX_THINKING_LEVEL_KEY]: {
				type: 'string',
				title: localize('manox.modelThinkingLevel.title', "Thinking Level"),
				description: localize('manox.modelThinkingLevel.description', "Controls how much reasoning effort the Manox agent uses."),
				enum: ['high', 'max'],
				enumLabels: ['high', 'max'].map(getReasoningEffortLabel),
				enumDescriptions: (['high', 'max'] as const).map(effort => getReasoningEffortDescription(effort) ?? ''),
				default: 'high',
			},
		},
	};
}


/** How many journal records the opening snapshot window requests. */
const MANOX_SNAPSHOT_WINDOW = 200;

/**
 * Per-chat bookkeeping. The host hands us a chat channel URI and an opaque
 * providerData token; the manox session id lives only here and, durably, in
 * the providerData blob the orchestrator persists for restore.
 */
interface IManoxChatRecord {
	readonly chatUri: URI;
	/** Rebinds on fork/truncate (the host learns the new id via onDidChangeChatData). */
	sessionId: string;
	streamId: string;
	/** Journal records seen so far (snapshot + appended entries), seq order. */
	readonly history: ManoxJournalEntry[];
	/** Turn id the host passed to the most recent sendMessage. */
	currentTurnId: string | undefined;
	/** Minted when journal events arrive outside a host-declared turn. */
	fallbackTurnId: string | undefined;
	/** Live streaming part ids, so deltas target one accumulating part. */
	textPartId: string | undefined;
	reasoningPartId: string | undefined;
	/** Tool calls announced but not yet completed, for out-of-order results. */
	readonly startedToolCalls: Set<string>;
	/** Whether a turn is currently in flight (drives steer-vs-submit). */
	turnActive: boolean;
	/** Wall-clock ms of the current turnStart, for ChatTurnComplete duration. */
	turnStartedAt: number | undefined;
	/** Live approval-mode mirror (journal permissionModeChange keeps it fresh). */
	approvalMode: ManoxApprovalMode;
	/** Session cwd from the follow snapshot (start-over truncation reuses it). */
	cwd: string | undefined;
	/** Last journal entry id observed inside a host-declared turn (fork point). */
	readonly lastEntryIdByTurn: Map<string, string>;
	/** Accumulated token usage per host turn id (journal token_usage metrics). */
	readonly turnTokenUsage: Map<string, { input: number; output: number; cacheRead: number; records: number }>;
}

/** One active client's contribution handle; assigning `tools` pushes the
 * set into the session (wire registration is full-replace). */
class ManoxActiveClient implements IActiveClient {
	private _tools: readonly ToolDefinition[] = [];
	private _customizations: readonly ClientPluginCustomization[] = [];

	constructor(
		private readonly _agent: ManoxAgent,
		private readonly _chat: URI,
		readonly clientId: string,
		readonly displayName: string | undefined,
	) { }

	get tools(): readonly ToolDefinition[] { return this._tools; }
	set tools(value: readonly ToolDefinition[]) {
		this._tools = value;
		this._agent._syncClientTools(this._chat, this.clientId, value);
	}

	get customizations(): readonly ClientPluginCustomization[] { return this._customizations; }
	set customizations(value: readonly ClientPluginCustomization[]) { this._customizations = value; }
}

export class ManoxAgent extends Disposable implements IAgent {

	readonly id: AgentProvider = MANOX_AGENT_PROVIDER_ID;
	readonly agentHostCapabilities: IAgentHostCapabilities = { workspaceConversion: false };

	private readonly _onDidChatProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this._onDidChatProgress.event;
	readonly onDidMaterializeChat = Event.None;
	private readonly _onDidChangeChatData = this._register(new Emitter<IAgentChatDataChange>());
	readonly onDidChangeChatData = this._onDidChangeChatData.event;
	readonly onDidSpawnChat = Event.None;
	private readonly _onDidDiscoverChats = this._register(new Emitter<readonly IAgentDiscoveredChat[]>());
	readonly onDidDiscoverChats = this._onDidDiscoverChats.event;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models = this._models;

	private _transport: ManoxNapiTransport | undefined;
	private readonly _chats = new Map<string, IManoxChatRecord>();
	/** Parked approve adjudications; metadata carries the wire reply target. */
	private readonly _pendingPermissions = new PendingRequestRegistry<boolean, { readonly replyId: string; readonly chat: URI }>();
	/** Parked askUserQuestion solicitations. */
	private readonly _pendingUserInputs = new PendingRequestRegistry<{ readonly response: ChatInputResponseKind; readonly answers?: Record<string, ChatInputAnswer> }, { readonly replyId: string }>();
	/** Parked invokeClientTool round-trips; the host executes the tool. */
	private readonly _pendingClientTools = new PendingRequestRegistry<{ readonly content: string; readonly isError: boolean }, { readonly replyId: string }>();
	/** Last-known slash-command catalog (listCommands + host commands events). */
	private _commands: readonly IManoxCommandInfo[] = [];
	private readonly _onDidCustomizationsChange = this._register(new Emitter<void>());
	/** Active-client handles keyed by `chat::clientId` (stable across fan-outs). */
	private readonly _activeClients = new Map<string, IActiveClient>();

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		// Eager connect so the model catalog is available to the new-session
		// picker. With VSCODE_AGENT_HOST_MANOX_HOME set this cannot contend for
		// the manox runtime lock; a failure leaves the harness unconnected and
		// createChat retries lazily.
		try {
			this._ensureConnected();
		} catch (err) {
			this._logService.warn('[manox] eager connect failed; will retry on first use', err);
		}
	}

	getDescriptor(): IAgentDescriptor {
		const capabilities: IAgentCapabilities = {
			// The manox kernel grants every createSession working directory
			// into the session's sandbox fence (dspo/manox#787); the primary
			// cwd is fixed at creation.
			multipleWorkingDirectories: { immutablePrimary: true },
			// forkSession copies a session's active-chain prefix at an entry;
			// the host normalizes side chats onto the same fork option.
			multipleChats: { fork: true, sideChat: true },
		};
		return {
			provider: this.id,
			displayName: localize('manoxAgent.displayName', "Manox"),
			description: localize('manoxAgent.description', "Manox coding agent"),
			capabilities,
		};
	}

	// ---- Connection ---------------------------------------------------------

	private _ensureConnected(): ManoxNapiTransport {
		if (this._transport) {
			return this._transport;
		}
		const sdkRoot = process.env[AgentHostManoxSdkRootEnvVar];
		if (!sdkRoot) {
			throw new Error(`${AgentHostManoxSdkRootEnvVar} is not set`);
		}
		// Redirect the manox state root (runtime lock, threads.db, provider
		// config) so the harness never contends with a running manox app or a
		// stale extension host holding the default `~/.manox` lock.
		const manoxHome = process.env[AgentHostManoxHomeEnvVar];
		if (manoxHome) {
			process.env.MANOX_HOME = manoxHome;
		}
		this._transport = ManoxNapiTransport.load(
			sdkRoot,
			event => this._handleEvent(event),
			err => {
				this._logService.error('[manox] transport error', err);
				this._transport = undefined;
			},
		);
		void this._refreshModelsNow();
		return this._transport;
	}

	async refreshModels(): Promise<void> {
		try {
			this._ensureConnected();
			await this._refreshModelsNow();
		} catch (err) {
			this._logService.warn('[manox] refreshModels: not connected', err);
		}
	}

	private async _refreshModelsNow(): Promise<void> {
		try {
			const raw = await this._call('listModels');
			const models = Array.isArray(raw) ? raw : (raw as { models?: unknown[] })?.models;
			if (!Array.isArray(models)) {
				this._logService.warn('[manox] listModels returned an unexpected shape');
				return;
			}
			this._models.set(models.map((m: {
				id?: unknown; name?: unknown; provider?: unknown; api?: unknown;
				contextWindow?: unknown; context_window?: unknown;
			}) => {
				const rawId = String(m.id);
				const provider = typeof m.provider === 'string' ? m.provider : '';
				// Registration-qualified reference (`provider/id`): wire variants of
				// one model share the bare id, and manox's resolve_model_ref pins
				// the exact registration only for this form — the picker must send
				// it so the user's wire choice survives changeModel/initialModel.
				const api = typeof m.api === 'string' ? m.api : '';
				return {
					provider: MANOX_AGENT_PROVIDER_ID,
					id: provider ? `${provider}/${rawId}` : rawId,
					name: api ? `${String(m.name ?? rawId)} · ${api}` : String(m.name ?? rawId),
					maxContextWindow: typeof m.contextWindow === 'number' ? m.contextWindow
						: typeof m.context_window === 'number' ? m.context_window : undefined,
					maxOutputTokens: typeof (m as { max_tokens?: unknown }).max_tokens === 'number'
						? (m as { max_tokens?: number }).max_tokens : undefined,
					configSchema: manoxThinkingLevelSchema(),
					supportsVision: false,
				};
			}), undefined);
		} catch (err) {
			this._logService.warn('[manox] listModels failed', err);
		}
	}

	private _call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		return this._ensureConnected().call(method, params);
	}

	// ---- Event handling -----------------------------------------------------

	private _handleEvent(event: ManoxFromServer): void {
		switch (event.kind) {
			case 'host':
				if (event.host.type === 'models') {
					void this._refreshModelsNow();
				} else if (event.host.type === 'threadsUpdated') {
					// Full-snapshot broadcast; coalesce bursts into one discovery pass.
					this._scheduleDiscovery();
				} else if (event.host.type === 'commands') {
					this._commands = event.host.commands;
					this._onDidCustomizationsChange.fire();
				}
				return;
			case 'streamItem':
				this._handleStreamItem(event);
				return;
			case 'streamEnd':
				if (event.reason.type === 'resync') {
					this._logService.warn('[manox] follow stream resynced; live events may be missing until next send');
				}
				return;
			case 'request':
				this._handleServerRequest(event);
				return;
			case 'notification':
				// v1 notes: superseded by host events / streams; ignored.
				return;
		}
	}

	private _handleServerRequest(event: Extract<ManoxFromServer, { kind: 'request' }>): void {
		const transport = this._transport;
		if (!transport) {
			return;
		}
		const call = event.call;
		switch (call.method) {
			case 'approve': {
				// Park the adjudication and surface it as a pending_confirmation
				// signal; the host owns the approval policy (auto-approval and
				// allow-in-session memory live in SessionPermissionManager) and
				// answers through respondToPermissionRequest. The reply id is
				// the wire MsgId (the server keys the parked waiter on it).
				const record = call.sessionId ? this._recordForSession(call.sessionId) : undefined;
				const authId = call.authId ?? event.id;
				if (!record) {
					this._logService.warn(`[manox] approve for unknown session '${call.sessionId}'; denying`);
					transport.reply(event.id, { allow: false });
					return;
				}
				const state: ToolCallPendingConfirmationState = {
					status: ToolCallStatus.PendingConfirmation,
					toolCallId: authId,
					toolName: call.toolName ?? 'manox tool',
					displayName: call.toolName ?? 'manox tool',
					invocationMessage: call.summary ?? call.toolName ?? 'manox tool',
					...(call.input !== undefined ? { toolInput: JSON.stringify(call.input, undefined, 2) } : {}),
				};
				void this._pendingPermissions
					.registerAndFire(authId, () => {
						this._onDidChatProgress.fire({
							kind: 'pending_confirmation',
							chat: record.chatUri,
							state,
							permissionKind: manoxPermissionKind(state.toolName),
							...(manoxPermissionPath(call.input) !== undefined ? { permissionPath: manoxPermissionPath(call.input) } : {}),
						});
					}, { replyId: event.id, chat: record.chatUri })
					.then(allow => transport.reply(event.id, { allow }));
				return;
			}
			case 'askUserQuestion': {
				const record = call.sessionId ? this._recordForSession(call.sessionId) : undefined;
				const authId = call.authId ?? event.id;
				if (!record) {
					transport.replyError(event.id, 'unknown session');
					return;
				}
				const input = (call.input ?? {}) as { questions?: readonly { question?: unknown; header?: unknown; multiSelect?: unknown; options?: readonly { label?: unknown; description?: unknown; recommended?: unknown }[] }[] };
				const questions: ChatInputQuestion[] = [];
				for (const [index, question] of (input.questions ?? []).entries()) {
					const options: ChatInputOption[] = (question.options ?? []).map((option, optionIndex) => ({
						id: String(optionIndex),
						label: typeof option.label === 'string' ? option.label : `Option ${optionIndex + 1}`,
						...(typeof option.description === 'string' ? { description: option.description } : {}),
						...(option.recommended === true ? { recommended: true } : {}),
					}));
					questions.push({
						kind: question.multiSelect === true ? ChatInputQuestionKind.MultiSelect : ChatInputQuestionKind.SingleSelect,
						id: `manox-q${index}`,
						...(typeof question.header === 'string' ? { title: question.header } : {}),
						message: typeof question.question === 'string' ? question.question : `Question ${index + 1}`,
						options,
					});
				}
				const request: ChatInputRequest = {
					id: authId,
					message: localize('manoxAgent.questionPrompt', "The Manox agent needs your input"),
					questions,
				};
				void this._pendingUserInputs
					.registerAndFire(authId, () => {
						this._fire(record, { type: ActionType.ChatInputRequested, request });
					}, { replyId: event.id })
					.then(result => {
						// manox expects `answers: [[question, answer], ...]`; a
						// decline/cancel maps to an empty list (the model reads a
						// non-answer) rather than an Err, which would read as expiry.
						const answers: Array<[string, string]> = [];
						if (result.response === ChatInputResponseKind.Accept) {
							for (const [questionId, answer] of Object.entries(result.answers ?? {})) {
								const question = questions.find(candidate => candidate.id === questionId);
								const text = manoxAnswerText(answer);
								if (question && text !== undefined) {
									answers.push([question.message, text]);
								}
							}
						}
						transport.reply(event.id, { answers, response: null });
					});
				return;
			}
			case 'planVerdict': {
				// The plan-review verdict as a single-select question; a
				// decline/cancel maps to `refine` (clears the pending card,
				// keeps the conversation going) — an Err would cancel the
				// hanging turn outright.
				const record = call.sessionId ? this._recordForSession(call.sessionId) : undefined;
				if (!record) {
					transport.replyError(event.id, 'unknown session');
					return;
				}
				const request: ChatInputRequest = {
					id: event.id,
					message: call.title ?? call.planFile ?? localize('manoxAgent.planReview', "Plan review"),
					questions: [{
						kind: ChatInputQuestionKind.SingleSelect,
						id: 'verdict',
						title: localize('manoxAgent.planVerdict', "Plan approval"),
						message: call.content ?? localize('manoxAgent.planVerdictMissing', "The plan file could not be read; review it before approving."),
						options: [
							{ id: 'execute_keep', label: localize('manoxAgent.planVerdict.executeKeep', "Execute"), description: localize('manoxAgent.planVerdict.executeKeepDescription', "Run the plan and keep it in the transcript.") },
							{ id: 'execute_compact', label: localize('manoxAgent.planVerdict.executeCompact', "Execute (compact)"), description: localize('manoxAgent.planVerdict.executeCompactDescription', "Run the plan and compact it afterwards.") },
							{ id: 'refine', label: localize('manoxAgent.planVerdict.refine', "Refine"), description: localize('manoxAgent.planVerdict.refineDescription', "Keep discussing the plan without executing it.") },
						],
					}],
				};
				void this._pendingUserInputs
					.registerAndFire(event.id, () => {
						this._fire(record, { type: ActionType.ChatInputRequested, request });
					}, { replyId: event.id })
					.then(result => {
						let choice: 'execute_keep' | 'execute_compact' | 'refine' = 'refine';
						const answer = result.answers?.verdict;
						const value = answer && answer.state !== ChatInputAnswerState.Skipped && answer.value.kind === ChatInputAnswerValueKind.Selected
							? answer.value.value : undefined;
						if (result.response === ChatInputResponseKind.Accept && (value === 'execute_keep' || value === 'execute_compact' || value === 'refine')) {
							choice = value;
						}
						transport.reply(event.id, { choice });
					});
				return;
			}
			case 'invokeClientTool': {
				// The model called a tool the host registered through
				// registerSessionTools: surface the call on the chat (the host
				// executes it in its own window) and park until
				// onClientToolCallComplete resolves the round-trip.
				const record = call.sessionId ? this._recordForSession(call.sessionId) : undefined;
				if (!record) {
					transport.replyError(event.id, 'unknown session');
					return;
				}
				const toolCallId = call.toolCallId ?? event.id;
				const toolName = call.name ?? 'client tool';
				record.startedToolCalls.add(toolCallId);
				const turnId = this._turnId(record);
				this._fire(record, {
					type: ActionType.ChatToolCallStart,
					turnId,
					toolCallId,
					toolName,
					displayName: toolName,
					...(call.clientId !== undefined ? { contributor: { kind: ToolCallContributorKind.Client, clientId: call.clientId } } : {}),
				});
				this._fire(record, {
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId,
					invocationMessage: toolName,
					toolInput: call.input === undefined ? undefined : JSON.stringify(call.input, undefined, 2),
					confirmed: ToolCallConfirmationReason.NotNeeded,
				});
				void this._pendingClientTools
					.register(toolCallId, { replyId: event.id })
					.then(result => transport.reply(event.id, { content: result.content, isError: result.isError }))
					.catch(() => transport.replyError(event.id, 'client tool call cancelled'));
				return;
			}
			case 'clipboardRead': {
				// manox accepts text/* only; empty clipboard answers null and
				// any failure is an Err (the model sees a failed read).
				void readSystemClipboardText()
					.then(text => transport.reply(event.id, text ? { data: Buffer.from(text, 'utf8').toString('base64'), mimeType: 'text/plain' } : null))
					.catch(err => {
						this._logService.warn('[manox] clipboard read failed', err);
						transport.replyError(event.id, `clipboard unavailable: ${err instanceof Error ? err.message : String(err)}`);
					});
				return;
			}
			case 'openExternal': {
				const url = call.url ?? '';
				void openExternalUrl(url)
					.then(() => {
						this._logService.info(`[manox] opened external URL ${url}`);
						transport.reply(event.id, {});
					})
					.catch(err => {
						this._logService.warn(`[manox] refused/failed to open ${url}`, err);
						transport.replyError(event.id, err instanceof Error ? err.message : String(err));
					});
				return;
			}
			default:
				// browserOp is undeclared in the napi handshake (no browser
				// surface in VS Code), so it is never routed here.
				this._logService.warn(`[manox] unhandled server call '${call.method}'; denying`);
				transport.replyError(event.id, 'not supported by the manox agent host');
		}
	}

	private _recordForSession(sessionId: string | undefined): IManoxChatRecord | undefined {
		if (!sessionId) {
			return undefined;
		}
		return [...this._chats.values()].find(record => record.sessionId === sessionId);
	}

	private _handleStreamItem(event: Extract<ManoxFromServer, { kind: 'streamItem' }>): void {
		const record = [...this._chats.values()].find(chat => chat.streamId === event.streamId);
		if (!record) {
			return;
		}
		const frame = event.frame;
		if (frame.type === 'snapshot') {
			record.history.length = 0;
			record.history.push(...frame.records);
			record.cwd = frame.header.cwd || record.cwd;
			return;
		}
		if (frame.type !== 'entry') {
			return;
		}
		record.history.push({ ...frame.event, seq: frame.seq, id: frame.id, parentId: frame.parentId, timestamp: frame.timestamp });
		if (record.currentTurnId) {
			record.lastEntryIdByTurn.set(record.currentTurnId, frame.id);
		}
		this._dispatchJournalEvent(record, frame.event);
	}

	// ---- Journal → AgentSignal mapping --------------------------------------

	private _fire(record: IManoxChatRecord, action: SessionAction | ChatAction): void {
		this._onDidChatProgress.fire({ kind: 'action', resource: record.chatUri, action });
	}

	private _fireToSession(record: IManoxChatRecord, action: SessionAction | ChatAction): void {
		const parsed = parseChatUri(record.chatUri.toString());
		const resource = parsed ? URI.parse(parsed.session) : record.chatUri;
		this._onDidChatProgress.fire({ kind: 'action', resource, action });
	}

	private _turnId(record: IManoxChatRecord): string {
		if (!record.currentTurnId && !record.fallbackTurnId) {
			record.fallbackTurnId = `manox-turn-${generateUuid()}`;
		}
		return record.currentTurnId ?? record.fallbackTurnId!;
	}

	private _ensureTextPart(record: IManoxChatRecord, turnId: string): string {
		if (!record.textPartId) {
			record.textPartId = `manox-md-${generateUuid()}`;
			this._fire(record, {
				type: ActionType.ChatResponsePart,
				turnId,
				part: { kind: ResponsePartKind.Markdown, id: record.textPartId, content: '' },
			});
		}
		return record.textPartId;
	}

	private _ensureReasoningPart(record: IManoxChatRecord, turnId: string): string {
		if (!record.reasoningPartId) {
			record.reasoningPartId = `manox-rs-${generateUuid()}`;
			this._fire(record, {
				type: ActionType.ChatResponsePart,
				turnId,
				part: { kind: ResponsePartKind.Reasoning, id: record.reasoningPartId, content: '' },
			});
		}
		return record.reasoningPartId;
	}

	private _endTurn(record: IManoxChatRecord): void {
		if (record.currentTurnId || record.fallbackTurnId) {
			const duration = record.turnStartedAt !== undefined ? Math.max(1, Date.now() - record.turnStartedAt) : 1;
			this._fire(record, { type: ActionType.ChatTurnComplete, turnId: this._turnId(record), duration });
		}
		record.turnActive = false;
		record.turnStartedAt = undefined;
		record.currentTurnId = undefined;
		record.fallbackTurnId = undefined;
		record.textPartId = undefined;
		record.reasoningPartId = undefined;
		record.startedToolCalls.clear();
	}

	private _dispatchJournalEvent(record: IManoxChatRecord, event: ManoxJournalEvent): void {
		switch (event.type) {
			case 'turnStart':
				record.turnActive = true;
				record.turnStartedAt = Date.now();
				this._turnId(record);
				return;
			case 'agentTextDelta': {
				const turnId = this._turnId(record);
				this._fire(record, { type: ActionType.ChatDelta, turnId, partId: this._ensureTextPart(record, turnId), content: event.s });
				return;
			}
			case 'agentThinkingDelta': {
				const turnId = this._turnId(record);
				this._fire(record, { type: ActionType.ChatDelta, turnId, partId: this._ensureReasoningPart(record, turnId), content: event.s });
				return;
			}
			case 'toolCall': {
				if (record.startedToolCalls.has(event.callId)) {
					return;
				}
				record.startedToolCalls.add(event.callId);
				if (event.status === 'pending-approval') {
					// The approval card is driven by the `approve` server call
					// (parked in _handleServerRequest); this row only announces
					// the call. The host dispatches ChatToolCallReady from the
					// pending_confirmation signal, so firing one here as well
					// would bypass the approval pipeline.
					return;
				}
				const turnId = this._turnId(record);
				this._fire(record, {
					type: ActionType.ChatToolCallStart,
					turnId,
					toolCallId: event.callId,
					toolName: event.name,
					displayName: event.title || event.name,
				});
				this._fire(record, {
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId: event.callId,
					invocationMessage: event.title || event.name,
					toolInput: event.input === undefined ? undefined : JSON.stringify(event.input),
					confirmed: ToolCallConfirmationReason.NotNeeded,
				});
				return;
			}
			case 'toolResult': {
				const turnId = this._turnId(record);
				if (!record.startedToolCalls.has(event.callId)) {
					// Result without an announced call (e.g. missed entry): surface a
					// minimal start so the completion has something to attach to.
					record.startedToolCalls.add(event.callId);
					this._fire(record, {
						type: ActionType.ChatToolCallStart,
						turnId,
						toolCallId: event.callId,
						toolName: 'manox tool',
						displayName: 'manox tool',
					});
				}
				this._fire(record, {
					type: ActionType.ChatToolCallComplete,
					turnId,
					toolCallId: event.callId,
					result: {
						pastTenseMessage: 'Done',
						content: [{ type: ToolResultContentType.Text, text: event.output }],
						success: !event.isError,
					},
				});
				return;
			}
			case 'turnFinish':
				this._endTurn(record);
				return;
			case 'error':
				this._fire(record, {
					type: ActionType.ChatError,
					turnId: this._turnId(record),
					duration: 1,
					part: createErrorResponsePart({ errorType: 'manox', message: event.message }),
				});
				return;
			case 'title':
				// Session-scoped action: address the session, not the chat channel.
				this._fireToSession(record, { type: ActionType.SessionTitleChanged, title: event.title });
				return;
			case 'permissionModeChange':
				if (isManoxApprovalMode(event.mode)) {
					record.approvalMode = event.mode;
				}
				return;
			case 'approval':
				// Journal mirror of the adjudication the approve server call
				// already drove; the card's lifecycle is host-owned.
				return;
			case 'metrics':
				if (event.kind !== 'token_usage' || !record.currentTurnId) {
					return;
				}
				this._accumulateTokenUsage(record, record.currentTurnId, event.data as IManoxTokenUsageData);
				return;
		}
	}

	private _accumulateTokenUsage(record: IManoxChatRecord, turnId: string, data: IManoxTokenUsageData): void {
		const totals = record.turnTokenUsage.get(turnId) ?? { input: 0, output: 0, cacheRead: 0, records: 0 };
		totals.input += data.input_tokens ?? 0;
		totals.output += data.output_tokens ?? 0;
		totals.cacheRead += (data.cache_read_input_tokens ?? 0) + (data.cache_creation_input_tokens ?? 0);
		totals.records += 1;
		record.turnTokenUsage.set(turnId, totals);
	}

	/** Token usage per turn from the journal's token_usage metrics —
	 * sufficient for the usage display and the turn tracker's accounting. */
	getTurnTokenUsage(chat: URI, turnId: string, _parentToolCallId?: string): IAgentTurnTokenUsage | undefined {
		const totals = this._chats.get(chat.toString())?.turnTokenUsage.get(turnId);
		if (!totals || totals.records === 0) {
			return undefined;
		}
		return {
			summaries: [{
				usageScope: 'direct-model',
				usageStatus: 'known',
				usageRecordCount: totals.records,
				inputKnownRecordCount: totals.records,
				outputKnownRecordCount: totals.records,
				cacheKnownRecordCount: totals.records,
				knownInputTokens: totals.input,
				knownOutputTokens: totals.output,
				knownCacheReadTokens: totals.cacheRead,
			}],
		};
	}

	// ---- IAgentChats ----------------------------------------------------------

	readonly chats: IAgentChats = {
		createChat: async (chat: URI, context: URI | IAgentChatContext, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult> => {
			resolveAgentChatContext(context, chat);
			const transport = this._ensureConnected();
			const workingDirectory = options?.workingDirectories?.[0];
			// Multi-root: the primary directory is the session cwd; every
			// additional folder rides `workingDirectories` and joins the
			// kernel's granted-root fence (dspo/manox#787), persisted in the
			// session sidecar so restores replay it.
			const extraWorkingDirectories = options?.workingDirectories?.slice(1).map(uri => uri.fsPath) ?? [];
			// The session-config picker's value wins; absent falls to the env
			// default (workspace-write). Mid-session switches are not wired yet
			// (the host applies session config at creation; no write-back hook
			// exists for providers), so the mode is fixed per session.
			const configuredMode = options?.config?.permissionMode;
			const approvalMode: ManoxApprovalMode = isManoxApprovalMode(configuredMode) ? configuredMode : manoxDefaultApprovalMode();
			let sessionId: string | undefined;
			if (options?.fork) {
				// The host normalizes fork AND side chat onto this option; the
				// forked turns are host-rendered either way, so a missing source
				// or entry point degrades to a fresh session (claude's pattern)
				// and only the backend continuation differs.
				const sourceRecord = this._chats.get(options.fork.source.toString());
				const throughEntryId = sourceRecord ? this._entryIdForTurn(sourceRecord, options.fork.turnId) : undefined;
				if (sourceRecord && throughEntryId) {
					try {
						const forked = await transport.forkSession({
							sourceSessionId: sourceRecord.sessionId,
							throughEntryId,
							cwd: workingDirectory?.fsPath ?? null,
							initialModel: options?.model?.id ?? null,
						});
						sessionId = forked.session_id;
						this._logService.info(`[manox] forked ${sourceRecord.sessionId}@${throughEntryId} -> ${sessionId}`);
					} catch (err) {
						this._logService.warn('[manox] forkSession failed; degrading to a fresh session', err);
					}
				} else {
					this._logService.warn(`[manox] fork source or entry not resolvable (turn ${options.fork.turnId}); degrading to a fresh session`);
				}
			}
			// importConversation deliberately lands here too: manox has no
			// transcript-seeding API, so an import is a fresh backend with the
			// imported turns rendered from the host's catalog (claude's model).
			if (!sessionId) {
				const response = await transport.call('createSession', {
					cwd: workingDirectory?.fsPath ?? null,
					workingDirectories: extraWorkingDirectories,
					project: null,
					initialModel: options?.model?.id ?? null,
					approvalMode,
					reasoningEffort: null,
				}) as { sessionId?: string; session_id?: string };
				sessionId = response?.sessionId ?? response?.session_id;
			}
			if (!sessionId) {
				throw new Error('[manox] createSession returned no session id');
			}
			const record: IManoxChatRecord = {
				chatUri: chat,
				sessionId,
				streamId: generateUuid(),
				history: [],
				currentTurnId: undefined,
				fallbackTurnId: undefined,
				textPartId: undefined,
				reasoningPartId: undefined,
				startedToolCalls: new Set(),
				turnActive: false,
				turnStartedAt: undefined,
				approvalMode,
				cwd: workingDirectory?.fsPath,
				lastEntryIdByTurn: new Map(),
				turnTokenUsage: new Map(),
			};
			this._chats.set(chat.toString(), record);
			transport.openStream(record.streamId, record.sessionId, MANOX_SNAPSHOT_WINDOW);
			this._logService.info(`[manox] session ${record.sessionId} created for ${chat.toString()}`);
			return {
				resolvedWorkingDirectory: workingDirectory,
				providerData: record.sessionId,
			};
		},

		disposeChat: async (chat: URI): Promise<void> => {
			const record = this._chats.get(chat.toString());
			if (!record) {
				return;
			}
			this._chats.delete(chat.toString());
			// Settle the chat's parked adjudications before tearing down: a
			// deny lets the server's waterfall fail closed immediately instead
			// of waiting out its 300s timeout; user-input asks cancel.
			this._pendingPermissions.respondWhere(meta => meta.chat.toString() === chat.toString(), false);
			this._pendingUserInputs.denyAll({ response: ChatInputResponseKind.Cancel });
			this._transport?.sendNote({ method: 'disposeSession', sessionId: record.sessionId });
		},

		releaseChat: async (chat: URI): Promise<void> => {
			// Non-destructive: drop the in-memory backing only; manox keeps the
			// durable session and a later materializeChat re-opens it.
			this._chats.delete(chat.toString());
		},

		sendMessage: async (chat: URI, prompt: string, _workingDirectoriesOrDirectory: readonly URI[] | URI | undefined, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> => {
			const record = this._chats.get(chat.toString());
			if (!record) {
				throw new Error(`[manox] no backing session for ${chat.toString()}`);
			}
			// Images ride the wire's ImageAttachment (base64 + mime); textual
			// references are appended to the prompt; anything else is dropped
			// with a warning rather than silently ignored.
			const images: IManoxImageAttachment[] = [];
			const referenceTexts: string[] = [];
			for (const attachment of attachments ?? []) {
				switch (attachment.type) {
					case MessageAttachmentKind.EmbeddedResource:
						if (/^image\//i.test(attachment.contentType)) {
							images.push({ data: attachment.data, mimeType: attachment.contentType });
						} else {
							this._logService.warn(`[manox] dropping embedded attachment of type ${attachment.contentType}`);
						}
						break;
					case MessageAttachmentKind.Resource:
						referenceTexts.push(`Attached resource: ${attachment.uri.toString()}`);
						break;
					case MessageAttachmentKind.Simple:
						if (attachment.modelRepresentation) {
							referenceTexts.push(`Attachment: ${attachment.modelRepresentation}`);
						}
						break;
					default:
						this._logService.warn(`[manox] dropping attachment of kind ${attachment.type}`);
				}
			}
			record.currentTurnId = turnId;
			record.fallbackTurnId = undefined;
			record.textPartId = undefined;
			record.reasoningPartId = undefined;
			if (turnId !== undefined) {
				record.turnTokenUsage.delete(turnId);
			}
			const receipt = await this._call('submit', {
				sessionId: record.sessionId,
				text: referenceTexts.length ? `${prompt}\n\n${referenceTexts.join('\n')}` : prompt,
				images,
				originRpc: null,
			}) as { accepted?: boolean };
			if (receipt?.accepted === false) {
				throw new Error('[manox] submit was not accepted');
			}
		},

		abort: async (chat: URI): Promise<void> => {
			const record = this._chats.get(chat.toString());
			if (record) {
				this._transport?.sendNote({ method: 'cancelTurn', sessionId: record.sessionId });
			}
		},

		changeModel: async (chat: URI, model: ModelSelection): Promise<void> => {
			const record = this._chats.get(chat.toString());
			if (record) {
				this._transport?.sendNote({ method: 'setModel', sessionId: record.sessionId, id: model.id });
				// The picker's per-model form carries the effort pick under the
				// shared thinkingLevel key; manox's wire vocabulary is high|max.
				const effort = model.config?.[MANOX_THINKING_LEVEL_KEY];
				if (effort === 'high' || effort === 'max') {
					this._transport?.setReasoningEffort(record.sessionId, effort satisfies ManoxReasoningEffort);
				}
			}
		},

		changeAgent: async (): Promise<void> => {
			// manox custom agents are not surfaced yet.
		},

		getMessages: async (chat: URI): Promise<readonly Turn[]> => {
			const record = this._chats.get(chat.toString());
			return record ? buildTurnsFromJournal(record.history) : [];
		},
	};

	// ---- Restore --------------------------------------------------------------

	async materializeChat(chat: URI, _context: URI | IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult | void> {
		if (!providerData) {
			this._logService.warn(`[manox] materialize without provider data for ${chat.toString()}`);
			return;
		}
		const transport = this._ensureConnected();
		const record: IManoxChatRecord = {
			chatUri: chat,
			sessionId: providerData,
			streamId: generateUuid(),
			history: [],
			currentTurnId: undefined,
			fallbackTurnId: undefined,
			textPartId: undefined,
			reasoningPartId: undefined,
			startedToolCalls: new Set(),
			turnActive: false,
			turnStartedAt: undefined,
			approvalMode: manoxDefaultApprovalMode(),
			cwd: undefined,
			lastEntryIdByTurn: new Map(),
			turnTokenUsage: new Map(),
		};
		// Attach server-side (replays any parked adjudications to this owner);
		// the answer is only `{restored: true}` — history arrives through the
		// follow stream's snapshot frame below.
		await transport.call('openSession', { sessionId: providerData });
		this._chats.set(chat.toString(), record);
		transport.openStream(record.streamId, providerData, MANOX_SNAPSHOT_WINDOW);
	}

	// ---- Config / metadata / auth stubs ---------------------------------------

	async resolveChatConfig(params: IAgentResolveChatConfigParams): Promise<ResolveSessionConfigResult> {
		// The single manox-specific knob: the sandbox approval mode, applied
		// at session creation (createChat reads options.config.permissionMode).
		// Not sessionMutable yet — the platform has no provider write-back
		// hook for mid-session config changes, so advertising mutability would
		// render a picker that lies.
		const sessionSchema = createSchema({
			permissionMode: schemaProperty<ManoxApprovalMode>({
				type: 'string',
				title: localize('manox.sessionConfig.approvalMode', "Approvals"),
				description: localize('manox.sessionConfig.approvalModeDescription', "How the Manox agent gates tool calls. Writes outside the granted working directories ask for approval."),
				enum: ['read-only', 'workspace-write', 'danger-full-access'],
				enumLabels: [
					localize('manox.sessionConfig.approvalMode.readOnly', "Read Only"),
					localize('manox.sessionConfig.approvalMode.workspaceWrite', "Workspace Write"),
					localize('manox.sessionConfig.approvalMode.dangerFullAccess', "Full Access"),
				],
				enumDescriptions: [
					localize('manox.sessionConfig.approvalMode.readOnlyDescription', "The agent cannot modify files."),
					localize('manox.sessionConfig.approvalMode.workspaceWriteDescription', "Writes inside the granted working directories are automatic; everything else asks first."),
					localize('manox.sessionConfig.approvalMode.dangerFullAccessDescription', "All tools run without asking."),
				],
				default: 'workspace-write',
				sessionMutable: false,
			}),
		});
		const values = sessionSchema.validateOrDefault(params.config ?? {}, {
			permissionMode: manoxDefaultApprovalMode(),
		});
		return { schema: sessionSchema.toProtocol(), values };
	}

	getInheritedChatConfig(): Record<string, unknown> | undefined {
		return undefined;
	}

	async chatConfigCompletions(_params: IAgentChatConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	readonly onDidCustomizationsChange = this._onDidCustomizationsChange.event;

	/** manox's slash-command catalog as per-session customizations: skills
	 * and commands surface as the children of two synthetic read-only
	 * directory containers (skills in the skill picker, commands as
	 * prompts). */
	async getChatCustomizations(_chat: URI): Promise<readonly Customization[]> {
		if (!this._commands.length) {
			try {
				this._commands = await this._ensureConnected().listCommands();
			} catch (err) {
				this._logService.warn('[manox] listCommands failed', err);
				return [];
			}
		}
		const toChild = (command: IManoxCommandInfo): SkillCustomization | PromptCustomization => ({
			type: command.kind === 'skill' ? CustomizationType.Skill : CustomizationType.Prompt,
			id: `manox:${command.kind}:${command.name}`,
			uri: `manox://commands/${encodeURIComponent(command.name)}`,
			name: command.name,
			...(command.description ? { description: command.description } : {}),
		});
		const skills = this._commands.filter(command => command.kind === 'skill');
		const prompts = this._commands.filter(command => command.kind === 'command');
		const containers: Customization[] = [];
		if (skills.length) {
			containers.push({
				type: CustomizationType.Directory,
				id: 'manox:skills',
				uri: 'manox://commands',
				name: localize('manoxAgent.skillsContainer', "Manox Skills"),
				enabled: true,
				contents: CustomizationType.Skill,
				writable: false,
				children: skills.map(toChild),
			});
		}
		if (prompts.length) {
			containers.push({
				type: CustomizationType.Directory,
				id: 'manox:prompts',
				uri: 'manox://commands',
				name: localize('manoxAgent.promptsContainer', "Manox Commands"),
				enabled: true,
				contents: CustomizationType.Prompt,
				writable: false,
				children: prompts.map(toChild),
			});
		}
		return containers;
	}

	async setWorkingDirectory(_chat: URI, _context: URI | IAgentChatContext, _workingDirectory: URI): Promise<void> {
		throw new Error('manox does not support changing the working directory of an existing session.');
	}

	async listChatsToMigrate(): Promise<AgentChatMigrationResult> {
		return [];
	}

	async getChatMetadata(chat: URI): Promise<IAgentChatMetadata | undefined> {
		const record = this._chats.get(chat.toString());
		if (!record) {
			// No live backing: let the host fall back to its registry values
			// instead of fabricating timestamps that advance on every call.
			return undefined;
		}
		const first = record.history[0];
		const last = record.history[record.history.length - 1];
		const modifiedTime = last ? (Date.parse(last.timestamp) || Date.now()) : Date.now();
		let enrichment: { summary?: string; workingDirectories?: readonly URI[]; model?: ModelSelection } = {};
		try {
			const info = await this._transport?.getConversationInfo(record.sessionId);
			if (info) {
				enrichment = {
					...(info.title ? { summary: info.title } : {}),
					...(info.cwd ? { workingDirectories: [URI.file(info.cwd), ...(info.project && info.project !== info.cwd ? [URI.file(info.project)] : [])] } : {}),
					...(info.model ? { model: { id: info.model } satisfies ModelSelection } : {}),
				};
			}
		} catch {
			// Best-effort enrichment; the journal-derived timestamps above
			// already satisfy the contract when the info call fails.
		}
		return {
			chat,
			startTime: first ? (Date.parse(first.timestamp) || modifiedTime) : modifiedTime,
			modifiedTime,
			...enrichment,
		};
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	async authenticate(_resource: string, _token: string, _expiresIn?: number): Promise<boolean> {
		return true;
	}

	getOrCreateActiveClient(chat: URI, _context: URI | IAgentChatContext, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		// One stable handle per (chat, clientId): the host fans out handle
		// updates repeatedly and `removeActiveClient` must be able to retire
		// the exact live registration.
		const key = `${chat.toString()}::${client.clientId}`;
		let handle = this._activeClients.get(key);
		if (!handle) {
			handle = new ManoxActiveClient(this, chat, client.clientId, client.displayName);
			this._activeClients.set(key, handle);
		}
		return handle;
	}

	removeActiveClient(chat: URI, _context: URI | IAgentChatContext, clientId: string): void {
		this._activeClients.delete(`${chat.toString()}::${clientId}`);
		// Full-replace semantics on the wire: an empty registration retires
		// the client's tools server-side.
		const record = this._chats.get(chat.toString());
		if (record && this._transport) {
			void this._transport.registerSessionTools({ sessionId: record.sessionId, clientId, tools: [] }).catch(err => this._logService.warn('[manox] client-tool deregistration failed', err));
		}
	}

	onClientToolCallComplete(_chat: URI, toolCallId: string, result: ToolCallResult): void {
		const parts: string[] = [];
		for (const content of result.content ?? []) {
			if (content.type === ToolResultContentType.Text) {
				parts.push(content.text);
			}
		}
		this._pendingClientTools.respond(toolCallId, {
			content: parts.join('\n') || 'ok',
			isError: !result.success,
		});
	}

	/** Push one client's contributed tools into the session (full replace). */
	public _syncClientTools(chat: URI, clientId: string, tools: readonly ToolDefinition[]): void {
		const record = this._chats.get(chat.toString());
		if (!record || !this._transport) {
			return;
		}
		const specs: IManoxClientToolSpec[] = tools.map(tool => ({
			name: tool.name,
			description: tool.description ?? tool.title ?? tool.name,
			input_schema: tool.inputSchema ?? { type: 'object' },
		}));
		void this._transport.registerSessionTools({ sessionId: record.sessionId, clientId, tools: specs })
			.then(({ registered }) => this._logService.info(`[manox] registered ${registered} client tools for ${clientId}`))
			.catch(err => this._logService.warn('[manox] client-tool registration failed', err));
	}

	/** The journal entry a fork of `turnId` should cut through: the last
	 * entry of that turn. Live turns are tracked as entries stream in; for
	 * restored history the host's turn id IS the user-message entry id
	 * (buildTurnsFromJournal), so the chain is walked forward to the next
	 * user message. */
	private _entryIdForTurn(record: IManoxChatRecord, turnId: string): string | undefined {
		const live = record.lastEntryIdByTurn.get(turnId);
		if (live) {
			return live;
		}
		let inTurn = false;
		let last: string | undefined;
		for (const entry of record.history) {
			if (entry.type === 'message' && entry.role === 'user') {
				if (inTurn) {
					return last;
				}
				inTurn = entry.id === turnId;
				last = entry.id;
			} else if (inTurn) {
				last = entry.id;
			}
		}
		return inTurn ? last : undefined;
	}

	/** Point an existing chat at a different backing session (fork-based
	 * truncation): dispose the old session, reset the per-turn state, reopen
	 * the follow stream (its snapshot rebuilds the retained history) and tell
	 * the host to persist the new providerData. */
	private async _rebindChatToSession(chat: URI, record: IManoxChatRecord, sessionId: string): Promise<void> {
		this._transport?.sendNote({ method: 'disposeSession', sessionId: record.sessionId });
		record.sessionId = sessionId;
		record.streamId = generateUuid();
		record.history.length = 0;
		record.currentTurnId = undefined;
		record.fallbackTurnId = undefined;
		record.textPartId = undefined;
		record.reasoningPartId = undefined;
		record.startedToolCalls.clear();
		record.turnActive = false;
		record.turnStartedAt = undefined;
		record.lastEntryIdByTurn.clear();
		this._ensureConnected().openStream(record.streamId, sessionId, MANOX_SNAPSHOT_WINDOW);
		this._onDidChangeChatData.fire({ chat, providerData: sessionId });
	}

	/** Checkpoint restore: fork the session at the retained turn (manox has
	 * no in-place rewind; ForkSession's prefix copy IS the truncation) and
	 * rebind, or mint a fresh session for a start-over. The host has already
	 * truncated its UI state and dropped its checkpoints. */
	async truncateChat(chat: URI, turnId: string | undefined, _context: URI | IAgentChatContext): Promise<void> {
		const record = this._chats.get(chat.toString());
		if (!record) {
			return;
		}
		const transport = this._ensureConnected();
		try {
			if (turnId === undefined) {
				const response = await transport.call('createSession', {
					cwd: record.cwd ?? null,
					workingDirectories: [],
					project: null,
					initialModel: null,
					approvalMode: record.approvalMode,
					reasoningEffort: null,
				}) as { sessionId?: string; session_id?: string };
				const fresh = response?.sessionId ?? response?.session_id;
				if (fresh) {
					await this._rebindChatToSession(chat, record, fresh);
				}
				return;
			}
			const throughEntryId = this._entryIdForTurn(record, turnId);
			if (!throughEntryId) {
				this._logService.warn(`[manox] truncate: no journal entry for turn '${turnId}'`);
				return;
			}
			const forked = await transport.forkSession({ sourceSessionId: record.sessionId, throughEntryId });
			await this._rebindChatToSession(chat, record, forked.session_id);
		} catch (err) {
			this._logService.warn('[manox] truncate failed', err);
		}
	}

	// ---- Session discovery (external manox sessions) -------------------------

	private _knownSessionsFilter: IAgentKnownSessionsFilter | undefined;
	private _discoveryTimer: ReturnType<typeof setTimeout> | undefined;

	setKnownSessionsFilter(filter: IAgentKnownSessionsFilter): void {
		this._knownSessionsFilter = filter;
	}

	async startChatDiscovery(): Promise<void> {
		await this._discoverExternalSessions();
	}

	private _scheduleDiscovery(): void {
		if (this._discoveryTimer) {
			clearTimeout(this._discoveryTimer);
		}
		this._discoveryTimer = setTimeout(() => {
			this._discoveryTimer = undefined;
			void this._discoverExternalSessions();
		}, 2000);
	}

	/** Surface every top-level manox session (including ones created by the
	 * desktop app under the same MANOX_HOME) as external discovered chats. */
	private async _discoverExternalSessions(): Promise<void> {
		try {
			const threads = await this._ensureConnected().listThreads();
			const sessionIds = threads.filter(thread => !thread.parent_id).map(thread => thread.id);
			// One registry query drops already-registered candidates (the set
			// holds session-URI strings, mirroring copilot's contract).
			const known = this._knownSessionsFilter && sessionIds.length
				? await this._knownSessionsFilter(sessionIds.map(id => AgentSession.uri(this.id, id)))
				: undefined;
			const candidates: IAgentDiscoveredChat[] = [];
			for (const thread of threads) {
				if (thread.parent_id) {
					continue; // team member rows nest under their leader
				}
				if (known?.has(AgentSession.uri(this.id, thread.id).toString())) {
					continue;
				}
				const chatUri = URI.parse(buildDefaultChatUri(AgentSession.uri(this.id, thread.id)));
				candidates.push({
					chat: chatUri,
					startTime: thread.updated_at * 1000,
					modifiedTime: thread.updated_at * 1000,
					...(thread.title ? { summary: thread.title } : {}),
					...(thread.project ? { workingDirectories: [URI.file(thread.project)] } : {}),
					...(thread.model_id ? { model: { id: thread.model_id } } : {}),
					external: true,
				});
			}
			this._onDidDiscoverChats.fire(candidates);
		} catch (err) {
			this._logService.warn('[manox] session discovery failed', err);
		}
	}

	/** Mirror the host's archive bit into the manox store so the desktop app
	 * (and a later discovery pass) sees the same state. */
	async onArchivedChanged(chat: URI, isArchived: boolean): Promise<void> {
		const record = this._chats.get(chat.toString());
		if (record) {
			this._transport?.archiveThread(record.sessionId, isArchived);
		}
	}

	/** Turn steering: forwarded as a wire steer only while a turn runs (a
	 * no-turn steer degrades to a fresh submit server-side and would double-
	 * send). Queued messages are host-consumed and never reach the agent. */
	setPendingMessages(chat: URI, steeringMessage: PendingMessage | undefined, _queuedMessages: readonly PendingMessage[]): void {
		const record = this._chats.get(chat.toString());
		if (!record || !record.turnActive || !steeringMessage) {
			return;
		}
		try {
			void this._ensureConnected().steer({
				sessionId: record.sessionId,
				messageId: steeringMessage.id,
				text: steeringMessage.message.text,
				images: [],
			}).then(receipt => {
				if (receipt.accepted) {
					this._onDidChatProgress.fire({ kind: 'steering_consumed', chat: record.chatUri, id: steeringMessage.id });
				}
			});
		} catch (err) {
			this._logService.warn('[manox] steer failed', err);
		}
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		this._pendingPermissions.respond(requestId, approved);
	}

	respondToUserInputRequest(requestId: string, response: ChatInputResponseKind, answers?: Record<string, ChatInputAnswer>): void {
		this._pendingUserInputs.respond(requestId, { response, answers });
	}

	async shutdown(): Promise<void> {
		await this._transport?.dispose();
		this._transport = undefined;
		this._settleAllPending();
	}

	override dispose(): void {
		void this._transport?.dispose();
		this._transport = undefined;
		this._settleAllPending();
		this._chats.clear();
		super.dispose();
	}

	/** Deny every parked adjudication and cancel every parked question — the
	 * wire replies can no longer be delivered once the transport is gone, but
	 * settling keeps the host-side awaiters from hanging. */
	private _settleAllPending(): void {
		this._pendingPermissions.denyAll(false);
		this._pendingUserInputs.denyAll({ response: ChatInputResponseKind.Cancel });
	}
}

// ---- Journal → Turn[] reconstruction (restore history) ----------------------
