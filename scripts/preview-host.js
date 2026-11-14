import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const sessionId = new URLSearchParams(location.search).get('session');
const frame = document.querySelector('iframe');
const bridge = new AppBridge(null, { name: 'Local development preview', version: '1' }, { serverTools: {} }, { hostContext: { displayMode: 'fullscreen', theme: 'light' } });
bridge.oncalltool = async params => {
  const response = await fetch('/tool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  return response.json();
};
bridge.oninitialized = async () => {
  await bridge.sendToolInput({ arguments: { session_id: sessionId } });
  await bridge.sendToolResult({ content: [], structuredContent: { probe: 'thread-panel-probe', version: '0.3.0', sessionId } });
};
await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
frame.src = '/panel';
