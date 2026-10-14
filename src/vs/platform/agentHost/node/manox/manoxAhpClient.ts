/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { join } from '../../../../base/common/path.js';
import { createRequire } from 'node:module';
import { Emitter } from '../../../../base/common/event.js';

/** Loaded from the addon location (dir or .node file path). */
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

/** One host→client action envelope (`action` notification, params shape). */
export interface IManoxActionEnvelope {
	readonly channel: string;
	readonly action: { readonly type: string } & Record<string, unknown>;
	readonly clientSeq?: number;
}

interface IManoxNapiBinding {
	ping(): string;
	start(clientId: string, callback: (err: Error | null, event: string) => void): void;
	sendCommand(command: string): void;
	shutdown(): void;
}

/**
 * Minimal AHP client over the manox napi addon. The addon is a raw transport:
 * it moves JSON-RPC text between the TypeScript host and manox's in-process
 * AHP runtime (protocol 0.9.0 — the same version this repo's registry
 * supports). Only the client machinery the harness needs is implemented:
 * initialize/subscribe, correlated requests, dispatchAction notifications and
 * an action-notification event; server-initiated requests are answered with
 * MethodNotFound unless a handler is installed.
 */
export class ManoxAhpClient {

	private readonly _binding: IManoxNapiBinding;
	private readonly _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private _reqCounter = 0;
	private _disposed = false;

	private readonly _onAction = new Emitter<IManoxActionEnvelope>();
	readonly onAction = this._onAction.event;
	private readonly _onRootNotification = new Emitter<{ method: string; params: Record<string, unknown> }>();
	readonly onRootNotification = this._onRootNotification.event;

	/** Initialized connection metadata (`_meta['x-manox']` included). */
	initialized: { protocolVersion: string; serverSeq: number; _meta?: Record<string, unknown> } | undefined;

	/** Root-snapshot agent catalog (one entry per configured provider; the
	 * model list is read straight out of the manox provider config). */
	private readonly _onDidRootAgents = new Emitter<readonly { provider: string; displayName?: string; models?: readonly { id: string; name?: string; maxContextWindow?: number; maxOutputTokens?: number }[] }[]>();
	readonly onDidRootAgents = this._onDidRootAgents.event;
	private _rootAgents: readonly { provider: string; displayName?: string; models?: readonly { id: string; name?: string; maxContextWindow?: number; maxOutputTokens?: number }[] }[] = [];
	get rootAgents() { return this._rootAgents; }

	constructor(addonPath: string) {
		this._binding = createRequire(import.meta.url)(addonPath) as IManoxNapiBinding;
	}

	private _connecting: Promise<void> | undefined;

	/** Start the runtime, run the initialize handshake and pump messages.
	 * Idempotent: concurrent and repeat calls await the first handshake. */
	connect(clientId: string): Promise<void> {
		this._connecting ??= this._connectOnce(clientId);
		return this._connecting;
	}

	private async _connectOnce(clientId: string): Promise<void> {
		await new Promise<void>((resolveHandshake, rejectHandshake) => {
			let handshakeSettled = false;
			this._binding.start(clientId, (err, raw) => {
				if (err) {
					const error = err instanceof Error ? err : new Error(String(err));
					if (!handshakeSettled) {
						handshakeSettled = true;
						rejectHandshake(error);
					}
					return;
				}
				let message: { jsonrpc?: string; id?: number | string; method?: string; result?: unknown; error?: { message: string }; params?: Record<string, unknown> } | undefined;
				try {
					message = JSON.parse(raw);
				} catch {
					return;
				}
				if (!message || message.jsonrpc !== '2.0') {
					return;
				}
				if (message.method !== undefined && message.id === undefined) {
					this._handleNotification(message.method, message.params ?? {});
				} else if (message.method !== undefined && message.id !== undefined) {
					// Server-initiated request: nothing in the harness answers
					// these yet; refuse so the server does not leak a pending.
					this._send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `no handler for server method "${message.method}"` } });
				} else if (message.id !== undefined) {
					const pending = this._pending.get(Number(message.id));
					if (pending) {
						this._pending.delete(Number(message.id));
						if (message.error) {
							pending.reject(new Error(`manox ${message.id}: ${message.error.message}`));
						} else {
							pending.resolve(message.result);
						}
					}
				}
				if (!handshakeSettled && this.initialized) {
					handshakeSettled = true;
					resolveHandshake();
				}
			});
			void this.request('initialize', {
				channel: 'ahp-root://',
				clientId,
				protocolVersions: ['0.9.0'],
				initialSubscriptions: ['ahp-root://'],
			}).then(result => {
				void this._refreshRootAgents();
				this.initialized = result as { protocolVersion: string; serverSeq: number; _meta?: Record<string, unknown> };
				if (!handshakeSettled) {
					handshakeSettled = true;
					resolveHandshake();
				}
			}, err => {
				if (!handshakeSettled) {
					handshakeSettled = true;
					rejectHandshake(err instanceof Error ? err : new Error(String(err)));
				}
			});
		});
	}

	private _rootSessions: readonly { id?: string; title?: string; modifiedAt?: number }[] = [];
	get rootSessions() { return this._rootSessions; }

	/** Re-read the agent catalog and session list from the root snapshot. */
	async _refreshRootAgents(): Promise<void> {
		const subscribed = await this.request<{ snapshot?: { state?: { agents?: unknown; sessions?: unknown } } }>('subscribe', { channel: 'ahp-root://' });
		const state = subscribed?.snapshot?.state as { agents?: unknown; sessions?: unknown } | undefined;
		const agents = state?.agents as typeof this._rootAgents | undefined;
		if (Array.isArray(agents)) {
			this._rootAgents = agents;
			this._onDidRootAgents.fire(agents);
		}
		const sessions = state?.sessions as typeof this._rootSessions | undefined;
		if (Array.isArray(sessions)) {
			this._rootSessions = sessions;
		}
	}

	private _handleNotification(method: string, params: Record<string, unknown>): void {
		if (method === 'action') {
			this._onAction.fire({ channel: String(params.channel ?? ''), action: params.action as IManoxActionEnvelope['action'], clientSeq: params.clientSeq as number | undefined });
			return;
		}
		this._onRootNotification.fire({ method, params });
	}

	request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
		const id = ++this._reqCounter;
		const promise = new Promise<T>((resolve, reject) => {
			this._pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
		});
		this._send({ jsonrpc: '2.0', id, method, params });
		return promise;
	}

	/** Fire-and-forget client action onto a channel (clientSeq-correlated). */
	dispatch(channel: string, action: { type: string } & Record<string, unknown>): number {
		const clientSeq = ++this._reqCounter;
		this._send({ jsonrpc: '2.0', method: 'dispatchAction', params: { channel, clientSeq, action } });
		return clientSeq;
	}

	private _send(message: Record<string, unknown>): void {
		if (this._disposed) {
			throw new Error('manox AHP client disposed');
		}
		this._binding.sendCommand(JSON.stringify(message));
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const pending of this._pending.values()) {
			pending.reject(new Error('manox AHP client disposed'));
		}
		this._pending.clear();
		try {
			this._binding.shutdown();
		} catch {
			// Best-effort: the runtime may already be gone.
		}
	}
}
