import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { captureEvent } from '../src/capture-store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('opening and polling a captured session never starts the enabled model coordinator', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'probe-no-model-'));
  const marker = resolve(root, 'model-called');
  const fakeCli = resolve(root, 'fake-cli.cjs');
  await writeFile(fakeCli, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');`);
  await captureEvent(root, { cwd: root, session_id: 'saved', turn_id: 'one', hook_event_name: 'UserPromptSubmit', prompt: 'test question' });
  await captureEvent(root, { cwd: root, session_id: 'saved', turn_id: 'one', hook_event_name: 'Stop', last_assistant_message: 'test answer' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('plugins/thread-panel-probe/dist/server.cjs')], env: { ...process.env, PROBE_PROJECT_ROOT: root, TREE_MODEL_DISABLED: '0', TREE_CODEX_CLI: fakeCli }, stderr: 'pipe' });
  const client = new Client({ name: 'no-model-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    for (const args of [{}, { session_id: 'saved' }]) await client.callTool({ name: 'open_thread_panel_probe', arguments: args });
    await client.callTool({ name: 'list_captured_sessions', arguments: {} });
    await client.callTool({ name: 'read_discussion_tree', arguments: { session_id: 'saved' } });
    await client.callTool({ name: 'prepare_qa_file', arguments: { session_id: 'saved', turn_id: 'one' } });
    // Cross a coordinator timer tick with classification enabled and pending data.
    await new Promise(resolve => setTimeout(resolve, 2200));
    await assert.rejects(access(marker), { code: 'ENOENT' });
    const tree = await client.callTool({ name: 'read_discussion_tree', arguments: { session_id: 'saved' } });
    assert.equal(tree.structuredContent.nodes[0].classification, 'pending');
  } finally { await client.close(); }
});

test('packaged MCP: discover thread entrypoint, read UI, call tools, reject invalid nonce', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'probe-mcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [process.env.PROBE_SERVER || resolve('plugins/thread-panel-probe/dist/server.cjs')], env: { ...process.env, PROBE_PROJECT_ROOT: root, TREE_MODEL_DISABLED: '1' }, stderr: 'pipe' });
  const client = new Client({ name: 'protocol-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const open = tools.find(t => t.name === 'open_thread_panel_probe');
    assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
    assert.equal(open.annotations.readOnlyHint, true);
    const { contents } = await client.readResource({ uri: open._meta.ui.resourceUri });
    assert.equal(contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(contents[0].text, /DISCUSSION ATLAS/);
    assert.match(contents[0].text, /ui\/initialize/);
    const result = await client.callTool({ name: open.name, arguments: {} });
    assert.equal(result.structuredContent.sessionId, null);
    const emptyList = await client.callTool({ name: 'list_captured_sessions', arguments: {} });
    assert.deepEqual(emptyList.structuredContent.sessions, []);
    const ping = await client.callTool({ name: 'probe_ping', arguments: { nonce: 'round-trip-test' } });
    assert.equal(ping.structuredContent.nonce, 'round-trip-test');
    const invalid = await client.callTool({ name: 'probe_ping', arguments: { nonce: '' } });
    assert.equal(invalid.isError, true);
    const bound = await client.callTool({ name: open.name, arguments: { session_id: 'live-test' } });
    assert.equal(bound.structuredContent.sessionId, 'live-test');
    const initial = await client.callTool({ name: 'read_captured_turns', arguments: { session_id: 'live-test' } });
    assert.equal(initial.structuredContent.eventCount, 0);
    await captureEvent(root, { cwd: root, session_id: 'live-test', turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
    await captureEvent(root, { cwd: root, session_id: 'live-test', turn_id: 'turn-1', hook_event_name: 'Stop', last_assistant_message: 'world' });
    const updated = await client.callTool({ name: 'read_captured_turns', arguments: { session_id: 'live-test', revision: initial.structuredContent.revision } });
    assert.equal(updated.structuredContent.turns[0].answer, 'world');
    const sessions = await client.callTool({ name: 'list_captured_sessions', arguments: {} });
    assert.equal(sessions.structuredContent.sessions[0].sessionId, 'live-test');
    assert.equal(sessions.structuredContent.sessions[0].label, 'hello');
    assert.equal(sessions.structuredContent.sessions[0].totalTurns, 1);
    const reopened = await client.callTool({ name: open.name, arguments: {} });
    assert.equal(reopened.structuredContent.sessionId, null);
    const unchanged = await client.callTool({ name: 'read_captured_turns', arguments: { session_id: 'live-test', revision: updated.structuredContent.revision } });
    assert.equal(unchanged.structuredContent.unchanged, true);
    const tree = await client.callTool({ name: 'read_discussion_tree', arguments: { session_id: 'live-test' } });
    assert.equal(tree.structuredContent.nodes.length, 1);
    assert.equal(tree.structuredContent.nodes[0].classification, 'pending');
    const detail = await client.callTool({ name: 'get_turn_detail', arguments: { session_id: 'live-test', turn_id: 'turn-1' } });
    assert.equal(detail.structuredContent.turn.answer, 'world');
    const qaTool = tools.find(t => t.name === 'prepare_qa_file');
    assert.deepEqual(qaTool._meta.ui.visibility, ['app']);
    const qa = await client.callTool({ name: 'prepare_qa_file', arguments: { session_id: 'live-test', turn_id: 'turn-1' } });
    assert.equal(qa.structuredContent.turnId, 'turn-1');
    assert.match(qa.structuredContent.path, /turn-1\.md$/);
    const missing = await client.callTool({ name: 'get_turn_detail', arguments: { session_id: 'another-session', turn_id: 'turn-1' } });
    assert.equal(missing.isError, true);
  } finally { await client.close(); }
});
