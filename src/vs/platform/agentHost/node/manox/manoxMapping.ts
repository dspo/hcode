/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatInputAnswerState, ChatInputAnswerValueKind, MessageKind, ResponsePartKind, TurnState, type ChatInputAnswer, type Message, type ResponsePart, type Turn } from '../../common/state/sessionState.js';
import type { ManoxJournalEntry } from './manoxNapiTransport.js';

/** Host auto-approval bucket for a manox tool name (SessionPermissionManager
 * keys its policy off this; it never gates what the runtime approves). */
export function manoxPermissionKind(toolName: string): 'shell' | 'write' | 'read' | 'custom-tool' {
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
export function manoxPermissionPath(input: unknown): string | undefined {
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

/** Flatten one answered chat-input question into the text manox expects. */
export function manoxAnswerText(answer: ChatInputAnswer | undefined): string | undefined {
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
