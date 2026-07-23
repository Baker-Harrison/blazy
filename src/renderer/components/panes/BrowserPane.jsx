import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackIcon,
  ForwardIcon,
  RefreshIcon,
  StopIcon,
  LockIcon,
  GlobeIcon,
  PlusIcon,
  CloseIcon,
  AudioIcon,
} from './BrowserIcons';

// Chrome-only pane: the actual page is a native WebContentsView owned by the
// main process. We render the vertical tab rail + toolbar and continuously
// report where the page area sits so main can position the view over it.
//
// In plain terms: "chrome" here means the browser's own controls (the
// toolbar, tab list, address bar) — not the Chrome browser by Google, but
// the general term for a browser's surrounding UI, as opposed to the web
// PAGE itself. This React component only draws that surrounding UI. The
// actual webpage is a completely separate, real browser view living in the
// background "main" process (see browser.js) — this component's job is to
// draw a rectangle of empty space, and constantly tell the background
// process "the page should appear exactly here, at this size," so the real
// browser view can be positioned on top of it like a picture frame.

// Turns whatever text the user typed into the address bar into an actual
// URL to load — handling three cases, similar to how a real browser's
// address bar works:
//  1. It's already a full URL (starts with "https://" or similar, or a
//     special "about:" page) — use it as-is.
//  2. It looks like a website address without the "https://" part (has a
//     dot in it, like "example.com", or is "localhost") — add "https://"
//     in front of it.
//  3. Otherwise, treat it as a search query and send it to Google search.
function toURL(raw) {
  const text = raw.trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith('about:')) return text;
  // Looks like a host (has a dot or is localhost[:port]) → treat as URL.
  if (!/\s/.test(text) && (/^[^\s]+\.[^\s]{2,}/.test(text) || /^localhost(:\d+)?/.test(text))) {
    return `https://${text}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

// Decides what to show in the address bar for a given URL — hides our own
// internal "data:" URLs (used for the custom error page in browser.js),
// since showing that long encoded text to the user would be confusing.
function displayURL(url) {
  if (!url || url.startsWith('data:')) return '';
  return url;
}

// The small icon shown at the start of each tab in the vertical tab rail:
// a spinning loading indicator while the page is loading, the website's
// own favicon once it has one, or a generic globe icon as a fallback.
function TabFavicon({ tab }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
      {tab.loading ? (
        <span className="h-3 w-3 animate-spin rounded-full border border-ink-dim border-t-ink" />
      ) : tab.favicon ? (
        <img src={tab.favicon} alt="" className="h-4 w-4 rounded-[2px]" draggable={false} />
      ) : (
        <GlobeIcon />
      )}
    </span>
  );
}

// One tab entry in this browser's vertical tab list (this app uses a
// sidebar-style vertical tab rail for browser tabs, rather than a
// horizontal strip along the top like most browsers). Shows the favicon,
// title, an audio indicator if the tab is playing sound, and a close
// button — or, when the rail is collapsed to save space, just the icon.
function VerticalTab({ tab, active, expanded, onActivate, onClose }) {
  return (
    <div
      onMouseDown={(e) => {
        if (e.button === 1) return; // middle-click close handled in auxclick
        onActivate();
      }}
      onAuxClick={(e) => {
        if (e.button === 1) onClose();
      }}
      title={tab.title || tab.url}
      className={`group relative flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[12px] transition-colors duration-100 ${
        active ? 'bg-hover text-ink' : 'text-ink-dim hover:bg-hover/50 hover:text-ink'
      } ${expanded ? '' : 'justify-center px-0'}`}
    >
      {/* A thin colored accent bar on the left edge, shown only for the
          currently active tab — a "you are here" indicator. */}
      <span
        className={`absolute inset-y-2 left-0 w-[2px] rounded-full bg-danger transition-opacity duration-150 ${
          active ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <TabFavicon tab={tab} />
      {expanded && (
        <>
          <span className="min-w-0 flex-1 truncate">{tab.title || 'New tab'}</span>
          {tab.audible && (
            <span className="shrink-0 text-ink-dim">
              <AudioIcon />
            </span>
          )}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded text-ink-dim hover:bg-danger hover:text-white"
            title="Close tab"
          >
            <CloseIcon />
          </button>
        </>
      )}
    </div>
  );
}

