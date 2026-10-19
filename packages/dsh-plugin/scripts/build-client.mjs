import { build } from 'vite';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ root, configFile: false, build: { lib: { entry: root + 'src/client/index.tsx', formats: ['cjs'], fileName: () => 'client-body.cjs' },
  rolldownOptions: { external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'] }, minify: false } });
const source = await readFile(root + 'dist/client-body.cjs', 'utf8');
await writeFile(root + 'dist/client.js', `window.__ModuleLoader__.load({id:'@dogo/dsh-plugin',factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${source}\nreturn module.exports;}});\n`);
await unlink(root + 'dist/client-body.cjs');
