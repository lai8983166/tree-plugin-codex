import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { captureEvent, readSnapshot } from '../src/capture-store.js';

test('hook executable captures Q&A, deduplicates, isolates sessions and marks interruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thread-probe-'));
  const run = input => {
    const child = spawnSync(process.execPath, [resolve('plugins/thread-panel-probe/dist/capture.cjs')], {
      input: JSON.stringify({ cwd: root, session_id: 'session-a', turn_id: 'turn-1', ...input }),
      encoding: 'utf8', env: { ...process.env, PROBE_PROJECT_ROOT: root }
    });
    assert.equal(child.status, 0); assert.equal(child.stderr, ''); assert.deepEqual(JSON.parse(child.stdout), {});
  };
  run({ hook_event_name: 'UserPromptSubmit', prompt: '测试问题 <script>不执行</script>' });
  let snapshot = await readSnapshot(root, 'session-a');
  assert.equal(snapshot.turns[0].status, 'waiting');
  const before = snapshot.revision;
  run({ hook_event_name: 'Stop', last_assistant_message: '自动采集的最终回答' });
  run({ hook_event_name: 'Stop', last_assistant_message: '自动采集的最终回答' });
  snapshot = await readSnapshot(root, 'session-a');
  assert.equal(snapshot.eventCount, 2); assert.equal(snapshot.completedTurns, 1);
  assert.notEqual(snapshot.revision, before);
  assert.equal(snapshot.turns[0].answer, '自动采集的最终回答');
  assert.match(snapshot.turns[0].prompts[0], /测试问题/);
  assert.equal((await readSnapshot(root, 'session-b')).eventCount, 0);
  run({ hook_event_name: 'Stop', turn_id: 'turn-2', last_assistant_message: null });
  run({ hook_event_name: 'Interrupt', turn_id: 'turn-3' });
  snapshot = await readSnapshot(root, 'session-a');
  assert.equal(snapshot.turns.find(t => t.turnId === 'turn-2').status, 'missing-answer');
  assert.equal(snapshot.turns.find(t => t.turnId === 'turn-3').status, 'interrupted');
  await assert.rejects(readSnapshot(root, '../escape'));
  const other = await mkdtemp(join(tmpdir(), 'thread-probe-other-'));
  assert.deepEqual(await captureEvent(root, { cwd: other, session_id: 'session-a', turn_id: 'turn-4', hook_event_name: 'Stop', last_assistant_message: 'outside' }), { ignored: 'outside-project' });
});
