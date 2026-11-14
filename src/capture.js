import { captureEvent } from './capture-store.js';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    await captureEvent(process.env.PROBE_PROJECT_ROOT || PROBE_PROJECT_ROOT, JSON.parse(raw));
    process.stdout.write('{}');
  } catch (error) {
    // Diagnostic only: never block a prompt or ask the model to continue.
    process.stderr.write(`Thread Panel capture failed: ${error.message}\n`);
    process.stdout.write(JSON.stringify({ systemMessage: `Thread Panel capture failed: ${error.message}` }));
  }
});
