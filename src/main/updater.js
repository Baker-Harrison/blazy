// This file handles the app's "check for updates" feature — the same idea
// as when your phone or another app tells you a newer version is ready and
// asks if you'd like to download and install it. This runs in the
// background "main" process (using the electron-updater library, which
// talks to GitHub Releases behind the scenes) and reports progress back to
// the on-screen UI.

const { ipcMain, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');

// A function (set up later, in registerUpdaterHandlers) that returns the
// app's main window, so we can send it status messages.
let getMainWindow = null;

// Remembers whether the user has clicked the "Download" button. When this
// is true, we don't just download the update — as soon as the download
// finishes we immediately install it and restart the app, all in one go,
// so the user doesn't have to click a second button.
let installWhenDownloaded = false;

// Actually quits the app, installs the new version, and starts it back up.
// This is wrapped in its own little function (instead of calling
// quitAndInstall directly) because of a known quirk: if quitAndInstall is
// called in the middle of handling a message from the UI, Electron can be
// "busy" and the quit silently does nothing. Wrapping the call in
// setImmediate means "finish whatever you're doing first, THEN quit" —
// like waiting for someone to finish their sentence before interrupting.
function installAndRestart() {
  setImmediate(() => {
    try {
      // The two "true" arguments mean: install silently (no extra installer
      // windows popping up) and re-launch the app automatically when the
      // install finishes.
      autoUpdater.quitAndInstall(true, true);
    } catch (err) {
      sendStatus('error', { message: err.message });
    }
  });
}

// Sends a small status update to the on-screen UI (for example: "checking",
// "an update is available", "12% downloaded"), so it can show a matching
// notification banner. If the window doesn't exist yet or has already been
// closed, there's nowhere to send the message, so we just skip it.
function sendStatus(status, data = {}) {
  const win = getMainWindow ? getMainWindow() : null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:status', { status, ...data });
  }
}

// Sets up everything related to auto-updating: listens for events from the
// electron-updater library and forwards them to the UI, and exposes a few
// actions (check / download / install) that the UI is allowed to trigger.
function registerUpdaterHandlers(getWindow) {
  getMainWindow = getWindow;

  // By default, electron-updater starts downloading an update the moment it
  // finds one, without asking. We turn that off so nothing downloads until
  // the user actually clicks the Download button — otherwise the download
  // could already be running (or finished) behind the scenes, which made
  // the update buttons behave unpredictably.
  autoUpdater.autoDownload = false;
  // Safety net: if an update has been downloaded but the user closes the
  // app normally instead of restarting through the banner, still apply the
  // update during that shutdown so they get the new version next launch.
  autoUpdater.autoInstallOnAppQuit = true;

  // Each of these "on" calls listens for a specific moment in the update
  // process and reports it to the UI with a short status word plus any
  // relevant details (like the new version number).
  autoUpdater.on('checking-for-update', () => {
    sendStatus('checking');
  });

  autoUpdater.on('update-available', (info) => {
    sendStatus('available', { version: info.version, releaseNotes: info.releaseNotes });
  });

  autoUpdater.on('update-not-available', (info) => {
    sendStatus('not-available', { version: info.version });
  });

  // Fired repeatedly while a download is in progress, so the UI can show a
  // progress bar/percentage — similar to a download progress bar in a
  // browser.
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
    // If the user kicked this off by clicking "Download," finish the job
    // automatically: install the update and restart into the new version
    // right now, no second click needed.
    if (installWhenDownloaded) {
      installWhenDownloaded = false;
      installAndRestart();
    }
  });

  autoUpdater.on('error', (err) => {
    sendStatus('error', { message: err.message });
  });

  // These three handlers let the on-screen UI ask the background process to
  // do something (check/download/install), the same "controlled messaging
  // channel" pattern used elsewhere in the app (see files.js for another
  // example). Each wraps its action in a try/catch so that if something
  // goes wrong, we report a clean error status instead of silently failing
  // or crashing.
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
      // Remember that the user asked for this download, so that when it
      // finishes (see the 'update-downloaded' listener above) we
      // immediately install it and restart the app.
      installWhenDownloaded = true;
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      installWhenDownloaded = false;
      sendStatus('error', { message: err.message });
      return { ok: false, error: err.message };
    }
  });

  // Installing quits the app and relaunches it with the new version
  // applied. Normally this happens automatically right after a download,
  // but this button-triggered path is kept as a manual fallback (e.g. if
  // the automatic restart was somehow interrupted).
  ipcMain.handle('updater:install', () => {
    installAndRestart();
    return { ok: true };
  });
}

module.exports = { registerUpdaterHandlers };
