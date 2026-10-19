const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("dogo", {
  snapshot: () => ipcRenderer.invoke("dogo:snapshot"),
  workspaceSnapshot: () => ipcRenderer.invoke('dogo:workspaceSnapshot'),
  workspaceShow: (value) => ipcRenderer.invoke('dogo:workspaceShow', value),
  workspaceReload: () => ipcRenderer.invoke('dogo:workspaceReload'),
  onWorkspace: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('dogo:workspace', handler);
    return () => ipcRenderer.removeListener('dogo:workspace', handler);
  },
  onOpenWorkspace: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('dogo:open-workspace', handler);
    return () => ipcRenderer.removeListener('dogo:open-workspace', handler);
  },
  subscribe: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("dogo:snapshot", handler);
    return () => ipcRenderer.removeListener("dogo:snapshot", handler);
  },
});
