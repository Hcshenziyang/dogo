import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
const root = '/var/lib/dogo/backups';
process.umask(0o077);
mkdirSync(root, { recursive: true, mode: 0o700 });
const db = new DatabaseSync('/var/lib/dogo/services.sqlite', { readOnly: true });
try {
  await backup(db, `${root}/tasks-${new Date().toISOString().replaceAll(':', '-')}.sqlite`);
} finally { db.close(); }
// Only these generated backup files are eligible for the 14-snapshot rotation.
const names = readdirSync(root).filter(name => /^tasks-\d{4}-\d\d-\d\dT[\d.-]+Z\.sqlite$/.test(name)).sort().reverse();
for (const name of names.slice(14)) unlinkSync(`${root}/${name}`);
console.log('DogO SQLite backup complete');
