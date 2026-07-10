import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createPane,
  findPane,
  findFirstPane,
  findPaneWithTab,
  reconcile,
  addTab,
  removeTab,
  activateTab as activateTabInTree,
  reorderTab,
  splitWithTab,
  setSplitSizes,
} from '../lib/layoutTree';

// This is the biggest, most central hook in the app: it manages everything
// about ONE open workspace — its list of tabs, its split-pane layout (see
// layoutTree.js for how that tree structure works), which pane is
// currently focused, and every action you can take (open a tab, close it,
// duplicate it, drag it into a split, resize a split, cycle through tabs
// with the keyboard, etc.). Every change here is saved to the on-disk
// database as it happens, so your layout is exactly as you left it the
// next time you open the app.

// Older builds persisted a different layout shape ({ type: 'tabs' } nodes, or
// panes without a tabIds array). Convert on load; reconcile() cleans up the rest.
//
// In plain terms: this app has changed how it stores your tab layout over
// time as it's been developed. This function looks at whatever was saved
// on disk and, if it's in an old/outdated format, converts it into the
// current format so old saved workspaces keep working correctly instead of
// breaking after an app update.
// While you're dragging a split divider, the resizable-panels library
// reports a brand new set of sizes on nearly every animation frame (dozens
// of times a second). If we saved every one of those to disk immediately,
// we'd flood the background process with database writes while you drag —
// which competes for the same background process that's also streaming
// live terminal output, and can make both the drag itself AND any open
// terminals feel laggy/stuttery. So instead we wait for the drag to pause
// for this many milliseconds before actually writing to disk — the on
// screen sizes still update instantly, only the SAVE is delayed.
const RESIZE_PERSIST_DELAY_MS = 200;

function migrateLegacyLayout(node) {
  if (!node || !node.type) return null;
  if (node.type === 'tabs') {
    return createPane(node.tabs || [], node.activeTabId);
  }
  if (node.type === 'pane') {
    if (Array.isArray(node.tabIds)) return node;
    return createPane(node.activeTabId ? [node.activeTabId] : [], node.activeTabId);
  }
  if (node.type === 'split') {
    return { ...node, children: (node.children || []).map(migrateLegacyLayout) };
  }
  return null;
}

