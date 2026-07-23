// This is the entry point for the app's background "main" process — the
// part of Electron that starts up first, creates the actual application
// window, and coordinates everything else (the database, terminals, file
// access, the embedded browser, and auto-updates). Think of this file as
// the app's control room: it doesn't draw anything on screen itself, but it
// sets up everything the on-screen UI will need.

const { app, BrowserWindow, Menu, ipcMain, dialog, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const db = require('./db');
const { registerTerminalHandlers } = require('./terminal');
const { registerFileHandlers } = require('./files');
const { registerBrowserHandlers } = require('./browser');
const { registerUpdaterHandlers } = require('./updater');

// Make sure only ONE copy of Blazy is ever running at a time.
//
// Why this matters (plain language): every copy of the app shares the
// same on-disk folder for its browser cache and cookies (Windows:
// %APPDATA%\blazy). If a second copy somehow starts up — a leftover
// window from an earlier dev-server run that never fully closed, a
// double-click while one was already open, etc. — both copies try to
// read and write that same cache folder at once. Windows won't let two
// programs rename/replace the same cache files at the same moment, so
// this shows up as "Unable to move the cache: Access is denied" errors,
// and any web page resource that depends on that broken cache (this is
// how we tracked down YouTube's missing search/notification icons — a
// font file was failing to load with a cache error) can silently fail to
// load. Grabbing this lock guarantees there's only ever one copy running:
// if a second launch is attempted, Electron hands it right back to us
// (see the 'second-instance' handler below) instead of letting it start.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Another copy is already running — let IT be the one that keeps going,
  // and quit this brand-new, redundant copy immediately.
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to open Blazy again while it was already running:
    // bring the existing window to the front instead of opening a new one.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// While developing (not yet packaged into a finished .exe/installer),
// automatically reload the app whenever this background code changes, so
// you don't have to manually restart it after every edit. If this fails
// for any reason (e.g. the dev-only package isn't installed), we just
// silently move on rather than crashing the whole app over a convenience
// feature.
if (!app.isPackaged) {
  try {
    require('electron-reloader')(module, { watchRenderer: false });
  } catch (_) {}
}

// While running the dev server (npm run dev, etc.), the on-screen UI is
// served live from a local web server instead of pre-built files — this
// environment variable holds that server's address.
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

// Registers all the database-related channels the on-screen UI can call
// through window.agentDB (see preload.js) — creating/renaming/deleting
// workspaces and tabs, and saving layouts. Each handler is a thin
// pass-through to the matching function in db.js.
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
}

// Registers the "choose a folder" system dialog (used when opening a
// workspace) as a channel the UI can call.
function registerFolderHandlers() {
  ipcMain.handle('dialog:openFolder', async (e) => {
    // Find which window sent this request, so the folder-picker dialog
    // appears attached to (and blocking) the correct window.
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
    });
    // If the user closed the dialog without picking anything, report
    // "nothing chosen" rather than an error.
    if (result.canceled || result.filePaths.length === 0) return null;
    const folderPath = result.filePaths[0];
    return {
      path: folderPath,
      name: path.basename(folderPath), // Just the folder's own name, not its full path.
    };
  });
}

// Registers the minimize/maximize/close button actions used by the custom
// titlebar (since this app draws its own titlebar instead of using the
// operating system's default window chrome).
function registerWindowHandlers() {
  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on('window:maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    // Clicking maximize when already maximized instead "restores" the
    // window back to its normal size — the same toggle behavior as a
    // standard window's maximize button.
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
}

// Registers the system clipboard read/write channels used by the Terminal
// pane's copy/paste shortcuts (see terminalClipboard.js). The renderer
// can't touch the OS clipboard directly (see preload.js's comment on why),
// so this is a thin pass-through to Electron's own clipboard module.
function registerClipboardHandlers() {
  ipcMain.handle('clipboard:readText', () => clipboard.readText());
  ipcMain.handle('clipboard:writeText', (_e, text) => clipboard.writeText(text));
}

// Registers a helper that lets the on-screen UI open a REAL operating-system
// menu (the same kind of popup menu you get when you right-click in most
// desktop apps). Why bother instead of drawing a fake HTML menu?
//
// The embedded Browser pane paints its pages as a native "WebContentsView"
// that always sits ON TOP of regular HTML. An HTML dropdown drawn under a
// browser tab would get covered by the page — so the old code hid every
// open browser whenever a menu opened, which made the page go blank. A
// native OS menu floats above everything (including those browser views),
// so the page can stay visible while you pick an option.
//
// The UI sends a list of items like [{ id: 'browser', label: 'Browser' }].
// When the user clicks one, we resolve with that item's id. If they
// dismiss the menu without choosing (click elsewhere, press Escape), we
// resolve with null.
function registerMenuHandlers() {
  ipcMain.handle('menu:popup', async (e, items, x, y) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || !Array.isArray(items) || items.length === 0) return null;

    return new Promise((resolve) => {
      // Make sure we only answer the UI once — a menu click fires both the
      // item's "click" handler AND the menu's close "callback", and we
      // don't want the close callback to overwrite a real selection with
      // null a moment later.
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      // Turn the simple list the UI sent into the shape Electron's Menu
      // API expects (separators for dividers, enabled/disabled flags, and
      // a click handler that reports which item was chosen).
      const template = items.map((item) => {
        if (item && item.divider) return { type: 'separator' };
        return {
          label: String(item?.label ?? ''),
          enabled: !item?.disabled,
          click: () => finish(item?.id ?? null),
        };
      });

      const menu = Menu.buildFromTemplate(template);
      // x/y are optional: when provided (as pixel positions relative to
      // the window), the menu opens there; otherwise it opens at the
      // current mouse cursor. Round them so we never hand Electron a
      // fractional pixel coordinate.
      const options = {
        window: win,
        callback: () => finish(null),
      };
      if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
        options.x = Math.round(x);
        options.y = Math.round(y);
      }
      menu.popup(options);
    });
  });
}

