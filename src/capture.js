import { captureEvent } from './capture-store.js';
import { syncPending } from './curated-tree.js';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const root = process.env.PROBE_PROJECT_ROOT || PROBE_PROJECT_ROOT, input = JSON.parse(raw);
    const result = await captureEvent(root, input);
    if (!result.ignored) {
      // Reconcile even when the panel is closed. Contention is retried by polling.
      try { await syncPending(root, input.session_id); } catch (error) { process.stderr.write(`Pending node: ${error.message}\n`); }
    }
    process.stdout.write('{}');
  } catch (error) {
    // Diagnostic only: never block a prompt or ask the model to continue.
    process.stderr.write(`Thread Panel capture failed: ${error.message}\n`);
    process.stdout.write(JSON.stringify({ systemMessage: `Thread Panel capture failed: ${error.message}` }));
  }
});
