import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Keep Chromium's origin stable so upstream DSH localStorage drafts survive a restart. */
export async function workspacePort(home) {
  const file = path.join(home, 'workspace-port.json');
  let saved;
  try { saved = JSON.parse(await readFile(file, 'utf8')).port; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('工作区端口记录损坏；为保留草稿，未自动更换地址'); }
  if (saved !== undefined && (!Number.isInteger(saved) || saved < 1024 || saved > 65535)) throw new Error('工作区端口记录无效');
  const server = createServer();
  const port = await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error(`工作区固定端口 ${saved ?? ''} 被占用；关闭冲突程序后重试，未更换草稿所属地址`)));
    server.listen(saved ?? 0, '127.0.0.1', () => resolve(server.address().port));
  });
  try { if (saved === undefined) await writeFile(file, JSON.stringify({ port }), { flag: 'wx', mode: 0o600 }); }
  finally { await new Promise(resolve => server.close(resolve)); }
  return port;
}
