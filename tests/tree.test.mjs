import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureEvent } from '../src/capture-store.js';
import { classifyNext, readTree, getTurn, retryFailed } from '../src/tree-store.js';
import { layoutTree } from '../src/tree-layout.js';

test('incremental classification, complete details, retry, no self/future-parent and >30 turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tree-test-'));
  for (let i = 0; i < 32; i++) {
    await captureEvent(root, { cwd: root, session_id: 's', turn_id: `t${i}`, hook_event_name: 'UserPromptSubmit', prompt: `问题 ${i}` });
    await captureEvent(root, { cwd: root, session_id: 's', turn_id: `t${i}`, hook_event_name: 'Stop', last_assistant_message: '完整回答'.repeat(1000) });
  }
  let calls = 0;
  const model = async (turn, candidates) => { calls++; return { title: '节点标题', summary: '摘要', reason: '承接前一问题', parentId: candidates.at(-1)?.turnId || 'root', relation: candidates.length ? '追问' : '新主题' }; };
  assert.equal((await readTree(root, 's')).nodes.length, 32);
  await classifyNext(root, 's', model); await classifyNext(root, 's', model);
  const tree = await readTree(root, 's');
  assert.equal(tree.nodes.filter(n => n.classification === 'ready').length, 2);
  assert.equal(calls, 2);
  assert.equal((await getTurn(root, 's', 't0')).answer.length, 4000);
  await assert.rejects(getTurn(root, 'other', 't0'));
  await classifyNext(root, 's', async turn => ({ title: '错误', summary: '错误', reason: '错误', relation: '追问', parentId: turn.turnId }));
  assert.equal((await readTree(root, 's')).nodes.filter(n => n.classification === 'error').length, 1);
  await retryFailed(root, 's'); await classifyNext(root, 's', model);
  assert.equal((await readTree(root, 's')).nodes.filter(n => n.classification === 'error').length, 0);
});
test('tree layout branches, collapses and survives cyclic persisted input', () => {
  const input = [ { turnId: 'a', title: 'a', parentId: 'root', classification: 'ready' }, { turnId: 'b', title: 'b', parentId: 'a', classification: 'ready' }, { turnId: 'c', title: 'c', parentId: 'a', classification: 'ready' } ];
  const graph = layoutTree(input);
  assert.equal(graph.edges.length, 3);
  assert.equal(graph.nodes.find(n => n.id === 'b').x, graph.nodes.find(n => n.id === 'c').x);
  assert.notEqual(graph.nodes.find(n => n.id === 'b').y, graph.nodes.find(n => n.id === 'c').y);
  assert.equal(layoutTree(input, new Set(['a'])).nodes.length, 2);
  assert.equal(layoutTree([{ ...input[0], parentId: 'b' }, input[1]]).nodes.length, 3);
});
