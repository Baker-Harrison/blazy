import { memo, useRef, useState } from 'react';
import { CloseIcon, PlusIcon } from '../icons';
import { PANE_TYPES, paneIcon, paneLabel } from '../../lib/paneTypes';

// The row of tabs shown at the top of each pane — like the tab strip in a
// web browser, but for the app's own tabs (browser/terminal/editor).
// This file draws that strip, handles dragging tabs to reorder/move them,
// double-click-to-rename, right-click context menus, and the "+" button
// for adding a new tab.
//
// We wrap `TabBar` in `memo` so that tab bars in other panes don't re-render
// when a tab in a different pane is clicked or created.
const TabBar = memo(function TabBar({ pane, tabs, workspace }) {
  const { activateTab, closeTab, createTab, reorderTabInPane, moveTabToPane } = workspace;
  const paneId = pane.id;

  // Handles dropping a tab (dragged from ANOTHER pane) onto empty space in
  // this tab bar — moves it into this pane, appended at the end.
  const handleDrop = (e) => {
    e.preventDefault();
    const tabId = e.dataTransfer.getData('application/blazy-tab');
    const sourcePaneId = e.dataTransfer.getData('application/blazy-source-pane');
    if (!tabId || sourcePaneId === paneId) return;
    moveTabToPane(tabId, paneId);
  };

  // Opens the right-click menu for a tab as a real OS menu, then runs the
  // matching workspace action for whatever item the user picked. Using a
  // native menu means we never have to hide open browser pages just so the
  // menu stays readable (see the file-level comment above).
  const openTabContextMenu = async (e, tabId) => {
    e.preventDefault();
    // If the appMenu bridge isn't available for some reason, do nothing
    // rather than crash — the rest of the tab strip still works.
    if (!window.appMenu?.popup) return;

    const tabCount = tabs.length;
    // Build the list of choices. "id" is what comes back when the user
    // clicks; "disabled" greys out options that don't make sense right now
    // (e.g. "Split right" when this pane only has one tab — splitting would
    // leave nothing behind in the original half).
    const items = [
      { id: 'duplicate', label: 'Duplicate' },
      { id: 'split-right', label: 'Split right', disabled: tabCount < 2 },
      { id: 'split-down', label: 'Split down', disabled: tabCount < 2 },
      { divider: true },
      { id: 'close', label: 'Close' },
      { id: 'close-others', label: 'Close others', disabled: tabCount < 2 },
      { id: 'close-pane', label: 'Close pane' },
    ];

    // Open the menu at the mouse cursor. Resolves with the chosen item's
    // id, or null if the user dismissed the menu without picking anything.
    const choice = await window.appMenu.popup(items, e.clientX, e.clientY);
    if (!choice) return;

    if (choice === 'duplicate') workspace.duplicateTab(tabId);
    else if (choice === 'split-right') workspace.splitPane(paneId, 'horizontal', tabId);
    else if (choice === 'split-down') workspace.splitPane(paneId, 'vertical', tabId);
    else if (choice === 'close') workspace.closeTab(tabId);
    else if (choice === 'close-others') workspace.closeOtherTabs(paneId, tabId);
    else if (choice === 'close-pane') workspace.closePane(paneId);
  };

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      className="flex h-9 shrink-0 items-center gap-px bg-app border-b border-edge px-1"
    >
      <div
        className="scrollbar-none flex flex-1 items-center gap-px overflow-x-auto"
        onWheel={(e) => {
          // Lets you scroll the tab strip horizontally using a normal
          // vertical mouse wheel/trackpad scroll, the same convenience
          // most browsers offer when you have more tabs than fit on
          // screen.
          if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((tab, index) => (
          <DraggableTab
            key={tab.id}
            tab={tab}
            index={index}
            paneId={paneId}
            active={String(pane.activeTabId) === String(tab.id)}
            onActivate={() => activateTab(tab.id, paneId)}
            onClose={() => closeTab(tab.id)}
            onRename={(title) => workspace.renameTab(tab.id, title)}
            onContextMenu={(e) => openTabContextMenu(e, String(tab.id))}
            onReorder={(tabId, newIndex) => reorderTabInPane(paneId, tabId, newIndex)}
            onMoveFromOtherPane={(tabId, insertIndex) =>
              moveTabToPane(tabId, paneId, insertIndex)
            }
          />
        ))}
      </div>
      <TabAddButton onSelect={(type) => createTab(type, paneLabel(type), {}, { paneId })} />
    </div>
  );
});

export default TabBar;

