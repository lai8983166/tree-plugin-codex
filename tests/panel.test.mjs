import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';

test('panel renders categories, right-click arms a child, and smart collection targets only selected Q&A', async () => {
  const { window, document } = parseHTML('<html><head></head><body></body></html>');
  // Supply browser select/Option behavior absent in this lightweight DOM.
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true, get() { return this.querySelector('option[selected]')?.value ?? ''; }, set(value) { for (const option of this.querySelectorAll('option')) option.selected = option.value === value; } });
  window.HTMLSelectElement.prototype.add = function(option) { this.append(option); };
  const calls = [], opened = [];
  const data = { sessionId: 's', revision: '1', nodes: [{ id: 'category', kind: 'category', title: 'Topic', parentId: 'root' }, { id: 'node-id', kind: 'qa', turnId: 'saved-turn', title: 'Saved question', parentId: 'category' }], pending: null, uncollected: [{ turnId: 'uncollected', title: 'Uncollected question', status: 'completed', firstSeenAt: '2026-01-01T00:00:00Z' }], totalTurns: 2 };
  let app;
  class FakeApp {
    constructor() { app = this; }
    async connect() {}
    getHostContext() { return { displayMode: 'pip' }; }
    getHostCapabilities() { return { experimental: { 'openai/files': {} } }; }
    async request(request) { opened.push(request); return {}; }
    async callServerTool(call) {
      calls.push(call);
      const args = call.arguments;
      let result = {};
      if (call.name === 'list_captured_sessions') result = { sessions: [] };
      if (call.name === 'read_discussion_tree') result = structuredClone(data);
      if (call.name === 'prepare_qa_file') result = { sessionId: args.session_id, turnId: args.turn_id, path: '/saved/qa.md' };
      return { content: [], structuredContent: result };
    }
  }
  const bundle = await build({ entryPoints: ['src/tree-panel.js'], bundle: true, format: 'iife', write: false, loader: { '.css': 'text' }, plugins: [{ name: 'fake-app', setup(build) { build.onResolve({ filter: /^@modelcontextprotocol\/ext-apps$/ }, () => ({ path: 'fake', namespace: 'fake' })); build.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'export const App = globalThis.FakeApp;', loader: 'js' })); } }] });
  const timers = [];
  runInNewContext(bundle.outputFiles[0].text, { FakeApp, document, window: { parent: {}, innerWidth: 1000, innerHeight: 800 }, console, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, Option: function(text, value) { const option = document.createElement('option'); option.textContent = text; option.value = value; return option; } });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  await flush();
  app.ontoolresult({ structuredContent: { probe: 'thread-panel-probe', sessionId: 's' } }); await flush();
  assert.equal(document.querySelectorAll('.node').length, 3);
  assert.equal(document.getElementById('session-id-fallback').hidden, true);
  const category = [...document.querySelectorAll('.node-main')].find(n => n.title === 'Topic');
  category.onclick(); await flush(); assert.equal(opened.length, 0);
  category.oncontextmenu({ preventDefault() {}, clientX: 40, clientY: 50 });
  assert.equal(document.getElementById('node-menu').hidden, false);
  document.getElementById('menu-child').onclick(); await flush();
  assert.equal(calls.find(c => c.name === 'arm_qa_child').arguments.parent_id, 'category');
  document.getElementById('outline').value = '- New topic';
  document.getElementById('create-outline').onclick(); await flush();
  assert.equal(calls.find(c => c.name === 'create_outline').arguments.outline, '- New topic');
  document.getElementById('uncollected').value = 'uncollected';
  document.getElementById('smart-collect').onclick(); await flush();
  assert.equal(calls.filter(c => c.name === 'smart_collect_turn').length, 1);
  assert.equal(calls.find(c => c.name === 'smart_collect_turn').arguments.turn_id, 'uncollected');
  [...document.querySelectorAll('.node-main')].find(n => n.title === 'Saved question').onclick(); await flush();
  assert.equal(calls.find(c => c.name === 'prepare_qa_file').arguments.turn_id, 'saved-turn');
  assert.equal(opened[0].method, 'openai/files/open');
  assert.equal(calls.some(c => c.name === 'retry_tree_classification'), false);
});
