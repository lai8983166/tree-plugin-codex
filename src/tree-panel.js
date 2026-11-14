import { App } from '@modelcontextprotocol/ext-apps';
import { layoutTree } from './tree-layout.js';
import { createQaTabOpener } from './qa-tab.js';
import styles from './panel.css';
import pickerStyles from './session-picker.css';
document.head.insertAdjacentHTML('beforeend', `<style>${styles}${pickerStyles}</style>`);
document.body.innerHTML = `<main>
<header><div><div class="eyebrow">DISCUSSION ATLAS</div><h1>讨论树 <span>0.7.0</span></h1></div><span id="connection" class="badge">连接中</span></header>
<div class="subhead"><span id="counts">按大纲组织，按需收录问答</span><span id="sync">等待绑定会话</span></div>
<p id="thread-binding" role="status">正在绑定当前会话…</p>
<button id="import-history" disabled>导入历史到未收录列表（不调用模型）</button>
<div id="session-id-fallback" class="session-picker"><label for="session-id-input">宿主未绑定时，填写当前会话 ID</label><input id="session-id-input" placeholder="当前会话 ID" aria-label="当前会话 ID"><button id="bind-session-id">绑定</button></div>
<details id="manual-session"><summary>手动指定会话（宿主未提供会话信息时使用）</summary><div class="session-picker"><label for="session-picker">本地会话</label><select id="session-picker"><option value="">请选择会话</option></select><button id="refresh-sessions">刷新列表</button></div></details>
<details><summary>用大纲创建分类节点</summary><p>使用 Markdown 标题，或每层两个空格缩进的列表。</p><textarea id="outline" rows="6" placeholder="- 学习主题&#10;  - 基础概念&#10;  - 应用练习"></textarea><label><input type="checkbox" id="replace-outline">重建：移除树内节点和等待绑定，保留本地问答</label><button id="create-outline" disabled>创建分类节点（不调用模型）</button></details>
<div class="session-picker"><button id="add-child">在选中节点下创建空问答子节点</button><button id="cancel-pending" hidden>取消等待节点</button></div>
<details><summary>未收录问答</summary><div class="session-picker"><select id="uncollected" aria-label="未收录问答"></select><button id="preview-turn">查看问答</button><button id="smart-collect">智能收录（一次模型请求）</button></div></details>
<div id="node-menu" role="menu" hidden><button id="menu-child" role="menuitem">创建空问答子节点，收录下一轮</button></div>
<div class="workspace"><section class="map-section" aria-label="讨论树画布">
<div class="toolbar"><div class="segmented"><button id="zoom-out" aria-label="缩小">−</button><span id="zoom-label">100%</span><button id="zoom-in" aria-label="放大">＋</button></div><button id="fit">适应画布</button><button id="expand">展开全部</button></div>
<div id="viewport" tabindex="0" aria-label="可滚动的树形图"><div id="extent"><div id="canvas"><svg id="edges" aria-hidden="true"></svg><div id="nodes"></div></div></div></div>
<div id="empty">正在等待会话数据…</div><footer><span class="dot"></span>右键创建空子节点 · 点击已收录问答查看完整内容</footer>
</section></div>
<p id="navigation-status" role="status">问答从本地读取；同一节点使用同一文件标签页，打开不调用模型。</p>
<details class="diagnostics"><summary>连接与模型说明</summary><p>采集和历史导入只更新未收录列表。空问答节点绑定下一轮提问，回复完整后填入。智能收录仅对选中问答发起一次后台模型请求，不向当前会话发送消息，不自动重试。</p><pre id="diagnostic"></pre></details>
</main>`;
const $ = id => document.getElementById(id);
const app = new App({ name: 'discussion-tree', version: '0.7.0' });
let sessionId = null, revision = null, snapshot = null, connected = false, polling = false, timer;
let selected = null, collapsed = new Set(), scale = 1, graph = null, fitted = false;
const diag = {};
const openQaTab = createQaTabOpener(app, call);
let openRequest = 0;
async function openNode(node) {
  const request = ++openRequest, session = sessionId;
  $('navigation-status').textContent = `正在打开「${node.title}」…`;
  try {
    await openQaTab(session, node.turnId);
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
  $('uncollected').replaceChildren(); $('node-menu').hidden = true; $('cancel-pending').hidden = true;
  $('empty').hidden = false; $('empty').textContent = sessionId ? '正在读取本地问答…' : '请选择本地会话；打开面板不调用模型。';
  $('counts').textContent = '按大纲组织，按需收录问答';
  $('create-outline').disabled = !sessionId; $('import-history').disabled = !sessionId;
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
$('bind-session-id').onclick = () => {
  const id = $('session-id-input').value.trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) { $('navigation-status').textContent = '请输入有效的当前会话 ID'; return; }
  bindSession(id); $('thread-binding').textContent = '已绑定手动指定的会话 ID';
};
$('import-history').onclick = async () => {
  const session = sessionId; if (!session) return;
  $('import-history').disabled = true;
  $('navigation-status').textContent = '正在读取本地历史到未收录列表…';
  try {
    const result = await call('import_current_history', { session_id: session });
    if (session !== sessionId) return;
    revision = null; await poll(); await refreshSessions();
    $('navigation-status').textContent = `已导入 ${result.importedTurns} 轮历史，问答不会自动入树。${result.partial ? '历史末尾尚未写完，已跳过；稍后可再次导入。' : ''}`;
  } catch (error) { if (session === sessionId) $('navigation-status').textContent = `导入失败：${error.message}`; }
  finally { $('import-history').disabled = !sessionId; }
};
let menuParent = 'root', mutating = false;
async function updateTree(name, args, message) {
  if (!sessionId || mutating) return;
  const session = sessionId; mutating = true;
  $('navigation-status').textContent = name === 'smart_collect_turn' ? '后台模型正在生成标题并选择父节点…' : '正在保存…';
  try { await call(name, { session_id: session, ...args }); if (session === sessionId) { revision = null; await poll(); $('navigation-status').textContent = message; } }
  catch (error) { if (session === sessionId) $('navigation-status').textContent = error.message; }
  finally { mutating = false; }
}
$('create-outline').onclick = () => updateTree('create_outline', { outline: $('outline').value, replace: $('replace-outline').checked }, '大纲分类已创建');
const addChild = parent => updateTree('arm_qa_child', { parent_id: parent }, '空节点已创建。现在发送下一轮请求，完整回复后将自动填入。');
$('add-child').onclick = () => addChild(selected ?? 'root');
$('menu-child').onclick = () => { $('node-menu').hidden = true; addChild(menuParent); };
document.addEventListener('click', event => { if (!$('node-menu').contains(event.target)) $('node-menu').hidden = true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('node-menu').hidden = true; });
$('cancel-pending').onclick = () => updateTree('cancel_pending_node', {}, '等待节点已取消，本地问答保留');
$('smart-collect').onclick = () => { const id = $('uncollected').value; if (id) updateTree('smart_collect_turn', { turn_id: id }, '选中的问答已智能收录'); };
$('preview-turn').onclick = () => { const turn = snapshot?.uncollected.find(t => t.turnId === $('uncollected').value); if (turn) openNode(turn); };
async function call(name, args) {
  const result = await app.callServerTool({ name, arguments: args }, name === 'smart_collect_turn' ? { timeout: 150000 } : undefined);
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
function textElement(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
function draw() {
  if (!snapshot) return;
  const data = snapshot.nodes;
  if (selected !== 'root' && !data.some(n => n.id === selected)) selected = null;
  graph = layoutTree(data, collapsed);
  $('empty').hidden = data.length > 0;
  $('empty').textContent = '先用大纲创建分类，或在讨论起点下创建空问答节点。';
  $('counts').textContent = `${data.filter(n => n.kind === 'category').length} 个分类 · ${data.filter(n => n.turnId).length} 个问答`;
  $('cancel-pending').hidden = !snapshot.pending;
  const picker = $('uncollected'), old = picker.value;
  picker.replaceChildren(new Option('请选择未收录问答', ''));
  for (const turn of snapshot.uncollected) picker.add(new Option(`${turn.title} · ${turn.status} · ${new Date(turn.firstSeenAt).toLocaleString()}`, turn.turnId));
  picker.value = old;
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
    button.append(textElement('span', node.id === 'root' ? '讨论起点' : node.kind === 'category' ? '分类标签' : node.turnId ? '已收录问答' : '等待收录', 'node-meta'));
    button.append(textElement('span', node.title, 'node-title'));
    button.title = node.title;
    button.onclick = () => {
      selected = node.id === 'root' ? null : node.id;
      draw();
      if (node.kind === 'qa' && node.turnId) void openNode(node);
      else { openRequest++; $('navigation-status').textContent = '已选中父节点，可右键创建空问答子节点。'; }
    };
    button.oncontextmenu = event => { event.preventDefault(); selected = node.id; menuParent = node.id; const menu = $('node-menu'); menu.hidden = false; menu.style.left = Math.min(event.clientX, Math.max(0, window.innerWidth - 300)) + 'px'; menu.style.top = Math.min(event.clientY, Math.max(0, window.innerHeight - 60)) + 'px'; };
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
  $('thread-binding').textContent = data.sessionId ? '已绑定当前会话' : '宿主未提供当前会话 ID，暂时无法自动加载。可展开下方手动指定会话。';
  $('manual-session').hidden = Boolean(data.sessionId);
  $('session-id-fallback').hidden = Boolean(data.sessionId);
  $('sync').textContent = sessionId ? '同步中…' : '请选择本地会话'; report(); refreshSessions(); poll();
};
app.onhostcontextchanged = ctx => { diag.displayMode = ctx.displayMode; if (ctx.theme) document.documentElement.dataset.theme = ctx.theme; report(); };
app.onerror = error => { diag.bridgeError = String(error); report(); };
if (window.parent === window) { $('connection').textContent = '预览模式'; $('empty').textContent = '请从 Codex 打开讨论树以连接真实问答。'; }
else app.connect().then(() => { connected = true; $('connection').textContent = '已连接'; diag.displayMode = app.getHostContext()?.displayMode; report(); refreshSessions(); poll(); }).catch(error => { $('connection').textContent = '连接失败'; diag.error = error.message; report(); });
