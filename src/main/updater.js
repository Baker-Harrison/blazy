const { ipcMain, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');

let getMainWindow = null;

function sendStatus(status, data = {}) {
  const win = getMainWindow ? getMainWindow() : null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:status', { status, ...data });
  }
}

function registerUpdaterHandlers(getWindow) {
  getMainWindow = getWindow;

  autoUpdater.on('checking-for-update', () => {
    sendStatus('checking');
  });

  autoUpdater.on('update-available', (info) => {
    sendStatus('available', { version: info.version, releaseNotes: info.releaseNotes });
  });

  autoUpdater.on('update-not-available', (info) => {
    sendStatus('not-available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendStatus('progress', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendStatus('downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    sendStatus('error', { message: err.message });
  });

  ipcMain.handle('updater:check', async () => {
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      sendStatus('error', { message: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      sendStatus('error', { message: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall(true, true);
  });
}

module.exports = { registerUpdaterHandlers };
