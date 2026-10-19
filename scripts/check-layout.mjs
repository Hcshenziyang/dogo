import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const required = ['README.md', 'PRODUCT.md', 'ARCHITECTURE.md', 'PLAN.md', 'STATUS.md',
  'CONTRIBUTING.md', 'AGENTS.md', 'pnpm-workspace.yaml',
  'docs/decisions/0001-local-first-typescript.md'];
for (const path of required) assert(existsSync(join(root, path)), `Missing: ${path}`);

const packages = new Map([
  ['.', 'dogo'], ['apps/web', '@dogo/web'], ['apps/desktop', '@dogo/desktop'],
   ['packages/contracts', '@dogo/contracts'],
  ['apps/mobile', '@dogo/mobile'], ['apps/others', '@dogo/others'],
  ['apps/others/services', '@dogo/services'],
  ['packages/dsh-plugin', '@dogo/dsh-plugin'],
  ['packages/hub-ui', '@dogo/hub-ui'], ['packages/sync-client', '@dogo/sync-client'],
]);
for (const [path, name] of packages) {
  const manifest = JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8'));
  assert.equal(manifest.name, name);
  assert.equal(manifest.private, true, `${name} must not be accidentally published to npm`);
  assert.equal(manifest.type, 'module');
  assert(existsSync(join(root, path, 'README.md')), `Missing package README: ${name}`);
}

let markdownCount = 0;
function checkDocs(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'release', 'dist', 'build'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) checkDocs(path);
    else if (entry.name.endsWith('.md')) {
      markdownCount++;
      const content = readFileSync(path, 'utf8');
      for (const match of content.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
        const target = match[1];
        if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue;
        const relative = decodeURIComponent(target.split('#')[0]);
        assert(existsSync(resolve(dirname(path), relative)), `Broken link in ${path}: ${target}`);
      }
    }
  }
}
checkDocs(root);
console.log(`Layout check passed: ${packages.size} manifests, ${markdownCount} Markdown files. No application tests run.`);
