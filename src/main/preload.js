const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  onMaximizedChange: (callback) =>
    ipcRenderer.on('window:maximized', (_event, isMaximized) => callback(isMaximized)),
});

contextBridge.exposeInMainWorld('agentDB', {
  getWorkspaces: () => ipcRenderer.invoke('db:getWorkspaces'),
  createWorkspace: (name, folderPath) => ipcRenderer.invoke('db:createWorkspace', name, folderPath),
  renameWorkspace: (id, name) => ipcRenderer.invoke('db:renameWorkspace', id, name),
  deleteWorkspace: (id) => ipcRenderer.invoke('db:deleteWorkspace', id),

  getTabs: (workspaceId) => ipcRenderer.invoke('db:getTabs', workspaceId),
  createTab: (workspaceId, type, title, config) => ipcRenderer.invoke('db:createTab', workspaceId, type, title, config),
  updateTab: (id, updates) => ipcRenderer.invoke('db:updateTab', id, updates),
  deleteTab: (id) => ipcRenderer.invoke('db:deleteTab', id),

  getLayout: (workspaceId) => ipcRenderer.invoke('db:getLayout', workspaceId),
  saveLayout: (workspaceId, tree) => ipcRenderer.invoke('db:saveLayout', workspaceId, tree),

  getMessages: (tabId) => ipcRenderer.invoke('db:getMessages', tabId),
  addMessage: (tabId, role, content) => ipcRenderer.invoke('db:addMessage', tabId, role, content),
});

contextBridge.exposeInMainWorld('dialogs', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
});

contextBridge.exposeInMainWorld('terminals', {
  create: (cwd) => ipcRenderer.invoke('terminal:create', cwd),
  attach: (id) => ipcRenderer.invoke('terminal:attach', id),
  write: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
  kill: (id) => ipcRenderer.invoke('terminal:kill', id),
  onData: (callback) => {
    const listener = (_event, id, data) => callback(id, data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onExit: (callback) => {
    const listener = (_event, id, exitCode) => callback(id, exitCode);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
});

contextBridge.exposeInMainWorld('browser', {
  ensurePane: (paneId, saved) => ipcRenderer.invoke('browser:ensurePane', paneId, saved),
  setViewport: (paneId, bounds, visible) =>
    ipcRenderer.send('browser:setViewport', paneId, bounds, visible),
  newTab: (paneId, url) => ipcRenderer.send('browser:newTab', paneId, url),
  closeTab: (paneId, tabId) => ipcRenderer.send('browser:closeTab', paneId, tabId),
  activateTab: (paneId, tabId) => ipcRenderer.send('browser:activateTab', paneId, tabId),
  navigate: (paneId, url) => ipcRenderer.send('browser:navigate', paneId, url),
  back: (paneId) => ipcRenderer.send('browser:back', paneId),
  forward: (paneId) => ipcRenderer.send('browser:forward', paneId),
  reload: (paneId) => ipcRenderer.send('browser:reload', paneId),
  stop: (paneId) => ipcRenderer.send('browser:stop', paneId),
  focusPage: (paneId) => ipcRenderer.send('browser:focusPage', paneId),
  destroyPane: (paneId) => ipcRenderer.send('browser:destroyPane', paneId),
  onState: (callback) => {
    const listener = (_event, paneId, state) => callback(paneId, state);
    ipcRenderer.on('browser:state', listener);
    return () => ipcRenderer.removeListener('browser:state', listener);
  },
  onShortcut: (callback) => {
    const listener = (_event, paneId, action) => callback(paneId, action);
    ipcRenderer.on('browser:shortcut', listener);
    return () => ipcRenderer.removeListener('browser:shortcut', listener);
  },
});

contextBridge.exposeInMainWorld('fs', {
  readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
});

contextBridge.exposeInMainWorld('updater', {
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.invoke('updater:download'),
  install: () => ipcRenderer.invoke('updater:install'),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
});
