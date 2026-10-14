/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { observableValue } from '../../../../base/common/observable.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentHostManoxHomeEnvVar, AgentHostManoxSdkRootEnvVar } from '../../common/agentService.js';
import { resolveAgentChatContext, type AgentProvider, type AgentSignal, type IAgent, type IAgentCapabilities, type IAgentChatMetadata, type IAgentChats, type IAgentCreateChatOptions, type IAgentCreateChatResult, type IAgentDescriptor, type IAgentDiscoveredChat, type IAgentHostCapabilities, type IAgentModelInfo } from '../../common/agent.js';
import type { ChatAction } from '../../common/state/protocol/channels-chat/actions.js';
import type { SessionAction } from '../../common/state/sessionActions.js';
import type { ChatInputAnswer, ChatInputResponseKind, ModelSelection, Turn } from '../../common/state/sessionState.js';
import type { ProtectedResourceMetadata } from '../../common/state/protocol/state.js';
import { ManoxAhpClient, resolveManoxAddonPath } from './manoxAhpClient.js';

const MANOX_AGENT_PROVIDER_ID: AgentProvider = 'manox';

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

	private _client: ManoxAhpClient | undefined;
	/** chat URI ↔ manox session channel (both directions). */
	private readonly _channelByChat = new Map<string, string>();
	private readonly _chatByChannel = new Map<string, string>();

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		try {
			this._ensureConnected();
		} catch (err) {
			this._logService.warn('[manox] eager connect failed; will retry on first use', err);
		}
	}

	getDescriptor(): IAgentDescriptor {
		const capabilities: IAgentCapabilities = {
			// The kernel grants every createSession working directory into the
			// sandbox fence; the primary cwd is fixed at creation.
			multipleWorkingDirectories: { immutablePrimary: true },
		};
		return {
			provider: this.id,
			displayName: localize('manoxAgent.displayName', "Manox"),
			description: localize('manoxAgent.description', "Manox coding agent"),
			capabilities,
		};
	}

	private _ensureConnected(): ManoxAhpClient {
		if (this._client) {
			return this._client;
		}
		const addonPath = resolveManoxAddonPath(process.env[AgentHostManoxSdkRootEnvVar]
			?? `${process.env['HOME'] ?? ''}/worktrees/manox/hcode-v0.3/target/napi`);
		if (!addonPath) {
			throw new Error(`manox addon not found (set ${AgentHostManoxSdkRootEnvVar})`);
		}
		// Multi-instance over one state root is manox's supported shape
		// (resource-granular locks); default to the desktop app's ~/.manox.
		process.env.MANOX_HOME = process.env[AgentHostManoxHomeEnvVar] ?? `${process.env['HOME'] ?? ''}/.manox`;
		const client = new ManoxAhpClient(addonPath);
		this._register(client.onAction(envelope => this._forwardAction(envelope)));
		void client.connect('vscode').then(() => {
			this._logService.info('[manox] AHP initialized', JSON.stringify(client.initialized?._meta?.['x-manox'])?.slice(0, 120));
		}, err => this._logService.warn('[manox] AHP initialize failed', err));
		this._client = client;
		return client;
	}

	/** Manox actions are AHP actions — forward verbatim onto the bound chat. */
	private _forwardAction(envelope: { channel: string; action: { type: string } & Record<string, unknown> }): void {
		const chatUri = this._chatByChannel.get(envelope.channel);
		if (!chatUri) {
			return;
		}
		this._onDidChatProgress.fire({
			kind: 'action',
			resource: URI.parse(chatUri),
			action: envelope.action as ChatAction | SessionAction,
		});
	}

	readonly chats: IAgentChats = {
		createChat: async (chat: URI, context: URI | import('../../common/agent.js').IAgentChatContext, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult> => {
			resolveAgentChatContext(context, chat);
			const client = this._ensureConnected();
			await client.connect('vscode');
			const workingDirectory = options?.workingDirectories?.[0];
			const channel = `ahp-session:/${generateUuid()}`;
			await client.request('createSession', {
				channel,
				activeClient: { clientId: 'vscode' },
				workingDirectories: options?.workingDirectories?.map(uri => uri.toString()) ?? (workingDirectory ? [workingDirectory.toString()] : []),
			});
			await client.request('subscribe', { channel });
			this._channelByChat.set(chat.toString(), channel);
			this._chatByChannel.set(channel, chat.toString());
			this._logService.info(`[manox] session ${channel} created for ${chat.toString()}`);
			return { resolvedWorkingDirectory: workingDirectory, providerData: channel };
		},

		disposeChat: async (chat: URI): Promise<void> => {
			const channel = this._channelByChat.get(chat.toString());
			if (channel) {
				this._channelByChat.delete(chat.toString());
				this._chatByChannel.delete(channel);
			}
		},

		releaseChat: async (chat: URI): Promise<void> => {
			this._channelByChat.delete(chat.toString());
		},

		sendMessage: async (chat: URI, prompt: string, _workingDirectoriesOrDirectory: readonly URI[] | URI | undefined, _attachments?: readonly unknown[], turnId?: string): Promise<void> => {
			const channel = this._channelByChat.get(chat.toString());
			if (!channel) {
				throw new Error(`[manox] no backing session for ${chat.toString()}`);
			}
			const resolvedTurn = turnId ?? `manox-turn-${generateUuid()}`;
			this._ensureConnected().dispatch(channel, {
				type: 'chat/turnStarted',
				turnId: resolvedTurn,
				startedAt: Date.now(),
				message: { text: prompt, origin: { kind: 'user' } },
			});
		},

		abort: async (chat: URI): Promise<void> => {
			const channel = this._channelByChat.get(chat.toString());
			if (channel) {
				this._ensureConnected().dispatch(channel, { type: 'chat/turnCancelled', turnId: null });
			}
		},

		changeModel: async (_chat: URI, _model: ModelSelection): Promise<void> => { },

		changeAgent: async (): Promise<void> => { },

		getMessages: async (_chat: URI): Promise<readonly Turn[]> => [],
	};

	// ---- Restore --------------------------------------------------------------

	async materializeChat(chat: URI, _context: URI | import('../../common/agent.js').IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult | void> {
		if (!providerData) {
			return;
		}
		const client = this._ensureConnected();
		await client.connect('vscode');
		await client.request('subscribe', { channel: providerData });
		this._channelByChat.set(chat.toString(), providerData);
		this._chatByChannel.set(providerData, chat.toString());
	}

	// ---- Minimal stubs (progressive port onto the AHP surface) ----------------

	async resolveChatConfig(): Promise<{ schema: { type: 'object'; properties: {} }; values: Record<string, unknown> }> {
		return { schema: { type: 'object', properties: {} }, values: {} };
	}

	getInheritedChatConfig(): undefined {
		return undefined;
	}

	async chatConfigCompletions(): Promise<{ items: never[] }> {
		return { items: [] };
	}

	async getChatCustomizations(): Promise<readonly never[]> {
		return [];
	}

	async listChatsToMigrate(): Promise<readonly never[]> {
		return [];
	}

	async setWorkingDirectory(): Promise<void> {
		throw new Error('manox does not support changing the working directory of an existing session.');
	}

	getOrCreateActiveClient(_chat: URI, _context: URI | import('../../common/agent.js').IAgentChatContext, client: { readonly clientId: string; readonly displayName?: string }): import('../../common/agent.js').IActiveClient {
		return { clientId: client.clientId, displayName: client.displayName, tools: [], customizations: [] };
	}

	removeActiveClient(): void { }

	onClientToolCallComplete(): void { }

	async getChatMetadata(chat: URI): Promise<IAgentChatMetadata | undefined> {
		return { chat, startTime: Date.now(), modifiedTime: Date.now() };
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	async authenticate(): Promise<boolean> {
		return true;
	}

	respondToPermissionRequest(): void { }
	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void { }

	async refreshModels(): Promise<void> { }
	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models = this._models;

	async shutdown(): Promise<void> {
		this._client?.dispose();
		this._client = undefined;
	}

	override dispose(): void {
		this._client?.dispose();
		this._client = undefined;
		super.dispose();
	}
}