// One draggable tab "chip" in the tab strip: shows an icon (or the site's
// favicon for browser tabs), the tab's title (double-click to rename it),
// and a small close button. Supports being dragged to reorder within the
// same pane, or dragged into a different pane entirely.
// Wrapped in `memo` so that switching between two tabs doesn't re-render
// every other un-involved tab in the strip.
const DraggableTab = memo(function DraggableTab({
  tab,
  index,
  paneId,
  active,
  onActivate,
  onClose,
  onRename,
  onContextMenu,
  onReorder,
  onMoveFromOtherPane,
}) {
  const Icon = paneIcon(tab.type);
  const ref = useRef(null);
  // Whether another tab is currently being dragged directly over this one
  // (used to draw a small highlight outline as a drop-target indicator).
  const [dragOver, setDragOver] = useState(false);
  // Whether this tab's label is currently being edited inline.
  const [renaming, setRenaming] = useState(false);

  // When a drag starts on this tab, attach the info other drop targets
  // will need: which tab it is, which pane it came from, and its current
  // position — using the browser's built-in drag-and-drop data transfer
  // mechanism (the same one used for dragging files, links, etc.).
  const handleDragStart = (e) => {
    e.dataTransfer.setData('application/blazy-tab', String(tab.id));
    e.dataTransfer.setData('application/blazy-source-pane', paneId);
    e.dataTransfer.setData('application/blazy-source-index', String(index));
    e.dataTransfer.effectAllowed = 'move';
  };

  // Handles another tab being dropped directly onto this one — either
  // reordering it within the same pane, or moving it in from a different
  // pane, landing just before or after this tab depending on which half of
  // it the drop happened on.
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const tabId = e.dataTransfer.getData('application/blazy-tab');
    const sourcePaneId = e.dataTransfer.getData('application/blazy-source-pane');
    if (!tabId) return;

    // Dropping on the left half of this tab inserts before it; dropping on
    // the right half inserts after it — the standard "which side did you
    // drop on" convention for reordering draggable lists.
    let insertIndex = index;
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      insertIndex = e.clientX < rect.left + rect.width / 2 ? index : index + 1;
    }

    if (sourcePaneId === paneId) {
      const sourceIndex = Number(e.dataTransfer.getData('application/blazy-source-index'));
      // If the tab is moving rightward past its own original position, the
      // removal of the tab from its old spot shifts every index after it
      // down by one — this adjustment accounts for that so it lands
      // exactly where visually expected.
      onReorder(tabId, sourceIndex < insertIndex ? insertIndex - 1 : insertIndex);
    } else {
      onMoveFromOtherPane(tabId, insertIndex);
    }
  };

  return (
    <div
      ref={ref}
      draggable={!renaming}
      onDragStart={handleDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={onActivate}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setRenaming(true);
      }}
      onAuxClick={(e) => {
        // Middle-click (mouse button 1) closes the tab, the same shortcut
        // most browsers support for quickly closing tabs.
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onContextMenu={onContextMenu}
      title={renaming ? undefined : `${tab.title} — double-click to rename`}
      className={`group relative flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors ${
        active ? 'bg-surface text-ink' : 'text-ink-dim hover:bg-hover hover:text-ink'
      } ${dragOver ? 'outline outline-1 outline-ink-dim/50' : ''}`}
    >
      {/* Browser tabs show the actual website's favicon if one has loaded;
          every other tab type (and browser tabs without a favicon yet)
          shows its generic type icon instead. */}
      {tab.type === 'browser' && tab.config?.favicon ? (
        <img
          src={tab.config.favicon}
          alt=""
          className="h-3.5 w-3.5 shrink-0 rounded-[2px]"
          draggable={false}
        />
      ) : (
        <Icon />
      )}
      {renaming ? (
        <TabRenameInput
          value={tab.title}
          onCommit={(title) => {
            setRenaming(false);
            if (title && title !== tab.title) onRename(title);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <span className="max-w-[120px] truncate">{tab.title}</span>
      )}
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={`ml-1 flex h-3.5 w-3.5 items-center justify-center rounded text-ink-dim transition-opacity hover:bg-hover hover:text-ink ${
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <CloseIcon />
      </button>
    </div>
  );
});

// The small inline text box shown while renaming a tab, following the same
// commit-on-Enter/blur, cancel-on-Escape pattern used elsewhere in the app
// (see EditableLabel.jsx for the sidebar's equivalent).
function TabRenameInput({ value, onCommit, onCancel }) {
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);

  return (
    <input
      type="text"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        if (cancelled.current) onCancel();
        else onCommit(draft.trim());
      }}
      className="w-[110px] rounded border border-edge bg-app px-1 py-px text-[12px] text-ink focus:outline-none"
    />
  );
}

// The "+" button on the tab strip, which opens a small menu letting you
// pick which type of tab (Browser / Terminal / Editor) to add.
//
// This deliberately uses a native OS menu (window.appMenu.popup) instead of
// an HTML dropdown. An older version drew an HTML menu and had to hide
// every open browser page while it was up — otherwise the native browser
// view would paint over the menu. Hiding the page made the browser look
// blank. A native menu floats above the page, so the browser content stays
// visible the whole time you are choosing a panel type.
function TabAddButton({ onSelect }) {
  const handleClick = async (e) => {
    if (!window.appMenu?.popup) return;

    // Open the menu just under the "+" button (using the button's on-screen
    // rectangle), so it feels attached to the control the user clicked.
    const rect = e.currentTarget.getBoundingClientRect();
    const items = PANE_TYPES.map(({ type, label }) => ({ id: type, label }));
    const choice = await window.appMenu.popup(items, rect.left, rect.bottom);
    // choice is the pane type string ('browser' / 'terminal' / 'editor'),
    // or null if the user closed the menu without picking anything.
    if (choice) onSelect(choice);
  };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        title="New tab"
        onClick={handleClick}
        className="flex h-7 w-7 items-center justify-center rounded text-ink-dim hover:bg-hover hover:text-ink"
      >
        <PlusIcon />
      </button>
    </div>
  );
}
