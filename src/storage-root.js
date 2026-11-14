import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Shared by MCP and Hooks, independent of their cwd and installed plugin version.
export function storageRoot(env = process.env, home = homedir()) {
  return resolve(env.TREE_DATA_ROOT || env.PROBE_PROJECT_ROOT || join(env.CODEX_HOME || join(home, '.codex'), 'discussion-tree'));
}
