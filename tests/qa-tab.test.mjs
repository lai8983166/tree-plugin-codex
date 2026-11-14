import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureEvent } from '../src/capture-store.js';
import { prepareQaFile } from '../src/qa-file.js';
import { createQaTabOpener } from '../src/qa-tab.js';

test('saved Q&A: full literal text, stable path, no rewrite, updates and session isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qa-file-'));
  try {
    const question = '测试 ``` <script>alert(1)</script>';
    const answer = '苹果\n' + '完整原文'.repeat(20000) + '\n````\n![image](https://example.com/x)';
    const event = { cwd: root, session_id: 'session-a', turn_id: 'apple' };
    await captureEvent(root, { ...event, hook_event_name: 'UserPromptSubmit', prompt: question });
    const waiting = await prepareQaFile(root, 'session-a', 'apple');
    assert.match(await readFile(waiting.path, 'utf8'), /尚未捕获最终回答/);
    await captureEvent(root, { ...event, hook_event_name: 'Stop', last_assistant_message: answer });
    const file = await prepareQaFile(root, 'session-a', 'apple');
    assert.equal(file.path, waiting.path);
    const content = await readFile(file.path, 'utf8');
    assert.ok(content.includes(question)); assert.ok(content.includes(answer));
    assert.ok(content.includes('`````text\n' + answer + '\n`````'));
    const modified = (await stat(file.path)).mtimeMs;
    assert.deepEqual(await prepareQaFile(root, 'session-a', 'apple'), file);
    assert.equal((await stat(file.path)).mtimeMs, modified);
    assert.deepEqual(await readdir(join(root, '.probe', 'qa', 'session-a')), ['apple.md']);
    await assert.rejects(prepareQaFile(root, 'session-b', 'apple'), /找不到/);
    await assert.rejects(prepareQaFile(root, '../escape', 'apple'), /Invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('node opening uses only local preparation and native file open; concurrent clicks coalesce', async () => {
  const calls = []; let resolveFile;
  const app = {
    getHostCapabilities: () => ({ experimental: { 'openai/files': {} } }),
    request: async request => { calls.push(request); return {}; }
  };
  const open = createQaTabOpener(app, async (name, args) => {
    calls.push({ name, args });
    return new Promise(resolve => { resolveFile = resolve; });
  });
  const first = open('session', 'apple');
  assert.equal(open('session', 'apple'), first);
  resolveFile({ sessionId: 'session', turnId: 'apple', path: 'F:/qa/apple.md' });
  await first;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'prepare_qa_file');
  assert.deepEqual(calls[1], { method: 'openai/files/open', params: { path: 'F:/qa/apple.md' } });
  const second = open('session', 'apple');
  resolveFile({ sessionId: 'session', turnId: 'apple', path: 'F:/qa/apple.md' });
  await second;
  assert.deepEqual(calls[3], calls[1]);
  const unsupported = createQaTabOpener({ getHostCapabilities: () => ({}) }, () => assert.fail('must not prepare'));
  await assert.rejects(unsupported('session', 'apple'), /未提供/);
});
