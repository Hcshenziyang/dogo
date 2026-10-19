const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("dogo", {
  account: (value) => ipcRenderer.invoke('dogo:account', value),
  saveArtifact: (value) => ipcRenderer.invoke('dogo:saveArtifact', value),
  snapshot: () => ipcRenderer.invoke("dogo:snapshot"),
  openDsh: () => ipcRenderer.invoke('dogo:openDsh'),
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
  copyResult: (id) => ipcRenderer.invoke("dogo:copyResult", id),
  configure: (value) => ipcRenderer.invoke("dogo:configure", value),
  create: (value) => ipcRenderer.invoke("dogo:create", value),
  followup: (value) => ipcRenderer.invoke("dogo:followup", value),
  cancel: (id) => ipcRenderer.invoke("dogo:cancel", { id }),
  chooseWorkspace: () => ipcRenderer.invoke("dogo:chooseWorkspace"),
  importRelay: () => ipcRenderer.invoke('dogo:importRelay'),
  refreshRelay: () => ipcRenderer.invoke('dogo:refreshRelay'),
  acceptRemote: (value) => ipcRenderer.invoke('dogo:acceptRemote', value),
  hubAction: (value) => ipcRenderer.invoke('dogo:hubAction', value),
  remotePolicy: (value) => ipcRenderer.invoke('dogo:remotePolicy', value),
  registerProject: () => ipcRenderer.invoke('dogo:registerProject'),
  updateProject: (value) => ipcRenderer.invoke('dogo:updateProject', value),
  hubCache: (value) => ipcRenderer.invoke('dogo:hubCache', value),
  memoryConfigure: (value) => ipcRenderer.invoke('dogo:memoryConfigure', value),
  memorySync: () => ipcRenderer.invoke('dogo:memorySync'),
  memory: (value) => ipcRenderer.invoke('dogo:memory', value),
  prepare: () => ipcRenderer.invoke('dogo:prepare'),
  capabilitiesConfigure: value => ipcRenderer.invoke('dogo:capabilitiesConfigure', value),
  openMemory: () => ipcRenderer.invoke('dogo:openMemory'),
  loginItem: (value) => ipcRenderer.invoke('dogo:loginItem', value),
  subscribe: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("dogo:snapshot", handler);
    return () => ipcRenderer.removeListener("dogo:snapshot", handler);
  },
});
