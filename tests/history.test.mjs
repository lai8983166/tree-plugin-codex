import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importHistory, parseHistory } from '../src/history-import.js';
import { captureEvent, readSnapshot, listCapturedSessions } from '../src/capture-store.js';
import { readTree, classifyNext, createCoordinator } from '../src/tree-store.js';

test('history import rebuilds all turns, preserves Markdown, deduplicates hooks and does not classify', async () => {
  const root = await mkdtemp(join(tmpdir(), 'history-test-'));
  const home = join(root, 'codex'), dir = join(home, 'sessions', '2026'); await mkdir(dir, { recursive: true });
  const file = join(dir, 'rollout-date-saved.jsonl');
  const records = [{ type: 'session_meta', payload: { id: 'saved', cwd: root } }];
  const answer = '```js\nconst answer = 42;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![image](https://example.invalid/image.png)\n\n$$x^2$$';
  const event = (type, turn_id, extra = {}) => ({ type: 'event_msg', timestamp: `2026-01-01T00:00:${String(Number(turn_id.split('-')[1]) || 0).padStart(2, '0')}.000Z`, payload: { type, turn_id, ...extra } });
  for (let i = 0; i < 45; i++) {
    const id = `turn-${i}`;
    records.push(event('item_completed', id, { thread_id: 'saved', item: { type: 'UserMessage', content: [{ type: 'text', text: `Question ${i}` }] } }));
    records.push(event('item_completed', id, { item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: 'DO NOT IMPORT COMMENTARY' }] } }));
    records.push({ type: 'response_item', payload: { type: 'reasoning', summary: 'DO NOT IMPORT REASONING' } });
    records.push(event('item_completed', id, { item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: answer }] } }));
    records.push(event('task_complete', id, { last_agent_message: answer }));
  }
  await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
  const result = await importHistory(root, 'saved', home);
  assert.equal(result.importedTurns, 45);
  assert.equal((await listCapturedSessions(root))[0].totalTurns, 45);
  let snapshot = await readSnapshot(root, 'saved', { limit: null });
  assert.equal(snapshot.turns[0].answer, answer);
  assert.equal(snapshot.turns.length, 45);
  const revision = snapshot.revision;
  await importHistory(root, 'saved', home);
  assert.equal((await readSnapshot(root, 'saved')).revision, revision);
  await captureEvent(root, { cwd: root, session_id: 'saved', turn_id: 'turn-0', hook_event_name: 'UserPromptSubmit', prompt: 'Question 0' });
  await captureEvent(root, { cwd: root, session_id: 'saved', turn_id: 'turn-0', hook_event_name: 'Stop', last_assistant_message: answer });
  snapshot = await readSnapshot(root, 'saved', { limit: null });
  assert.equal(snapshot.turns.length, 45); assert.deepEqual(snapshot.turns[0].prompts, ['Question 0']);
  assert.ok((await readTree(root, 'saved')).nodes.every(n => n.classification === 'pending'));
  assert.doesNotMatch(await readFile(join(root, '.probe', 'history', 'saved.json'), 'utf8'), /DO NOT IMPORT/);
  await classifyNext(root, 'saved', async () => ({ title: 'Title', summary: 'Summary', parentId: 'root', relation: '新主题', reason: 'Reason' }));
  await importHistory(root, 'saved', home);
  assert.equal((await readTree(root, 'saved')).nodes[0].classification, 'ready');
  await assert.rejects(importHistory(root, 'missing', home), /找不到/);
  await assert.rejects(importHistory(root, '../saved', home), /Invalid/);
  await assert.rejects(parseHistory(file, 'different', root), /不匹配/);
  const other = await mkdtemp(join(tmpdir(), 'other-project-'));
  assert.equal((await parseHistory(file, 'saved', other)).turns.length, 45);
  await writeFile(file, records.map(JSON.stringify).join('\n') + '\n{"unfinished":');
  assert.equal((await importHistory(root, 'saved', home)).partial, true);
  const before = await readFile(join(root, '.probe', 'history', 'saved.json'), 'utf8');
  await writeFile(file, 'broken\n' + records.map(JSON.stringify).join('\n'));
  await assert.rejects(importHistory(root, 'saved', home), /损坏/);
  assert.equal(await readFile(join(root, '.probe', 'history', 'saved.json'), 'utf8'), before);
});

test('legacy events retain interrupted and waiting turns; coordinator pauses before import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'history-legacy-'));
  const file = join(root, 'history.jsonl');
  const records = [
    { type: 'session_meta', payload: { id: 'saved', cwd: root } },
    { type: 'turn_context', payload: { turn_id: 'one' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Question' } },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'one' } },
    { type: 'turn_context', payload: { turn_id: 'two' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Waiting' } }
  ].map(r => ({ timestamp: '2026-01-01T00:00:00.000Z', ...r }));
  await writeFile(file, records.map(JSON.stringify).join('\n'));
  assert.deepEqual((await parseHistory(file, 'saved', root)).turns.map(t => t.status), ['interrupted', 'waiting']);
  await captureEvent(root, { cwd: root, session_id: 'saved', turn_id: 'one', hook_event_name: 'UserPromptSubmit', prompt: 'Question' });
  await captureEvent(root, { cwd: root, session_id: 'saved', turn_id: 'one', hook_event_name: 'Stop', last_assistant_message: 'Answer' });
  let release, started;
  const began = new Promise(r => { started = r; });
  const wait = new Promise(r => { release = r; });
  let calls = 0;
  const coordinator = createCoordinator(root, async () => { calls++; started(); await wait; return { title: 'Title', summary: 'Summary', parentId: 'root', relation: '新主题', reason: 'Reason' }; });
  try {
    coordinator.track('saved'); await began;
    assert.throws(() => coordinator.pause('saved'), /已暂停/);
    release();
    await new Promise(r => setTimeout(r, 100));
    coordinator.pause('saved');
    await captureEvent(root, { cwd: root, session_id: 'saved', turn_id: 'two', hook_event_name: 'Stop', last_assistant_message: 'Answer 2' });
    await new Promise(r => setTimeout(r, 2200));
    assert.equal(calls, 1);
  } finally { release(); coordinator.close(); }
});
