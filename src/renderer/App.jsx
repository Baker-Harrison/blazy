import { useMemo, useState } from 'react';
import Sidebar from './components/Sidebar';
import TitleBar from './components/TitleBar';
import UpdateNotification from './components/UpdateNotification';
import WorkspaceView from './components/workspace/WorkspaceView';
import { useUpdater } from './hooks/useUpdater';
import { useWorkspaces } from './hooks/useWorkspaces';

export default function App() {
  const workspaces = useWorkspaces();
  const updater = useUpdater();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const selectedWorkspace = useMemo(
    () => workspaces.workspaces.find((w) => w.id === workspaces.selectedId) || null,
    [workspaces.workspaces, workspaces.selectedId]
  );

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <Sidebar workspaces={workspaces} open={sidebarOpen} onToggle={() => setSidebarOpen((v) => !v)} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
        <UpdateNotification updater={updater} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <WorkspaceView workspace={selectedWorkspace} />
        </main>
      </div>
    </div>
  );
}
