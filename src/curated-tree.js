import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readSnapshot, validId } from './capture-store.js';
import { classifyWithCodex, validateClassification } from './classifier.js';

const empty = () => ({ version: 1, nodes: [], pending: null });
async function load(root, id) {
  if (!validId(id)) throw new Error('Invalid session ID');
  try { return JSON.parse(await readFile(join(root, '.probe', 'curated', `${id}.json`), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return empty(); }
}
async function save(root, id, state) {
  const dir = join(root, '.probe', 'curated'); await mkdir(dir, { recursive: true });
  const temp = join(dir, `${id}-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await rename(temp, join(dir, `${id}.json`));
}
async function mutate(root, id, fn) {
  if (!validId(id)) throw new Error('Invalid session ID');
  const dir = join(root, '.probe', 'curated'); await mkdir(dir, { recursive: true });
  const lock = join(dir, `${id}.lock`);
  try { await mkdir(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (Date.now() - (await stat(lock)).mtimeMs > 300000) { await rm(lock, { recursive: true, force: true }); return mutate(root, id, fn); }
    throw new Error('讨论树正在更新，请稍后重试');
  }
  try { const state = await load(root, id); const result = await fn(state); await save(root, id, state); return result; }
  finally { await rm(lock, { recursive: true, force: true }); }
}
function parentExists(state, id) {
  if (id !== 'root' && !state.nodes.some(n => n.id === id && (n.kind === 'category' || n.turnId))) throw new Error('父节点不存在或仍为空');
}
export function parseOutline(text) {
  if (typeof text !== 'string' || text.length > 30000) throw new Error('大纲过长');
  const rows = []; let baseHeading;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    let depth, title;
    if (heading) { baseHeading ??= heading[1].length; depth = heading[1].length - baseHeading; title = heading[2]; }
    else { const spaces = line.match(/^ */)[0].length; if (line.includes('\t') || spaces % 2) throw new Error('列表每层使用两个空格缩进'); depth = spaces / 2; title = line.trim().replace(/^(?:[-*+] |\d+[.)] )/, ''); }
    if (depth < 0 || depth > (rows.at(-1)?.depth ?? -1) + 1 || !title.trim() || title.length > 120) throw new Error('大纲层级不能跳级，标题需为 1–120 字');
    rows.push({ depth, title: title.trim() });
  }
  if (!rows.length || rows.length > 300) throw new Error('大纲需要 1–300 个分类节点');
  return rows;
}
export async function createOutline(root, id, text, replace = false) {
  const rows = parseOutline(text);
  return mutate(root, id, state => {
    if (replace) { state.nodes = []; state.pending = null; }
    if (state.nodes.length + rows.length > 300) throw new Error('一棵树最多 300 个节点');
    const stack = ['root'];
    for (const row of rows) { const node = { id: randomUUID(), kind: 'category', title: row.title, parentId: stack[row.depth], source: 'outline' }; state.nodes.push(node); stack[row.depth + 1] = node.id; }
    return { created: rows.length };
  });
}
export async function armChild(root, id, parentId) {
  return mutate(root, id, async state => {
    if (state.pending) throw new Error('已有等待收录的节点，请先完成或取消');
    parentExists(state, parentId);
    if (state.nodes.length >= 300) throw new Error('一棵树最多 300 个节点');
    const snapshot = await readSnapshot(root, id, { limit: null });
    const node = { id: randomUUID(), kind: 'qa', title: '等待下一轮问答', parentId, turnId: null, source: 'manual' };
    state.nodes.push(node); state.pending = { nodeId: node.id, armedAt: new Date().toISOString(), existing: snapshot.turns.map(t => t.turnId), turnId: null };
    return { nodeId: node.id };
  });
}
function reconcile(state, turns) {
  const pending = state.pending; if (!pending) return false;
  const used = new Set(state.nodes.map(n => n.turnId).filter(Boolean));
  const turn = pending.turnId ? turns.find(t => t.turnId === pending.turnId) : turns.find(t => !pending.existing.includes(t.turnId) && !used.has(t.turnId) && t.firstSeenAt >= pending.armedAt && t.prompts.some(Boolean));
  if (!turn) return false;
  pending.turnId = turn.turnId;
  const node = state.nodes.find(n => n.id === pending.nodeId);
  if (!node) { state.pending = null; return true; }
  if (turn.status === 'completed') {
    node.turnId = turn.turnId; node.title = turn.prompts.filter(Boolean).join(' ').slice(0, 80); state.pending = null;
  } else node.title = turn.status === 'interrupted' ? '本轮已中断，可取消等待' : '已绑定本轮，等待完整回复';
  return true;
}
export async function syncPending(root, id) {
  const state = await load(root, id); if (!state.pending) return;
  await mutate(root, id, async fresh => { reconcile(fresh, (await readSnapshot(root, id, { limit: null })).turns); });
}
export async function cancelPending(root, id) {
  return mutate(root, id, state => { if (state.pending) state.nodes = state.nodes.filter(n => n.id !== state.pending.nodeId); state.pending = null; return { cancelled: true }; });
}
export async function readCuratedTree(root, id, { sync = true } = {}) {
  if (sync) await syncPending(root, id);
  const state = await load(root, id), snapshot = await readSnapshot(root, id, { limit: null });
  const used = new Set(state.nodes.map(n => n.turnId).filter(Boolean));
  const data = { sessionId: id, nodes: state.nodes, pending: state.pending ? { nodeId: state.pending.nodeId, turnId: state.pending.turnId } : null,
    uncollected: snapshot.turns.filter(t => !used.has(t.turnId) && t.turnId !== state.pending?.turnId).map(t => ({ turnId: t.turnId, title: t.prompts.filter(Boolean).join(' ').slice(0, 100), status: t.status, firstSeenAt: t.firstSeenAt })), totalTurns: snapshot.totalTurns };
  return { ...data, revision: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
}
export async function smartCollect(root, id, turnId, classify = classifyWithCodex) {
  return mutate(root, id, async state => {
    const turns = (await readSnapshot(root, id, { limit: null })).turns;
    reconcile(state, turns);
    if (state.nodes.some(n => n.turnId === turnId) || state.pending?.turnId === turnId) throw new Error('该问答已收录或已绑定待填充节点');
    const turn = turns.find(t => t.turnId === turnId);
    if (!turn || turn.status !== 'completed' || !turn.prompts.some(Boolean)) throw new Error('请选择有完整提问和回复的未收录问答');
    if (state.nodes.length >= 300) throw new Error('一棵树最多 300 个节点');
    const candidates = state.nodes.filter(n => n.kind === 'category' || n.turnId).map(n => ({ turnId: n.id, kind: n.kind, title: n.title, summary: n.summary ?? '', parentId: n.parentId }));
    const result = validateClassification(await classify(turn, candidates), ['root', ...candidates.map(n => n.turnId)]);
    const node = { ...result, id: randomUUID(), kind: 'qa', turnId, source: 'model' };
    state.nodes.push(node); return { nodeId: node.id };
  });
}
