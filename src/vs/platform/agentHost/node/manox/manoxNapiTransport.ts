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
	readonly method: 'approve' | 'planVerdict' | 'askUserQuestion' | 'browserOp' | 'clipboardRead' | 'openExternal';
	readonly deliveryId?: string;
	readonly sessionId?: string;
	readonly authId?: string;
	readonly toolName?: string;
	readonly summary?: string;
	readonly input?: unknown;
	readonly planFile?: string;
	readonly title?: string;
}

/** `HostEvent`: global change-driven broadcasts (manox spec D.5). */
export type ManoxHostEvent =
	| { readonly type: 'ready'; readonly epoch: number }
	| { readonly type: 'models'; readonly models: readonly IManoxModelInfo[] }
	| { readonly type: 'commands'; readonly commands: unknown }
	| { readonly type: 'threadsUpdated'; readonly threads: readonly unknown[] }
	| { readonly type: 'sessionStatus'; readonly sessionId: string; readonly running?: boolean | null; readonly errored?: boolean | null; readonly unread?: boolean | null; readonly pendingAuth?: boolean | null; readonly pendingPlan?: boolean | null; readonly backgroundWork?: boolean | null }
	| { readonly type: 'sessionCreated'; readonly sessionId: string }
	| { readonly type: 'sessionDisposed'; readonly sessionId: string }
	| { readonly type: 'error'; readonly message: string; readonly sessionId?: string | null }
	| { readonly type: 'projects'; readonly known: readonly string[] };

export interface IManoxModelInfo {
	readonly id: string;
	readonly name: string;
	readonly provider: string;
	readonly providerName?: string;
	readonly api: string;
	readonly contextWindow: number;
	readonly maxTokens?: number;
}

/** `JournalWireEvent`, tagged `type` (manox spec C.2 vocabulary). Fields are camelCase. */
export type ManoxJournalEvent =
	| { readonly type: 'message'; readonly role: string; readonly content: readonly unknown[]; readonly usage?: unknown; readonly originRpc?: string | null }
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
	| { readonly type: 'toolCall'; readonly callId: string; readonly name: string; readonly title: string; readonly status: string; readonly input: unknown }
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
	| { readonly type: 'approval'; readonly kind: string; readonly authId: string; readonly toolName?: string | null; readonly toolCallId?: string | null; readonly verdict?: string | null; readonly reason?: string | null }
	| { readonly type: 'pinnedArchived'; readonly pinned: boolean; readonly archived: boolean }
	| { readonly type: 'compaction'; readonly summary: string }
	| { readonly type: 'compactionStarted'; readonly tokensBefore: number }
	| { readonly type: 'metrics'; readonly kind: string; readonly data: unknown }
	| { readonly type: 'sessionInfo'; readonly data: unknown }
	| { readonly type: 'leaf'; readonly targetId: string }
	| { readonly type: 'goal'; readonly goal?: unknown }
	| { readonly type: 'branchSummary'; readonly text: string }
	| { readonly type: 'label'; readonly label: string }
	| { readonly type: 'planReview'; readonly state: string; readonly planFile?: string | null }
	| { readonly type: 'planUpdate'; readonly snapshot: unknown }
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
	| { readonly type: 'projections'; readonly sessionId: string; readonly asOfSeq: number; readonly values: Readonly<Record<string, unknown>> };

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

	/** Answer a `FromServer::Request` server call. The reply payload rides the
	 * same externally tagged `Ok`/`Err` encoding as responses. */
	reply(id: string, payload: Record<string, unknown>): void {
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
