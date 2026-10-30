import { build } from 'esbuild';
for (const name of ['memos', 'devices']) {
  await build({
    entryPoints: [`${name}/index.ts`],
    outfile: `${name}/dist/index.js`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@deepseek-ai/*'],
    banner: {
      js: "import { createRequire as dogoCreateRequire } from 'node:module'; const require = dogoCreateRequire(import.meta.url);",
    },
  });
  await build({
    entryPoints: [`${name}/client.ts`],
    outfile: `${name}/dist/client.js`,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  });
}