// Keeps a reference to the app's single main window so other parts of the
// app (like the updater) can send it messages.
let mainWindow = null;

// Creates and configures the actual application window.
function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 400,
    minHeight: 300,
    frame: false, // No default OS titlebar/border — we draw our own (see TitleBar.jsx).
    titleBarStyle: 'hidden',
    backgroundColor: '#16171b', // Matches the app's dark background so there's no white flash while loading.
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      // The "bridge" script (see preload.js) that safely exposes a
      // limited set of background-process features to the on-screen UI.
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow = win;

  // In development, load the UI from the live dev server (with hot
  // reloading); in a packaged, finished build, load the pre-built HTML
  // file instead.
  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  if (!app.isPackaged) {
    // Forward any warnings/errors logged by the on-screen UI into this
    // process's terminal too, so you can see them without opening
    // DevTools.
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log(`[renderer] ${message}`);
    });
    // The app menu is disabled (its Ctrl+W accelerator conflicts with
    // close-tab), so re-provide the dev shortcuts it used to supply.
    // In other words: normally Electron's default menu bar gives you
    // shortcuts like F12 for DevTools, but this app has that menu turned
    // off entirely (see Menu.setApplicationMenu(null) below) so those
    // shortcuts stop working on their own — this manually restores just
    // the two most useful ones for development.
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12') win.webContents.toggleDevTools();
      if (input.control && !input.shift && input.key.toLowerCase() === 'r') win.webContents.reload();
    });
  }

  // Let the on-screen UI know when the window becomes maximized or
  // restored, so it can update the maximize button's icon accordingly.
  win.on('maximize', () => win.webContents.send('window:maximized', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized', false));
}

// Must be set BEFORE the app finishes starting (before whenReady callbacks
// create windows). Tells Chromium to allow websites to autoplay video/audio
// without requiring a click first — matching how many people configure a
// daily-driver browser, and fixing sites (YouTube Shorts, news clips, etc.)
// that look "broken" when autoplay is blocked and their player UI never
// fully initializes.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Once Electron has finished starting up, set everything in motion: remove
// the default menu bar, wire up all the background functionality, make
// sure the database is ready, and finally open the window.
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // We use our own custom titlebar instead of a native menu bar.
  registerDbHandlers();
  registerFolderHandlers();
  registerWindowHandlers();
  registerClipboardHandlers();
  registerMenuHandlers();
  registerTerminalHandlers();
  registerFileHandlers();
  registerBrowserHandlers(() => mainWindow);
  registerUpdaterHandlers(() => mainWindow);
  await db.ensureInit();
  createWindow();

  // In a real, packaged build (not during development), check for updates
  // a few seconds after startup — waiting a moment first so it doesn't
  // compete with the app's own startup work. Failures are silently
  // ignored here since updater.js already reports errors to the UI.
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 3000);
  }

  // On macOS, apps often stay "running" even with no windows open (you see
  // this when clicking the dock icon reopens the app). This re-creates a
  // window in that situation.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// On Windows/Linux, closing the last window should quit the whole app.
// (macOS apps conventionally keep running in the background even with no
// windows open, which is why this check excludes 'darwin', the internal
// name for macOS.)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
