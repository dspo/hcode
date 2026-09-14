/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
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
import { resolveAgentChatContext, type AgentChatMigrationResult, type AgentProvider, type AgentSignal, type IActiveClient, type IAgent, type IAgentCapabilities, type IAgentChatConfigCompletionsParams, type IAgentChatContext, type IAgentChatMetadata, type IAgentChats, type IAgentCreateChatOptions, type IAgentCreateChatResult, type IAgentDescriptor, type IAgentDiscoveredChat, type IAgentHostCapabilities, type IAgentModelInfo, type IAgentResolveChatConfigParams } from '../../common/agent.js';
import { ActionType, type SessionAction } from '../../common/state/sessionActions.js';
import type { ChatAction } from '../../common/state/protocol/channels-chat/actions.js';
import { ChatInputResponseKind, MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolResultContentType, TurnState, createErrorResponsePart, parseChatUri, ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputQuestionKind, MessageAttachmentKind, ToolCallStatus, type ChatInputAnswer, type ChatInputOption, type ChatInputQuestion, type ChatInputRequest, type ClientPluginCustomization, type Customization, type Message, type MessageAttachment, type ModelSelection, type PendingMessage, type ResponsePart, type ToolCallPendingConfirmationState, type ToolDefinition, type Turn } from '../../common/state/sessionState.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { ConfigSchema, ProtectedResourceMetadata } from '../../common/state/protocol/state.js';
import { ManoxNapiTransport, type IManoxImageAttachment, type ManoxFromServer, type ManoxJournalEntry, type ManoxJournalEvent } from './manoxNapiTransport.js';

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

/** Host auto-approval bucket for a manox tool name (SessionPermissionManager
 * keys its policy off this; it never gates what the runtime approves). */
function manoxPermissionKind(toolName: string): 'shell' | 'write' | 'read' | 'custom-tool' {
	const name = toolName.toLowerCase();
	if (name.includes('bash') || name.includes('shell') || name.includes('terminal') || name.includes('exec')) {
		return 'shell';
	}
	if (name.includes('edit') || name.includes('write') || name.includes('patch') || name.includes('notebook')) {
		return 'write';
	}
	if (name.startsWith('read') || name.includes('grep') || name.includes('glob') || name.includes('list')) {
		return 'read';
	}
	return 'custom-tool';
}

