const { contextBridge, ipcRenderer } = require('electron');
// No generic RPC, bootstrap credentials, filesystem or Node access crosses this boundary.
const allowed = new Set(['importRelay', 'account', 'saveArtifact', 'registerProject', 'updateProject', 'remotePolicy', 'capabilitiesConfigure', 'memory', 'openMemory', 'prepare', 'loginItem']);
contextBridge.exposeInMainWorld('dogoNative', {
  call(method, params) {
    if (!allowed.has(method)) return Promise.reject(new Error('不允许的原生操作'));
    return ipcRenderer.invoke('dogo:' + method, params);
  },
});
