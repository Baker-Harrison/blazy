const { WebContentsView, Menu, clipboard, ipcMain, session } = require('electron');

// Real browser engine for BrowserPane: one WebContentsView per browser tab,
// grouped per pane (a pane = one Blazy workspace tab of type 'browser').
// The renderer draws all chrome (tab strip, toolbar) and tells us where the
// page area is; we position the active native view over it.

const PARTITION = 'persist:blazy-browser';
const BG = '#16171b';

let win = null;
let nextTabId = 1;
let overlayOpen = false;

// paneId -> { tabs: Map<tabId, TabEntry>, order: [tabId], activeTabId,
//             bounds, visible }
// TabEntry: { id, url, title, favicon, loading, canGoBack, canGoForward,
//             audible, muted, crashed, view|null (lazy) }
const panes = new Map();

function browserSession() {
  return session.fromPartition(PARTITION);
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function publicTab(t) {
  const { view, ...rest } = t;
  return rest;
}

function pushState(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  send('browser:state', paneId, {
    tabs: pane.order.map((id) => publicTab(pane.tabs.get(id))),
    activeTabId: pane.activeTabId,
  });
}

function getPane(paneId) {
  let pane = panes.get(paneId);
  if (!pane) {
    pane = { tabs: new Map(), order: [], activeTabId: null, bounds: null, visible: false };
    panes.set(paneId, pane);
  }
  return pane;
}

function errorPage(url, description) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(`<!doctype html><html><head><title>Can't reach page</title><style>
      body{background:${BG};color:#9aa1ad;font-family:"Segoe UI Variable Text","Segoe UI",sans-serif;
      display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .box{text-align:center;max-width:420px}h1{color:#e8eaf0;font-weight:300;font-size:22px;margin:0 0 8px}
      p{font-size:13px;margin:4px 0}code{font-family:"Cascadia Code",Consolas,monospace;font-size:12px;color:#6b7280}
    </style></head><body><div class="box"><h1>This page can’t be reached</h1>
    <p>${esc(url)}</p><code>${esc(description)}</code></div></body></html>`)
  );
}

