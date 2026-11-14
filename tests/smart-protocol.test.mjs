import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { captureEvent } from '../src/capture-store.js';

test('packaged smart collection uses one ephemeral background CLI request with no automatic follow-up', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'smart-protocol-'));
  const cli = resolve(root, 'fake-cli.cjs'), log = resolve(root, 'calls.jsonl');
  await writeFile(cli, `const fs = require('node:fs'); let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => input += x); process.stdin.on('end', () => {
    const data = JSON.parse(input.slice(input.indexOf('DATA=') + 5));
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2), data}) + '\\n');
    const path = process.argv[process.argv.indexOf('--output-last-message') + 1];
    fs.writeFileSync(path, JSON.stringify({title:'Collected question',summary:'Summary',parentId:data.candidates[0].turnId,relation:'解释',reason:'Matches category'}));
  });`);
  for (const event of ['UserPromptSubmit', 'Stop']) await captureEvent(root, { cwd: root, session_id: 's', turn_id: 't', hook_event_name: event, prompt: 'Question', last_assistant_message: 'Complete answer' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('plugins/thread-panel-probe/dist/server.cjs')], env: { ...process.env, PROBE_PROJECT_ROOT: root, TREE_CODEX_CLI: cli, TREE_MODEL_DISABLED: '0' }, stderr: 'pipe' });
  const client = new Client({ name: 'smart-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await client.callTool({ name: 'create_outline', arguments: { session_id: 's', outline: '- Topic' } });
    const result = await client.callTool({ name: 'smart_collect_turn', arguments: { session_id: 's', turn_id: 't' } });
    assert.ok(result.structuredContent?.nodeId, JSON.stringify(result));
    const duplicate = await client.callTool({ name: 'smart_collect_turn', arguments: { session_id: 's', turn_id: 't' } });
    assert.equal(duplicate.isError, true);
    const tree = await client.callTool({ name: 'read_discussion_tree', arguments: { session_id: 's' } });
    assert.equal(tree.structuredContent.nodes[1].parentId, tree.structuredContent.nodes[0].id);
    assert.equal(tree.structuredContent.nodes[1].turnId, 't');
    assert.equal(tree.structuredContent.uncollected.length, 0);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('--ephemeral'));
    for (const feature of ['hooks','plugins','apps','shell_tool','multi_agent']) assert.ok(calls[0].args.includes(feature));
    assert.equal(calls[0].data.current.answer, 'Complete answer');
    assert.equal(calls[0].data.candidates[0].kind, 'category');
  } finally { await client.close(); }
});
