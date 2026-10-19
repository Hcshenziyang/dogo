import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from 'node:fs';
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const binary = require("electron");
const helper = fileURLToPath(new URL('../build/dogo-computer', import.meta.url));
if (process.platform === 'darwin') {
  mkdirSync(fileURLToPath(new URL('../build/', import.meta.url)), { recursive: true });
  const build = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-O', fileURLToPath(new URL('../native/Computer.swift', import.meta.url)), '-o', helper], { stdio: 'inherit' });
  if (build.status !== 0) throw new Error('Mac 操作组件编译失败');
}
const child = spawn(binary, [fileURLToPath(new URL("..", import.meta.url))], {
  stdio: "inherit",
  env: { ...process.env, DOGO_NODE: process.execPath, ...(process.platform === 'darwin' ? { DOGO_MAC_HELPER: helper } : {}) },
});
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
