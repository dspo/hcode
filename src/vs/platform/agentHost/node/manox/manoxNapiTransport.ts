/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { join } from '../../../../base/common/path.js';
import { createRequire } from 'node:module';

/**
 * Typed bridge over the manox napi addon (`crates/manox-napi` in the manox
 * repo): the agent core runs in-process on its own tokio runtime and
 * `FromServer` frames arrive as JSON strings through a threadsafe callback.
 *
 * Only the wire vocabulary the harness consumes is typed here; the Rust side
 * is envelope-generic (unknown frames are logged and dropped, never fatal),
 * so a protocol bump degrades to missing features instead of a crash.
 *
 * Casing traps (verified against manox-protocol at PROTOCOL_EPOCH 6): the
 * typed enums (journal events, server calls, host events) are serde
 * camelCase, but hand-written `json!()` payloads are snake_case —
 * createSession/forkSession answer `{session_id}`, submit/steer receipts
 * `{accepted, message_id}`, pageHistory `{records, has_more, cursor}`,
 * ThreadListItem/ModelInfo fields, ClientToolSpec (`input_schema`,
 * `read_only`) and the commands list are snake_case, and the
 * `metrics` token-usage data is snake_case bare serde. Only
 * `getConversationInfo` and the assistant-message `usage` payload are
 * hand-written camelCase.
 *
 * Stable error codes in `Err.data.code`: session/not-found,
 * session/already-owned (another process holds this session's write lease —
 * e.g. the manox desktop app has the session open; retry or open it there),
 * gateway/bad-request, gateway/internal, resync-required, model/unresolvable,
 * feature/unavailable, protocol/unsupported-epoch, client/reseated.
 */

