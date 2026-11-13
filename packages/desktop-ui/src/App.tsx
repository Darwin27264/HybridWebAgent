import React, { useEffect } from 'react';
import { Toaster } from 'sonner';
import { TelemetryHeader } from './components/TelemetryHeader';
import { TaskStudio } from './components/TaskStudio';
import { DecisionMatrix } from './components/DecisionMatrix';
import { AlertsDrawer } from './components/AlertsDrawer';
import { LiveBrowserView } from './components/LiveBrowserView';
import { AgentActionTimeline } from './components/AgentActionTimeline';
import { JobManager } from './components/JobManager';
import { StatusPage } from './components/StatusPage';
import { useScoutStore } from './store/useScoutStore';
import { wsClient } from './lib/wsClient';

export const App: React.FC = () => {
  const activeTab = useScoutStore((state) => state.activeTab);

  useEffect(() => {
    // Initiate resilient WebSocket connection on application start
    wsClient.connect();

    return () => {
      wsClient.disconnect();
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#18181b] text-[#F3F4F6] flex flex-col font-sans selection:bg-[#10B981]/30">
      {/* Top Telemetry & Control Bar with Navigation Switcher */}
      <TelemetryHeader />

      {/* Main Fluid Responsive Workspace Viewport */}
      <main className="flex-1 p-6 w-full mx-auto">
        {activeTab === 'workbench' && (
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
            {/* Column 1: System 2 Task Builder & Spec Inspector (4 cols) */}
            <div className="xl:col-span-4 flex flex-col gap-6">
              <TaskStudio />
            </div>

            {/* Column 2: Live Browser View & Agent Action Trajectory (4 cols) */}
            <div className="xl:col-span-4 flex flex-col gap-6">
              <LiveBrowserView />
              <AgentActionTimeline />
            </div>

            {/* Column 3: System 1 Live Inference Stream & Flagged Matches (4 cols) */}
            <div className="xl:col-span-4 flex flex-col gap-6">
              <DecisionMatrix />
              <AlertsDrawer />
            </div>
          </div>
        )}

        {activeTab === 'jobs' && (
          <div className="w-full max-w-7xl mx-auto">
            <JobManager />
          </div>
        )}

        {activeTab === 'status' && (
          <div className="w-full max-w-7xl mx-auto">
            <StatusPage />
          </div>
        )}
      </main>

      {/* Notification Toasts Anchored at Bottom-Right */}
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: '#242427',
            border: '1px solid #383842',
            color: '#F3F4F6',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
          },
        }}
      />
    </div>
  );
};

export default App;