// The little icon on the button that expands/collapses the vertical tab
// rail — draws a rectangle with a divider line, shading the left "rail"
// portion of it darker when the rail is currently expanded, to visually
// hint at what the button does.
function RailToggleIcon({ expanded }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <rect x="1" y="1.5" width="10" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" />
      <line x1="4.5" y1="1.5" x2="4.5" y2="10.5" stroke="currentColor" strokeWidth="1" />
      {expanded && <rect x="1" y="1.5" width="3.5" height="9" rx="1.5" fill="currentColor" opacity="0.5" />}
    </svg>
  );
}

export default function BrowserPane({ tab, workspace }) {
  const paneId = String(tab.id);
  // The live state of this browser pane's tabs, kept in sync with the
  // background process (see browser.js's pushState function).
  const [state, setState] = useState({ tabs: [], activeTabId: null });
  // What's currently typed into the address bar.
  const [input, setInput] = useState('');
  // Whether the user is actively editing the address bar right now (as
  // opposed to it just displaying the current page's URL).
  const [editing, setEditing] = useState(false);
  // Whether the vertical tab rail is shown expanded (with titles/text) or
  // collapsed to just icons — this is the user's own preference, remembered
  // per-tab so it's restored next time. It can still end up collapsed on
  // screen even when this is true, though: see "narrow" below.
  const [railExpanded, setRailExpanded] = useState(tab.config?.railExpanded !== false);
  // A reference to this whole pane's outer element, used below to measure
  // its actual on-screen width so the tab rail can respond to it.
  const rootRef = useRef(null);
  // Whether this pane is currently too narrow to comfortably show the
  // expanded (titled) tab rail without leaving barely any room for the
  // actual page — kept live by the ResizeObserver below, the same
  // responsive approach used for the Explorer in EditorPane.jsx. When
  // true, the rail is forced to its icon-only width regardless of the
  // user's own railExpanded preference above, which is left untouched so
  // widening the pane back out restores exactly what they had before.
  const [narrow, setNarrow] = useState(false);
  // Whether the mouse is currently hovering the tab rail, temporarily
  // showing it expanded even when the user has it pinned collapsed — the
  // same auto-hide behavior as Arc/Edge's vertical tab strip. This is
  // layered on top of railExpanded/narrow below rather than replacing them:
  // hovering only ever opens an already-collapsed rail, it never collapses
  // one the user has deliberately pinned open.
  const [hoverOpen, setHoverOpen] = useState(false);
  // Collapsing back down is delayed a bit after the mouse actually leaves
  // (see handleRailMouseLeave), so a quick flick across the rail's edge
  // doesn't make it flicker shut and reopen. Expanding on the way in has no
  // such delay — that should feel instant.
  const collapseTimer = useRef(null);
  // What the user has actually pinned, ignoring hover — used for the
  // toggle button's own label/icon below, so hovering never makes that
  // button lie about what clicking it will do.
  const pinnedExpanded = railExpanded && !narrow;
  const showExpandedRail = pinnedExpanded || hoverOpen;

  const handleRailMouseEnter = () => {
    if (collapseTimer.current) {
      clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
    setHoverOpen(true);
  };
  const handleRailMouseLeave = () => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => {
      collapseTimer.current = null;
      setHoverOpen(false);
    }, 200);
  };
  // Don't leave a pending collapse timer running after the pane itself is
  // torn down (e.g. the tab was closed while the mouse happened to be
  // hovering the rail).
  useEffect(() => {
    return () => {
      if (collapseTimer.current) clearTimeout(collapseTimer.current);
    };
  }, []);
  // A reference to the empty "page area" div — its on-screen position and
  // size is measured continuously and reported to the background process,
  // so it knows exactly where to draw the real webpage.
  const contentRef = useRef(null);
  const inputRef = useRef(null);
  // Used to "debounce" saving this pane's session — see the effect below
  // that uses it, which waits for things to settle before saving.
  const persistTimer = useRef(null);
  // Remembers the last reported page-area position/size, so we only send
  // an update to the background process when something has actually
  // changed (rather than every single animation frame regardless).
  const lastRect = useRef(null);
  // A ref-mirrored copy of "state," used inside long-lived event listeners
  // below that need to read the LATEST state without re-subscribing every
  // time state changes.
  const stateRef = useRef(state);
  stateRef.current = state;

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) || null;

  // --- Pane lifecycle: create native tabs from saved config, subscribe to state.
  // In plain terms: when this Browser pane first appears, tell the
  // background process to set up its real tabs (restoring whatever URLs
  // were saved from last time, if any), and start listening for state
  // updates (tab list changes) and keyboard shortcuts forwarded from the
  // actual web page (see browser.js's before-input-event handling).
  useEffect(() => {
    const saved = tab.config || {};
    window.browser.ensurePane(paneId, {
      urls: saved.urls,
      activeIndex: saved.activeIndex,
      url: saved.url, // legacy single-url config
    });
    const offState = window.browser.onState((id, next) => {
      if (id === paneId) setState(next);
    });
    const offShortcut = window.browser.onShortcut((id, action) => {
      if (id !== paneId) return;
      if (action === 'new-tab') window.browser.newTab(paneId);
      if (action === 'focus-address') {
        setEditing(true);
        requestAnimationFrame(() => inputRef.current?.select());
        inputRef.current?.focus();
      }
      const s = stateRef.current;
      if (action === 'close-tab' && s.activeTabId) {
        window.browser.closeTab(paneId, s.activeTabId);
      }
      if ((action === 'next-tab' || action === 'prev-tab') && s.tabs.length > 1) {
        const i = s.tabs.findIndex((t) => t.id === s.activeTabId);
        const delta = action === 'next-tab' ? 1 : -1;
        window.browser.activateTab(paneId, s.tabs[(i + delta + s.tabs.length) % s.tabs.length].id);
      }
    });
    return () => {
      offState();
      offShortcut();
      // Tell the background process this pane is no longer visible on
      // screen, so it hides/detaches the native page view accordingly.
      window.browser.setViewport(paneId, null, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  // --- Responsive tab rail: watch this pane's actual on-screen width.
  // In plain terms: this is what makes "narrow" above stay accurate as the
  // pane is resized — whether that's the window shrinking, a split
  // divider being dragged, or the app's own sidebar being toggled open.
  // Below a certain width, showing the full titled tab rail would leave
  // barely any room for the actual page, so it gets forced down to its
  // compact icon-only width instead (see showExpandedRail above).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const NARROW_BREAKPOINT = 480;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setNarrow(width < NARROW_BREAKPOINT);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // --- Viewport tracking: report the content area's rect whenever it changes.
  //
  // In plain terms: instead of running an expensive loop 60 to 144 times every
  // single second even when nothing is moving (which wasted CPU power), we use
  // a `ResizeObserver` and window resize event listeners to detect EXACTLY when
  // the page area rectangle actually changes size or position.
  //
  // During an active drag (like resizing a split pane), we track mouse movements
  // live so the native webpage follows your cursor instantly with zero lag. Once
  // the drag finishes or the app is sitting still, the loop stops completely,
  // taking CPU usage down to zero while preserving perfect alignment!
  useEffect(() => {
    lastRect.current = null;

    const rectsMatch = (a, b) =>
      a.visible === b.visible &&
      Math.abs(a.x - b.x) <= 0.5 &&
      Math.abs(a.y - b.y) <= 0.5 &&
      Math.abs(a.width - b.width) <= 0.5 &&
      Math.abs(a.height - b.height) <= 0.5;

    const syncViewportRect = () => {
      const el = contentRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const visible =
        r.width > 0 &&
        r.height > 0 &&
        el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
      const rect = { x: r.x, y: r.y, width: r.width, height: r.height, visible };

      if (!lastRect.current || !rectsMatch(lastRect.current, rect)) {
        lastRect.current = rect;
        window.browser.setViewport(
          paneId,
          { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          rect.visible
        );
      }
    };

    // Measure immediately once on mount or tab change.
    syncViewportRect();

    // ResizeObserver catches all container size changes (split pane resizing, sidebar toggling, window sizing).
    let resizeObserver = null;
    if (contentRef.current && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        syncViewportRect();
      });
      resizeObserver.observe(contentRef.current);
    }

    // Also listen to window resize and orientation events for OS/window level changes.
    const handleWindowResize = () => syncViewportRect();
    window.addEventListener('resize', handleWindowResize);

    // Track mouse dragging live during active pane divider or window resizes so movement is buttery smooth.
    let isMouseDown = false;
    let dragRaf = null;

    const onPointerMove = () => {
      if (isMouseDown) {
        syncViewportRect();
      }
    };
    const onPointerDown = () => {
      isMouseDown = true;
      syncViewportRect();
    };
    const onPointerUp = () => {
      if (isMouseDown) {
        isMouseDown = false;
        syncViewportRect();
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      if (dragRaf) cancelAnimationFrame(dragRaf);
    };
  }, [paneId]);

  // --- Reflect active tab in the address bar (unless the user is typing).
  // In plain terms: whenever you switch to a different browser tab (or
  // that tab navigates somewhere new), update the address bar to show its
  // URL — but only if the user isn't in the middle of typing something
  // into the address bar themselves, so we don't yank their half-typed
  // text away.
  useEffect(() => {
    if (!editing) setInput(displayURL(activeTab?.url));
  }, [activeTab?.url, editing]);

  // --- Persist session (urls + active index) and surface page title, debounced.
  // In plain terms: every time this browser pane's tabs change (a new tab
  // opened, closed, navigated, etc.), save a snapshot of "which URLs are
  // open and which one is active" to the database, so reopening this
  // workspace later restores your browsing session. This waits 600
  // milliseconds after the last change before actually saving
  // ("debouncing") so that rapid changes (like typing quickly or loading a
  // page that redirects several times) don't trigger a flood of separate
  // saves — only the final settled state gets written.
  useEffect(() => {
    if (!state.tabs.length) return;
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const urls = state.tabs.map((t) => t.url);
      const activeIndex = Math.max(0, state.tabs.findIndex((t) => t.id === state.activeTabId));
      const title = activeTab?.title || 'Browser';
      workspace.updateTab(tab.id, {
        title,
        config: {
          ...tab.config,
          urls,
          activeIndex,
          favicon: activeTab?.favicon || null,
          railExpanded,
          url: undefined, // Clear out the old legacy single-url field, now superseded by "urls".
        },
      });
    }, 600);
    return () => clearTimeout(persistTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, railExpanded]);

  // Handles submitting the address bar (pressing Enter): converts whatever
  // was typed into an actual URL (or search) and navigates there, then
  // hands keyboard focus back to the actual web page.
  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      const url = toURL(input);
      if (!url) return;
      window.browser.navigate(paneId, url);
      setEditing(false);
      inputRef.current?.blur();
      window.browser.focusPage(paneId);
    },
    [input, paneId]
  );

  // Handles a few browser-style keyboard shortcuts (Ctrl+T new tab, Ctrl+W
  // close tab, Ctrl+L focus the address bar) while focus is somewhere in
  // this pane's own UI (not inside the actual web page, which has its own
  // separate shortcut handling in browser.js).
  const handleChromeKeys = useCallback(
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 't') {
        e.preventDefault();
        window.browser.newTab(paneId);
      } else if (key === 'w') {
        e.preventDefault();
        if (stateRef.current.activeTabId) window.browser.closeTab(paneId, stateRef.current.activeTabId);
      } else if (key === 'l') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    },
    [paneId]
  );

  const isSecure = activeTab?.url?.startsWith('https://');
  const loading = !!activeTab?.loading;

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-app"
      onKeyDown={handleChromeKeys}
    >
      {/* Chrome row: nav + address bar */}
      <form
        onSubmit={handleSubmit}
        className="relative flex h-[38px] shrink-0 items-center gap-2 px-2 py-1 [-webkit-app-region:no-drag]"
      >
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => window.browser.back(paneId)}
            disabled={!activeTab?.canGoBack}
            className="flex h-7 w-7 items-center justify-center rounded text-ink transition-colors duration-100 hover:bg-hover disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title="Back"
          >
            <BackIcon disabled={!activeTab?.canGoBack} />
          </button>
          <button
            type="button"
            onClick={() => window.browser.forward(paneId)}
            disabled={!activeTab?.canGoForward}
            className="flex h-7 w-7 items-center justify-center rounded text-ink transition-colors duration-100 hover:bg-hover disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title="Forward"
          >
            <ForwardIcon disabled={!activeTab?.canGoForward} />
          </button>
          <button
            type="button"
            onClick={() => (loading ? window.browser.stop(paneId) : window.browser.reload(paneId))}
            className="flex h-7 w-7 items-center justify-center rounded text-ink transition-colors duration-100 hover:bg-hover"
            title={loading ? 'Stop' : 'Reload'}
          >
            {/* Same button doubles as Reload/Stop, swapping its icon and
                action depending on whether the page is currently loading —
                the same convention used by every major web browser. */}
            {loading ? <StopIcon /> : <RefreshIcon />}
          </button>
        </div>

        <div className="flex h-[26px] min-w-0 flex-1 items-center gap-1.5 rounded-md border border-edge bg-surface px-2 transition-colors duration-100 focus-within:border-ink-dim">
          {/* The little lock/globe icon doubles as a drag handle for the
              current page's URL — the same convention real browsers use.
              Drag it onto an Editor pane to drop in a markdown link, the
              same way you'd drag a URL out of Chrome's address bar. */}
          <span
            draggable={!!activeTab?.url}
            onDragStart={(e) => {
              if (!activeTab?.url) return;
              e.dataTransfer.setData('text/uri-list', activeTab.url);
              e.dataTransfer.setData('text/plain', activeTab.url);
              e.dataTransfer.setData('text/x-blazy-title', activeTab.title || '');
              e.dataTransfer.effectAllowed = 'copy';
            }}
            className={`shrink-0 cursor-grab ${isSecure ? 'text-green-400' : 'text-ink-dim'}`}
          >
            {isSecure ? <LockIcon /> : <GlobeIcon />}
          </span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => {
              setEditing(true);
              requestAnimationFrame(() => inputRef.current?.select());
            }}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              // Escape cancels editing and restores the current page's
              // actual URL, then hands focus back to the page — the same
              // behavior as pressing Escape in a real browser's address
              // bar.
              if (e.key === 'Escape') {
                setInput(displayURL(activeTab?.url));
                inputRef.current?.blur();
                window.browser.focusPage(paneId);
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink placeholder:text-ink-dim focus:outline-none"
            placeholder="Search or enter address"
            spellCheck={false}
          />
        </div>

        <button
          type="button"
          onClick={() => setRailExpanded((v) => !v)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-dim transition-colors duration-100 hover:bg-hover hover:text-ink"
          // While narrow, the rail is forced compact regardless of this
          // button's own on/off preference (see showExpandedRail above) —
          // the label reflects that, so it doesn't claim an action it
          // can't actually perform right now.
          title={narrow ? 'Not enough room to expand the tab rail' : pinnedExpanded ? 'Collapse tab rail' : 'Expand tab rail'}
        >
          <RailToggleIcon expanded={pinnedExpanded} />
        </button>

        {/* Thin accent loading line, flush with the bottom of the chrome row. */}
        {loading && (
          <div className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden">
            <div className="h-full w-1/3 animate-[browser-loading_1.1s_ease-in-out_infinite] rounded-full bg-danger/70" />
          </div>
        )}
      </form>

      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Vertical tab rail — hovering it temporarily expands it even when
            pinned collapsed (see hoverOpen above); leaving collapses it back
            down after a short delay so it doesn't flicker. */}
        <div
          onMouseEnter={handleRailMouseEnter}
          onMouseLeave={handleRailMouseLeave}
          className={`flex shrink-0 flex-col gap-0.5 overflow-y-auto overflow-x-hidden py-1 pl-1.5 pr-1 transition-[width] duration-150 [scrollbar-width:none] ${
            showExpandedRail ? 'w-[188px]' : 'w-[40px]'
          }`}
        >
          {state.tabs.map((t) => (
            <VerticalTab
              key={t.id}
              tab={t}
              active={t.id === state.activeTabId}
              expanded={showExpandedRail}
              onActivate={() => window.browser.activateTab(paneId, t.id)}
              onClose={() => window.browser.closeTab(paneId, t.id)}
            />
          ))}
          <button
            type="button"
            onClick={() => window.browser.newTab(paneId)}
            className={`flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-[12px] text-ink-dim transition-colors duration-100 hover:bg-hover/50 hover:text-ink ${
              showExpandedRail ? '' : 'justify-center px-0'
            }`}
            title="New tab (Ctrl+T)"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <PlusIcon />
            </span>
            {showExpandedRail && <span>New tab</span>}
          </button>
        </div>

        {/* Page area — the native WebContentsView is positioned over this div. */}
        <div ref={contentRef} className="min-h-0 min-w-0 flex-1 bg-app">
          {/* If the actual page's background process crashed (which can
              happen with any web page in any browser), show a friendly
              message with a button to reload it, instead of leaving a
              blank/broken-looking area. */}
          {activeTab?.crashed && (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <div className="text-[15px] font-light text-ink">This tab crashed</div>
              <button
                onClick={() => window.browser.activateTab(paneId, activeTab.id)}
                className="rounded-md border border-edge px-3 py-1 text-[12px] text-ink-dim transition-colors duration-100 hover:bg-hover hover:text-ink"
              >
                Reload tab
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
