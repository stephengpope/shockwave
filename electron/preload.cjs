const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  readTree: (dirPath) => ipcRenderer.invoke('fs:readTree', dirPath),
  readAllMarkdown: (dirPath) => ipcRenderer.invoke('fs:readAllMarkdown', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath, content) =>
    ipcRenderer.invoke('fs:writeFile', { filePath, content }),
  createFile: (dirPath, name, content) =>
    ipcRenderer.invoke('fs:createFile', { dirPath, name, content }),
  renameFile: (fromPath, toName) =>
    ipcRenderer.invoke('fs:renameFile', { fromPath, toName }),
  duplicateFile: (filePath) => ipcRenderer.invoke('fs:duplicateFile', filePath),
  writeImage: (dirPath, bytes, ext, baseName) =>
    ipcRenderer.invoke('fs:writeImage', { dirPath, bytes, ext, baseName }),
  trashFile: (filePath) => ipcRenderer.invoke('fs:trashFile', filePath),
  trashFolder: (folderPath) => ipcRenderer.invoke('fs:trashFolder', folderPath),
  revealInFolder: (filePath) => ipcRenderer.invoke('shell:revealInFolder', filePath),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  showFileContextMenu: () => ipcRenderer.invoke('context:fileMenu'),
  showFolderContextMenu: () => ipcRenderer.invoke('context:folderMenu'),
  showEditorContextMenu: (opts) => ipcRenderer.invoke('context:editorMenu', opts),
  createFolder: (dirPath, name) => ipcRenderer.invoke('fs:createFolder', { dirPath, name }),
  renameFolder: (fromPath, toName) => ipcRenderer.invoke('fs:renameFolder', { fromPath, toName }),
  moveItem: (srcPath, destDir) => ipcRenderer.invoke('fs:moveItem', { srcPath, destDir }),
  pathExists: (p) => ipcRenderer.invoke('fs:pathExists', p),
  watchStart: (dirPath) => ipcRenderer.invoke('fs:watchStart', dirPath),
  watchStop: () => ipcRenderer.invoke('fs:watchStop'),
  onFsChanged: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('fs:changed', listener);
    return () => ipcRenderer.removeListener('fs:changed', listener);
  },
  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    write: (obj) => ipcRenderer.invoke('settings:write', obj),
  },
  theme: {
    getInitial: () => ipcRenderer.invoke('theme:getInitial'),
    onSystemChange: (cb) => {
      const listener = (_evt, payload) => cb(payload);
      ipcRenderer.on('theme:systemChanged', listener);
      return () => ipcRenderer.removeListener('theme:systemChanged', listener);
    },
  },
  ai: {
    run: (requestId, action, params) =>
      ipcRenderer.invoke('ai:run', { requestId, action, params }),
    cancel: (requestId) => ipcRenderer.invoke('ai:cancel', { requestId }),
    onChunk: (cb) => {
      const listener = (_evt, payload) => cb(payload);
      ipcRenderer.on('ai:chunk', listener);
      return () => ipcRenderer.removeListener('ai:chunk', listener);
    },
    onDone: (cb) => {
      const listener = (_evt, payload) => cb(payload);
      ipcRenderer.on('ai:done', listener);
      return () => ipcRenderer.removeListener('ai:done', listener);
    },
    onError: (cb) => {
      const listener = (_evt, payload) => cb(payload);
      ipcRenderer.on('ai:error', listener);
      return () => ipcRenderer.removeListener('ai:error', listener);
    },
  },
});
