import { stripTypeScriptTypes } from 'node:module';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(root + 'dist', { recursive: true });
for (const name of ['client', 'schema', 'sync']) {
  const source = await readFile(root + `src/${name}.ts`, 'utf8');
  const code = stripTypeScriptTypes(source).replace(/(from\s+['"]\.\/[^'"\n]+)\.ts(['"])/g, '$1.mjs$2');
  const file = root + `dist/${name}.mjs`, temporary = file + '.' + process.pid + '.tmp';
  await writeFile(temporary, code); await rename(temporary, file);
}
