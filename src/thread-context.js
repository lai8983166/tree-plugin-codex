import { validId } from './capture-store.js';

// Use per-request host metadata, never the newest capture or a process-wide ID.
export function resolveThreadSession(explicitId, meta = {}) {
  let turn = meta['x-codex-turn-metadata'];
  if (typeof turn === 'string') {
    try { turn = JSON.parse(turn); } catch { turn = null; }
  }
  const candidates = [meta['openai/threadId'], meta['openai/thread_id'],
    meta.codexThreadId, meta.codex_thread_id, meta.threadId, meta.thread_id, turn?.thread_id];
  const hostId = candidates.find(validId);
  if (hostId && explicitId && hostId !== explicitId) throw new Error('Requested session does not match the current host thread');
  return hostId ?? (validId(explicitId) ? explicitId : null);
}
