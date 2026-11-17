import React from 'react';
import {
  Play,
  Square,
  RotateCw,
  ShieldCheck,
} from 'lucide-react';
import { useScoutStore } from '../../store/useScoutStore';
import { wsClient } from '../../lib/wsClient';
import { LiveBrowserView } from '../LiveBrowserView';
import { AgentActionTimeline } from '../AgentActionTimeline';
import { DecisionMatrix } from '../DecisionMatrix';

export const Page3LiveExecution: React.FC = () => {
  const setPage = useScoutStore((state) => state.setPage);
  const daemonStatus = useScoutStore((state) => state.daemonStatus);
  const isLaunching = useScoutStore((state) => state.isLaunching);
  const isStopping = useScoutStore((state) => state.isStopping);
  const wsConnected = useScoutStore((state) => state.wsConnected);
  const canResume = useScoutStore((state) => state.canResume);
  const lastCheckpoint = useScoutStore((state) => state.lastCheckpoint);
  const resumeTask = useScoutStore((state) => state.resumeTask);
  const currentSpec = useScoutStore((state) => state.currentSpec);

  const handleStop = () => {
    wsClient.stopTask();
  };

  const handleResume = async () => {
    await resumeTask(lastCheckpoint?.taskId, lastCheckpoint?.id);
  };

  const handleStartNew = () => {
    if (currentSpec) {
      wsClient.startTask(currentSpec);
    } else {
      setPage(2);
    }
  };

  return (
    <div className="max-w-[1920px] w-full mx-auto flex flex-col gap-6 p-4 sm:p-6 lg:px-8 xl:px-10">
      {/* Page Header & Live Execution Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#2d2d35] pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#06B6D4]/20 text-[#06B6D4] border border-[#06B6D4]/30 font-semibold">
              Step 3 of 4
            </span>
            <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <span>Live Agent Execution View</span>
              {daemonStatus.isRunning && (
                <span className="flex items-center gap-1.5 text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/40 animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-[#10B981] animate-ping" />
                  RUNNING
                </span>
              )}
            </h1>
          </div>
          <p className="text-xs text-gray-400">
            Real-time visual browser viewport, autonomous agent action trajectory, and System 1 non-autoregressive inference stream.
          </p>
        </div>

        {/* Execution Control Action Buttons */}
        <div className="flex flex-wrap items-center gap-2.5">
          {daemonStatus.isRunning ? (
            <button
              onClick={handleStop}
              disabled={isStopping || !wsConnected}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold shadow-sm transition-colors disabled:opacity-50"
            >
              {isStopping ? (
                <>
                  <RotateCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Stopping...</span>
                </>
              ) : (
                <>
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>Stop Agent</span>
                </>
              )}
            </button>
          ) : (
            <>
              {canResume && (
                <button
                  onClick={handleResume}
                  disabled={isLaunching || !wsConnected}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold shadow-sm transition-colors disabled:opacity-50 animate-pulse"
                  title={lastCheckpoint ? `Resume checkpoint at ${lastCheckpoint.currentUrl}` : 'Resume task from checkpoint'}
                >
                  <RotateCw className="w-3.5 h-3.5" />
                  <span>Resume from Checkpoint</span>
                </button>
              )}

              <button
                onClick={handleStartNew}
                disabled={isLaunching || !wsConnected}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#10B981] hover:bg-[#059669] text-black text-xs font-bold shadow-sm transition-colors disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Start Task</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Checkpoint Status Banner if resumable */}
      {canResume && !daemonStatus.isRunning && lastCheckpoint && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-amber-300">
            <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              Checkpoint available for task <strong className="font-mono text-white">{lastCheckpoint.taskId}</strong> (Step {lastCheckpoint.activeStepCount}, Scanned: {lastCheckpoint.totalScanned}, Alerts: {lastCheckpoint.totalAlerts}).
            </span>
          </div>
        </div>
      )}

      {/* 3-Column Execution Dashboard */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Live Browser View */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          <LiveBrowserView />
        </div>

        {/* Center Column: Agent Action Sequence Timeline */}
        <div className="lg:col-span-4 flex flex-col gap-6">
          <AgentActionTimeline />
        </div>

        {/* Right Column: System 1 Inference Stream (DecisionMatrix) */}
        <div className="lg:col-span-3 flex flex-col gap-6">
          <DecisionMatrix />
        </div>
      </div>
    </div>
  );
};
