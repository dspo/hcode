/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../log/common/log.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { URI } from '../../../../base/common/uri.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { generateUuid } from '../../../../base/common/uuid.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import {
	AgentSession, resolveAgentChatContext, type AgentChatMigrationResult, type AgentProvider, type AgentSignal, type IAgent,
	type IAgentCapabilities, type IAgentChatContext, type IAgentChatDataChange, type IAgentChatMetadata,
	type IAgentChats, type IAgentCreateChatOptions, type IAgentCreateChatResult, type IAgentDescriptor,
	type IAgentDiscoveredChat, type IAgentHostCapabilities, type IAgentKnownSessionsFilter, type IAgentMaterializeChatEvent,
	type IAgentModelInfo, type IAgentResolveChatConfigParams, type IAgentSpawnChatEvent, type IAgentTelemetryContext,
	type IAgentTurnTokenUsage, type IActiveClient
} from '../../common/agent.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { Customization, MessageAttachment, ModelSelection, ProtectedResourceMetadata } from '../../common/state/protocol/state.js';
import { buildDefaultChatUri, type Turn } from '../../common/state/sessionState.js';
import type { ChatAction, SessionAction } from '../../common/state/sessionActions.js';
import { ManoxNapiTransport, MANOX_SDK_ROOT_ENV, resolveDefaultManoxSdkRoot } from './manoxNapiTransport.js';

const MANOX_AGENT_PROVIDER_ID: AgentProvider = 'manox';

/** The AHP protocol version manox's host speaks. */
const PROTOCOL_VERSION = '0.9.0';

/** The manox model catalogue shape (a subset of the AHP `ModelInfo`). */
interface IManoxModelInfo {
	readonly id: string;
	readonly name: string;
	readonly maxContextWindow?: number;
	readonly maxOutputTokens?: number;
}

interface IManoxAgentInfo {
	readonly provider: string;
	readonly models: readonly IManoxModelInfo[];
}

/** One manox session backing a host chat. */
interface IManoxChatRecord {
	/** The host chat channel URI (what chat-level `AgentSignal.resource` carries). */
	readonly chatUri: URI;
	/** The host session URI (what session-level `AgentSignal.resource` carries). */
	readonly sessionUri: URI;
	/** The manox session/thread id. */
	readonly sessionId: string;
	/** The AHP chat channel (`ahp-chat:/<id>`), for routing action envelopes. */
	readonly chatChannel: string;
	/** The AHP session channel (`ahp-session:/<id>`). */
	readonly sessionChannel: string;
	readonly startTime: number;
	modifiedTime: number;
}

/**
 * manox as an Agent Host provider: a native runtime embedded in-process over
 * the napi AHP bridge. The provider drives manox through AHP (initialize,
 * createSession, subscribe, dispatchAction) and relays manox's action stream
 * to the host as {@link AgentSignal} — manox already speaks AHP, so the action
 * envelopes pass through unchanged rather than being re-mapped.
 */
export class ManoxAgent extends Disposable implements IAgent {
	readonly id: AgentProvider = MANOX_AGENT_PROVIDER_ID;
	readonly agentHostCapabilities: IAgentHostCapabilities = { workspaceConversion: false };

	private readonly _onDidChatProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this._onDidChatProgress.event;

	private readonly _onDidMaterializeChat = this._register(new Emitter<IAgentMaterializeChatEvent>());
	readonly onDidMaterializeChat = this._onDidMaterializeChat.event;

	private readonly _onDidChangeChatData = this._register(new Emitter<IAgentChatDataChange>());
	readonly onDidChangeChatData = this._onDidChangeChatData.event;

	private readonly _onDidSpawnChat = this._register(new Emitter<IAgentSpawnChatEvent>());
	readonly onDidSpawnChat = this._onDidSpawnChat.event;

