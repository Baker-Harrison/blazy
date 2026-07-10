import { useEffect, useRef, useState } from 'react';
import { CloseIcon, PlusIcon } from '../icons';
import { PANE_TYPES, paneIcon, paneLabel } from '../../lib/paneTypes';

let overlayRefCount = 0;
function setBrowserOverlay(open) {
  overlayRefCount += open ? 1 : -1;
  if (overlayRefCount < 0) overlayRefCount = 0;
  window.browser?.setOverlayOpen(overlayRefCount > 0);
}

export default function TabBar({ pane, tabs, workspace }) {
  const { activateTab, closeTab, createTab, reorderTabInPane, moveTabToPane } = workspace;
  const paneId = pane.id;
  const [menu, setMenu] = useState(null); // { tabId, x, y }

  const handleDrop = (e) => {
    e.preventDefault();
    const tabId = e.dataTransfer.getData('application/blazy-tab');
    const sourcePaneId = e.dataTransfer.getData('application/blazy-source-pane');
    if (!tabId || sourcePaneId === paneId) return;
    moveTabToPane(tabId, paneId);
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
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ tabId: String(tab.id), x: e.clientX, y: e.clientY });
            }}
            onReorder={(tabId, newIndex) => reorderTabInPane(paneId, tabId, newIndex)}
            onMoveFromOtherPane={(tabId, insertIndex) =>
              moveTabToPane(tabId, paneId, insertIndex)
            }
          />
        ))}
      </div>
      <TabAddButton onSelect={(type) => createTab(type, paneLabel(type), {}, { paneId })} />
      {menu && (
        <TabContextMenu
          menu={menu}
          paneId={paneId}
          tabCount={tabs.length}
          workspace={workspace}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function DraggableTab({
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
  const [dragOver, setDragOver] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const handleDragStart = (e) => {
    e.dataTransfer.setData('application/blazy-tab', String(tab.id));
    e.dataTransfer.setData('application/blazy-source-pane', paneId);
    e.dataTransfer.setData('application/blazy-source-index', String(index));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const tabId = e.dataTransfer.getData('application/blazy-tab');
    const sourcePaneId = e.dataTransfer.getData('application/blazy-source-pane');
    if (!tabId) return;

    let insertIndex = index;
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      insertIndex = e.clientX < rect.left + rect.width / 2 ? index : index + 1;
    }

    if (sourcePaneId === paneId) {
      const sourceIndex = Number(e.dataTransfer.getData('application/blazy-source-index'));
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
}

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

function TabContextMenu({ menu, paneId, tabCount, workspace, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  useEffect(() => {
    setBrowserOverlay(true);
    return () => setBrowserOverlay(false);
  }, []);

  // Keep the menu on-screen.
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - rect.width - 4),
      y: Math.min(menu.y, window.innerHeight - rect.height - 4),
    });
  }, [menu]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = (fn) => () => {
    onClose();
    fn();
  };

  const items = [
    { label: 'Duplicate', action: run(() => workspace.duplicateTab(menu.tabId)) },
    {
      label: 'Split right',
      action: run(() => workspace.splitPane(paneId, 'horizontal', menu.tabId)),
      disabled: tabCount < 2,
    },
    {
      label: 'Split down',
      action: run(() => workspace.splitPane(paneId, 'vertical', menu.tabId)),
      disabled: tabCount < 2,
    },
    { divider: true },
    { label: 'Close', action: run(() => workspace.closeTab(menu.tabId)) },
    {
      label: 'Close others',
      action: run(() => workspace.closeOtherTabs(paneId, menu.tabId)),
      disabled: tabCount < 2,
    },
    { label: 'Close pane', action: run(() => workspace.closePane(paneId)) },
  ];

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={ref}
        style={{ left: pos.x, top: pos.y }}
        className="fixed z-40 min-w-[150px] rounded-md border border-edge bg-surface py-1 shadow-lg"
      >
        {items.map((item, i) =>
          item.divider ? (
            <div key={i} className="my-1 border-t border-edge" />
          ) : (
            <button
              key={item.label}
              type="button"
              disabled={item.disabled}
              onClick={item.action}
              className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-ink hover:bg-hover disabled:cursor-default disabled:text-ink-dim/50 disabled:hover:bg-transparent"
            >
              {item.label}
            </button>
          )
        )}
      </div>
    </>
  );
}

function TabAddButton({ onSelect }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) setBrowserOverlay(true);
    return () => {
      if (open) setBrowserOverlay(false);
    };
  }, [open]);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        title="New tab"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-7 items-center justify-center rounded text-ink-dim hover:bg-hover hover:text-ink"
      >
        <PlusIcon />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-8 z-40 min-w-[140px] rounded-md border border-edge bg-surface py-1 shadow-lg">
            {PANE_TYPES.map(({ type, label, icon: Icon }) => (
              <button
                key={type}
                type="button"
                onClick={() => {
                  onSelect(type);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink hover:bg-hover"
              >
                <Icon />
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
