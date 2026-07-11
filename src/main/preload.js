// This is a special "bridge" file used by Electron apps for security. The
// on-screen part of the app (the "renderer," which is really just a web
// page under the hood) is deliberately NOT allowed to talk directly to the
// computer's operating system — that would be dangerous, since any bug or
// malicious content in the web page could then do things like delete files
// or run arbitrary programs.
//
// Instead, this file runs in a special, more trusted context and hand-picks
// a very specific, limited set of functions to expose to the web page —
// like a hotel receptionist who won't let guests wander into the back
// office, but will happily relay very specific requests for them. Each
// "contextBridge.exposeInMainWorld(...)" call below creates one named
// object (like "window.windowControls" or "window.agentDB") that the
// on-screen React code can call, without ever getting direct access to
// Node.js or the file system itself.

const { contextBridge, ipcRenderer } = require('electron');

// Controls for the custom titlebar buttons (minimize/maximize/close),
// since this app draws its own titlebar instead of using the operating
// system's default one.
contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  // Lets the UI know when the window becomes maximized/un-maximized (e.g.
  // to swap the maximize icon for a "restore" icon), by listening for a
  // message sent from the background process.
  onMaximizedChange: (callback) =>
    ipcRenderer.on('window:maximized', (_event, isMaximized) => callback(isMaximized)),
});

// The app's saved data: workspaces, tabs, and layouts. Every function here
// just forwards the request to the background process, which actually
// reads/writes the on-disk database (see db.js).
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
});

// The native "choose a folder" system dialog, used when opening a workspace.
contextBridge.exposeInMainWorld('dialogs', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
});

// The operating system's clipboard (the same one every other app on your
// computer copies/pastes through). The on-screen UI can't reach this
// directly — same reason as everything else in this file — so this just
// forwards read/write requests to the background process. Used by the
// Terminal pane's Ctrl+C/Ctrl+V handling (see terminalClipboard.js).
contextBridge.exposeInMainWorld('clipboard', {
  readText: () => ipcRenderer.invoke('clipboard:readText'),
  writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
});

// Everything needed to run a Terminal pane: creating a shell process,
// re-attaching to an already-running one, sending it keystrokes, resizing
// it, and closing it. See terminal.js for the background-process side of
// this.
contextBridge.exposeInMainWorld('terminals', {
  // Tells the renderer which OS (and, on Windows, which build) it's
  // running on, so the on-screen terminal widget can apply the correct
  // platform-specific fixes. See terminal.js's getPlatformInfo for why.
  platformInfo: () => ipcRenderer.invoke('terminal:platformInfo'),
  create: (cwd) => ipcRenderer.invoke('terminal:create', cwd),
  attach: (id) => ipcRenderer.invoke('terminal:attach', id),
  write: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
  kill: (id) => ipcRenderer.invoke('terminal:kill', id),
  // Confirms that `count` characters of output have been fully drawn on
  // screen — part of the flow-control handshake that stops a very fast
  // shell from overwhelming the display (see terminal.js). Uses "send"
  // (one-way, no reply) instead of "invoke" because it fires constantly
  // and nothing needs to wait for an answer.
  ack: (id, count) => ipcRenderer.send('terminal:ack', id, count),
  // Terminal output streams in continuously (as text is printed), so
  // instead of a one-time request/response, we subscribe to an ongoing
  // stream of "data" events. Each call to onData returns an "unsubscribe"
  // function so the caller can stop listening later (e.g. when the
  // terminal pane is closed) and avoid a memory leak.
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

// Controls for the embedded Browser pane (a mini web browser inside the
// app). See browser.js for how the background process actually manages the
// real browser view underneath.
contextBridge.exposeInMainWorld('browser', {
  ensurePane: (paneId, saved) => ipcRenderer.invoke('browser:ensurePane', paneId, saved),
  setViewport: (paneId, bounds, visible) =>
    ipcRenderer.send('browser:setViewport', paneId, bounds, visible),
  setOverlayOpen: (open) => ipcRenderer.send('browser:setOverlayOpen', open),
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

// Basic file operations used by the code Editor pane (list a folder's
// contents, read a file, save a file). See files.js.
contextBridge.exposeInMainWorld('fs', {
  readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  // Reads a file as raw bytes (base64-encoded text) instead of as plain
  // text. Used for file types where reading as text would corrupt the
  // data — images, .xlsx spreadsheets, PDFs, etc. See files.js.
  readFileBinary: (filePath) => ipcRenderer.invoke('fs:readFileBinary', filePath),
});

// Auto-update controls (check for a new version, download it, install it),
// plus a way to listen for status updates as they happen. See updater.js.
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
