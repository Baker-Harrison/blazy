const { WebContentsView, Menu, clipboard, ipcMain, session, net } = require('electron');

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
    // "attachedTabId" remembers which tab's native view is currently
    // plugged into the window (via addChildView) — kept separate from
    // "activeTabId" so we can tell "which tab SHOULD be on top" apart from
    // "which tab's view is ACTUALLY wired into the window right now," and
    // only touch the window's view hierarchy when those two disagree.
    // "appliedBounds" remembers the last {x,y,width,height} rectangle we
    // actually handed to setBounds, so a flood of identical viewport
    // reports (the renderer can send many per second while resizing) don't
    // all turn into real work — see syncBounds below.
    pane = {
      tabs: new Map(),
      order: [],
      activeTabId: null,
      bounds: null,
      visible: false,
      attachedTabId: null,
      appliedBounds: null,
    };
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

// The page's own <img src="..."> can't be handed straight to the on-screen
// tab strip: the app's Content-Security-Policy only allows images from
// "self", "data:", and "blob:" sources (to keep a rogue web page from
// loading tracking pixels or other junk into the app's own UI), which
// blocks a plain "https://example.com/favicon.ico" URL. Since the CSP only
// applies to the on-screen page itself and not to the background process,
// we fetch the favicon HERE instead and hand the renderer a "data:" URI
// (the raw image bytes, inlined right into the URL) — a form the CSP
// already allows through. Cached by URL since most tabs on the same site
// share one favicon, so we don't re-fetch it for every tab.
const faviconCache = new Map(); // faviconUrl -> data: URI (or null if it failed)
const MAX_FAVICON_BYTES = 200_000; // Generous for an icon; guards against something misbehaving.
// This cache has no natural size limit of its own — a long-running session
// that visits many different websites would otherwise add one entry per
// unique favicon URL FOREVER, for as long as the app stays open, slowly
// growing memory usage with no ceiling. Capping it at a generous entry
// count (each entry is small, so this is still cheap even at the cap) and
// evicting the OLDEST entry once it's full keeps memory bounded while still
// caching every favicon you're likely to see again soon.
const MAX_FAVICON_CACHE_ENTRIES = 500;

async function fetchFaviconDataUri(url) {
  if (faviconCache.has(url)) return faviconCache.get(url);
  let result = null;
  try {
    const response = await net.fetch(url);
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 0 && buffer.length <= MAX_FAVICON_BYTES) {
        const contentType = response.headers.get('content-type') || 'image/x-icon';
        result = `data:${contentType};base64,${buffer.toString('base64')}`;
      }
    }
  } catch {
    // Network hiccup, blocked scheme, whatever — just show the fallback
    // globe icon instead of a broken image.
  }
  // A Map remembers insertion order, so its first key is always the
  // oldest entry still in the cache — evict that one once we're full,
  // right before adding the new one, so the cache never grows past the cap.
  if (faviconCache.size >= MAX_FAVICON_CACHE_ENTRIES) {
    faviconCache.delete(faviconCache.keys().next().value);
  }
  faviconCache.set(url, result);
  return result;
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
  wc.on('page-favicon-updated', (_e, favicons) => {
    const url = favicons[0] || null;
    if (!url) {
      update({ favicon: null });
      return;
    }
    fetchFaviconDataUri(url).then((dataUri) => update({ favicon: dataUri }));
  });
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
    // We only care about a key being pressed down (not released), so ignore
    // every other kind of key event.
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    // "ctrl" is true if either the Ctrl key (Windows/Linux) or the Cmd key
    // (Mac, called "meta" here) is held down, so the same shortcuts work on
    // both kinds of keyboards.
    const ctrl = input.control || input.meta;


    // A little helper: tell the renderer (the visible part of the app) that
    // a shortcut happened, and stop the key press from doing anything else
    // (like typing a letter into a text box on the page).
    const forward = (action) => {
      e.preventDefault();
      send('browser:shortcut', paneId, action);
    };

    // 1. Handle global hotkeys (no Ctrl modifier required). F12 opens
    // developer tools, F5 refreshes the page — these work no matter what.
    switch (key) {
      case 'f12':
        e.preventDefault();
        wc.toggleDevTools();
        return;
      case 'f5':
        e.preventDefault();
        wc.reload();
        return;
    }

    // 2. Handle Ctrl-modified hotkeys. If Ctrl/Cmd isn't held down, none of
    // these apply, so there's nothing left to do.
    if (ctrl) {
      switch (key) {
        case 't': return forward('new-tab');
        case 'w': return forward('close-tab');
        case 'l': return forward('focus-address');
        case 'tab': return forward(input.shift ? 'prev-tab' : 'next-tab');
        case 'r':
          e.preventDefault();
          wc.reload();
          return;
        case '=':
        case '+':
          // Zoom in. "=" and "+" share a key on most keyboards (one needs
          // Shift, one doesn't), so we treat them the same.
          e.preventDefault();
          wc.setZoomLevel(wc.getZoomLevel() + 0.5);
          return;
        case '-':
          e.preventDefault();
          wc.setZoomLevel(wc.getZoomLevel() - 0.5);
          return;
        case '0':
          // Reset the zoom level back to the default (normal) size.
          e.preventDefault();
          wc.setZoomLevel(0);
          return;
      }
    }
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

