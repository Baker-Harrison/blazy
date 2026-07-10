const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const db = require('./db');
const { registerTerminalHandlers } = require('./terminal');
const { registerFileHandlers } = require('./files');
const { registerBrowserHandlers } = require('./browser');
const { registerUpdaterHandlers } = require('./updater');

if (!app.isPackaged) {
  try {
    require('electron-reloader')(module, { watchRenderer: false });
  } catch (_) {}
}

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

function registerDbHandlers() {
  ipcMain.handle('db:getWorkspaces', () => db.getWorkspaces());
  ipcMain.handle('db:createWorkspace', (_e, name, folderPath) => db.createWorkspace(name, folderPath));
  ipcMain.handle('db:renameWorkspace', (_e, id, name) => db.renameWorkspace(id, name));
  ipcMain.handle('db:deleteWorkspace', (_e, id) => db.deleteWorkspace(id));

  ipcMain.handle('db:getTabs', (_e, workspaceId) => db.getTabs(workspaceId));
  ipcMain.handle('db:createTab', (_e, workspaceId, type, title, config) =>
    db.createTab(workspaceId, type, title, config)
  );
  ipcMain.handle('db:updateTab', (_e, id, updates) => db.updateTab(id, updates));
  ipcMain.handle('db:deleteTab', (_e, id) => db.deleteTab(id));

  ipcMain.handle('db:getLayout', (_e, workspaceId) => db.getLayout(workspaceId));
  ipcMain.handle('db:saveLayout', (_e, workspaceId, tree) => db.saveLayout(workspaceId, tree));

  ipcMain.handle('db:getMessages', (_e, tabId) => db.getMessages(tabId));
  ipcMain.handle('db:addMessage', (_e, tabId, role, content) =>
    db.addMessage(tabId, role, content)
  );
}

function registerFolderHandlers() {
  ipcMain.handle('dialog:openFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const folderPath = result.filePaths[0];
    return {
      path: folderPath,
      name: path.basename(folderPath),
    };
  });
}

function registerWindowHandlers() {
  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on('window:maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
}

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 400,
    minHeight: 300,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#16171b',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow = win;

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  if (!app.isPackaged) {
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log(`[renderer] ${message}`);
    });
    // The app menu is disabled (its Ctrl+W accelerator conflicts with
    // close-tab), so re-provide the dev shortcuts it used to supply.
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12') win.webContents.toggleDevTools();
      if (input.control && !input.shift && input.key.toLowerCase() === 'r') win.webContents.reload();
    });
  }

  win.on('maximize', () => win.webContents.send('window:maximized', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized', false));
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerDbHandlers();
  registerFolderHandlers();
  registerWindowHandlers();
  registerTerminalHandlers();
  registerFileHandlers();
  registerBrowserHandlers(() => mainWindow);
  registerUpdaterHandlers(() => mainWindow);
  await db.ensureInit();
  createWindow();

  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 3000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
