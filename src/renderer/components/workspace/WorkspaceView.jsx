import { useEffect, useMemo, useRef } from 'react';
import { useWorkspace } from '../../hooks/useWorkspace';
import { PANE_TYPES, paneLabel } from '../../lib/paneTypes';
import EmptyWorkspace from './EmptyWorkspace';
import SplitLayout from './SplitLayout';

// This is the big content area that fills most of the app window: whatever
// tabs/panes belong to the currently selected workspace. It also listens
// for a handful of keyboard shortcuts (like Ctrl+T for a new tab) while a
// workspace is open.
export default function WorkspaceView({ workspace }) {
  // Load all the live data/actions for this specific workspace (its tabs,
  // layout, etc.) — see useWorkspace.js for the details.
  const workspaceState = useWorkspace(workspace?.id);
  const { ready, layout } = workspaceState;
  // Combine the workspace's basic info (name, id, etc.) with all its live
  // state/actions into one object that gets passed down to child
  // components. We wrap this in `useMemo` so that child components receiving
  // `state` as a prop won't re-render on every frame unless `workspaceState`
  // or `workspace` has genuinely changed.
  const state = useMemo(
    () => ({ ...workspaceState, workspace }),
    [workspaceState, workspace]
  );

  // useWorkspace() returns a brand-new plain object every single time this
  // component re-renders (it's just an object literal at the end of that
  // hook, not something memoized) — so "workspaceState" itself is a
  // different object on every render even when nothing meaningful in it
  // actually changed. A ref lets the keydown handler below always read the
  // LATEST workspaceState without needing to be recreated (and
  // re-registered with the window) every time it changes identity — see
  // the effect below for why that matters.
  const workspaceStateRef = useRef(workspaceState);
  workspaceStateRef.current = workspaceState;

  // Tab keyboard shortcuts, scoped to the focused pane:
  //   Ctrl+T new browser tab · Ctrl+W close active tab · Ctrl+(Shift+)Tab cycle
  //
  // In plain terms: this sets up a few familiar keyboard shortcuts, similar
  // to the ones in a web browser — Ctrl+T opens a new tab, Ctrl+W closes
  // the current one, and Ctrl+Tab / Ctrl+Shift+Tab jump between tabs.
  //
  // This effect depends only on "workspace" (not "workspaceState") so it
  // attaches its window-wide keydown listener just ONCE per workspace,
  // instead of tearing it down and re-adding it on every re-render — which
  // is what would happen if it depended on workspaceState directly, since
  // that object's identity changes constantly (see the ref above). The
  // handler itself always reads workspaceStateRef.current, so it still acts
  // on fully up-to-date data despite not being recreated every render.
  useEffect(() => {
    // If there's no workspace open, there's nothing to attach shortcuts to.
    if (!workspace) return undefined;
    const onKeyDown = (e) => {
      // Only react to Ctrl-held shortcuts, and ignore them if Alt is also
      // held (to avoid clashing with other OS-level shortcuts like Alt+Tab).
      if (!e.ctrlKey || e.altKey) return;
      const current = workspaceStateRef.current;
      if (e.key === 'Tab') {
        e.preventDefault();
        // Ctrl+Shift+Tab cycles backward (-1), plain Ctrl+Tab cycles
        // forward (+1) through the open tabs.
        current.cycleTab(e.shiftKey ? -1 : 1);
      } else if (e.key.toLowerCase() === 'w' && !e.shiftKey) {
        e.preventDefault();
        if (current.activeTabId) current.closeTab(current.activeTabId);
      } else if (e.key.toLowerCase() === 't' && !e.shiftKey) {
        e.preventDefault();
        const defaultType = PANE_TYPES[0].type;
        current.createTab(defaultType, paneLabel(defaultType));
      }
    };
    // Listen for key presses anywhere in the window (not just inside one
    // particular element), and make sure to remove that listener again
    // when this component goes away or the workspace changes, so we don't
    // end up with multiple overlapping shortcut handlers.
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [workspace]);

  // No workspace selected at all — show the app's welcome/empty screen.
  if (!workspace) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 select-none">
        <span className="text-[26px] font-light text-ink">Blazy</span>
        <span className="text-[13px] text-ink-dim">Select or create a workspace to get started.</span>
      </div>
    );
  }

  // A workspace is selected, but its data hasn't finished loading from disk
  // yet — show a brief loading message rather than a flash of empty content.
  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-ink-dim">
        Loading workspace…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* If this workspace has a saved tab/split layout, draw it; otherwise
          this workspace has no tabs yet, so show the "add your first pane"
          empty state instead. */}
      {layout ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <SplitLayout node={layout} workspace={state} />
        </div>
      ) : (
        <EmptyWorkspace workspace={state} />
      )}
    </div>
  );
}