// Detaches whichever tab's native view is currently plugged into the
// window for this pane (if any) — used when the active tab changes, or
// when the pane itself is being torn down. Detaching is the "expensive,
// only-when-it-really-changed" operation (it can cause a visible flicker
// and reshuffles the window's on-screen stacking order), so every other
// code path in this file is careful to only call this when the attached
// tab is actually about to change, not on every single bounds update.
function detachActiveView(pane) {
  if (!pane.attachedTabId) return;
  const prevTab = pane.tabs.get(pane.attachedTabId);
  if (prevTab?.view && win && !win.isDestroyed()) {
    prevTab.view.setVisible(false);
    win.contentView.removeChildView(prevTab.view);
  }
  pane.attachedTabId = null;
  pane.appliedBounds = null;
}

// Moves (or first-time-plugs-in) this pane's active native page view to
// match wherever the renderer's placeholder rectangle currently is.
//
// This is deliberately split apart from "should the page even be showing
// right now?" (that decision lives in applyVisibility below). The reason:
// a window resize or split-divider drag can call this dozens of times a
// second, and each call should be as cheap as possible — just "move the
// rectangle" — with none of the heavier attach/detach work repeated unless
// something actually changed. Think of it like a picture frame: once the
// picture (the native view) is hung on the wall (addChildView), you don't
// take it down and re-hang it every time you nudge it a few pixels over —
// you just slide it. Re-hanging it every time is what caused the flicker
// and z-order glitches this function exists to avoid.
function syncBounds(paneId) {
  const pane = panes.get(paneId);
  if (!pane || !win || win.isDestroyed()) return;
  const activeTab = pane.activeTabId ? pane.tabs.get(pane.activeTabId) : null;
  if (!activeTab?.view || !pane.bounds) return;

  // Step 1: make sure the RIGHT tab's view is plugged into the window.
  // If some other tab's view is currently attached (e.g. the user just
  // switched tabs), detach that one first — but only in that case, never
  // as a routine part of a plain bounds update.
  if (pane.attachedTabId !== activeTab.id) {
    detachActiveView(pane);
    win.contentView.addChildView(activeTab.view);
    pane.attachedTabId = activeTab.id;
  }

  // Step 2: move it, but only if the rectangle actually changed since the
  // last time we applied one. Bounds are integers (rounded once, in
  // browser:setViewport below) so this comparison is exact — no risk of
  // "close enough" floating-point numbers making us think nothing changed
  // when it did, or vice versa.
  const b = pane.bounds;
  const prev = pane.appliedBounds;
  const changed = !prev || prev.x !== b.x || prev.y !== b.y || prev.width !== b.width || prev.height !== b.height;
  if (changed) {
    activeTab.view.setBounds(b);
    pane.appliedBounds = b;
  }
}

// Decides whether this pane's active page should be visible at all right
// now (as opposed to WHERE it should sit, which is syncBounds's job) —
// e.g. it should hide while an in-app menu/overlay is open (so the native
// page can't render on top of it), while the pane itself is off-screen
// (a different workspace tab is active), or while it has no bounds yet.
// Hiding just flips a "don't paint this" flag (setVisible(false)) rather
// than unplugging the view from the window (removeChildView) — unplugging
// is the expensive, flicker-prone operation, so we save it for when a tab
// is actually closed or the pane is destroyed (see destroyTabView/
// destroyPane), not for routine show/hide toggling.
function applyVisibility(paneId) {
  const pane = panes.get(paneId);
  if (!pane || !win || win.isDestroyed()) return;
  const activeTab = pane.activeTabId ? pane.tabs.get(pane.activeTabId) : null;
  const shouldShow = !overlayOpen && pane.visible && !!activeTab?.view && !!pane.bounds;

  if (shouldShow) {
    syncBounds(paneId);
    activeTab.view.setVisible(true);
  } else if (pane.attachedTabId) {
    const attachedTab = pane.tabs.get(pane.attachedTabId);
    attachedTab?.view?.setVisible(false);
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

// Tears down a tab's native view completely — this is one of the few
// places actually removing it from the window (via removeChildView) is
// correct, since the view is being thrown away entirely, not just hidden.
// Takes the owning pane (rather than looking it up) so it can clear
// attachedTabId/appliedBounds when the tab being destroyed happens to be
// the one currently plugged into the window — otherwise syncBounds would
// wrongly believe that (now-destroyed) view was still attached and skip
// re-attaching the next one.
function destroyTabView(pane, tab) {
  if (!tab.view) return;
  try {
    if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
  } catch {}
  tab.view = null;
  if (pane.attachedTabId === tab.id) {
    pane.attachedTabId = null;
    pane.appliedBounds = null;
  }
}

function closeTab(paneId, tabId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  const tab = pane.tabs.get(tabId);
  if (!tab) return;
  destroyTabView(pane, tab);
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
  for (const tab of pane.tabs.values()) destroyTabView(pane, tab);
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

  // The renderer measures its "page area" placeholder with sub-pixel
  // precision (e.g. 412.37px) — real screens don't have fractional
  // pixels, so this is the ONE place we round that down to a whole
  // number. Doing it here (and nowhere else) means syncBounds's "did the
  // rectangle actually change?" check above can compare plain integers
  // with a simple !== instead of guessing at some "close enough" fudge
  // factor — and it means a rectangle that moved by less than half a
  // pixel rounds back to the exact same integers, so it's correctly
  // treated as "no change" instead of causing a pointless 1px-jitter
  // setBounds call.
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
      destroyTabView(pane, tab);
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
