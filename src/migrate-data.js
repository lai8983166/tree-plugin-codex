import { readdir, mkdir, copyFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';

// Explicit, additive migration. Never follows symlinks or overwrites newer data.
export async function migrateData(sourceRoot, destinationRoot) {
  const source = join(resolve(sourceRoot), '.probe'), destination = join(resolve(destinationRoot), '.probe');
  if (source === destination) return { copied: 0, skipped: 0 };
  await mkdir(destination, { recursive: true });
  if (await realpath(source) === await realpath(destination)) return { copied: 0, skipped: 0 };
  const result = { copied: 0, skipped: 0 };
  async function copy(dir, target) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.name.endsWith('.lock') || entry.name.endsWith('.tmp') || entry.isSymbolicLink()) continue;
      const to = join(target, entry.name);
      if (entry.isDirectory()) await copy(join(dir, entry.name), to);
      else if (entry.isFile() && /\.(json|md)$/.test(entry.name)) {
        await mkdir(target, { recursive: true });
        try { await copyFile(join(dir, entry.name), to, constants.COPYFILE_EXCL); result.copied++; }
        catch (error) { if (error.code !== 'EEXIST') throw error; result.skipped++; }
      }
    }
  }
  for (const category of ['events', 'history', 'curated', 'trees', 'qa']) await copy(join(source, category), join(destination, category));
  return result;
}
