const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  showFileContextMenu: (opts) => ipcRenderer.invoke('context:fileMenu', opts),
  showFolderContextMenu: () => ipcRenderer.invoke('context:folderMenu'),
  showEditorContextMenu: (opts) => ipcRenderer.invoke('context:editorMenu', opts),
  createFolder: (dirPath, name) => ipcRenderer.invoke('fs:createFolder', { dirPath, name }),
  ensureDir: (dirPath) => ipcRenderer.invoke('fs:ensureDir', dirPath),
  bookmarks: {
    read: (workspacePath) => ipcRenderer.invoke('bookmarks:read', workspacePath),
    write: (workspacePath, paths) => ipcRenderer.invoke('bookmarks:write', { workspacePath, paths }),
  },
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
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    libraryDir: () => ipcRenderer.invoke('skills:libraryDir'),
    importPicker: () => ipcRenderer.invoke('skills:importPicker'),
    importFromPath: (srcPath) => ipcRenderer.invoke('skills:importFromPath', srcPath),
    remove: (folderName) => ipcRenderer.invoke('skills:remove', folderName),
    // Exposes Electron's webUtils.getPathForFile so the renderer can resolve a
    // drag-dropped folder's absolute path. Returns '' for File objects not
    // backed by disk.
    pathForFile: (file) => webUtils.getPathForFile(file),
  },
  agent: {
    send: (text, images) => ipcRenderer.invoke('agent:send', { text, images }),
    abort: () => ipcRenderer.invoke('agent:abort'),
    reset: () => ipcRenderer.invoke('agent:reset'),
    getDefaultSystemPrompt: () => ipcRenderer.invoke('agent:getDefaultSystemPrompt'),
    listProviders: () => ipcRenderer.invoke('agent:listProviders'),
    listModels: (provider) => ipcRenderer.invoke('agent:listModels', provider),
    onEvent: (cb) => {
      const listener = (_evt, payload) => cb(payload);
      ipcRenderer.on('agent:event', listener);
      return () => ipcRenderer.removeListener('agent:event', listener);
    },
    onError: (cb) => {
      const listener = (_evt, payload) => cb(payload);
      ipcRenderer.on('agent:error', listener);
      return () => ipcRenderer.removeListener('agent:error', listener);
    },
  },
});
