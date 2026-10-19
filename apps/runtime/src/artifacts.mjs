import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const meta = z.object({ id: z.string().uuid(), name: z.string().min(1).max(200).refine(v => !/[\x00-\x1f/\\]/.test(v) && !['.', '..'].includes(v)),
  size: z.number().int().min(0).max(8 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), state: z.literal('ready') }).passthrough();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Download and verify every attachment before DSH admission; only file references enter its prompt. */
export async function receiveArtifacts(root, ids, call) {
  const output = [];
  for (const id of z.array(z.string().uuid()).max(4).parse(ids ?? [])) {
    const item = meta.parse(await call('artifactRead', { id }));
    if (item.id !== id) throw new Error('附件身份不匹配，未开始执行');
    const directory = path.join(root, 'attachments', id);
    for (const folder of [root, path.join(root, 'attachments'), directory]) {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      if ((await lstat(folder)).isSymbolicLink()) throw new Error('附件目录不能是符号链接');
    }
    const file = path.join(directory, item.name);
    const existing = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) {
      if (!existing.isFile() || digest(await readFile(file)) !== item.sha256) throw new Error('本机附件已改变，原文件保留，未开始执行');
    } else {
      const chunks = [];
      for (let offset = 0, index = 0; offset < item.size; offset += 192 * 1024, index++) {
        const { data } = await call('artifactRead', { id, index }); chunks.push(Buffer.from(data, 'base64'));
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== item.size || digest(bytes) !== item.sha256) throw new Error('附件缺失或校验失败，未开始执行');
      const temporary = file + '.download';
      // Recover only our private, previously interrupted download; reject symlink targets.
      const staged = await lstat(temporary).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (staged && !staged.isFile()) throw new Error('附件临时文件类型异常');
      await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, file);
    }
    output.push({ id, name: item.name, path: file, mime: item.mime, size: item.size });
  }
  return output;
}
