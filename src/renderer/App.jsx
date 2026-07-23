import { useEffect, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar';
import TitleBar from './components/TitleBar';
import UpdateNotification from './components/UpdateNotification';
import WorkspaceView from './components/workspace/WorkspaceView';
import { ConfirmProvider } from './contexts/ConfirmContext';
import { useUpdater } from './hooks/useUpdater';
import { useWorkspaces } from './hooks/useWorkspaces';

// This is the top-level component of the whole app — think of it as the
// blueprint for the entire window. Everything you see (the sidebar on the
// left, the titlebar with the min/max/close buttons, and the main content
// area) is assembled here and nested inside this one component.
//
// It's wrapped in <ConfirmProvider> so that any component or hook anywhere
// in the app can pop up the custom "Are you sure?" dialog (see
// contexts/ConfirmContext.jsx) instead of the browser's plain built-in one.
export default function App() {
  return (
    <ConfirmProvider>
      <AppShell />
    </ConfirmProvider>
  );
}

function AppShell() {
  // "Hooks" are reusable bundles of logic + data. Here we pull in:
  // - workspaces: all the data and actions related to your list of
  //   workspaces (create, rename, delete, switch between them, etc.)
  // - updater: info about whether a newer version of the app is available
  //   to download and install.
  const workspaces = useWorkspaces();
  const updater = useUpdater();

  // Whether the sidebar panel is currently shown (true) or collapsed/hidden
  // (false). "useState" gives us a piece of memory that, when changed,
  // automatically causes the screen to redraw with the new value.
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Automatically collapse the sidebar when the app window is resized below
  // 768px (e.g., small screens, split windows on desktop, or tablet displays).
  // This keeps the main content area spacious without forcing the user to manually
  // close the sidebar every time they shrink the window.
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 768) {
        setSidebarOpen(false);
      }
    };
    // Run once on initial load to set appropriate layout state for current screen size.
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Figure out which workspace (if any) is the one currently selected/open,
  // by matching its id against workspaces.selectedId. "useMemo" just means
  // "only redo this search when the list of workspaces or the selected id
  // actually changes" — a small performance optimization so we're not
  // re-scanning the list on every single re-render for no reason.
  const selectedWorkspace = useMemo(
    () => workspaces.workspaces.find((w) => w.id === workspaces.selectedId) || null,
    [workspaces.workspaces, workspaces.selectedId]
  );

  return (
    // The overall window is a horizontal strip: sidebar on the left, and
    // everything else (titlebar + main content) stacked vertically on the
    // right of it.
    <div className="flex h-full min-h-0 overflow-hidden">
      <Sidebar workspaces={workspaces} open={sidebarOpen} onToggle={() => setSidebarOpen((v) => !v)} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
        {/* If an update is available/downloading/ready, this shows a small
            banner. If there's nothing to report, it renders nothing. */}
        <UpdateNotification updater={updater} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/* The main content area: shows whatever is inside the currently
              selected workspace (its tabs and panes), or an empty state if
              no workspace is selected. */}
          <WorkspaceView workspace={selectedWorkspace} />
        </main>
      </div>
    </div>
  );
}
