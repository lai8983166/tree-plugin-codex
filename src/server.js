import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readSnapshot, listCapturedSessions } from './capture-store.js';
import { getTurn } from './tree-store.js';
import { readCuratedTree, createOutline, armChild, cancelPending, smartCollect } from './curated-tree.js';
import { prepareQaFile } from './qa-file.js';
import { resolveThreadSession } from './thread-context.js';
import { importHistory } from './history-import.js';

const uri = 'ui://thread-panel-probe/v8.html';
const server = new McpServer({ name: 'thread-panel-probe', version: '0.7.0' });
const root = process.env.PROBE_PROJECT_ROOT || PROBE_PROJECT_ROOT;
const sessionId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
const ui = { resourceUri: uri };

server.registerTool('import_current_history', {
  title: 'Import current conversation history',
  description: 'Import saved local user questions and final answers into the uncollected pool. Does not create nodes or call a model.',
  inputSchema: { session_id: sessionId }, annotations: { ...annotations, readOnlyHint: false },
  _meta: { ui: { visibility: ['app'] } }
}, async ({ session_id }, extra) => {
  const id = resolveThreadSession(session_id, extra?._meta);
  const imported = await importHistory(root, id);
  return { content: [{ type: 'text', text: 'Local history imported into uncollected Q&A.' }], structuredContent: imported };
});

server.registerTool('prepare_qa_file', {
  title: 'Open saved Q&A', description: 'Prepare a stable local file containing the complete captured Q&A. Does not call a model or start classification.',
  inputSchema: { session_id: sessionId, turn_id: sessionId },
  annotations: { ...annotations, readOnlyHint: false },
  _meta: { ui: { visibility: ['app'] } }
}, async ({ session_id, turn_id }) => ({
  content: [{ type: 'text', text: 'Local Q&A file ready' }],
  structuredContent: await prepareQaFile(root, session_id, turn_id)
}));

server.registerResource('probe-panel', uri, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
  contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: PROBE_HTML,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }]
}));

server.registerTool('open_thread_panel_probe', {
  title: '讨论树',
  description: 'Open the discussion tree beside the current conversation without calling a model. Bind using host request thread metadata or an explicit current session_id. Never infer the session from recent captures.',
  inputSchema: { session_id: sessionId.optional() }, annotations,
  _meta: { ui, 'openai/ui': { entrypoints: [{ type: 'thread' }] } }
}, async ({ session_id }, extra) => {
  const boundSession = resolveThreadSession(session_id, extra?._meta);
  return { content: [{ type: 'text', text: boundSession ? 'Discussion tree bound to the current conversation without a model call.' : 'The host did not supply a current conversation ID. No session was selected automatically.' }],
    structuredContent: { probe: 'thread-panel-probe', version: '0.7.0', requestedEntrypoint: 'thread', sessionId: boundSession } };
});

server.registerTool('list_captured_sessions', {
  title: 'List local captured sessions', description: 'List captured sessions in this project for explicit user selection; never calls a model.',
  inputSchema: {}, annotations, _meta: { ui: { visibility: ['app'] } }
}, async () => ({ content: [{ type: 'text', text: 'Local sessions loaded' }], structuredContent: { sessions: await listCapturedSessions(root) } }));

server.registerTool('read_discussion_tree', {
  title: 'Read discussion tree', description: 'Synchronize the explicitly armed question node and read curated categories, collected nodes and uncollected Q&A. Never calls a model.',
  inputSchema: { session_id: sessionId, revision: z.string().optional() }, annotations: { ...annotations, readOnlyHint: false },
  _meta: { ui: { visibility: ['app'] } }
}, async ({ session_id, revision }) => {
  const tree = await readCuratedTree(root, session_id);
  return { content: [{ type: 'text', text: `${tree.totalTurns} discussion nodes` }], structuredContent: tree.revision === revision ? { unchanged: true, sessionId: session_id, revision } : tree };
});
server.registerTool('get_turn_detail', {
  title: 'Read complete Q&A', description: 'Read the complete original question and answer for one node in the bound session.',
  inputSchema: { session_id: sessionId, turn_id: sessionId }, annotations,
  _meta: { ui: { visibility: ['app'] } }
}, async ({ session_id, turn_id }) => ({ content: [{ type: 'text', text: 'Complete Q&A loaded' }], structuredContent: { turn: await getTurn(root, session_id, turn_id) } }));
for (const [name, description, schema, run] of [
  ['create_outline', 'Create category nodes from an outline; no model call.', { outline: z.string().max(30000), replace: z.boolean().optional() }, (id, a) => createOutline(root, id, a.outline, a.replace)],
  ['arm_qa_child', 'Create an empty child and bind the next new question and complete reply; no model call.', { parent_id: sessionId }, (id, a) => armChild(root, id, a.parent_id)],
  ['cancel_pending_node', 'Remove the empty pending node without removing saved Q&A.', {}, id => cancelPending(root, id)],
  ['smart_collect_turn', 'Make one independent background model request for this uncollected Q&A title and parent. Consumes model usage; never sends a chat message.', { turn_id: sessionId }, (id, a) => {
    if (process.env.TREE_MODEL_DISABLED === '1') throw new Error('模型调用已禁用');
    return smartCollect(root, id, a.turn_id);
  }]
]) server.registerTool(name, { title: name, description, inputSchema: { session_id: sessionId, ...schema }, annotations: { ...annotations, readOnlyHint: false, idempotentHint: false }, _meta: { ui: { visibility: ['app'] } } }, async (args, extra) => ({
  content: [{ type: 'text', text: 'Discussion tree updated' }], structuredContent: await run(resolveThreadSession(args.session_id, extra?._meta), args)
}));

server.registerTool('read_captured_turns', {
  title: 'Read captured turns',
  description: 'Read locally captured hook events for a single explicitly bound Codex session. Used by the panel to poll for completed Q&A; does not read transcripts.',
  inputSchema: { session_id: sessionId, revision: z.string().optional() }, annotations,
  _meta: { ui: { visibility: ['app'] } }
}, async ({ session_id, revision }) => {
  const snapshot = await readSnapshot(root, session_id);
  return { content: [{ type: 'text', text: `${snapshot.eventCount} hook events; ${snapshot.completedTurns} completed turns.` }],
    structuredContent: snapshot.revision === revision ? { unchanged: true, sessionId: session_id, revision } : snapshot };
});

server.registerTool('probe_ping', {
  title: 'Probe round trip',
  description: 'Echo a test nonce to verify that the MCP App can call its server through the host bridge.',
  inputSchema: { nonce: z.string().min(1).max(100) }, annotations,
  _meta: { ui: { visibility: ['app'] } }
}, async ({ nonce }) => ({
  content: [{ type: 'text', text: `Probe echo: ${nonce}` }],
  structuredContent: { nonce, server: 'thread-panel-probe', time: new Date().toISOString() }
}));

server.connect(new StdioServerTransport()).catch(error => { console.error(error); process.exitCode = 1; });
