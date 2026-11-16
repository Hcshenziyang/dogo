import type { Dict } from '../shared/presentation.js';

export function workspaceBaseline(value: unknown): { items: Dict[]; archived: string[] } | null {
  if (!value || typeof value !== 'object') return null;
  const baseline = value as Dict;
  if (
    !Array.isArray(baseline.items) ||
    !Array.isArray(baseline.archivedSessionIds) ||
    !baseline.archivedSessionIds.every((id: unknown) => typeof id === 'string') ||
    !baseline.items.every(
      (item: unknown) =>
        !!item && typeof item === 'object' && Array.isArray((item as Dict).sessionIds),
    )
  )
    return null;
  return { items: baseline.items, archived: baseline.archivedSessionIds };
}

export function deviceStatus(device: Dict, status: Dict): string {
  if (!device.active) return '已禁用';
  if (device.kind !== 'desktop') return '已登记';
  if (device.id === status.deviceId) {
    if (status.consumer?.online) return '在线';
    if (!status.consumer?.enabled) return '仅作为访问方';
    return status.consumer?.error ? '连接异常' : '正在连接';
  }
  return device.online ? '在线' : '离线';
}

export function visibleSessions(
  sessions: Dict[],
  archived: string[] | null,
  projectFilter: string,
  workspaces: Dict[],
): Dict[] {
  if (!archived) return [];
  const hidden = new Set(archived);
  return sessions.filter((session) => {
    if (hidden.has(session.sessionId)) return false;
    const project = workspaces.find((workspace) =>
      workspace.sessionIds.includes(session.sessionId),
    );
    return (
      !projectFilter ||
      (projectFilter === '@ungrouped' ? !project : project?.workspaceId === projectFilter)
    );
  });
}
