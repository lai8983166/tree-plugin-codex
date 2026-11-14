import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { validId } from './capture-store.js';

const messageText = content => typeof content === 'string' ? content : (content ?? [])
  .filter(c => ['text', 'Text', 'input_text', 'output_text'].includes(c.type))
  .map(c => c.text ?? '').join('\n');

export async function parseHistory(file, sessionId) {
  const turns = new Map(); let meta, current, broken = false, partial = false;
  const get = (id, at) => {
    if (!validId(id)) return null;
    if (!turns.has(id)) turns.set(id, { turnId: id, prompts: [], answer: null, status: 'waiting', firstSeenAt: at, updatedAt: at });
    return turns.get(id);
  };
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    if (broken) throw new Error('历史文件中间存在损坏记录，未导入');
    let record;
    try { record = JSON.parse(line); } catch { broken = true; partial = true; continue; }
    const p = record.payload ?? {}, at = record.timestamp;
    if (record.type === 'session_meta') {
      if ((!p.id && !p.session_id) || [p.id, p.session_id].some(id => id != null && id !== sessionId)) throw new Error('历史文件会话 ID 不匹配');
      meta = p; continue;
    }
    if (record.type === 'turn_context' || (record.type === 'event_msg' && p.type === 'task_started')) current = p.turn_id;
    if (record.type !== 'event_msg' || !['item_completed', 'user_message', 'task_complete', 'turn_aborted'].includes(p.type)) continue;
    if (p.thread_id && p.thread_id !== sessionId) continue;
    const item = p.item;
    if (p.type === 'item_completed' && !['UserMessage', 'AgentMessage'].includes(item?.type)) continue;
    if (item?.type === 'AgentMessage' && !['final', 'final_answer'].includes(item.phase)) continue;
    const turn = get(p.turn_id ?? current, at);
    if (!turn) continue;
    if (item?.type === 'UserMessage' || p.type === 'user_message') {
      const text = item ? messageText(item.content) : p.message;
      if (typeof text === 'string' && text && !turn.prompts.includes(text)) turn.prompts.push(text);
    } else if (item?.type === 'AgentMessage' || p.type === 'task_complete') {
      const text = item ? messageText(item.content) : p.last_agent_message;
      if (typeof text === 'string') { turn.answer = text; turn.status = 'completed'; }
    } else if (p.type === 'turn_aborted') turn.status = 'interrupted';
    turn.updatedAt = at;
  }
  if (!meta || (meta.id ?? meta.session_id) !== sessionId) throw new Error('历史文件会话 ID 不匹配');
  const result = [...turns.values()].filter(t => t.prompts.length);
  if (result.some(t => !Number.isFinite(Date.parse(t.firstSeenAt)) || !Number.isFinite(Date.parse(t.updatedAt)))) throw new Error('历史记录缺少有效时间');
  if (!result.length) throw new Error('未找到可导入的用户问答；此历史格式可能不受支持');
  return { sessionId, turns: result, partial };
}

async function findHistory(dir, id, found = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return found; throw error; }
  for (const entry of entries) {
    if (entry.isDirectory()) await findHistory(join(dir, entry.name), id, found);
    else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`)) found.push(join(dir, entry.name));
  }
  return found;
}

export async function importHistory(root, sessionId, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  if (!validId(sessionId)) throw new Error('Invalid session ID');
  const files = [...await findHistory(join(codexHome, 'sessions'), sessionId), ...await findHistory(join(codexHome, 'archived_sessions'), sessionId)];
  if (!files.length) throw new Error('找不到该会话的本地历史。仅支持当前机器保存的 Codex 会话。');
  if (files.length !== 1) throw new Error('找到多个同 ID 历史文件，无法安全选择');
  const data = await parseHistory(files[0], sessionId);
  const dir = join(resolve(root), '.probe', 'history'); await mkdir(dir, { recursive: true });
  const temp = join(dir, `${sessionId}-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
  await rename(temp, join(dir, `${sessionId}.json`));
  return { sessionId, importedTurns: data.turns.length, partial: data.partial, classificationEnabled: false };
}
