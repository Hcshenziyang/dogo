import { readdir, realpath, open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const excluded = new Set([
  "node_modules",
  "dist",
  "build",
  "vendor",
  "coverage",
  "target",
]);
const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".css",
  ".html",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".swift",
  ".txt",
  ".yaml",
  ".yml",
  ".toml",
]);
const allowed = (name) =>
  !name.startsWith(".") &&
  !excluded.has(name) &&
  !/secret|credential|password|private.?key|^auth\./i.test(name);

export async function normalizeWorkspace(input) {
  const root = await realpath(input);
  if (!(await stat(root)).isDirectory()) throw new Error("请选择文件夹");
  return root;
}

export async function listWorkspace(root, signal) {
  const files = [];
  let truncated = false;
  async function visit(relative, depth) {
    signal?.throwIfAborted();
    for (const entry of (
      await readdir(path.join(root, relative), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (!allowed(entry.name) || entry.isSymbolicLink()) continue;
      if (files.length >= 350) {
        truncated = true;
        return;
      }
      const item = path.join(relative, entry.name);
      files.push(item + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) {
        if (depth < 3) await visit(item, depth + 1);
        else truncated = true;
      }
    }
  }
  await visit("", 0);
  return { files, truncated };
}

export async function readWorkspaceFile(root, relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((p) => p === ".." || !allowed(p))
  )
    throw new Error("只允许读取授权目录内的普通源码文件");
  if (!textExtensions.has(path.extname(relative).toLowerCase()))
    throw new Error("此文件类型不在只读源码白名单内");
  const candidate = path.resolve(root, relative);
  const resolved = await realpath(candidate);
  if (!resolved.startsWith(root + path.sep) || resolved !== candidate)
    throw new Error("禁止符号链接及目录外读取");
  const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024)
      throw new Error("仅支持不超过 64 KiB 的普通文本文件");
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 64 * 1024 || buffer.subarray(0, bytesRead).includes(0))
      throw new Error("文件过大或不是文本");
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
}
