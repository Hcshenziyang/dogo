/** Remove only obsolete memo drafts, leaving knowledge drafts and login preferences intact. */
export function clearLegacyMemoDrafts(storage: Storage): number {
  const prefixes = ['dogo.editor.', 'dogo.memo.', 'dogo.draft.'];
  let removed = 0;
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key && prefixes.some((prefix) => key.startsWith(prefix))) {
      storage.removeItem(key);
      removed++;
    }
  }
  return removed;
}
