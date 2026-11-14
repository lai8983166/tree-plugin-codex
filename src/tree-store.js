import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readSnapshot, validId } from './capture-store.js';
import { classifyWithCodex, validateClassification } from './classifier.js';

export const fingerprint = turn => createHash('sha256').update(JSON.stringify([turn.prompts, turn.answer])).digest('hex');
async function load(root, sessionId) {
  if (!validId(sessionId)) throw new Error('Invalid session ID');
  try { return JSON.parse(await readFile(join(root, '.probe', 'trees', `${sessionId}.json`), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { nodes: {}, errors: {}, working: null }; }
}
async function save(root, sessionId, state) {
  const dir = join(root, '.probe', 'trees'); await mkdir(dir, { recursive: true });
  const temp = join(dir, `${sessionId}-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await rename(temp, join(dir, `${sessionId}.json`));
}
export async function readTree(root, sessionId) {
  const snapshot = await readSnapshot(root, sessionId, { limit: null });
  const state = await load(root, sessionId);
  const nodes = snapshot.turns.map(turn => {
    const stored = state.nodes[turn.turnId];
    const classified = stored?.fingerprint === fingerprint(turn);
    const error = state.errors[turn.turnId];
    const active = state.working?.turnId === turn.turnId && Date.now() - Date.parse(state.working.at) < 180000;
    return { turnId: turn.turnId, title: turn.prompts.filter(Boolean).join(' ').slice(0, 40) || '未捕获问题',
      parentId: null, relation: null, ...(classified ? stored : {}),
      status: turn.status, classification: classified ? 'ready' : turn.status !== 'completed' ? 'waiting' : active ? 'classifying' : error ? 'error' : 'pending',
      error: classified ? null : error?.message, firstSeenAt: turn.firstSeenAt, updatedAt: turn.updatedAt };
  });
  const payload = { sessionId, nodes, totalTurns: snapshot.totalTurns, completedTurns: snapshot.completedTurns };
  return { ...payload, revision: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}
export async function getTurn(root, sessionId, turnId) {
  const snapshot = await readSnapshot(root, sessionId, { limit: null });
  const turn = snapshot.turns.find(t => t.turnId === turnId);
  if (!turn) throw new Error('当前会话找不到该轮问答');
  return turn;
}
export async function classifyNext(root, sessionId, classify = classifyWithCodex) {
  if (!validId(sessionId)) throw new Error('Invalid session ID');
  const dir = join(root, '.probe', 'trees'); await mkdir(dir, { recursive: true });
  const lock = join(dir, `${sessionId}.lock`);
  try { await mkdir(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Recover after an interrupted worker; model timeout is 120 seconds.
    if (Date.now() - (await stat(lock)).mtimeMs > 300000) await rm(lock, { recursive: true, force: true });
    return false;
  }
  try {
    const state = await load(root, sessionId);
    const snapshot = await readSnapshot(root, sessionId, { limit: null });
    const eligible = snapshot.turns.filter(t => t.status === 'completed' && t.prompts.some(Boolean));
    const turn = eligible.find(t => state.nodes[t.turnId]?.fingerprint !== fingerprint(t) && !state.errors[t.turnId]);
    if (!turn) return false;
    state.working = { turnId: turn.turnId, at: new Date().toISOString() }; await save(root, sessionId, state);
    try {
      const index = snapshot.turns.findIndex(t => t.turnId === turn.turnId);
      const candidates = snapshot.turns.slice(0, index).filter(t => state.nodes[t.turnId]?.fingerprint === fingerprint(t)).map(t => {
        const n = state.nodes[t.turnId]; return { turnId: t.turnId, title: n.title, summary: n.summary, parentId: n.parentId };
      });
      const result = validateClassification(await classify(turn, candidates), ['root', ...candidates.map(n => n.turnId)]);
      state.nodes[turn.turnId] = { ...result, fingerprint: fingerprint(turn), classifiedAt: new Date().toISOString(), source: 'model' };
      delete state.errors[turn.turnId];
    } catch (error) { state.errors[turn.turnId] = { message: error.message, at: new Date().toISOString() }; }
    state.working = null; await save(root, sessionId, state); return true;
  } finally { await rm(lock, { recursive: true, force: true }); }
}
export async function retryFailed(root, sessionId) {
  if (!validId(sessionId)) throw new Error('Invalid session ID');
  const dir = join(root, '.probe', 'trees'); await mkdir(dir, { recursive: true });
  const lock = join(dir, `${sessionId}.lock`);
  try { await mkdir(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('仍有节点正在归类，请稍后重试'); throw error; }
  try { const state = await load(root, sessionId); state.errors = {}; await save(root, sessionId, state); }
  finally { await rm(lock, { recursive: true, force: true }); }
}
export function createCoordinator(root, classify) {
  const sessions = new Set(); let running = false, stopped = false;
  async function tick() {
    if (running || stopped) return;
    running = true;
    try { for (const id of sessions) { try { await classifyNext(root, id, classify); } catch (error) { console.error('Tree worker:', error.message); } } }
    finally { running = false; }
  }
  const timer = setInterval(tick, 2000); timer.unref();
  return { track(id) { if (!validId(id)) throw new Error('Invalid session ID'); sessions.add(id); void tick(); }, close() { stopped = true; clearInterval(timer); } };
}