function attachViewEvents(paneId, tab) {
  const wc = tab.view.webContents;
  const update = (patch) => {
    Object.assign(tab, patch);
    pushState(paneId);
  };

  wc.on('did-start-loading', () => update({ loading: true, crashed: false }));
  wc.on('did-stop-loading', () =>
    update({ loading: false, canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() })
  );
  const onNav = () => {
    const url = wc.getURL();
    if (!url.startsWith('data:')) tab.url = url;
    update({ canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() });
  };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.on('page-title-updated', (_e, title) => update({ title }));
  wc.on('page-favicon-updated', (_e, favicons) => update({ favicon: favicons[0] || null }));
  wc.on('audio-state-changed', (e) => update({ audible: e.audible }));
  wc.on('render-process-gone', () => update({ crashed: true, loading: false }));
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    wc.loadURL(errorPage(url, `${description} (${code})`));
  });

  wc.setWindowOpenHandler(({ url }) => {
    createTab(paneId, url, { activate: true });
    return { action: 'deny' };
  });

  // Browser keyboard shortcuts while the page has focus. Chrome-level keys
  // are handled here; pane-level ones are forwarded to the renderer.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    if (!ctrl && key !== 'f5' && key !== 'f12') return;

    const forward = (action) => {
      e.preventDefault();
      send('browser:shortcut', paneId, action);
    };

    if (ctrl && key === 't') return forward('new-tab');
    if (ctrl && key === 'w') return forward('close-tab');
    if (ctrl && key === 'l') return forward('focus-address');
    if (ctrl && key === 'tab') return forward(input.shift ? 'prev-tab' : 'next-tab');
    if ((ctrl && key === 'r') || key === 'f5') { e.preventDefault(); wc.reload(); return; }
    if (key === 'f12') { e.preventDefault(); wc.toggleDevTools(); return; }
    if (ctrl && (key === '=' || key === '+')) { e.preventDefault(); wc.setZoomLevel(wc.getZoomLevel() + 0.5); return; }
    if (ctrl && key === '-') { e.preventDefault(); wc.setZoomLevel(wc.getZoomLevel() - 0.5); return; }
    if (ctrl && key === '0') { e.preventDefault(); wc.setZoomLevel(0); return; }
  });

  wc.on('context-menu', (_e, params) => {
    const template = [];
    if (params.linkURL) {
      template.push(
        { label: 'Open link in new tab', click: () => createTab(paneId, params.linkURL, { activate: true }) },
        { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }
    if (params.selectionText) {
      template.push({ label: 'Copy', role: 'copy' }, { type: 'separator' });
    }
    if (params.isEditable) {
      template.push(
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { type: 'separator' }
      );
    }
    if (params.mediaType === 'image' && params.srcURL) {
      template.push({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) }, { type: 'separator' });
    }
    template.push(
      { label: 'Back', enabled: wc.canGoBack(), click: () => wc.goBack() },
      { label: 'Forward', enabled: wc.canGoForward(), click: () => wc.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Inspect element', click: () => wc.inspectElement(params.x, params.y) }
    );
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function materialize(paneId, tab) {
  if (tab.view) return;
  tab.view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  tab.view.setBackgroundColor(BG);
  attachViewEvents(paneId, tab);
  tab.view.webContents.loadURL(tab.url).catch(() => {});
}

function applyVisibility(paneId) {
  const pane = panes.get(paneId);
  if (!pane || !win || win.isDestroyed()) return;
  for (const id of pane.order) {
    const tab = pane.tabs.get(id);
    if (!tab?.view) continue;
    const show = !overlayOpen && pane.visible && id === pane.activeTabId && pane.bounds;
    if (show) {
      win.contentView.addChildView(tab.view);
      tab.view.setBounds(pane.bounds);
      tab.view.setVisible(true);
    } else {
      tab.view.setVisible(false);
      win.contentView.removeChildView(tab.view);
    }
  }
}

function createTab(paneId, url, { activate = true, lazy = false } = {}) {
  const pane = getPane(paneId);
  const id = String(nextTabId++);
  const tab = {
    id,
    url: url || 'https://www.google.com',
    title: 'New tab',
    favicon: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    crashed: false,
    view: null,
  };
  pane.tabs.set(id, tab);
  pane.order.push(id);
  if (activate || !pane.activeTabId) pane.activeTabId = id;
  if (!lazy || pane.activeTabId === id) materialize(paneId, tab);
  applyVisibility(paneId);
  pushState(paneId);
  return id;
}

function destroyTabView(tab) {
  if (!tab.view) return;
  try {
    if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
  } catch {}
  tab.view = null;
}

function closeTab(paneId, tabId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  const tab = pane.tabs.get(tabId);
  if (!tab) return;
  destroyTabView(tab);
  pane.tabs.delete(tabId);
  const index = pane.order.indexOf(tabId);
  pane.order = pane.order.filter((id) => id !== tabId);
  if (pane.activeTabId === tabId) {
    pane.activeTabId = pane.order[Math.min(index, pane.order.length - 1)] || null;
    const next = pane.activeTabId && pane.tabs.get(pane.activeTabId);
    if (next) materialize(paneId, next);
  }
  applyVisibility(paneId);
  pushState(paneId);
}

function destroyPane(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  for (const tab of pane.tabs.values()) destroyTabView(tab);
  panes.delete(paneId);
}

function activeWebContents(paneId) {
  const pane = panes.get(paneId);
  const tab = pane && pane.activeTabId ? pane.tabs.get(pane.activeTabId) : null;
  return tab?.view?.webContents || null;
}

function registerBrowserHandlers(getWindow) {
  browserSession().setPermissionRequestHandler((_wc, permission, callback) => {
    // Quiet defaults for a daily driver; extend with a prompt UI later.
    const allowed = ['clipboard-sanitized-write', 'fullscreen', 'pointerLock'];
    callback(allowed.includes(permission));
  });

  ipcMain.handle('browser:ensurePane', (_e, paneId, saved) => {
    win = getWindow();
    const pane = getPane(paneId);
    if (pane.order.length === 0) {
      const urls = saved?.urls?.length ? saved.urls : [saved?.url || 'https://www.google.com'];
      const activeIndex = Math.min(saved?.activeIndex || 0, urls.length - 1);
      urls.forEach((url, i) => createTab(paneId, url, { activate: i === activeIndex, lazy: true }));
    }
    pushState(paneId);
  });

  ipcMain.on('browser:setViewport', (_e, paneId, bounds, visible) => {
    const pane = getPane(paneId);
    pane.bounds = bounds
      ? {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.max(0, Math.round(bounds.width)),
          height: Math.max(0, Math.round(bounds.height)),
        }
      : null;
    pane.visible = !!visible;
    applyVisibility(paneId);
  });

  ipcMain.on('browser:newTab', (_e, paneId, url) => createTab(paneId, url, { activate: true }));
  ipcMain.on('browser:closeTab', (_e, paneId, tabId) => closeTab(paneId, tabId));
  ipcMain.on('browser:activateTab', (_e, paneId, tabId) => {
    const pane = panes.get(paneId);
    if (!pane || !pane.tabs.has(tabId)) return;
    pane.activeTabId = tabId;
    const tab = pane.tabs.get(tabId);
    materialize(paneId, tab);
    if (tab.crashed) {
      // Recreate a crashed tab's renderer on activation.
      destroyTabView(tab);
      tab.crashed = false;
      materialize(paneId, tab);
    }
    applyVisibility(paneId);
    pushState(paneId);
  });

  ipcMain.on('browser:navigate', (_e, paneId, url) => {
    const wc = activeWebContents(paneId);
    if (wc) wc.loadURL(url).catch(() => {});
    else {
      const pane = panes.get(paneId);
      const tab = pane?.activeTabId && pane.tabs.get(pane.activeTabId);
      if (tab) {
        tab.url = url;
        materialize(paneId, tab);
      }
    }
  });
  ipcMain.on('browser:back', (_e, paneId) => activeWebContents(paneId)?.goBack());
  ipcMain.on('browser:forward', (_e, paneId) => activeWebContents(paneId)?.goForward());
  ipcMain.on('browser:reload', (_e, paneId) => activeWebContents(paneId)?.reload());
  ipcMain.on('browser:stop', (_e, paneId) => activeWebContents(paneId)?.stop());
  ipcMain.on('browser:focusPage', (_e, paneId) => activeWebContents(paneId)?.focus());
  ipcMain.on('browser:destroyPane', (_e, paneId) => destroyPane(paneId));

  ipcMain.on('browser:setOverlayOpen', (_e, open) => {
    overlayOpen = !!open;
    for (const paneId of panes.keys()) applyVisibility(paneId);
  });
}

module.exports = { registerBrowserHandlers };
