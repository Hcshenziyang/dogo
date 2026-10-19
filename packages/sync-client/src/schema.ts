import { z } from 'zod';

// Portable, deliberately narrow names for the first shared-memory folder implementation.
export const memoryPath = z.string().max(240).refine(value => {
  const parts = value.split('/');
  return parts.length <= 12 && parts.every((part, index) =>
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) &&
    (index === parts.length - 1
      ? /^[a-z0-9][a-z0-9_-]*\.(md|txt|json)$/.test(part)
      : /^[a-z0-9][a-z0-9_-]*$/.test(part)));
}, 'Use lowercase portable paths ending in .md, .txt or .json; no hidden files or traversal');
export const memoryWriteSchema = z.object({
  path: memoryPath,
  baseVersion: z.number().int().nonnegative(),
  content: z.string().max(256_000).nullable(),
}).strict();
export type MemoryFile = {
  path: string;
  version: number;
  content: string | null;
  updatedBy: string;
  updatedAt: number;
};
