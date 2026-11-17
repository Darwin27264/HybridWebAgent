import React, { useEffect } from 'react';
import { Toaster } from 'sonner';
import { TelemetryHeader } from './components/TelemetryHeader';
import { WorkflowNavigator } from './components/WorkflowNavigator';
import { Page1GoalModelSetup } from './components/pages/Page1GoalModelSetup';
import { Page2SpecInspector } from './components/pages/Page2SpecInspector';
import { Page3LiveExecution } from './components/pages/Page3LiveExecution';
import { Page4ResultsSteering } from './components/pages/Page4ResultsSteering';
import { JobManager } from './components/JobManager';
import { StatusPage } from './components/StatusPage';
import { ResultsPanel } from './components/ResultsPanel';
import { ChatConsole } from './components/ChatConsole';
import { useScoutStore } from './store/useScoutStore';
import { wsClient } from './lib/wsClient';

export const App: React.FC = () => {
  const activeTab = useScoutStore((state) => state.activeTab);
  const currentPage = useScoutStore((state) => state.currentPage);

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

      {/* Sequential Workflow Navigator when on Workbench */}
      {activeTab === 'workbench' && <WorkflowNavigator />}

      {/* Main Fluid Responsive Workspace Viewport */}
      <main className="flex-1 w-full mx-auto">
        {activeTab === 'workbench' && (
          <div className="w-full">
            {currentPage === 1 && <Page1GoalModelSetup />}
            {currentPage === 2 && <Page2SpecInspector />}
            {currentPage === 3 && <Page3LiveExecution />}
            {currentPage === 4 && <Page4ResultsSteering />}
          </div>
        )}

        {activeTab === 'jobs' && (
          <div className="w-full max-w-[1920px] mx-auto p-6 lg:px-8 xl:px-10">
            <JobManager />
          </div>
        )}

        {activeTab === 'status' && (
          <div className="w-full max-w-[1920px] mx-auto p-6 lg:px-8 xl:px-10">
            <StatusPage />
          </div>
        )}

        {activeTab === 'results' && (
          <div className="w-full max-w-[1920px] mx-auto p-6 lg:px-8 xl:px-10 grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
            <div className="xl:col-span-7 flex flex-col gap-6">
              <ResultsPanel />
            </div>
            <div className="xl:col-span-5 flex flex-col gap-6">
              <ChatConsole />
            </div>
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