/** Best-effort path target for host auto-approval scoping (write tools). */
function manoxPermissionPath(input: unknown): string | undefined {
	if (typeof input !== 'object' || input === null) {
		return undefined;
	}
	const record = input as Record<string, unknown>;
	for (const key of ['file_path', 'filePath', 'notebook_path', 'path', 'file']) {
		const value = record[key];
		if (typeof value === 'string' && value) {
			return value;
		}
	}
	return undefined;
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

/** Flatten one answered chat-input question into the text manox expects. */
function manoxAnswerText(answer: ChatInputAnswer | undefined): string | undefined {
	if (!answer || answer.state === ChatInputAnswerState.Skipped) {
		return undefined;
	}
	const value = answer.value;
	switch (value.kind) {
		case ChatInputAnswerValueKind.SelectedMany:
			return value.value.length ? value.value.join(', ') : undefined;
		case ChatInputAnswerValueKind.Text:
		case ChatInputAnswerValueKind.Selected:
			return value.value || undefined;
		case ChatInputAnswerValueKind.Number:
		case ChatInputAnswerValueKind.Boolean:
			return String(value.value);
	}
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
	readonly sessionId: string;
	readonly streamId: string;
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
}

export class ManoxAgent extends Disposable implements IAgent {

	readonly id: AgentProvider = MANOX_AGENT_PROVIDER_ID;
	readonly agentHostCapabilities: IAgentHostCapabilities = { workspaceConversion: false };

	private readonly _onDidChatProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this._onDidChatProgress.event;
	readonly onDidMaterializeChat = Event.None;
	readonly onDidChangeChatData = Event.None;
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
			default:
				// Fail closed rather than stalling the server's 300s timeout:
				// browserOp is undeclared (never routed); clipboardRead /
				// openExternal / invokeClientTool / planVerdict arrive once the
				// corresponding bridge lands.
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
			return;
		}
		if (frame.type !== 'entry') {
			return;
		}
		record.history.push({ ...frame.event, seq: frame.seq, id: frame.id, parentId: frame.parentId, timestamp: frame.timestamp });
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
		}
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
			const response = await transport.call('createSession', {
				cwd: workingDirectory?.fsPath ?? null,
				workingDirectories: extraWorkingDirectories,
				project: null,
				initialModel: options?.model?.id ?? null,
				approvalMode,
				reasoningEffort: null,
			}) as { sessionId?: string; session_id?: string };
			const sessionId = response?.sessionId ?? response?.session_id;
			if (!sessionId) {
				throw new Error(`[manox] createSession returned no session id: ${JSON.stringify(response)}`);
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

	async getChatCustomizations(): Promise<readonly Customization[]> {
		return [];
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
			let tools: readonly ToolDefinition[] = [];
			let customizations: readonly ClientPluginCustomization[] = [];
			handle = {
				clientId: client.clientId,
				displayName: client.displayName,
				get tools() { return tools; },
				set tools(value: readonly ToolDefinition[]) { tools = value; },
				get customizations() { return customizations; },
				set customizations(value: readonly ClientPluginCustomization[]) { customizations = value; },
			};
			this._activeClients.set(key, handle);
		}
		return handle;
	}

	removeActiveClient(chat: URI, _context: URI | IAgentChatContext, clientId: string): void {
		this._activeClients.delete(`${chat.toString()}::${clientId}`);
	}

	onClientToolCallComplete(): void { }

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

function extractText(blocks: readonly unknown[] | undefined): string {
	if (!blocks) {
		return '';
	}
	let text = '';
	for (const block of blocks) {
		const candidate = block as { text?: unknown };
		if (typeof candidate?.text === 'string') {
			text += candidate.text;
		}
	}
	return text;
}

/** Rebuilds user/assistant turns from the journal. Tool traffic is skipped in
 * history for now: the live stream renders it via actions, and durable tool
 * parts need the full `ToolCallState` codec. */
export function buildTurnsFromJournal(records: readonly ManoxJournalEntry[]): Turn[] {
	const turns: Turn[] = [];
	let current: { id: string; userText: string } | undefined;
	let parts: ResponsePart[] = [];
	let textBuffer = '';
	let partCounter = 0;

	const flushText = (): void => {
		if (textBuffer) {
			parts.push({ kind: ResponsePartKind.Markdown, id: `manox-hist-${++partCounter}`, content: textBuffer });
			textBuffer = '';
		}
	};
	const finalize = (): void => {
		flushText();
		if (current) {
			const message: Message = { text: current.userText, origin: { kind: MessageKind.User } };
			turns.push({
				id: current.id,
				message,
				responseParts: parts,
				usage: undefined,
				state: TurnState.Complete,
			});
			current = undefined;
			parts = [];
		}
	};

	for (const entry of records) {
		if (entry.type === 'message' && entry.role === 'user') {
			finalize();
			current = { id: entry.id, userText: extractText(entry.content) };
		} else if (entry.type === 'message' && entry.role === 'assistant') {
			if (!current) {
				current = { id: entry.id, userText: '' };
			}
			const text = extractText(entry.content);
			if (text) {
				flushText();
				parts.push({ kind: ResponsePartKind.Markdown, id: `manox-hist-${++partCounter}`, content: text });
			}
		} else if (entry.type === 'agentTextDelta') {
			if (!current) {
				current = { id: entry.id, userText: '' };
			}
			textBuffer += entry.s;
		}
	}
	finalize();
	return turns;
}