	private readonly _onDidDiscoverChats = this._register(new Emitter<readonly IAgentDiscoveredChat[]>());
	readonly onDidDiscoverChats = this._onDidDiscoverChats.event;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private _transport: ManoxNapiTransport | undefined;
	/** Resolves once the AHP `initialize` handshake has completed. */
	private _ready: Promise<void> | undefined;
	/** The AHP clientId for this host instance. */
	private readonly _clientId = `vscode-manox-${generateUuid()}`;
	/** Maps a host chat URI (authority string) to its manox backing. */
	private readonly _chats = new Map<string, IManoxChatRecord>();
	/** Pending confirmation's `toolCallId` → its owning `turnId`. */
	private readonly _toolCallTurns = new Map<string, string>();
	private _chatDiscoveryStarted = false;
	/** Monotonic per-connection dispatch sequence (`dispatchAction.clientSeq`). */
	private _clientSeq = 0;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
	) {
		super();
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: 'manox',
			description: 'manox agent backed by the native manox runtime',
			capabilities: {} satisfies IAgentCapabilities,
		};
	}

	// ---- Transport ----------------------------------------------------------

	private _ensureConnected(): ManoxNapiTransport {
		if (this._transport) {
			return this._transport;
		}
		const sdkRoot = process.env[MANOX_SDK_ROOT_ENV] ?? resolveDefaultManoxSdkRoot(this._environmentService.appRoot);
		const transport = ManoxNapiTransport.load(sdkRoot ?? '');
		transport.onNotification((method, params) => this._onNotification(method, params));
		transport.onRequest((method, params) => this._onRequest(method, params));
		this._transport = transport;
		this._ready = this._initialize(transport).catch(error => {
			this._logService.error('[manox] initialize failed', error);
		});
		return transport;
	}

	/** Ensure the transport exists and the AHP handshake has completed. */
	private async _ensureReady(): Promise<void> {
		this._ensureConnected();
		await this._ready;
	}

	private async _initialize(transport: ManoxNapiTransport): Promise<void> {
		const result = await transport.request('initialize', {
			channel: 'ahp-root://',
			protocolVersions: [PROTOCOL_VERSION],
			clientId: this._clientId,
			capabilities: {},
			// Declare the host→client request methods this provider answers:
			// the manox runtime routes Open/ClipboardRead through these.
			_meta: {
				'x-manox': {
					serverRequests: ['x-manox/openExternal', 'x-manox/clipboardRead'],
				},
			},
		}) as { protocolVersion?: string };
		this._logService.info(`[manox] connected, protocol ${result.protocolVersion ?? '?'}`);
		void this._refreshModels(transport);
	}

	private async _refreshModels(transport?: ManoxNapiTransport): Promise<void> {
		const t = transport ?? this._transport;
		if (!t) {
			return;
		}
		const snapshot = await t.request('subscribe', { channel: 'ahp-root://' }) as {
			snapshot?: { state?: { agents?: readonly IManoxAgentInfo[] } };
		};
		this._applyModels(snapshot.snapshot?.state?.agents ?? []);
	}

	/** Flatten the manox catalogue (one `AgentInfo` per LLM provider) into the
	 * host's flat model list, all owned by this agent. */
	private _applyModels(agents: readonly IManoxAgentInfo[]): void {
		const models: IAgentModelInfo[] = [];
		for (const agent of agents) {
			for (const model of agent.models ?? []) {
				models.push({
					provider: this.id,
					id: model.id,
					name: model.id,
					maxContextWindow: model.maxContextWindow,
					maxOutputTokens: model.maxOutputTokens,
					supportsVision: false,
				});
			}
		}
		if (models.length > 0) {
			this._models.set(models, undefined);
		}
	}

	async refreshModels(): Promise<void> {
		await this._refreshModels();
	}

	// ---- Notification routing ----------------------------------------------

	private _onNotification(method: string, params: unknown): void {
		if (method !== 'action') {
			return;
		}
		const envelope = params as { channel?: string; action?: { type?: string; agents?: readonly IManoxAgentInfo[] } };
		if (!envelope.channel || !envelope.action) {
			return;
		}
		// The root channel carries the model catalogue, which arrives as an
		// action once the provider registry has loaded (not in the snapshot).
		if (envelope.channel === 'ahp-root://' && envelope.action.type === 'root/agentsChanged') {
			this._applyModels(envelope.action.agents ?? []);
			return;
		}
		const record = this._recordForChannel(envelope.channel);
		if (!record) {
			return;
		}
		const action = envelope.action as { type?: string; turnId?: string; toolCallId?: string };
		// Remember the turn each pending confirmation lives in, so a later
		// `chat/toolCallConfirmed` can carry the required `turnId`.
		if (action.type === 'chat/toolCallReady' && action.toolCallId && action.turnId) {
			this._toolCallTurns.set(action.toolCallId, action.turnId);
		}
		// Session-level actions address the session channel, chat-level actions
		// the chat channel; the host rejects a mismatch.
		const resource = envelope.channel.startsWith('ahp-session:') ? record.sessionUri : record.chatUri;
		this._onDidChatProgress.fire({ kind: 'action', resource, action: envelope.action as unknown as ChatAction | SessionAction });
	}

	private _recordForChannel(channel: string): IManoxChatRecord | undefined {
		for (const record of this._chats.values()) {
			if (record.chatChannel === channel || record.sessionChannel === channel) {
				return record;
			}
		}
		return undefined;
	}

	/** Answer a host→client request (`x-manox/openExternal` / `clipboardRead`). */
	private async _onRequest(method: string, params: unknown): Promise<unknown> {
		const execFileAsync = promisify(execFile);
		switch (method) {
			case 'x-manox/openExternal': {
				const url = (params as { url?: string })?.url;
				if (!url || !/^(https?|mailto|file):/.test(url)) {
					throw new Error(`refusing to open URL with a non-allowlisted scheme`);
				}
				const command = process.platform === 'darwin'
					? { file: 'open', args: [url] }
					: process.platform === 'win32'
						? { file: 'cmd.exe', args: ['/c', 'start', '', url] }
						: { file: 'xdg-open', args: [url] };
				await execFileAsync(command.file, command.args, { timeout: 5000 });
				return null;
			}
			case 'x-manox/clipboardRead': {
				const command = process.platform === 'darwin'
					? { file: 'pbpaste', args: [] }
					: process.platform === 'win32'
						? { file: 'powershell.exe', args: ['-NoProfile', '-Command', 'Get-Clipboard'] }
						: { file: 'xclip', args: ['-o', '-selection', 'clipboard'] };
				const { stdout } = await execFileAsync(command.file, command.args, { timeout: 3000 });
				return stdout;
			}
			default:
				throw new Error(`unknown host request: ${method}`);
		}
	}

	private _record(sessionId: string, chat: URI, sessionUri: URI): IManoxChatRecord {
		const now = Date.now();
		return {
			chatUri: chat,
			sessionUri,
			sessionId,
			chatChannel: `ahp-chat:/${sessionId}`,
			sessionChannel: `ahp-session:/${sessionId}`,
			startTime: now,
			modifiedTime: now,
		};
	}

	// ---- Chat operations ----------------------------------------------------

	readonly chats: IAgentChats = {
		createChat: async (chat: URI, context: URI | IAgentChatContext, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult | void> => {
			const transport = this._ensureConnected();
			await this._ready;
			const workingDirectories = options?.workingDirectories?.map(uri => uri.toString()) ?? [];
			const sessionId = generateUuid();
			const sessionChannel = `ahp-session:/${sessionId}`;
			await transport.request('createSession', {
				channel: sessionChannel,
				provider: this.id,
				workingDirectories,
				config: {
					model: options?.model?.id,
					permissionMode: options?.config?.permissionMode,
				},
			});
			const sessionUri = resolveAgentChatContext(context, chat).configurationResource;
			this._chats.set(chat.toString(), this._record(sessionId, chat, sessionUri));
			await transport.request('subscribe', { channel: sessionChannel }).catch(() => undefined);
			await transport.request('subscribe', { channel: `ahp-chat:/${sessionId}` }).catch(() => undefined);
			this._logService.info(`[manox] session ${sessionId} created for ${chat.toString()}`);
			return { resolvedWorkingDirectory: options?.workingDirectories?.[0], providerData: sessionId };
		},

		disposeChat: async (chat: URI): Promise<void> => {
			const record = this._chats.get(chat.toString());
			if (!record) {
				return;
			}
			this._chats.delete(chat.toString());
			this._transport?.request('disposeSession', { channel: record.sessionChannel }).catch(() => undefined);
		},

		releaseChat: async (chat: URI): Promise<void> => {
			this._chats.delete(chat.toString());
		},

		sendMessage: async (chat: URI, prompt: string, _workingDirectoriesOrDirectory: readonly URI[] | URI | undefined, _attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> => {
			const record = this._chats.get(chat.toString());
			if (!record) {
				throw new Error('[manox] sendMessage on an unknown chat');
			}
			await this._ensureReady();
			const action = {
				type: 'chat/turnStarted',
				turnId: turnId ?? generateUuid(),
				startedAt: new Date().toISOString(),
				message: { text: prompt, origin: { kind: 'user' as const }, attachments: [] },
			};
			this._transport?.notify('dispatchAction', { channel: record.chatChannel, clientSeq: ++this._clientSeq, action });
		},

		abort: async (chat: URI): Promise<void> => {
			const record = this._chats.get(chat.toString());
			if (!record) {
				return;
			}
			const action = { type: 'chat/turnCancelled', turnId: '' };
			this._transport?.notify('dispatchAction', { channel: record.chatChannel, clientSeq: ++this._clientSeq, action });
		},

		changeModel: async (chat: URI, model: ModelSelection): Promise<void> => {
			const record = this._chats.get(chat.toString());
			if (!record) {
				return;
			}
			const action = { type: 'session/configChanged', config: { model: model.id } };
			this._transport?.notify('dispatchAction', { channel: record.sessionChannel, clientSeq: ++this._clientSeq, action });
		},

		changeAgent: async (): Promise<void> => {
			// manox has no selectable custom agents.
		},

		getMessages: async (chat: URI): Promise<readonly Turn[]> => {
			const record = this._chats.get(chat.toString());
			if (!record) {
				return [];
			}
			// `subscribe` answers with the folded `ChatState`, whose `turns` is
			// the full retained history. `fetchTurns` returns an empty result and
			// delivers turns as a separate `chat/turnsLoaded` action, which does
			// not fit this synchronous return contract.
			const snapshot = await this._transport?.request('subscribe', { channel: record.chatChannel }) as {
				snapshot?: { state?: { turns?: readonly Turn[] } };
			};
			return snapshot?.snapshot?.state?.turns ?? [];
		},
	};

	// ---- Materialization ----------------------------------------------------

	async materializeChat(chat: URI, context: URI | IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult | void> {
		const sessionId = providerData ?? generateUuid();
		const sessionUri = resolveAgentChatContext(context, chat).configurationResource;
		this._chats.set(chat.toString(), this._record(sessionId, chat, sessionUri));
		await this._ensureReady();
		this._transport?.request('subscribe', { channel: `ahp-chat:/${sessionId}` }).catch(() => undefined);
		return { providerData: sessionId };
	}

	// ---- Active clients -----------------------------------------------------

	getOrCreateActiveClient(): IActiveClient {
		return { clientId: this._clientId, displayName: undefined, tools: [], customizations: [] };
	}

	removeActiveClient(): void {
		// The host manages membership; manox has no per-client contribution to drop.
	}

	onClientToolCallComplete(): void {
		// manox tool calls are client-observed, not client-executed.
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		// `chat/toolCallConfirmed` requires the owning `turnId` and carries the
		// authId in `_meta` — the gateway settles by that id, not by the wire
		// `toolCallId`.
		const turnId = this._toolCallTurns.get(requestId) ?? '';
		for (const record of this._chats.values()) {
			const action = {
				type: 'chat/toolCallConfirmed',
				turnId,
				toolCallId: requestId,
				approved,
				_meta: { 'x-manox': { authId: requestId } },
			};
			this._transport?.notify('dispatchAction', { channel: record.chatChannel, clientSeq: ++this._clientSeq, action });
		}
	}

	respondToUserInputRequest(requestId: string, response: string, answers?: Record<string, unknown>): void {
		for (const record of this._chats.values()) {
			// `chat/inputCompleted` requires both the request id and the
			// completion outcome; `answers` is optional.
			const action = { type: 'chat/inputCompleted', requestId, response, answers: answers ?? undefined };
			this._transport?.notify('dispatchAction', { channel: record.chatChannel, clientSeq: ++this._clientSeq, action });
		}
	}

	// ---- Configuration ------------------------------------------------------

	async resolveChatConfig(_params: IAgentResolveChatConfigParams): Promise<ResolveSessionConfigResult> {
		return { schema: { type: 'object', properties: {} }, values: {} };
	}

	getInheritedChatConfig(): Record<string, unknown> | undefined {
		return undefined;
	}

	async chatConfigCompletions(): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async getChatCustomizations(): Promise<readonly Customization[]> {
		return [];
	}

	// ---- Discovery and metadata --------------------------------------------

	async startChatDiscovery(): Promise<void> {
		if (this._chatDiscoveryStarted) {
			return;
		}
		this._chatDiscoveryStarted = true;
		await this._discoverChats();
	}

	private async _discoverChats(): Promise<void> {
		const transport = this._ensureConnected();
		await this._ready;
		const result = await transport.request('listSessions', { channel: 'ahp-root://' }) as {
			items?: readonly { resource?: string; title?: string; modifiedAt?: string; project?: { uri?: string; displayName?: string } }[];
		};
		const now = Date.now();
		const discovered: IAgentDiscoveredChat[] = [];
		for (const item of result.items ?? []) {
			if (!item.resource) {
				continue;
			}
			// `item.resource` is manox's own `ahp-session:/<id>`; the host's chat
			// URI derives from the provider-scoped session URI (`manox:/<id>`).
			const sessionId = AgentSession.id(item.resource);
			const sessionUri = AgentSession.uri(this.id, sessionId);
			const modifiedTime = item.modifiedAt ? Date.parse(item.modifiedAt) : now;
			discovered.push({
				chat: URI.parse(buildDefaultChatUri(sessionUri.toString())),
				startTime: modifiedTime,
				modifiedTime,
				summary: item.title,
				// The project groups a session under its worktree; without it the
				// host parks the thread under "unknown".
				project: item.project?.uri
					? { uri: URI.parse(item.project.uri), displayName: item.project.displayName ?? item.project.uri }
					: undefined,
				external: true,
			});
		}
		this._onDidDiscoverChats.fire(discovered);
	}

	setKnownSessionsFilter(_filter: IAgentKnownSessionsFilter): void {
		// manox has no filterable discovery backend.
	}

	async getChatMetadata(chat: URI, _context: URI | IAgentChatContext, providerData?: string): Promise<IAgentChatMetadata | undefined> {
		const record = this._chats.get(chat.toString());
		if (record) {
			return { chat, startTime: record.startTime, modifiedTime: record.modifiedTime };
		}
		// A restore asks for metadata before `materializeChat` runs, so fall back
		// to the manox catalog keyed by the persisted provider data.
		const sessionId = providerData;
		if (!sessionId) {
			return undefined;
		}
		await this._ensureReady();
		const transport = this._transport!;
		const result = await transport.request('listSessions', { channel: 'ahp-root://' }) as {
			items?: readonly { resource?: string; title?: string; modifiedAt?: string; project?: { uri?: string; displayName?: string } }[];
		};
		const item = (result.items ?? []).find(i => i.resource === `ahp-session:/${sessionId}`);
		if (!item) {
			return undefined;
		}
		const modifiedTime = item.modifiedAt ? Date.parse(item.modifiedAt) : Date.now();
		return {
			chat,
			startTime: modifiedTime,
			modifiedTime,
			summary: item.title,
			project: item.project?.uri
				? { uri: URI.parse(item.project.uri), displayName: item.project.displayName ?? item.project.uri }
				: undefined,
		};
	}

	async listChatsToMigrate(): Promise<AgentChatMigrationResult> {
		return [];
	}

	// ---- Auth and diagnostics ----------------------------------------------

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	async authenticate(): Promise<boolean> {
		return false;
	}

	getTelemetryContext(): IAgentTelemetryContext {
		return { copilotSku: undefined };
	}

	getTurnTokenUsage(): IAgentTurnTokenUsage | undefined {
		return undefined;
	}

	async setWorkingDirectory(): Promise<void> {
		// manox does not support changing a chat's working directory after creation.
	}

	async shutdown(): Promise<void> {
		this._transport?.dispose();
		this._transport = undefined;
	}
}
