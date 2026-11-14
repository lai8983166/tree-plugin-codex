import { migrateData } from '../src/migrate-data.js';
import { storageRoot } from '../src/storage-root.js';
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/migrate-data.mjs <old-project-root>');
console.log(JSON.stringify(await migrateData(source, storageRoot())));
