import React from 'react';
import {
  ShieldAlert,
  RotateCw,
} from 'lucide-react';
import { useScoutStore } from '../../store/useScoutStore';
import { wsClient } from '../../lib/wsClient';
import { ResultsPanel } from '../ResultsPanel';
import { ChatConsole } from '../ChatConsole';
import { AlertsDrawer } from '../AlertsDrawer';

export const Page4ResultsSteering: React.FC = () => {
  const setPage = useScoutStore((state) => state.setPage);
  const currentSpec = useScoutStore((state) => state.currentSpec);
  const daemonStatus = useScoutStore((state) => state.daemonStatus);
  const alerts = useScoutStore((state) => state.alerts);

  const handleRerun = () => {
    if (currentSpec) {
      wsClient.startTask(currentSpec);
      setPage(3);
    } else {
      setPage(2);
    }
  };

  return (
    <div className="max-w-[1920px] w-full mx-auto flex flex-col gap-6 p-4 sm:p-6 lg:px-8 xl:px-10">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#2d2d35] pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-semibold">
              Step 4 of 4
            </span>
            <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <span>Results & Steering</span>
              {alerts.length > 0 && (
                <span className="flex items-center gap-1 text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
                  <ShieldAlert className="w-3.5 h-3.5" />
                  {alerts.length} Flagged
                </span>
              )}
            </h1>
          </div>
          <p className="text-xs text-gray-400">
            Examine discovered items, review System 2 narrative synthesis, inspect flagged alerts, and converse with System 2 to steer subsequent runs.
          </p>
        </div>

        <div>
          <button
            onClick={handleRerun}
            disabled={daemonStatus.isRunning}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#8B5CF6] hover:bg-[#7c3aed] text-white text-xs font-semibold shadow-sm transition-colors disabled:opacity-50"
            title="Re-run task with calibrated or steered directives"
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span>Re-Run Task</span>
          </button>
        </div>
      </div>

      {/* Main 12-Column Results & Steering Layout */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left / Main Section: Results Dataset & Markdown Viewer */}
        <div className="xl:col-span-7 flex flex-col gap-6">
          <ResultsPanel />
        </div>

        {/* Right Section: Flagged Matches Drawer + Conversational Chat & Steering */}
        <div className="xl:col-span-5 flex flex-col gap-6">
          <AlertsDrawer />
          <ChatConsole />
        </div>
      </div>
    </div>
  );
};
