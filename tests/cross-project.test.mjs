import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { storageRoot } from '../src/storage-root.js';
import { migrateData } from '../src/migrate-data.js';

test('MCP and bundled Hooks share user storage across projects and isolate identical turn IDs', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'cross-project-'));
  const home = join(temp, 'codex'), a = join(temp, 'project-a'), b = join(temp, 'project-b');
  for (const dir of [a, b, join(home, 'sessions')]) await mkdir(dir, { recursive: true });
  const env = { ...process.env, CODEX_HOME: home, TREE_MODEL_DISABLED: '1' }; delete env.PROBE_PROJECT_ROOT; delete env.TREE_DATA_ROOT;
  const root = storageRoot(env);
  assert.equal(root, join(home, 'discussion-tree'));
  assert.equal(storageRoot({ TREE_DATA_ROOT: a, CODEX_HOME: home }), a);
  const pluginRoot = join(temp, 'installed plugin with spaces');
  await mkdir(join(pluginRoot, 'dist'), { recursive: true });
  await copyFile(resolve('plugins/thread-panel-probe/dist/capture.cjs'), join(pluginRoot, 'dist', 'capture.cjs'));
  env.PLUGIN_ROOT = pluginRoot;
  const bundledHooks = JSON.parse(await readFile('plugins/thread-panel-probe/hooks/hooks.json', 'utf8')).hooks;
  const hook = (cwd, session_id, hook_event_name, text) => {
    const command = bundledHooks[hook_event_name][0].hooks[0][process.platform === 'win32' ? 'commandWindows' : 'command'];
    const child = spawnSync(command, { shell: true, cwd, env, encoding: 'utf8', input: JSON.stringify({ cwd, session_id, turn_id: 'same-turn', hook_event_name, prompt: text, last_assistant_message: text }) });
    assert.equal(child.status, 0); assert.equal(child.stderr, '');
  };
  const client = new Client({ name: 'cross-project-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('plugins/thread-panel-probe/dist/server.cjs')], cwd: a, env, stderr: 'pipe' });
  const call = async (name, args) => client.callTool({ name, arguments: args });
  try {
    await client.connect(transport);
    for (const session of ['session-a', 'session-b']) {
      const outline = await call('create_outline', { session_id: session, outline: '- Topic ' + session });
      assert.equal(outline.isError, undefined);
      await call('arm_qa_child', { session_id: session, parent_id: 'root' });
    }
    hook(a, 'session-a', 'UserPromptSubmit', 'Question A');
    hook(b, 'session-b', 'UserPromptSubmit', 'Question B');
    hook(b, 'session-b', 'Stop', 'Answer B');
    hook(a, 'session-a', 'Stop', 'Answer A');
    for (const [session, answer] of [['session-a', 'Answer A'], ['session-b', 'Answer B']]) {
      const tree = (await call('read_discussion_tree', { session_id: session })).structuredContent;
      assert.equal(tree.nodes.length, 2); assert.equal(tree.pending, null); assert.equal(tree.nodes[1].turnId, 'same-turn');
      const detail = (await call('get_turn_detail', { session_id: session, turn_id: 'same-turn' })).structuredContent;
      assert.equal(detail.turn.answer, answer);
    }
    const missing = await call('get_turn_detail', { session_id: 'session-c', turn_id: 'same-turn' });
    assert.equal(missing.isError, true);
    // A deleted or foreign cwd does not prevent importing this exact session.
    const records = [
      { type: 'session_meta', payload: { id: 'historical', session_id: 'historical', cwd: join(temp, 'deleted-project') } },
      { type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'user_message', turn_id: 'old', message: 'Old question' } },
      { type: 'event_msg', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'task_complete', turn_id: 'old', last_agent_message: 'Old answer' } }
    ];
    const path = join(home, 'sessions', 'rollout-date-historical.jsonl');
    await writeFile(path, records.map(JSON.stringify).join('\n'));
    assert.equal((await call('import_current_history', { session_id: 'historical' })).structuredContent.importedTurns, 1);
    const tree = (await call('read_discussion_tree', { session_id: 'historical' })).structuredContent;
    assert.equal(tree.nodes.length, 0); assert.equal(tree.uncollected.length, 1);
    records[0].payload.session_id = 'forged';
    await writeFile(path, records.map(JSON.stringify).join('\n'));
    assert.equal((await call('import_current_history', { session_id: 'historical' })).isError, true);
    await assert.rejects(access(join(a, '.probe')), { code: 'ENOENT' });
    await assert.rejects(access(join(b, '.probe')), { code: 'ENOENT' });
  } finally { await client.close(); }
  const manifest = JSON.parse(await readFile('plugins/thread-panel-probe/plugin.json', 'utf8'));
  assert.equal(manifest.extensions['com.openai'].hooks, './hooks/hooks.json');
  const hooks = JSON.parse(await readFile('plugins/thread-panel-probe/hooks/hooks.json', 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['Interrupt', 'Stop', 'UserPromptSubmit']);
  for (const groups of Object.values(hooks)) assert.match(groups[0].hooks[0].commandWindows, /PLUGIN_ROOT/);
});

test('legacy migration is additive, repeatable, preserves sources and excludes diagnostics/locks', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'tree-migration-')), source = join(temp, 'old'), dest = join(temp, 'new');
  for (const root of [source, dest]) await mkdir(join(root, '.probe', 'curated'), { recursive: true });
  await writeFile(join(source, '.probe', 'curated', 'one.json'), '{"old":true}');
  await writeFile(join(dest, '.probe', 'curated', 'one.json'), '{"new":true}');
  await writeFile(join(source, '.probe', 'curated', 'two.json'), '{"tree":true}');
  await writeFile(join(source, '.probe', 'curated', 'ignored.tmp'), 'temporary');
  const result = await migrateData(source, dest);
  assert.deepEqual(result, { copied: 1, skipped: 1 });
  assert.equal(await readFile(join(dest, '.probe', 'curated', 'one.json'), 'utf8'), '{"new":true}');
  assert.equal(await readFile(join(source, '.probe', 'curated', 'two.json'), 'utf8'), '{"tree":true}');
  await assert.rejects(access(join(dest, '.probe', 'curated', 'ignored.tmp')), { code: 'ENOENT' });
  assert.deepEqual(await migrateData(source, dest), { copied: 0, skipped: 2 });
});
