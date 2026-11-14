import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js';

// Protocol adapter for @openai/mcp-extensions 0.2.1 files.open.
// Its packaged SDK currently peers on ext-apps 1.x; this app uses 2.x.
export function createQaTabOpener(app, call) {
  const pending = new Map();
  return function open(sessionId, turnId) {
    const key = `${sessionId}/${turnId}`;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      if (!app.getHostCapabilities()?.experimental?.['openai/files']) {
        throw new Error('当前宿主未提供文件标签页接口，请更新桌面应用后重试');
      }
      const file = await call('prepare_qa_file', { session_id: sessionId, turn_id: turnId });
      if (file.sessionId !== sessionId || file.turnId !== turnId || typeof file.path !== 'string') {
        throw new Error('问答文件与所选节点不匹配');
      }
      await app.request({ method: 'openai/files/open', params: { path: file.path } }, EmptyResultSchema);
      return file;
    })().finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
}
