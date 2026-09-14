/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ChatInputAnswerState, ChatInputAnswerValueKind, type ChatInputAnswer } from '../../common/state/sessionState.js';
import { buildTurnsFromJournal, manoxAnswerText, manoxPermissionKind, manoxPermissionPath } from '../../node/manox/manoxMapping.js';
import type { ManoxJournalEntry } from '../../node/manox/manoxNapiTransport.js';

function selectedAnswer(value: string): ChatInputAnswer {
	return { state: ChatInputAnswerState.Submitted, value: { kind: ChatInputAnswerValueKind.Selected, value } };
}

suite('manoxAgent', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('manoxAnswerText', () => {
		test('flattens selected, multi-select and text answers', () => {
			assert.strictEqual(manoxAnswerText(selectedAnswer('b')), 'b');
			assert.strictEqual(manoxAnswerText({ state: ChatInputAnswerState.Submitted, value: { kind: ChatInputAnswerValueKind.SelectedMany, value: ['a', 'c'] } }), 'a, c');
			assert.strictEqual(manoxAnswerText({ state: ChatInputAnswerState.Submitted, value: { kind: ChatInputAnswerValueKind.Text, value: 'free text' } }), 'free text');
		});
		test('undefined for skipped, missing and empty answers', () => {
			assert.strictEqual(manoxAnswerText(undefined), undefined);
			assert.strictEqual(manoxAnswerText({ state: ChatInputAnswerState.Skipped }), undefined);
			assert.strictEqual(manoxAnswerText(selectedAnswer('')), undefined);
			assert.strictEqual(manoxAnswerText({ state: ChatInputAnswerState.Submitted, value: { kind: ChatInputAnswerValueKind.SelectedMany, value: [] } }), undefined);
		});
	});

	suite('manoxPermissionKind', () => {
		test('buckets tool names for host auto-approval', () => {
			assert.strictEqual(manoxPermissionKind('Bash'), 'shell');
			assert.strictEqual(manoxPermissionKind('terminal_exec'), 'shell');
			assert.strictEqual(manoxPermissionKind('Edit'), 'write');
			assert.strictEqual(manoxPermissionKind('apply_patch'), 'write');
			assert.strictEqual(manoxPermissionKind('Read'), 'read');
			assert.strictEqual(manoxPermissionKind('Grep'), 'read');
			assert.strictEqual(manoxPermissionKind('web_fetch'), 'custom-tool');
		});
	});

	suite('manoxPermissionPath', () => {
		test('extracts the first file-ish field', () => {
			assert.strictEqual(manoxPermissionPath({ file_path: '/a/b.ts' }), '/a/b.ts');
			assert.strictEqual(manoxPermissionPath({ command: 'ls', notebook_path: '/n.ipynb' }), '/n.ipynb');
			assert.strictEqual(manoxPermissionPath({ command: 'ls' }), undefined);
			assert.strictEqual(manoxPermissionPath('not an object'), undefined);
		});
	});

	suite('buildTurnsFromJournal', () => {
		test('rebuilds user/assistant turns from journal rows (surface.rs sample shapes)', () => {
			const records = [
				{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }], seq: 0, id: 'm1', parentId: null, timestamp: '2026-09-14T07:00:00.000Z' },
				{ type: 'turnStart', seq: 1, id: 'e1', parentId: 'm1', timestamp: '2026-09-14T07:00:01.000Z' },
				{ type: 'agentTextDelta', s: 'hi ', seq: 2, id: 'e2', parentId: 'e1', timestamp: '2026-09-14T07:00:02.000Z' },
				{ type: 'agentTextDelta', s: 'there', seq: 3, id: 'e3', parentId: 'e2', timestamp: '2026-09-14T07:00:03.000Z' },
				{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi there' }], seq: 4, id: 'm2', parentId: 'e3', timestamp: '2026-09-14T07:00:04.000Z' },
				{ type: 'turnFinish', cancelled: false, failed: false, strandedSteerIds: [], seq: 5, id: 'e5', parentId: 'm2', timestamp: '2026-09-14T07:00:05.000Z' },
			] as unknown as ManoxJournalEntry[];
			const turns = buildTurnsFromJournal(records);
			assert.strictEqual(turns.length, 1);
			assert.strictEqual(turns[0].id, 'm1');
			assert.strictEqual(turns[0].message.text, 'hello');
			assert.ok(turns[0].responseParts.some(part => part.kind === 'markdown' && part.content.includes('hi there')));
		});
	});
});
