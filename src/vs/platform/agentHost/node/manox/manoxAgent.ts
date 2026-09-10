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
import { AgentHostManoxHomeEnvVar, AgentHostManoxSdkRootEnvVar } from '../../common/agentService.js';
import { resolveAgentChatContext, type AgentChatMigrationResult, type AgentProvider, type AgentSignal, type IActiveClient, type IAgent, type IAgentCapabilities, type IAgentChatConfigCompletionsParams, type IAgentChatContext, type IAgentChatMetadata, type IAgentChats, type IAgentCreateChatOptions, type IAgentCreateChatResult, type IAgentDescriptor, type IAgentDiscoveredChat, type IAgentHostCapabilities, type IAgentModelInfo, type IAgentResolveChatConfigParams } from '../../common/agent.js';
import { ActionType, type SessionAction } from '../../common/state/sessionActions.js';
import type { ChatAction } from '../../common/state/protocol/channels-chat/actions.js';
import { MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolResultContentType, TurnState, createErrorResponsePart, parseChatUri, type ChatInputAnswer, type ChatInputResponseKind, type ClientPluginCustomization, type Customization, type Message, type MessageAttachment, type ModelSelection, type ResponsePart, type ToolDefinition, type Turn } from '../../common/state/sessionState.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { ProtectedResourceMetadata } from '../../common/state/protocol/state.js';
import { ManoxNapiTransport, type ManoxFromServer, type ManoxJournalEntry, type ManoxJournalEvent } from './manoxNapiTransport.js';

const MANOX_AGENT_PROVIDER_ID: AgentProvider = 'manox';

/** Approval mode every manox session is created with. The experiment does
 * not wire tool adjudication into the UI yet, so sessions run ungated. */
const MANOX_APPROVAL_MODE = 'danger-full-access';

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
		const capabilities: IAgentCapabilities = {};
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
		// The experiment runs sessions in danger-full-access mode, so approve
		// calls are not expected. Fail closed on anything that slips through
		// rather than stalling the server's 300s adjudication timeout.
		this._logService.warn(`[manox] unhandled server call '${event.call.method}'; denying`);
		if (!this._transport) {
			return;
		}
		if (event.call.method === 'approve') {
			this._transport.reply(event.id, { allow: false });
		} else {
			this._transport.replyError(event.id, 'not supported by the manox agent host');
		}
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
			this._fire(record, { type: ActionType.ChatTurnComplete, turnId: this._turnId(record), duration: 1 });
		}
		record.currentTurnId = undefined;
		record.fallbackTurnId = undefined;
		record.textPartId = undefined;
		record.reasoningPartId = undefined;
		record.startedToolCalls.clear();
	}

	private _dispatchJournalEvent(record: IManoxChatRecord, event: ManoxJournalEvent): void {
		switch (event.type) {
			case 'turnStart':
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
		}
	}

	// ---- IAgentChats ----------------------------------------------------------

	readonly chats: IAgentChats = {
		createChat: async (chat: URI, context: URI | IAgentChatContext, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult> => {
			resolveAgentChatContext(context, chat);
			const transport = this._ensureConnected();
			const workingDirectory = options?.workingDirectories?.[0];
			const response = await transport.call('createSession', {
				cwd: workingDirectory?.fsPath ?? null,
				project: null,
				initialModel: options?.model?.id ?? null,
				approvalMode: MANOX_APPROVAL_MODE,
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
			if (attachments?.length) {
				this._logService.warn('[manox] message attachments are not supported yet; dropping');
			}
			record.currentTurnId = turnId;
			record.fallbackTurnId = undefined;
			record.textPartId = undefined;
			record.reasoningPartId = undefined;
			const receipt = await this._call('submit', {
				sessionId: record.sessionId,
				text: prompt,
				images: [],
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
		};
		const response = await transport.call('openSession', { sessionId: providerData }) as { records?: ManoxJournalEntry[] };
		if (Array.isArray(response?.records)) {
			record.history.push(...response.records);
		}
		this._chats.set(chat.toString(), record);
		transport.openStream(record.streamId, providerData, MANOX_SNAPSHOT_WINDOW);
	}

	// ---- Config / metadata / auth stubs ---------------------------------------

	async resolveChatConfig(params: IAgentResolveChatConfigParams): Promise<ResolveSessionConfigResult> {
		return { schema: { type: 'object', properties: {} }, values: params.config ?? {} };
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
		return { chat, startTime: Date.now(), modifiedTime: Date.now() };
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	async authenticate(_resource: string, _token: string, _expiresIn?: number): Promise<boolean> {
		return true;
	}

	getOrCreateActiveClient(_chat: URI, _context: URI | IAgentChatContext, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		let tools: readonly ToolDefinition[] = [];
		let customizations: readonly ClientPluginCustomization[] = [];
		return {
			clientId: client.clientId,
			displayName: client.displayName,
			get tools() { return tools; },
			set tools(value: readonly ToolDefinition[]) { tools = value; },
			get customizations() { return customizations; },
			set customizations(value: readonly ClientPluginCustomization[]) { customizations = value; },
		};
	}

	removeActiveClient(): void { }

	onClientToolCallComplete(): void { }

	respondToPermissionRequest(_requestId: string, _approved: boolean): void {
		// Sessions run with danger-full-access; adjudication is denied in
		// _handleServerRequest, so nothing pending exists to respond to.
	}

	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void { }

	async shutdown(): Promise<void> {
		await this._transport?.dispose();
		this._transport = undefined;
	}

	override dispose(): void {
		void this._transport?.dispose();
		this._transport = undefined;
		this._chats.clear();
		super.dispose();
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
