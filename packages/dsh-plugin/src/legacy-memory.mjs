import { memoryVersion } from './host/scoped-memory.mjs';

/** Reuse the original plugin's storage and approval path; never infer an old
 * workspace fact's new scope or open storage files behind the running backend. */
export async function legacyMemory(ctx, memory, args, exec) {
  exec.signal.throwIfAborted();
  if (args.action === 'legacy_forget' && !memory.state.automatic)
    throw new Error('Agent memory maintenance is disabled in settings');
  if (args.scope === 'personal')
    return args.action === 'legacy_read' ? memory.legacyFiles(args) : memory.forgetLegacyFile(args, exec.signal);

  const session = exec.agent.session;
  if (args.scopeId !== session.id) throw new Error('Legacy workspace operations require the current session ID');
  const recall = ctx.tools.get('memory_recall'), profile = ctx.tools.get('memory_profile');
  if (!recall || !profile) throw new Error('Legacy memory plugin is unavailable; original data has not been removed');
  // Opens the original domain through its plugin and enforces its workspace check.
  await recall.execute({ limit: 1 }, exec);
  exec.signal.throwIfAborted();
  const domain = ctx.get('storageDomain')?.get('dsh_memory');
  if (!domain) throw new Error('Legacy memory domain is unavailable');
  const table = domain.table('facts');
  const active = fact => fact?.workspacePath === session.header.cwd && fact.state === 'active';
  if (args.action === 'legacy_read') {
    const terms = args.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const found = [...table.entries()].map(([, fact]) => fact).filter(fact => active(fact) &&
      (!args.id || fact.id === args.id) &&
      terms.every(term => `${fact.text} ${fact.tags.join(' ')}`.toLocaleLowerCase().includes(term)))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    if (args.id && !found.length) throw new Error('No matching active legacy fact in this workspace');
    return { legacy: true, workspace: session.header.cwd, total: found.length,
      records: found.slice(args.offset, args.offset + args.limit).map(fact => ({ ...fact, version: memoryVersion(JSON.stringify(fact)) })),
      profile: await profile.execute({}, exec),
      note: 'Old workspace facts, not new session records. legacy_forget archives one exact id/version through the original approval policy. Profile entries are not fact IDs.' };
  }
  const existing = table.get(args.id);
  if (!active(existing)) throw new Error('No active legacy fact with this ID in the current workspace');
  if (memoryVersion(JSON.stringify(existing)) !== args.version) throw new Error('Legacy memory changed; read it again before deleting');
  const forget = ctx.tools.get('memory_forget');
  // An unpatched/manual dependency must never silently drop the CAS precondition.
  if (!forget?.parameters.properties.version) throw new Error('Update the bundled memory dependency before legacy cleanup');
  if (!memory.state.automatic || memory.engine.closing) throw new Error('Agent memory maintenance is disabled or DogO is closing');
  const signal = memory.maintenanceController ? AbortSignal.any([exec.signal, memory.maintenanceController.signal]) : exec.signal;
  signal.throwIfAborted();
  const result = await forget.execute({ id: args.id, version: args.version }, { ...exec, signal });
  if (table.get(args.id)?.state !== 'archived') throw new Error('Legacy archive was not verified; read the current record before retrying');
  return { legacy: true, scope: 'session', scopeId: session.id, id: args.id, deleted: true,
    archived: true, historyRetained: true, sync: 'not-applicable-legacy-workspace', result };
}
