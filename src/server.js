import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readSnapshot, listCapturedSessions } from './capture-store.js';
import { readTree, getTurn, retryFailed, createCoordinator } from './tree-store.js';
import { prepareQaFile } from './qa-file.js';

const uri = 'ui://thread-panel-probe/v5.html';
const server = new McpServer({ name: 'thread-panel-probe', version: '0.5.0' });
const root = process.env.PROBE_PROJECT_ROOT || PROBE_PROJECT_ROOT;
const coordinator = process.env.TREE_MODEL_DISABLED === '1' ? { track() {}, close() {} } : createCoordinator(root);
const sessionId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
const ui = { resourceUri: uri };

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
  description: 'Open the discussion tree without calling a model. With no session_id, show a local session picker. Never choose another session automatically.',
  inputSchema: { session_id: sessionId.optional() }, annotations,
  _meta: { ui, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } }
}, async ({ session_id }) => {
  return { content: [{ type: 'text', text: 'Discussion tree opened without a model call. Choose a captured session to view saved nodes and Q&A.' }],
    structuredContent: { probe: 'thread-panel-probe', version: '0.5.0', requestedEntrypoint: session_id ? 'thread' : 'global', sessionId: session_id ?? null } };
});

server.registerTool('list_captured_sessions', {
  title: 'List local captured sessions', description: 'List captured sessions in this project for explicit user selection; never calls a model.',
  inputSchema: {}, annotations, _meta: { ui: { visibility: ['app'] } }
}, async () => ({ content: [{ type: 'text', text: 'Local sessions loaded' }], structuredContent: { sessions: await listCapturedSessions(root) } }));

server.registerTool('read_discussion_tree', {
  title: 'Read discussion tree', description: 'Read node titles, model-selected relationships, and classification status for the bound session.',
  inputSchema: { session_id: sessionId, revision: z.string().optional() }, annotations,
  _meta: { ui: { visibility: ['app'] } }
}, async ({ session_id, revision }) => {
  const tree = await readTree(root, session_id);
  return { content: [{ type: 'text', text: `${tree.totalTurns} discussion nodes` }], structuredContent: tree.revision === revision ? { unchanged: true, sessionId: session_id, revision } : tree };
});
server.registerTool('get_turn_detail', {
  title: 'Read complete Q&A', description: 'Read the complete original question and answer for one node in the bound session.',
  inputSchema: { session_id: sessionId, turn_id: sessionId }, annotations,
  _meta: { ui: { visibility: ['app'] } }
}, async ({ session_id, turn_id }) => ({ content: [{ type: 'text', text: 'Complete Q&A loaded' }], structuredContent: { turn: await getTurn(root, session_id, turn_id) } }));
server.registerTool('retry_tree_classification', {
  title: 'Retry failed classifications', description: 'Clear failed classification states and retry using the locally signed-in Codex model. Consumes model usage.',
  inputSchema: { session_id: sessionId }, annotations: { ...annotations, readOnlyHint: false, idempotentHint: false },
  _meta: { ui: { visibility: ['app'] } }
}, async ({ session_id }) => { await retryFailed(root, session_id); coordinator.track(session_id); return { content: [{ type: 'text', text: 'Retry queued' }], structuredContent: { queued: true } }; });

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