export function useWorkspace(workspaceId) {
  // Every tab that belongs to this workspace (browser, terminal, editor
  // tabs alike), as flat data from the database.
  const [tabs, setTabs] = useState([]);
  // The split/pane layout tree describing how those tabs are arranged on
  // screen (see layoutTree.js).
  const [layout, setLayout] = useState(null);
  // Whether this workspace's tabs and layout have finished loading yet.
  const [ready, setReady] = useState(false);
  // Which pane currently has keyboard/action "focus" — this is what Ctrl+T
  // / Ctrl+W / Ctrl+Tab shortcuts and "new tab" buttons act on.
  const [focusedPaneId, setFocusedPaneId] = useState(null);

  // "Ref" versions of the layout/focus state, kept in sync below. We need
  // these because several functions in this hook need to read the LATEST
  // layout/focus value immediately (e.g. right after just changing it), but
  // React's normal state (layout/focusedPaneId) only updates on the next
  // render — reading a ref instead avoids acting on stale, one-step-behind
  // data.
  const layoutRef = useRef(layout);
  const focusedPaneRef = useRef(focusedPaneId);
  layoutRef.current = layout;
  focusedPaneRef.current = focusedPaneId;

  // Holds the pending "save to disk" timer for split-resize drags (see
  // RESIZE_PERSIST_DELAY_MS above and resizeSplit below) — kept as a ref so
  // it survives across renders without itself triggering one.
  const resizePersistTimerRef = useRef(null);

  // Keep the focused pane pointing at a pane that actually exists.
  // In plain terms: if the pane that was focused gets closed/merged away
  // (e.g. its last tab was closed), automatically move focus to whatever
  // pane is left, so keyboard shortcuts don't silently stop working.
  useEffect(() => {
    if (!layout) {
      if (focusedPaneId) setFocusedPaneId(null);
      return;
    }
    if (!focusedPaneId || !findPane(layout, focusedPaneId)) {
      setFocusedPaneId(findFirstPane(layout)?.id || null);
    }
  }, [layout, focusedPaneId]);

  // Saves the current layout tree to the database.
  const persistLayout = useCallback(
    async (tree) => {
      if (!workspaceId) return;
      await window.agentDB.saveLayout(workspaceId, tree);
    },
    [workspaceId]
  );

  // Apply a layout mutation, persist it, and return the new tree.
  //
  // In plain terms: this is the ONE place every layout-changing action
  // funnels through. You give it a function that describes "how to change
  // the layout" (e.g. "add this tab" or "resize this split"), and it: runs
  // that change against the current layout, updates both the React state
  // AND the ref (so the next call sees the fresh value immediately), saves
  // the result to disk, and hands back the new tree so the caller can use
  // it right away (for example, to figure out which new pane a tab landed
  // in).
  const applyLayout = useCallback(
    (updater) => {
      const next = updater(layoutRef.current);
      layoutRef.current = next;
      setLayout(next);
      persistLayout(next);
      return next;
    },
    [persistLayout]
  );

  // Loads this workspace's tabs and layout fresh from the database — used
  // both on first load and any time the workspace changes.
  const refreshTabs = useCallback(async () => {
    if (!workspaceId) {
      // No workspace to load — clear everything out to an empty state.
      setTabs([]);
      setLayout(null);
      setFocusedPaneId(null);
      setReady(true);
      return;
    }
    const rows = await window.agentDB.getTabs(workspaceId);
    const savedLayout = await window.agentDB.getLayout(workspaceId);
    setTabs(rows);

    // Convert any old-format saved layout, then run it through reconcile()
    // to make sure it matches the actual current list of tabs exactly
    // (adding any missing tabs, dropping any that no longer exist).
    const allTabIds = rows.map((t) => String(t.id));
    const tree = reconcile(migrateLegacyLayout(savedLayout), allTabIds);
    layoutRef.current = tree;
    setLayout(tree);
    setFocusedPaneId(findFirstPane(tree)?.id || null);
    await window.agentDB.saveLayout(workspaceId, tree);
    setReady(true);
  }, [workspaceId]);

  // Reload everything whenever the selected workspace changes.
  useEffect(() => {
    setReady(false);
    refreshTabs();
  }, [refreshTabs]);

  // A fast lookup table from tab id to full tab data, rebuilt only when
  // the tab list actually changes, so components can quickly look up "the
  // tab with this id" without scanning the whole list every time.
  const tabsById = useMemo(() => {
    const map = new Map();
    for (const tab of tabs) map.set(String(tab.id), tab);
    return map;
  }, [tabs]);

  // Create a tab in the focused pane (or a given pane / a new split).
  //
  // In plain terms: opens a brand new tab. By default it lands in whatever
  // pane is currently focused. You can instead pass a specific "paneId" to
  // target, or a "direction" ('horizontal'/'vertical') to have it create a
  // brand new split section for the new tab instead of adding it to an
  // existing pane's tab strip.
  const createTab = useCallback(
    async (type, title, config = {}, { paneId, direction } = {}) => {
      if (!workspaceId) return null;
      const tab = await window.agentDB.createTab(workspaceId, type, title, config);
      setTabs((prev) => [...prev, tab]);

      const tabId = String(tab.id);
      if (direction) {
        const target = paneId || focusedPaneRef.current || findFirstPane(layoutRef.current)?.id;
        let newPaneId = null;
        applyLayout((prev) => {
          const result = splitWithTab(prev, target, direction, tabId);
          newPaneId = result.newPaneId;
          return result.tree;
        });
        if (newPaneId) setFocusedPaneId(newPaneId);
      } else {
        const target =
          paneId || focusedPaneRef.current || findFirstPane(layoutRef.current)?.id;
        const next = applyLayout((prev) => addTab(prev, target, tabId));
        setFocusedPaneId(findPaneWithTab(next, tabId)?.id || null);
      }
      return tab;
    },
    [workspaceId, applyLayout]
  );

  // Updates a tab's saved data (like its title, or config details such as
  // which file is open in an editor tab), both on disk and in the
  // on-screen state. "config" updates are merged in rather than replacing
  // the whole config object, so updating one setting doesn't accidentally
  // erase others.
  const updateTab = useCallback(async (id, updates) => {
    await window.agentDB.updateTab(id, updates);
    setTabs((prev) =>
      prev.map((t) =>
        String(t.id) === String(id)
          ? { ...t, ...updates, config: { ...t.config, ...(updates.config || {}) } }
          : t
      )
    );
  }, []);

  // A shortcut for the common case of just renaming a tab.
  const renameTab = useCallback(
    (tabId, title) => updateTab(tabId, { title }),
    [updateTab]
  );

  // Duplicate a tab and place the copy: into `paneId`, into a new split, or
  // right after the original in its own pane.
  //
  // In plain terms: makes a copy of an existing tab (used when you
  // Ctrl+drag a tab, for example). The copy starts as its own new tab in
  // the database with the same type/title/settings, but with any
  // resources the original "owns" (like a running terminal process)
  // stripped out, since a copy shouldn't share a live terminal session
  // with the original — it needs to start its own fresh one instead.
  const duplicateTab = useCallback(
    async (tabId, { paneId, direction } = {}) => {
      if (!workspaceId) return null;
      const original = tabsById.get(String(tabId));
      if (!original) return null;
      // The copy must not share owned resources with the original.
      const { terminalId: _terminalId, ...configCopy } = original.config || {};
      const copy = await window.agentDB.createTab(
        workspaceId,
        original.type,
        original.title,
        configCopy
      );
      setTabs((prev) => [...prev, copy]);

      const copyId = String(copy.id);
      if (direction) {
        const target = paneId || findPaneWithTab(layoutRef.current, tabId)?.id;
        let newPaneId = null;
        applyLayout((prev) => {
          const result = splitWithTab(prev, target, direction, copyId);
          newPaneId = result.newPaneId;
          return result.tree;
        });
        if (newPaneId) setFocusedPaneId(newPaneId);
      } else if (paneId) {
        applyLayout((prev) => addTab(prev, paneId, copyId));
        setFocusedPaneId(paneId);
      } else {
        // No specific target given — place the copy right next to the
        // original, in the same pane, immediately after it.
        const home = findPaneWithTab(layoutRef.current, tabId);
        const index = home ? home.tabIds.indexOf(String(tabId)) + 1 : undefined;
        applyLayout((prev) => addTab(prev, home?.id, copyId, { insertIndex: index }));
        if (home) setFocusedPaneId(home.id);
      }
      return copy;
    },
    [workspaceId, tabsById, applyLayout]
  );

  // Release anything a tab owns outside the DB (currently: its pty).
  //
  // In plain terms: some tabs have a "real" background resource attached
  // to them that isn't just data in the database — a terminal tab has an
  // actual running shell process, and a browser tab has an actual native
  // browser view. Before we delete such a tab for good, we need to
  // explicitly shut those down too, or they'd keep running invisibly in
  // the background forever (a resource/memory leak).
  const releaseTabResources = useCallback(
    (tabId) => {
      const tab = tabsById.get(String(tabId));
      if (tab?.type === 'terminal' && tab.config?.terminalId) {
        window.terminals.kill(tab.config.terminalId);
      }
      if (tab?.type === 'browser') {
        window.browser.destroyPane(String(tabId));
      }
    },
    [tabsById]
  );

  // Closes (permanently deletes) one or more tabs at once: releases their
  // background resources, deletes them from the database, removes them
  // from on-screen state, and removes them from the layout tree.
  const closeTabs = useCallback(
    async (tabIds) => {
      for (const id of tabIds) {
        releaseTabResources(id);
        await window.agentDB.deleteTab(id);
      }
      const closed = new Set(tabIds.map(String));
      setTabs((prev) => prev.filter((t) => !closed.has(String(t.id))));
      applyLayout((prev) => tabIds.reduce((tree, id) => removeTab(tree, id), prev));
    },
    [applyLayout, releaseTabResources]
  );

  // Closing a tab deletes it (and its data) permanently.
  const closeTab = useCallback((tabId) => closeTabs([tabId]), [closeTabs]);

  // Closes every tab in a pane EXCEPT the one you want to keep — the
  // "close other tabs" action you'd find in most tabbed apps' right-click
  // menus.
  const closeOtherTabs = useCallback(
    (paneId, keepTabId) => {
      const pane = findPane(layoutRef.current, paneId);
      if (!pane) return;
      return closeTabs(pane.tabIds.filter((id) => id !== String(keepTabId)));
    },
    [closeTabs]
  );

  // Closes every tab in a pane, which (through normalize() inside
  // layoutTree.js) also collapses that now-empty pane out of the layout
  // entirely — this is effectively "close this whole split section."
  const closePane = useCallback(
    (paneId) => {
      const pane = findPane(layoutRef.current, paneId);
      if (!pane) return;
      return closeTabs([...pane.tabIds]);
    },
    [closeTabs]
  );

  // Switches which tab is the visible/active one, in whichever pane
  // contains it (or a specific pane if given), and makes that pane the
  // focused one too.
  const activateTab = useCallback(
    (tabId, paneId) => {
      const target = paneId || findPaneWithTab(layoutRef.current, tabId)?.id;
      if (!target) return;
      applyLayout((prev) => activateTabInTree(prev, target, tabId));
      setFocusedPaneId(target);
    },
    [applyLayout]
  );

  // Moves a tab to a new position within its own pane's tab strip (used
  // when dragging a tab left/right to reorder it).
  const reorderTabInPane = useCallback(
    (paneId, tabId, newIndex) => {
      applyLayout((prev) => reorderTab(prev, paneId, tabId, newIndex));
    },
    [applyLayout]
  );

  // Move a tab into another pane. The source pane collapses automatically if
  // it becomes empty.
  const moveTabToPane = useCallback(
    (tabId, targetPaneId, insertIndex) => {
      applyLayout((prev) => {
        const stripped = removeTab(prev, tabId);
        return addTab(stripped, targetPaneId, tabId, { insertIndex });
      });
      setFocusedPaneId(findPaneWithTab(layoutRef.current, tabId)?.id || targetPaneId);
    },
    [applyLayout]
  );

  // Split a pane, moving the tab into the new half.
  //
  // In plain terms: used when you drag a tab to the edge of a pane to
  // create a brand new resizable split section, moving that tab into the
  // freshly created half.
  const splitPane = useCallback(
    (targetPaneId, direction, tabId) => {
      let newPaneId = null;
      applyLayout((prev) => {
        const result = splitWithTab(prev, targetPaneId, direction, tabId);
        newPaneId = result.newPaneId;
        return result.tree;
      });
      const landed = findPaneWithTab(layoutRef.current, tabId)?.id;
      setFocusedPaneId(landed || newPaneId || targetPaneId);
    },
    [applyLayout]
  );

  // Marks a pane as the currently focused one (e.g. when you click inside
  // it) — see PaneContainer.jsx for where this gets called.
  const focusPane = useCallback((paneId) => {
    setFocusedPaneId(paneId);
  }, []);

  // Cycle the active tab within the focused pane (Ctrl+Tab / Ctrl+Shift+Tab).
  //
  // "delta" is +1 to move to the next tab or -1 to move to the previous
  // one, wrapping around from the last tab back to the first (and vice
  // versa) using the "% pane.tabIds.length" remainder trick.
  const cycleTab = useCallback(
    (delta) => {
      const pane = findPane(layoutRef.current, focusedPaneRef.current);
      if (!pane || pane.tabIds.length < 2) return;
      const index = pane.tabIds.indexOf(pane.activeTabId);
      const next = pane.tabIds[(index + delta + pane.tabIds.length) % pane.tabIds.length];
      applyLayout((prev) => activateTabInTree(prev, pane.id, next));
    },
    [applyLayout]
  );

  // Update the sizes of a (possibly nested) split while the user is
  // actively dragging its divider.
  //
  // In plain terms: this is called continuously (many times per second)
  // while you drag a divider between two panes. Unlike every other action
  // in this file, it deliberately does NOT go through applyLayout — it
  // updates what's on screen right away (so dragging still feels instant),
  // but saving the new sizes to disk is debounced (delayed until the drag
  // pauses) instead of happening on every single frame. See
  // RESIZE_PERSIST_DELAY_MS above for why.
  const resizeSplit = useCallback(
    (splitId, sizes) => {
      const next = setSplitSizes(layoutRef.current, splitId, sizes);
      layoutRef.current = next;
      setLayout(next);

      if (resizePersistTimerRef.current) clearTimeout(resizePersistTimerRef.current);
      resizePersistTimerRef.current = setTimeout(() => {
        resizePersistTimerRef.current = null;
        persistLayout(layoutRef.current);
      }, RESIZE_PERSIST_DELAY_MS);
    },
    [persistLayout]
  );

  // If a resize's debounced save hasn't fired yet when this workspace is
  // switched away from (or the whole app closes), don't just drop it —
  // save immediately so the size you dragged to isn't silently lost.
  useEffect(() => {
    return () => {
      if (resizePersistTimerRef.current) {
        clearTimeout(resizePersistTimerRef.current);
        resizePersistTimerRef.current = null;
        persistLayout(layoutRef.current);
      }
    };
  }, [persistLayout]);

  // The id of whichever tab is currently active within the focused pane —
  // recalculated only when the layout or focused pane actually changes.
  const activeTabId = useMemo(() => {
    if (!layout || !focusedPaneId) return null;
    return findPane(layout, focusedPaneId)?.activeTabId || null;
  }, [layout, focusedPaneId]);

  // Hand back everything a component needs to display and control this
  // workspace's tabs and layout.
  return {
    workspaceId,
    tabs,
    tabsById,
    layout,
    ready,
    focusedPaneId,
    activeTabId,
    refreshTabs,
    createTab,
    updateTab,
    renameTab,
    duplicateTab,
    closeTab,
    closeOtherTabs,
    closePane,
    activateTab,
    reorderTabInPane,
    moveTabToPane,
    splitPane,
    focusPane,
    cycleTab,
    resizeSplit,
  };
}
