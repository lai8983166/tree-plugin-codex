import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readSnapshot, validId } from './capture-store.js';

export async function prepareQaFile(root, sessionId, turnId) {
  if (!validId(sessionId) || !validId(turnId)) throw new Error('Invalid session or turn ID');
  const snapshot = await readSnapshot(root, sessionId, { limit: null });
  const turn = snapshot.turns.find(turn => turn.turnId === turnId);
  if (!turn) throw new Error('当前会话找不到该轮问答');
  const question = turn.prompts.join('\n\n');
  const answer = turn.answer ?? (turn.status === 'interrupted' ? '（本轮已中断，未捕获最终回答）' : '（尚未捕获最终回答，请完成后再次点击节点）');
  // Preserve Markdown rather than wrapping the entire exchange in a code block.
  // The host's Markdown preview handles highlighting, images, tables and math.
  const content = `# 完整问答\n\n本地保存的 Markdown · 打开此文件不调用模型\n\n## 提问\n\n${question}\n\n## 回答\n\n${answer}\n\n---\n\n会话：${sessionId}\n\n轮次：${turnId}\n\n状态：${turn.status}\n\n更新时间：${turn.updatedAt}\n`;
  const dir = resolve(root, '.probe', 'qa', sessionId);
  const path = join(dir, `${turnId}.md`);
  await mkdir(dir, { recursive: true });
  let previous;
  try { previous = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== content) {
    const temporary = join(dir, `${turnId}.${randomUUID()}.tmp`);
    try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  return { path, sessionId, turnId, updatedAt: turn.updatedAt };
}
