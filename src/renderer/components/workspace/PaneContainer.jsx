import { memo, useRef, useState } from 'react';
import PaneContent from './PaneContent';
import TabBar from './TabBar';

// A "pane" is one rectangular section of the workspace that has its own
// row of tabs and shows the content of whichever tab is active inside it —
// think of each pane like one of the split sections you get when you drag
// a browser tab to the edge of the screen to snap two windows side by side.
// This component draws one pane: its tab bar on top, and the actual content
// (browser/terminal/editor) below it. It also handles dragging tabs
// around — both reordering/moving tabs between panes, and dropping a tab on
// an edge of a pane to create a brand-new split.
//
// We wrap `PaneContainer` in `memo` so that edits or focus changes in ONE split
// pane don't trigger unnecessary DOM re-renders in other separate split panes.
const PaneContainer = memo(function PaneContainer({ pane, workspace }) {
  const { tabsById, focusPane, focusedPaneId, moveTabToPane, splitPane, duplicateTab } = workspace;
  const { id, activeTabId, tabIds } = pane;
  // A reference to this pane's outer DOM element, used to measure exactly
  // where the mouse is relative to the pane while dragging a tab over it.
  const containerRef = useRef(null);
  // Which "drop region" (center/left/right/top/bottom) is currently being
  // hovered over while dragging a tab, so we can show a highlighted
  // preview of where it would land. Null when nothing is being dragged
  // over this pane.
  const [dropRegion, setDropRegion] = useState(null);
  const isFocused = focusedPaneId === id;

  // Look up the actual tab objects (title, type, etc.) for the ids listed
  // in this pane, filtering out any that might be missing/stale.
  const paneTabs = tabIds.map((tabId) => tabsById.get(String(tabId))).filter(Boolean);
  const activeTab = activeTabId ? tabsById.get(String(activeTabId)) : null;

  // Figures out which "zone" of the pane the mouse is currently over during
  // a drag: dropping near an edge (within 15% of the pane's width/height)
  // means "split the pane in that direction," while dropping anywhere else
  // means "just move the tab into this pane" (center).
  const regionFromEvent = (e) => {
    if (!containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    // Convert the mouse's pixel position into a 0–1 fraction of the pane's
    // width/height, so the 15% edge threshold works regardless of the
    // pane's actual on-screen size.
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const edge = 0.15;
    if (x < edge) return 'left';
    if (x > 1 - edge) return 'right';
    if (y < edge) return 'top';
    if (y > 1 - edge) return 'bottom';
    return 'center';
  };

  // While a tab is being dragged over this pane, continuously update which
  // drop region is highlighted.
  const handleDragOver = (e) => {
    e.preventDefault(); // Required so the browser allows dropping here at all.
    setDropRegion(regionFromEvent(e));
  };

  // Runs when a dragged tab is actually released/dropped onto this pane.
  // Depending on where it was dropped and which modifier keys were held,
  // this either moves the tab here, splits the pane and puts the tab in the
  // new section, or duplicates the tab instead of moving the original.
  const handleDrop = async (e) => {
    e.preventDefault();
    const region = dropRegion;
    setDropRegion(null); // Clear the highlight now that the drop is happening.

    // Read back the tab's id and which pane it came from, which were
    // attached to the drag by TabBar.jsx when the drag started.
    const tabId = e.dataTransfer.getData('application/blazy-tab');
    const sourcePaneId = e.dataTransfer.getData('application/blazy-source-pane');
    if (!tabId) return; // Not a recognized drag (e.g. something else was dropped).

    // Holding Ctrl/Alt/Cmd while dropping duplicates the tab instead of
    // moving it — similar to how holding Ctrl while dragging a file in
    // File Explorer copies it instead of moving it.
    const isCopy = e.ctrlKey || e.altKey || e.metaKey;
    const splitting = region && region !== 'center';

    // Dropping a tab onto the middle of its own pane is a no-op.
    if (!splitting && !isCopy && sourcePaneId === id) return;

    const direction = splitting
      ? region === 'left' || region === 'right'
        ? 'horizontal'
        : 'vertical'
      : null;

    if (isCopy) {
      await duplicateTab(tabId, splitting ? { paneId: id, direction } : { paneId: id });
    } else if (splitting) {
      splitPane(id, direction, tabId);
    } else {
      moveTabToPane(tabId, id);
    }
  };

  return (
    <div
      ref={containerRef}
      onClick={() => {
        // Clicking anywhere in this pane makes it the "focused" pane
        // (highlighted with a subtle red ring), so keyboard shortcuts like
        // Ctrl+T/Ctrl+W know which pane they should apply to.
        if (!isFocused) focusPane(id);
      }}
      className={`relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
        isFocused ? 'ring-1 ring-inset ring-danger/40' : ''
      }`}
    >
      <TabBar pane={pane} tabs={paneTabs} workspace={workspace} />
      <div
        onDragOver={handleDragOver}
        onDragLeave={() => setDropRegion(null)}
        onDrop={handleDrop}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {/* All tabs stay mounted so their state (shell, page, editor) survives
            switching; inactive ones are hidden but keep their size.
            In plain terms: every tab's content is actually kept alive in
            the background all the time (not destroyed when you switch
            away) — we just hide the inactive ones with CSS. This is why
            switching back to a terminal tab shows it exactly as you left
            it, rather than starting fresh. */}
        {paneTabs.map((t) => {
          const isActive = activeTab && String(t.id) === String(activeTab.id);
          return (
            <div
              key={t.id}
              className={`absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden ${
                isActive ? 'visible z-[1]' : 'invisible pointer-events-none'
              }`}
            >
              <PaneContent tab={t} workspace={workspace} />
            </div>
          );
        })}

        {/* Shows the highlighted drop-zone preview (e.g. a shaded half of
            the pane) while dragging a tab over it. */}
        {dropRegion && <DropIndicator region={dropRegion} />}
      </div>
    </div>
  );
});

export default PaneContainer;

// The visual highlight shown during a tab drag, indicating where the tab
// would land if dropped right now — either covering the whole pane
// (center, meaning "just move it here") or half of it (meaning "split the
// pane in this direction").
function DropIndicator({ region }) {
  const classes = {
    center: 'inset-0 bg-ink/5',
    left: 'left-0 top-0 bottom-0 w-1/2 bg-ink/10',
    right: 'right-0 top-0 bottom-0 w-1/2 bg-ink/10',
    top: 'left-0 right-0 top-0 h-1/2 bg-ink/10',
    bottom: 'left-0 right-0 bottom-0 h-1/2 bg-ink/10',
  };

  return (
    <div className={`pointer-events-none absolute z-20 ${classes[region]}`}>
      {region !== 'center' && (
        <div className="flex h-full w-full items-center justify-center">
          <div className="rounded-md border border-ink-dim bg-surface/80 px-2 py-1 text-[11px] text-ink">
            Split {region}
          </div>
        </div>
      )}
    </div>
  );
}
