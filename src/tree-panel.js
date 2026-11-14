import { App } from '@modelcontextprotocol/ext-apps';
import { layoutTree } from './tree-layout.js';
import { createQaTabOpener } from './qa-tab.js';
import styles from './panel.css';
import pickerStyles from './session-picker.css';
document.head.insertAdjacentHTML('beforeend', `<style>${styles}${pickerStyles}</style>`);
document.body.innerHTML = `<main>
<header><div><div class="eyebrow">DISCUSSION ATLAS</div><h1>讨论树 <span>0.5.0</span></h1></div><span id="connection" class="badge">连接中</span></header>
<div class="subhead"><span id="counts">每轮问答，成为一个节点</span><span id="sync">等待绑定会话</span></div>
<div class="session-picker"><label for="session-picker">本地会话</label><select id="session-picker"><option value="">请选择会话</option></select><button id="refresh-sessions">刷新列表</button><button id="classify" disabled>启用模型归类（消耗额度）</button></div>
<div class="workspace"><section class="map-section" aria-label="讨论树画布">
<div class="toolbar"><div class="segmented"><button id="zoom-out" aria-label="缩小">−</button><span id="zoom-label">100%</span><button id="zoom-in" aria-label="放大">＋</button></div><button id="fit">适应画布</button><button id="expand">展开全部</button><button id="retry" hidden>重试失败节点</button></div>
<div id="viewport" tabindex="0" aria-label="可滚动的树形图"><div id="extent"><div id="canvas"><svg id="edges" aria-hidden="true"></svg><div id="nodes"></div></div></div></div>
<div id="empty">正在等待会话数据…</div><footer><span class="dot"></span>新问答自动加入 · 点击节点在标签页打开完整问答</footer>
</section></div>
<p id="navigation-status" role="status">问答从本地读取；同一节点使用同一文件标签页，打开不调用模型。</p>
<details class="diagnostics"><summary>连接与模型说明</summary><p>打开入口、选择会话和查看问答只读本地数据，不调用模型。每 2 秒读取新问答；只有明确点击“启用模型归类”或“重试失败节点”才启动模型，之后服务存活期间会自动归类该会话的新节点并消耗额度。未归类节点的虚线不代表模型关系。</p><pre id="diagnostic"></pre></details>
</main>`;
const $ = id => document.getElementById(id);
const app = new App({ name: 'discussion-tree', version: '0.5.0' });
let sessionId = null, revision = null, snapshot = null, connected = false, polling = false, timer;
let selected = null, collapsed = new Set(), scale = 1, graph = null, fitted = false;
const diag = {};
const openQaTab = createQaTabOpener(app, call);
let openRequest = 0;
async function openNode(node) {
  const request = ++openRequest, session = sessionId;
  $('navigation-status').textContent = `正在打开「${node.title}」…`;
  try {
    await openQaTab(session, node.id);
    if (request === openRequest && session === sessionId) $('navigation-status').textContent = `已请求打开「${node.title}」的本地问答标签页`;
  } catch (error) {
    if (request === openRequest && session === sessionId) $('navigation-status').textContent = `打开失败：${error.message}。可再次点击重试。`;
  }
}
const report = () => { $('diagnostic').textContent = JSON.stringify({ sessionId, ...diag }, null, 2); };
function bindSession(id) {
  if (sessionId === id) return;
  sessionId = id || null; revision = null; selected = null; snapshot = null; collapsed.clear(); fitted = false; openRequest++;
  $('nodes').replaceChildren(); $('edges').replaceChildren();
  $('empty').hidden = false; $('empty').textContent = sessionId ? '正在读取本地问答…' : '请选择本地会话；打开面板不调用模型。';
  $('counts').textContent = '每轮问答，成为一个节点';
  $('classify').disabled = !sessionId; $('retry').hidden = true;
  $('navigation-status').textContent = '点击问答节点可打开本地完整内容。';
  $('session-picker').value = sessionId ?? ''; report(); poll();
}
async function refreshSessions() {
  if (!connected) return;
  $('refresh-sessions').disabled = true;
  try {
    const { sessions } = await call('list_captured_sessions', {});
    const picker = $('session-picker'); picker.replaceChildren(new Option(sessions.length ? '请选择会话' : '暂无采集记录，请先启用项目 Hooks', ''));
    for (const session of sessions) picker.add(new Option(`${session.label} · ${session.totalTurns} 轮 · ${session.sessionId.slice(0, 8)} · ${new Date(session.updatedAt).toLocaleString()}`, session.sessionId));
    if (sessionId && !sessions.some(s => s.sessionId === sessionId)) picker.add(new Option(`当前会话 · ${sessionId.slice(0, 8)}`, sessionId));
    picker.value = sessionId ?? '';
    if (!sessionId) { $('empty').textContent = '请选择本地会话；打开面板不调用模型。'; $('sync').textContent = '仅读取本地数据'; }
  } catch (error) { $('sync').textContent = `列表读取失败：${error.message}`; }
  finally { $('refresh-sessions').disabled = false; }
}
$('session-picker').onchange = event => bindSession(event.target.value);
$('refresh-sessions').onclick = refreshSessions;
$('classify').onclick = async () => {
  const session = sessionId; if (!session) return;
  $('classify').disabled = true;
  try { await call('retry_tree_classification', { session_id: session }); if (session === sessionId) $('navigation-status').textContent = '已启用本会话模型归类，将消耗账号额度。'; }
  catch (error) { $('navigation-status').textContent = `启用失败：${error.message}`; }
  finally { $('classify').disabled = !sessionId; }
};
async function call(name, args) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError || !result.structuredContent) throw new Error(result.content?.find(x => x.type === 'text')?.text || '工具没有返回有效结果');
  return result.structuredContent;
}
function zoom(value) {
  scale = Math.max(.25, Math.min(1.5, value));
  $('zoom-label').textContent = `${Math.round(scale * 100)}%`;
  $('canvas').style.transform = `scale(${scale})`;
  if (graph) { $('extent').style.width = `${graph.width * scale}px`; $('extent').style.height = `${graph.height * scale}px`; }
}
$('zoom-out').onclick = () => zoom(scale - .1);
$('zoom-in').onclick = () => zoom(scale + .1);
$('fit').onclick = () => { if (graph) { zoom(Math.min(1, ($('viewport').clientWidth - 32) / graph.width, ($('viewport').clientHeight - 32) / graph.height)); $('viewport').scrollTo(0, 0); } };
$('expand').onclick = () => { collapsed.clear(); draw(); };
$('retry').onclick = async () => {
  $('retry').disabled = true;
  try { await call('retry_tree_classification', { session_id: sessionId }); revision = null; await poll(); }
  catch (error) { $('sync').textContent = error.message; }
  finally { $('retry').disabled = false; }
};
function textElement(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
const labels = { ready: '模型已归类', pending: '待归类', classifying: '模型归类中', error: '归类失败', waiting: '等待回答' };
function draw() {
  if (!snapshot) return;
  const data = snapshot.nodes;
  graph = layoutTree(data, collapsed);
  $('empty').hidden = data.length > 0;
  $('empty').textContent = '暂无问答。发送一条新消息，结束后会自动加入讨论树。';
  $('counts').textContent = `${data.length} 个问答 · ${data.filter(n => n.classification === 'ready').length} 个已归类`;
  $('retry').hidden = !data.some(n => n.classification === 'error');
  $('canvas').style.width = `${graph.width}px`; $('canvas').style.height = `${graph.height}px`;
  const svg = $('edges'); svg.replaceChildren(); svg.setAttribute('width', graph.width); svg.setAttribute('height', graph.height);
  for (const edge of graph.edges) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const x1 = edge.from.x + 220, y1 = edge.from.y + 40, x2 = edge.to.x, y2 = edge.to.y + 40;
    path.setAttribute('d', `M${x1},${y1} C${x1 + 34},${y1} ${x2 - 34},${y2} ${x2},${y2}`);
    path.setAttribute('class', edge.provisional ? 'provisional' : ''); svg.append(path);
  }
  $('nodes').replaceChildren();
  for (const node of graph.nodes) {
    const box = document.createElement('div'); box.className = `node ${node.id === 'root' ? 'root' : ''} ${node.id === selected ? 'selected' : ''}`;
    box.style.left = `${node.x}px`; box.style.top = `${node.y}px`;
    const button = document.createElement('button'); button.className = 'node-main';
    button.setAttribute('aria-pressed', String(node.id === selected));
    button.append(textElement('span', node.id === 'root' ? '讨论起点' : node.classification === 'ready' ? node.relation : labels[node.classification], `node-meta ${node.classification || ''}`));
    button.append(textElement('span', node.title, 'node-title'));
    button.title = node.title;
    button.onclick = () => {
      selected = node.id === 'root' ? null : node.id;
      draw();
      if (selected) void openNode(node);
      else { openRequest++; $('navigation-status').textContent = '实线表示模型判断的父子关系；点击问答节点在标签页查看原文。'; }
    };
    box.append(button);
    if (node.childCount) {
      const toggle = document.createElement('button'); toggle.className = 'collapse'; toggle.textContent = collapsed.has(node.id) ? '+' : '−';
      toggle.setAttribute('aria-label', `${collapsed.has(node.id) ? '展开' : '折叠'} ${node.title}`);
      toggle.onclick = () => { collapsed.has(node.id) ? collapsed.delete(node.id) : collapsed.add(node.id); draw(); }; box.append(toggle);
    }
    $('nodes').append(box);
  }
  zoom(scale);
  if (!fitted && data.length) { fitted = true; zoom(Math.max(.75, Math.min(1, ($('viewport').clientWidth - 32) / graph.width))); }
}
async function poll() {
  if (polling || !sessionId || !connected) return;
  polling = true; const session = sessionId;
  try {
    const data = await call('read_discussion_tree', { session_id: session, ...(revision ? { revision } : {}) });
    if (session !== sessionId) return;
    if (data.sessionId !== session) throw new Error('会话不匹配');
    revision = data.revision;
    if (!data.unchanged) {
      snapshot = data; draw();

    }
    $('sync').textContent = `已同步 ${new Date().toLocaleTimeString()}`; diag.error = null;
  } catch (error) { $('sync').textContent = '同步失败 · 自动重试中'; diag.error = error.message; }
  finally { polling = false; report(); clearTimeout(timer); timer = setTimeout(poll, 2000); }
}
app.ontoolresult = result => {
  const data = result.structuredContent;
  if (data?.probe !== 'thread-panel-probe') return;
  bindSession(data.sessionId);
  $('sync').textContent = sessionId ? '同步中…' : '请选择本地会话'; report(); refreshSessions(); poll();
};
app.onhostcontextchanged = ctx => { diag.displayMode = ctx.displayMode; if (ctx.theme) document.documentElement.dataset.theme = ctx.theme; report(); };
app.onerror = error => { diag.bridgeError = String(error); report(); };
if (window.parent === window) { $('connection').textContent = '预览模式'; $('empty').textContent = '请从 Codex 打开讨论树以连接真实问答。'; }
else app.connect().then(() => { connected = true; $('connection').textContent = '已连接'; diag.displayMode = app.getHostContext()?.displayMode; report(); refreshSessions(); poll(); }).catch(error => { $('connection').textContent = '连接失败'; diag.error = error.message; report(); });
