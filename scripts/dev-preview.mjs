// Loopback-only, read-only UI test harness. Does not classify or modify real chats.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { getTurn } from '../src/tree-store.js';
import { readCuratedTree } from '../src/curated-tree.js';
import { listCapturedSessions } from '../src/capture-store.js';
const bundle = await build({ entryPoints: ['scripts/preview-host.js'], bundle: true, format: 'esm', write: false });
const hostScript = bundle.outputFiles[0].text;
const root = process.cwd();
createServer(async (req, res) => {
  if (req.headers.host !== '127.0.0.1:4329' || (req.headers.origin && req.headers.origin !== 'http://127.0.0.1:4329')) { res.writeHead(403).end(); return; }
  try {
    const path = new URL(req.url, 'http://127.0.0.1:4329').pathname;
    if (path === '/tool' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 10000) throw new Error('Too large'); }
      const { name, arguments: args } = JSON.parse(raw);
      let data;
      if (name === 'read_discussion_tree') data = await readCuratedTree(root, args.session_id, { sync: false });
      else if (name === 'list_captured_sessions') data = { sessions: await listCapturedSessions(root) };
      else if (name === 'get_turn_detail') data = { turn: await getTurn(root, args.session_id, args.turn_id) };
      else throw new Error('Read-only preview');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ content: [], structuredContent: data }));
    } else if (path === '/host.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(hostScript); }
    else if (path === '/panel') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await readFile('plugins/thread-panel-probe/dist/panel.html')); }
    else if (path === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html><meta charset="utf-8"><title>讨论树 · 本地验收预览</title><body style="margin:0"><div style="padding:7px 18px;font:12px system-ui;background:#e8ede5">本地开发预览 · 实际问答数据 · 非 Codex 宿主</div><iframe title="讨论树预览" style="width:100%;height:calc(100vh - 30px);border:0"></iframe><script type="module" src="/host.js"></script></body></html>'); }
    else res.writeHead(404).end();
  } catch (error) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: error.message }] })); }
}).listen(4329, '127.0.0.1', () => console.log('Read-only preview: http://127.0.0.1:4329'));
