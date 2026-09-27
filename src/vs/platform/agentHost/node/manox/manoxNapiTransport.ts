/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../base/common/path.js';
import { createRequire } from 'node:module';

/**
 * Typed bridge over the manox napi addon (`crates/manox-napi` in the manox
 * repo): a raw AHP transport bridge. The agent core runs in-process on its own
 * tokio runtime and exposes one end of an in-process AHP connection; complete
 * JSON-RPC 2.0 messages move across it in both directions.
 *
 * Nothing here interprets a message. Channels, subscriptions, request
 * correlation and the AHP action stream all belong to the caller — the binding
 * only hands a JSON string to `sendCommand` and hands back one JSON string per
 * host→client message through the `start` callback.
 */

/** The napi-rs addon surface (`crates/manox-napi/src/lib.rs`). */
export interface IManoxNapiBinding {
	ping(): string;
	start(clientId: string, callback: (err: Error | null, event: string) => void): void;
	sendCommand(command: string): void;
	shutdown(): void;
}

/** JSON-RPC 2.0 request/response/notification, the AHP wire envelope. */
export interface IJsonRpcMessage {
	jsonrpc: '2.0';
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** The AHP server→client action notification payload. */
export interface IActionEnvelope {
	channel: string;
	action: unknown;
	server_seq: number;
	origin?: unknown;
	rejection_reason?: string;
}

/** Environment variable naming the SDK root (a directory or a `.node` path). */
export const MANOX_SDK_ROOT_ENV = 'VSCODE_AGENT_HOST_MANOX_SDK_ROOT';

/** Loaded from `sdkRoot` (a directory holding `manox_napi.node`, or the file itself). */
export function resolveManoxAddonPath(sdkRoot: string | undefined): string | undefined {
	if (!sdkRoot) {
		return undefined;
	}
	const candidates = sdkRoot.endsWith('.node')
		? [sdkRoot]
		: [join(sdkRoot, 'manox_napi.node'), join(sdkRoot, 'libmanox_napi.dylib')];
	return candidates.find(candidate => fs.existsSync(candidate));
}

export function isManoxAddonAvailable(sdkRoot: string | undefined): boolean {
	return resolveManoxAddonPath(sdkRoot) !== undefined;
}

/**
 * Addon locations used when the env var is unset: the in-repo staged artifact,
 * then the local manox worktree build.
 */
export function resolveDefaultManoxSdkRoot(appRoot: string | undefined): string | undefined {
	const candidates = [
		appRoot ? join(appRoot, '.build', 'manox', 'napi') : undefined,
		join(os.homedir(), 'projects', 'dspo', 'manox--ahp-host', 'target', 'napi'),
	];
	return candidates.find(candidate => candidate !== undefined && isManoxAddonAvailable(candidate));
}

/**
 * One in-process AHP connection to the embedded manox host. Owns request
 * correlation; the caller supplies the protocol logic (initialize, subscribe,
 * dispatch) and receives notifications through {@link onNotification}.
 */
export class ManoxNapiTransport {
	private readonly _pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
	private _reqCounter = 0;
	private _disposed = false;
	private readonly _onNotificationHandlers = new Set<(method: string, params: unknown) => void>();
	private _onRequestHandler: ((method: string, params: unknown) => Promise<unknown>) | undefined;

	private constructor(
		private readonly _binding: IManoxNapiBinding,
	) { }

	/**
	 * Load the addon from `sdkRoot` and start the in-process connection.
	 * `start` only boots the runtime and connects the transport — the AHP
	 * handshake (`initialize`) is the caller's next step.
	 */
	static load(sdkRoot: string): ManoxNapiTransport {
		const addonPath = resolveManoxAddonPath(sdkRoot);
		if (!addonPath) {
			throw new Error(`manox addon not found under '${sdkRoot}' (expected manox_napi.node)`);
		}
		const binding = createRequire(import.meta.url)(addonPath) as IManoxNapiBinding;
		const transport = new ManoxNapiTransport(binding);
		binding.start('vscode', (err, raw) => {
			if (err) {
				transport._failAll(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			transport._dispatch(raw);
		});
		return transport;
	}

	/** Send one AHP request and correlate its response by id. */
	request(method: string, params: unknown): Promise<unknown> {
		if (this._disposed) {
			return Promise.reject(new Error('manox transport disposed'));
		}
		const id = ++this._reqCounter;
		return new Promise<unknown>((resolve, reject) => {
			this._pending.set(id, { resolve, reject });
			const message: IJsonRpcMessage = { jsonrpc: '2.0', id, method, params };
			try {
				this._binding.sendCommand(JSON.stringify(message));
			} catch (err) {
				this._pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/** Send a fire-and-forget AHP notification (e.g. `dispatchAction`). */
	notify(method: string, params: unknown): void {
		if (this._disposed) {
			return;
		}
		const message: IJsonRpcMessage = { jsonrpc: '2.0', method, params };
		this._binding.sendCommand(JSON.stringify(message));
	}

	/** Subscribe to server→client notifications (the `action` stream). */
	onNotification(handler: (method: string, params: unknown) => void): void {
		this._onNotificationHandlers.add(handler);
	}

	/** Handle a server→client request (e.g. `x-manox/openExternal`). */
	onRequest(handler: (method: string, params: unknown) => Promise<unknown>): void {
		this._onRequestHandler = handler;
	}

	/** Close the connection and release the addon's event callback. */
	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._binding.shutdown();
		this._failAll(new Error('manox transport disposed'));
	}

	private _dispatch(raw: string): void {
		let message: IJsonRpcMessage;
		try {
			message = JSON.parse(raw) as IJsonRpcMessage;
		} catch {
			return; // An unparseable frame has no id and no method — nothing to answer.
		}
		if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
			const pending = this._pending.get(message.id);
			if (pending) {
				this._pending.delete(message.id);
				if (message.error !== undefined) {
					pending.reject(new Error(`${message.error.message} (${message.error.code})`));
				} else {
					pending.resolve(message.result);
				}
			}
			return;
		}
		if (message.id !== undefined && message.method !== undefined) {
			// A server→client request: answer it (or fail it) rather than
			// treating it as a notification.
			void this._handleRequest(message.id, message.method, message.params);
			return;
		}
		if (message.method !== undefined) {
			for (const handler of this._onNotificationHandlers) {
				handler(message.method, message.params);
			}
		}
	}

	private _handleRequest(id: number, method: string, params: unknown): void {
		if (!this._onRequestHandler) {
			this._sendError(id, -32601, `no handler for ${method}`);
			return;
		}
		Promise.resolve()
			.then(() => this._onRequestHandler!(method, params))
			.then(
				result => this._sendResponse(id, result),
				err => this._sendError(id, -32000, err instanceof Error ? err.message : String(err)),
			);
	}

	private _sendResponse(id: number, result: unknown): void {
		this._binding.sendCommand(JSON.stringify({ jsonrpc: '2.0', id, result }));
	}

	private _sendError(id: number, code: number, message: string): void {
		this._binding.sendCommand(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
	}

	private _failAll(err: Error): void {
		for (const [, pending] of this._pending) {
			pending.reject(err);
		}
		this._pending.clear();
	}
}
