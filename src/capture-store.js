import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export async function listCapturedSessions(root) {
  let entries;
  try { entries = await readdir(join(resolve(root), '.probe', 'events'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') entries = []; else throw error; }
  const ids = new Set(entries.filter(e => e.isDirectory() && validId(e.name)).map(e => e.name));
  try { for (const file of await readdir(join(resolve(root), '.probe', 'history'))) if (file.endsWith('.json') && validId(file.slice(0, -5))) ids.add(file.slice(0, -5)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sessions = await Promise.all([...ids].map(async id => {
    const snapshot = await readSnapshot(root, id, { limit: 1 });
    return { sessionId: id, totalTurns: snapshot.totalTurns, updatedAt: snapshot.lastEventAt,
      label: snapshot.turns[0]?.prompts.filter(Boolean).join(' ').slice(0, 60) || '未捕获提问' };
  }));
  return sessions.filter(s => s.totalTurns > 0).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function captureEvent(root, input) {
  const event = input.hook_event_name;
  if (!['UserPromptSubmit', 'Stop', 'Interrupt'].includes(event)) return { ignored: 'event' };
  if (!validId(input.session_id) || !validId(input.turn_id)) throw new Error('Invalid session_id or turn_id');
  if (typeof input.cwd !== 'string') throw new Error('Missing cwd');
  const [expected, actual] = await Promise.all([realpath(root), realpath(input.cwd)]);
  if (expected !== actual) return { ignored: 'outside-project' };
  const text = event === 'UserPromptSubmit' ? input.prompt : event === 'Stop' ? input.last_assistant_message : null;
  if (text != null && typeof text !== 'string') throw new Error('Expected text or null');
  const record = {
    sessionId: input.session_id, turnId: input.turn_id, event,
    text: text ?? null, capturedAt: new Date().toISOString(),
    stopHookActive: event === 'Stop' ? Boolean(input.stop_hook_active) : undefined
  };
  // No transcript, tool output, credentials or hidden model reasoning is read.
  const key = createHash('sha256').update(JSON.stringify([record.sessionId, record.turnId, event, record.text])).digest('hex');
  const dir = join(resolve(root), '.probe', 'events', record.sessionId);
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${key}.json`);
  try { await access(target); return { duplicate: true }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = join(dir, `${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
  await rename(temp, target);
  return { captured: true };
}

export async function readSnapshot(root, sessionId, { limit = 30 } = {}) {
  if (!validId(sessionId)) throw new Error('Invalid session ID');
  const dir = join(resolve(root), '.probe', 'events', sessionId);
  let files;
  try { files = await readdir(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
  const records = await Promise.all(files.filter(file => /^[a-f0-9]{64}\.json$/.test(file)).map(async file => JSON.parse(await readFile(join(dir, file), 'utf8'))));
  records.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const grouped = new Map();
  for (const record of records) {
    if (record.sessionId !== sessionId) continue;
    let turn = grouped.get(record.turnId);
    if (!turn) { turn = { turnId: record.turnId, prompts: [], answer: null, status: 'waiting', firstSeenAt: record.capturedAt }; grouped.set(record.turnId, turn); }
    if (record.event === 'UserPromptSubmit') turn.prompts.push(record.text);
    if (record.event === 'Stop') { turn.answer = record.text; turn.status = record.text == null ? 'missing-answer' : 'completed'; }
    if (record.event === 'Interrupt') turn.status = 'interrupted';
    turn.updatedAt = record.capturedAt;
  }
  let history = { turns: [] };
  try { history = JSON.parse(await readFile(join(resolve(root), '.probe', 'history', `${sessionId}.json`), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const saved of history.turns) {
    const live = grouped.get(saved.turnId);
    const prompts = [...saved.prompts];
    for (const prompt of live?.prompts ?? []) if (!prompts.some(p => p?.trim() === prompt?.trim())) prompts.push(prompt);
    grouped.set(saved.turnId, { ...saved, ...(live && live.updatedAt >= saved.updatedAt ? live : {}), prompts,
      firstSeenAt: saved.firstSeenAt < (live?.firstSeenAt ?? saved.firstSeenAt) ? saved.firstSeenAt : (live?.firstSeenAt ?? saved.firstSeenAt) });
  }
  const turns = [...grouped.values()].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
  const revision = createHash('sha256').update(JSON.stringify(turns)).digest('hex');
  return { sessionId, revision, eventCount: records.length, totalTurns: turns.length,
    completedTurns: turns.filter(t => t.status === 'completed').length,
    // Bound the panel response; all records remain on disk for this probe.
    turns: limit === null ? turns : turns.slice(-limit), lastEventAt: turns.map(t => t.updatedAt).sort().at(-1) ?? null };
}