/** Loaded from `VSCODE_AGENT_HOST_MANOX_SDK_ROOT` (dir or .node file path). */
export function resolveManoxAddonPath(sdkRoot: string | undefined): string | undefined {
	if (!sdkRoot) {
		return undefined;
	}
	const candidates = sdkRoot.endsWith('.node') ? [sdkRoot] : [join(sdkRoot, 'manox_napi.node'), join(sdkRoot, 'libmanox_napi.dylib')];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

export function isManoxAddonAvailable(sdkRoot: string | undefined): boolean {
	return resolveManoxAddonPath(sdkRoot) !== undefined;
}

interface IManoxNapiBinding {
	ping(): string;
	start(clientId: string, callback: (err: Error | null, event: string) => void): void;
	sendCommand(command: string): void;
	shutdown(): void;
}

// ---- Wire shapes (subset of manox-protocol, camelCase per serde) ------------

export interface IManoxRpcError {
	readonly code: number;
	readonly message: string;
	readonly data?: { readonly code?: string };
}

export type ManoxOutcome = { readonly Ok?: unknown } | { readonly Err?: IManoxRpcError };

/** `ServerCall`: the server asks the client to adjudicate or provide data. */
export interface IManoxServerCall {
	readonly method: 'approve' | 'planVerdict' | 'askUserQuestion' | 'browserOp' | 'clipboardRead' | 'openExternal' | 'invokeClientTool';
	readonly deliveryId?: string;
	readonly sessionId?: string;
	readonly authId?: string;
	readonly toolName?: string;
	readonly summary?: string;
	readonly input?: unknown;
	readonly planFile?: string;
	readonly title?: string;
	/** planVerdict: the plan markdown; null when the server failed to read the file. */
	readonly content?: string | null;
	/** openExternal: the URL to open. */
	readonly url?: string;
	/** invokeClientTool: routed only to the client that registered the tool. */
	readonly clientId?: string;
	readonly toolCallId?: string;
	/** invokeClientTool: the registered (original) tool name. */
	readonly name?: string;
}

/** `ThreadListItem` (snake_case on the wire; manox-protocol wire.rs). */
export interface IManoxThreadListItem {
	readonly id: string;
	readonly title: string;
	/** Unix seconds of the last human prompt or steer. */
	readonly updated_at: number;
	readonly running: boolean;
	/** Deprecated on the wire: always false; derive from SessionStatus deltas. */
	readonly unread: boolean;
	readonly errored: boolean;
	readonly pending_auth: boolean;
	readonly pending_plan: boolean;
	readonly background_work: boolean;
	readonly model_id: string;
	readonly pinned: boolean;
	readonly archived: boolean;
	readonly parent_id: string | null;
	readonly depth: number;
	readonly project?: string;
	readonly tag?: string;
	readonly approval_mode?: number;
}

/** One row of the commands list (snake_case; `argument_hint`/`i18n_key`). */
export interface IManoxCommandInfo {
	readonly name: string;
	readonly description: string | null;
	readonly kind: 'command' | 'skill';
	readonly argument_hint?: string | null;
	/** Builtins only: localization key for the description. */
	readonly i18n_key?: string;
}

export interface IManoxTerminalSummary {
	readonly id: string;
	readonly title?: string | null;
	readonly lifecycle: 'running' | 'exited';
	readonly exitCode?: number | null;
}

/** Image attachment on submit/steer (base64 bytes + mime). */
export interface IManoxImageAttachment {
	readonly data: string;
	readonly mimeType: string;
}

/** Client-contributed session tool registration (snake_case schema fields). */
export interface IManoxClientToolSpec {
	readonly name: string;
	readonly description: string;
	readonly input_schema: unknown;
	readonly read_only?: boolean;
}

/** `getConversationInfo` response (hand-written camelCase). */
export interface IManoxConversationInfo {
	readonly threadId: string;
	readonly cursor: number;
	readonly title: string | null;
	readonly cwd: string;
	readonly project: string | null;
	readonly model: string | null;
	readonly contextWindow: number | null;
	readonly turns: number;
	readonly messages: number;
}

/** `HostEvent`: global change-driven broadcasts (manox spec D.5). */
export type ManoxHostEvent =
	| { readonly type: 'ready'; readonly epoch: number }
	| { readonly type: 'models'; readonly models: readonly IManoxModelInfo[] }
	| { readonly type: 'commands'; readonly commands: readonly IManoxCommandInfo[] }
	| { readonly type: 'threadsUpdated'; readonly threads: readonly IManoxThreadListItem[] }
	| { readonly type: 'sessionStatus'; readonly sessionId: string; readonly running?: boolean | null; readonly errored?: boolean | null; readonly unread?: boolean | null; readonly pendingAuth?: boolean | null; readonly pendingPlan?: boolean | null; readonly backgroundWork?: boolean | null }
	| { readonly type: 'sessionCreated'; readonly sessionId: string; readonly header?: { readonly id: string; readonly cwd: string; readonly parentSession?: string | null; readonly metadata?: unknown; readonly createdAt: string } }
	| { readonly type: 'sessionDisposed'; readonly sessionId: string }
	| { readonly type: 'error'; readonly message: string; readonly sessionId?: string | null }
	| { readonly type: 'projects'; readonly known: readonly string[] }
	| { readonly type: 'terminalsUpdated'; readonly terminals: readonly IManoxTerminalSummary[] };

export interface IManoxModelInfo {
	readonly id: string;
	readonly name: string;
	readonly provider: string;
	readonly providerName?: string;
	readonly api: string;
	readonly contextWindow: number;
	readonly maxTokens?: number;
}

/** `toolCall.status` vocabulary (kebab-case on the wire). */
export type ManoxToolCallStatus = 'pending-approval' | 'running' | 'success' | 'continued' | 'error' | 'denied' | 'cancelled';

/** Assistant-message usage payload (hand-written camelCase). */
export interface IManoxMessageUsage {
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly reasoning?: number;
}

/** `metrics{kind:'token_usage'}` data (snake_case bare serde; zero-fields omitted). */
export interface IManoxTokenUsageData {
	readonly input_tokens?: number;
	readonly output_tokens?: number;
	readonly cache_creation_input_tokens?: number;
	readonly cache_read_input_tokens?: number;
}

/** `planUpdate.snapshot` (kernel PlanSnapshot; step status snake_case). */
export interface IManoxPlanSnapshot {
	readonly explanation: string | null;
	readonly steps: readonly { readonly step: string; readonly status: 'pending' | 'in_progress' | 'completed' }[];
}

/** `JournalWireEvent`, tagged `type` (manox spec C.2 vocabulary). Fields are camelCase. */
export type ManoxJournalEvent =
	| { readonly type: 'message'; readonly role: string; readonly content: readonly unknown[]; readonly usage?: IManoxMessageUsage; readonly originRpc?: string | null; readonly display?: boolean }
	| { readonly type: 'uiNote'; readonly kind: string; readonly data: unknown }
	| { readonly type: 'custom'; readonly customType: string; readonly data: unknown }
	| { readonly type: 'customMessage'; readonly customType: string; readonly content: readonly unknown[]; readonly display: boolean }
	| { readonly type: 'turnStart' }
	| { readonly type: 'turnFinish'; readonly cancelled: boolean; readonly failed: boolean; readonly strandedSteerIds: readonly string[] }
	| { readonly type: 'stop'; readonly reason?: string | null }
	| { readonly type: 'retry'; readonly attempt: number; readonly maxAttempts: number; readonly delaySecs: number; readonly reason: string }
	| { readonly type: 'error'; readonly message: string }
	| { readonly type: 'agentTextDelta'; readonly s: string }
	| { readonly type: 'agentThinkingDelta'; readonly s: string }
	| { readonly type: 'toolCall'; readonly callId: string; readonly name: string; readonly title: string; readonly status: ManoxToolCallStatus; readonly input: unknown }
	| { readonly type: 'toolResult'; readonly callId: string; readonly output: string; readonly isError: boolean }
	| { readonly type: 'toolOutputChunk'; readonly callId: string; readonly chunk: string }
	| { readonly type: 'subagentChild'; readonly agentId: string; readonly event: unknown }
	| { readonly type: 'subagentProgress'; readonly agentId: string; readonly agentType: string; readonly toolUses: number; readonly latestActivity?: string; readonly status: string }
	| { readonly type: 'modelChange'; readonly from?: string | null; readonly to: string }
	| { readonly type: 'cwdChange'; readonly path: string }
	| { readonly type: 'permissionModeChange'; readonly mode: string }
	| { readonly type: 'reasoningEffortChange'; readonly effort: string }
	| { readonly type: 'planModeChange'; readonly enabled: boolean }
	| { readonly type: 'title'; readonly title: string }
	| { readonly type: 'approval'; readonly kind: 'request' | 'decision'; readonly authId: string; readonly toolName?: string | null; readonly toolCallId?: string | null; readonly verdict?: 'allow_once' | 'deny' | 'answered' | 'expired' | 'cancelled' | null; readonly reason?: string | null }
	| { readonly type: 'pinnedArchived'; readonly pinned: boolean; readonly archived: boolean }
	| { readonly type: 'compaction'; readonly summary: string; readonly messagesCompacted: number; readonly tokensBefore: number; readonly retainedTail: readonly string[]; readonly firstKeptEntryId?: string | null }
	| { readonly type: 'compactionStarted'; readonly tokensBefore: number }
	| { readonly type: 'metrics'; readonly kind: 'token_usage' | 'prefix_stability' | 'cache_invalidation' | 'side_call' | 'main_call'; readonly data: IManoxTokenUsageData | unknown }
	| { readonly type: 'sessionInfo'; readonly data: unknown }
	| { readonly type: 'leaf'; readonly targetId: string }
	| { readonly type: 'goal'; readonly goal?: unknown }
	| { readonly type: 'branchSummary'; readonly text: string }
	| { readonly type: 'label'; readonly label: string }
	| { readonly type: 'planReview'; readonly state: 'proposed' | 'resolved'; readonly planFile?: string | null }
	| { readonly type: 'planUpdate'; readonly snapshot: IManoxPlanSnapshot }
	| { readonly type: 'browserSuites'; readonly suites: readonly string[] }
	| { readonly type: 'backgroundTask'; readonly snapshot: unknown }
	| { readonly type: 'activeToolsChange'; readonly tools: readonly string[] }
	| { readonly type: 'projectChange'; readonly path?: string | null };

/** `JournalWireEntry`: event flattened into the chain envelope (manox spec C.1). */
export type ManoxJournalEntry = ManoxJournalEvent & {
	readonly seq: number;
	readonly id: string;
	readonly parentId?: string | null;
	readonly timestamp: string;
};

export interface IManoxSessionSnapshot {
	readonly sessionId: string;
	readonly header: { readonly id: string; readonly cwd: string; readonly createdAt: string };
	readonly cursor: number;
	readonly records: readonly ManoxJournalEntry[];
	readonly hasMore: boolean;
	readonly projections: Readonly<Record<string, unknown>>;
	readonly projectionsAsOfSeq: number;
}

export type ManoxStreamFrame =
	| ({ readonly type: 'snapshot' } & IManoxSessionSnapshot)
	| { readonly type: 'entry'; readonly seq: number; readonly id: string; readonly parentId?: string | null; readonly timestamp: string; readonly event: ManoxJournalEvent }
	| { readonly type: 'projections'; readonly sessionId: string; readonly asOfSeq: number; readonly values: Readonly<Record<string, unknown>> }
	| { readonly type: 'terminalOutput'; readonly data: string };

export type ManoxFromServer =
	| { readonly kind: 'response'; readonly id: string; readonly outcome: ManoxOutcome }
	| { readonly kind: 'request'; readonly id: string; readonly call: IManoxServerCall }
	| { readonly kind: 'notification'; readonly note: { readonly method: string } & Record<string, unknown> }
	| { readonly kind: 'host'; readonly host: ManoxHostEvent }
	| { readonly kind: 'streamItem'; readonly streamId: string; readonly frame: ManoxStreamFrame }
	| { readonly kind: 'streamEnd'; readonly streamId: string; readonly reason: { readonly type: 'closed' } | { readonly type: 'cancelled' } | { readonly type: 'resync' } | { readonly type: 'failure'; readonly code: string; readonly message: string } };

const FROM_SERVER_KINDS = new Set(['response', 'request', 'notification', 'host', 'streamItem', 'streamEnd']);

function parseFromServer(raw: string): ManoxFromServer | undefined {
	try {
		const value = JSON.parse(raw) as { kind?: unknown };
		if (typeof value === 'object' && value !== null && typeof value.kind === 'string' && FROM_SERVER_KINDS.has(value.kind)) {
			return value as ManoxFromServer;
		}
	} catch {
		// fall through
	}
	return undefined;
}

export class ManoxNapiTransport {
	private readonly _pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
	private _reqCounter = 0;
	private _disposed = false;

	private constructor(
		private readonly _binding: IManoxNapiBinding,
		private readonly _onEvent: (event: ManoxFromServer) => void,
		private readonly _onDisconnect: (err: Error) => void,
	) { }

	/**
	 * Loads the addon from `sdkRoot` and starts the in-process connection.
	 * The Rust side performs the Initialize handshake inside `start()`.
	 */
	static load(sdkRoot: string, onEvent: (event: ManoxFromServer) => void, onDisconnect: (err: Error) => void): ManoxNapiTransport {
		const addonPath = resolveManoxAddonPath(sdkRoot);
		if (!addonPath) {
			throw new Error(`manox addon not found under '${sdkRoot}' (expected manox_napi.node)`);
		}
		const binding = createRequire(import.meta.url)(addonPath) as IManoxNapiBinding;
		const transport = new ManoxNapiTransport(binding, onEvent, onDisconnect);
		binding.start('vscode', (err, raw) => {
			if (err) {
				transport._onDisconnect(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			const event = parseFromServer(raw);
			if (!event) {
				// Version skew: a frame this host cannot describe. Log + drop.
				return;
			}
			transport._handleEvent(event);
		});
		return transport;
	}

	private _handleEvent(event: ManoxFromServer): void {
		if (event.kind === 'response') {
			const pending = this._pending.get(event.id);
			if (pending) {
				this._pending.delete(event.id);
				// serde's default Result encoding is externally tagged `Ok`/`Err`.
				const outcome = event.outcome as { Ok?: unknown; Err?: IManoxRpcError };
				if (outcome.Err !== undefined && outcome.Err !== null) {
					pending.reject(new Error(`manox ${event.id}: [${outcome.Err.code}] ${outcome.Err.message}`));
				} else {
					pending.resolve(outcome.Ok);
				}
			}
			return;
		}
		this._onEvent(event);
	}

	/** Fire-and-forget client note (e.g. `cancelTurn`, `disposeSession`). */
	sendNote(note: Record<string, unknown>): void {
		this._sendJson({ kind: 'notification', note });
	}

	/** Correlated request; rejects on error outcome or unanswered dispose. */
	async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		const id = `vscode-req-${++this._reqCounter}`;
		const promise = new Promise<unknown>((resolve, reject) => {
			this._pending.set(id, { resolve, reject });
		});
		this._sendJson({ kind: 'request', id, call: { method, ...params } });
		return promise;
	}

	/** Open a follow stream (`FromClient::StreamOpen`). */
	openStream(streamId: string, sessionId: string, maxMessages?: number): void {
		this._sendJson({ kind: 'streamOpen', streamId, streamKind: { type: 'followSession', sessionId, maxMessages: maxMessages ?? null } });
	}

	// ---- Typed client calls (spec D.2) (see the casing traps in the header) ------------

	/** Fork a session's active chain at an entry; answers `{session_id}`. */
	forkSession(params: { sourceSessionId: string; throughEntryId: string; cwd?: string | null; project?: string | null; initialModel?: string | null; approvalMode?: string | null; reasoningEffort?: string | null }): Promise<{ session_id: string }> {
		return this.call('forkSession', params as unknown as Record<string, unknown>) as Promise<{ session_id: string }>;
	}

	/** Steer the running turn (a no-turn steer degrades to a submit server-side,
	 * so only send this while a turn is active); answers `{accepted, message_id}`. */
	steer(params: { sessionId: string; messageId: string; text: string; images: readonly IManoxImageAttachment[] }): Promise<{ accepted: boolean; message_id?: string }> {
		return this.call('steer', params as unknown as Record<string, unknown>) as Promise<{ accepted: boolean; message_id?: string }>;
	}

	/** Cold journal page-read (never activates the engine). */
	pageHistory(params: { sessionId: string; throughSeq?: number; beforeSeq?: number | null; maxMessages?: number | null }): Promise<{ records: readonly ManoxJournalEntry[]; has_more: boolean; cursor: number }> {
		return this.call('pageHistory', params as unknown as Record<string, unknown>) as Promise<{ records: readonly ManoxJournalEntry[]; has_more: boolean; cursor: number }>;
	}

	getConversationInfo(sessionId: string): Promise<IManoxConversationInfo> {
		return this.call('getConversationInfo', { sessionId }) as Promise<IManoxConversationInfo>;
	}

	/** Bare snake_case array of session rows. */
	listThreads(): Promise<readonly IManoxThreadListItem[]> {
		return this.call('listThreads', {}) as Promise<readonly IManoxThreadListItem[]>;
	}

	listCommands(): Promise<readonly IManoxCommandInfo[]> {
		return this.call('listCommands', {}) as Promise<readonly IManoxCommandInfo[]>;
	}

	/** Full-replace registration of one client's contributed tools. */
	registerSessionTools(params: { sessionId: string; clientId: string; tools: readonly IManoxClientToolSpec[] }): Promise<{ registered: number }> {
		return this.call('registerSessionTools', params as unknown as Record<string, unknown>) as Promise<{ registered: number }>;
	}

	/** Withdraw a pending adjudication delivery (user navigated away). */
	cancelDelivery(deliveryId: string): Promise<unknown> {
		return this.call('cancelDelivery', { deliveryId });
	}

	// ---- Typed notes --------------------------------------------------------

	setApprovalMode(sessionId: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access'): void {
		this.sendNote({ method: 'setApprovalMode', sessionId, mode });
	}

	setReasoningEffort(sessionId: string, effort: 'high' | 'max'): void {
		this.sendNote({ method: 'setReasoningEffort', sessionId, effort });
	}

	archiveThread(sessionId: string, archived: boolean): void {
		this.sendNote({ method: 'archiveThread', sessionId, archived });
	}

	pinThread(sessionId: string, pinned: boolean): void {
		this.sendNote({ method: 'pinThread', sessionId, pinned });
	}

	dropQueued(sessionId: string, clientId: string): void {
		this.sendNote({ method: 'dropQueued', sessionId, clientId });
	}

	detachSession(sessionId: string): void {
		this.sendNote({ method: 'detachSession', sessionId });
	}

	compact(sessionId: string, instructions: string | null): void {
		this.sendNote({ method: 'compact', sessionId, instructions });
	}

	planSeedExecution(sessionId: string, planFile: string): void {
		this.sendNote({ method: 'planSeedExecution', sessionId, planFile });
	}

	/** Answer a `FromServer::Request` server call. The reply payload rides the
	 * same externally tagged `Ok`/`Err` encoding as responses. */
	reply(id: string, payload: Record<string, unknown> | null): void {
		this._sendJson({ kind: 'reply', id, outcome: { Ok: payload } });
	}

	replyError(id: string, message: string): void {
		this._sendJson({ kind: 'reply', id, outcome: { Err: { code: -1, message } } });
	}

	private _sendJson(message: Record<string, unknown>): void {
		if (this._disposed) {
			throw new Error('manox transport is disposed');
		}
		this._binding.sendCommand(JSON.stringify(message));
	}

	async dispose(): Promise<void> {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const pending of this._pending.values()) {
			pending.reject(new Error('manox transport disposed'));
		}
		this._pending.clear();
		this._binding.shutdown();
	}
}
