export interface Snapshot {
  backend?: { state: 'stopped' | 'starting' | 'ready' | 'failed'; error: string; version: string };
  relay?: { connected: boolean };
}
export interface WorkspaceViewState {
  phase: 'idle' | 'loading' | 'ready' | 'error'; message: string; visible: boolean;
}
interface Bridge {
  snapshot(): Promise<Snapshot>;
  workspaceSnapshot(): Promise<WorkspaceViewState>;
  workspaceShow(value: { visible: boolean }): Promise<WorkspaceViewState>;
  workspaceReload(): Promise<WorkspaceViewState>;
  onWorkspace(listener: (value: WorkspaceViewState) => void): () => void;
  onOpenWorkspace(listener: () => void): () => void;
  subscribe(listener: (value: Snapshot) => void): () => void;
}
declare global { interface Window { dogo?: Bridge } }
export const isPreview = !window.dogo;
const previewState: WorkspaceViewState = { phase: 'idle', message: '桌面外壳预览', visible: true };
export const bridge: Bridge = window.dogo ?? {
  snapshot: async () => ({}),
  workspaceSnapshot: async () => previewState,
  workspaceShow: async () => previewState,
  workspaceReload: async () => previewState,
  onWorkspace: () => () => {}, onOpenWorkspace: () => () => {}, subscribe: () => () => {},
};
