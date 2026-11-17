import React from 'react';
import {
  Activity,
  Wifi,
  WifiOff,
  Cpu,
  ShieldAlert,
  Clock,
  Layers,
  Calendar,
  BarChart3,
} from 'lucide-react';
import { AreaChart, Area, YAxis } from 'recharts';
import { useScoutStore, formatLatency } from '../store/useScoutStore';

export const TelemetryHeader: React.FC = () => {
  const wsConnected = useScoutStore((state) => state.wsConnected);
  const daemonStatus = useScoutStore((state) => state.daemonStatus);
  const telemetryStats = useScoutStore((state) => state.telemetryStats);
  const activeTab = useScoutStore((state) => state.activeTab);
  const setActiveTab = useScoutStore((state) => state.setActiveTab);

  // Prepare data points for Recharts sparkline
  const sparklineData =
    telemetryStats.latencyHistory.length > 0
      ? telemetryStats.latencyHistory
      : [
          { time: '0', latencyMs: 0 },
          { time: '1', latencyMs: 0 },
        ];

  return (
    <header className="w-full bg-[#242427] border-b border-[#383842] px-6 py-3 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-50 shadow-md">
      {/* Brand & Connection Status */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-[#10B981] flex items-center justify-center text-black shadow-sm">
            <Activity className="w-5 h-5 text-black" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-base tracking-tight text-white flex items-center gap-1.5">
                sysOne Scout
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-[#18181b] text-[#10B981] border border-[#383842]">
                  v0.2.0
                </span>
              </h1>
            </div>
            <p className="text-xs text-gray-400">Production Offline Dual-Brain AI</p>
          </div>
        </div>

        <div className="h-6 w-px bg-[#383842] mx-1 hidden sm:block" />

        {/* Top-Level Navigation View Switcher */}
        <nav className="flex items-center bg-[#18181b] p-1 rounded-lg border border-[#383842] gap-1">
          <button
            onClick={() => setActiveTab('workbench')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'workbench'
                ? 'bg-[#242427] text-white shadow-sm border border-[#383842]'
                : 'text-gray-400 hover:text-white hover:bg-[#2c2c31]'
            }`}
          >
            <Layers className="w-4 h-4 text-[#8B5CF6]" />
            <span>Workbench</span>
          </button>

          <button
            onClick={() => setActiveTab('jobs')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'jobs'
                ? 'bg-[#242427] text-white shadow-sm border border-[#383842]'
                : 'text-gray-400 hover:text-white hover:bg-[#2c2c31]'
            }`}
          >
            <Calendar className="w-4 h-4 text-[#06B6D4]" />
            <span>Jobs</span>
          </button>

          <button
            onClick={() => setActiveTab('status')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'status'
                ? 'bg-[#242427] text-white shadow-sm border border-[#383842]'
                : 'text-gray-400 hover:text-white hover:bg-[#2c2c31]'
            }`}
          >
            <BarChart3 className="w-4 h-4 text-[#10B981]" />
            <span>Status & Health</span>
          </button>
        </nav>

        <div className="h-6 w-px bg-[#383842] mx-1 hidden md:block" />

        {/* WS Status Pill */}
        <div
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
            wsConnected
              ? 'bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30'
              : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
          }`}
        >
          {wsConnected ? (
            <>
              <Wifi className="w-3.5 h-3.5" />
              <span>WS 4040 Online</span>
            </>
          ) : (
            <>
              <WifiOff className="w-3.5 h-3.5" />
              <span>WS Offline</span>
            </>
          )}
        </div>

        {/* Daemon Status Pill */}
        <div
          className={`hidden xl:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
            daemonStatus.isRunning
              ? 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/40'
              : 'bg-[#18181b] text-gray-400 border-[#383842]'
          }`}
        >
          <div
            className={`w-2 h-2 rounded-full ${
              daemonStatus.isRunning ? 'bg-[#10B981] animate-pulse' : 'bg-gray-500'
            }`}
          />
          <span>{daemonStatus.isRunning ? 'RUNNING' : 'IDLE'}</span>
        </div>

        {/* Laya Engine Pill */}
        <div
          className={`hidden 2xl:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
            daemonStatus.layaReady
              ? 'bg-[#06B6D4]/10 text-[#06B6D4] border-[#06B6D4]/30'
              : 'bg-[#F59E0B]/10 text-[#F59E0B] border-[#F59E0B]/30'
          }`}
        >
          <Cpu className="w-3 h-3" />
          <span>{daemonStatus.layaReady ? 'Laya ONNX Ready' : 'Laya Initializing...'}</span>
        </div>
      </div>

      {/* Latency Sparkline & Counters & Controls */}
      <div className="flex items-center gap-4">
        {/* Latency Sparkline */}
        <div className="hidden lg:flex flex-col items-end">
          <div className="flex items-center gap-1 text-xs text-gray-400 mb-0.5">
            <Clock className="w-3.5 h-3.5 text-[#06B6D4]" />
            <span>Latency Trend</span>
          </div>
          <div className="w-28 h-7 bg-[#18181b] rounded border border-[#383842] px-1 py-0.5 overflow-hidden flex items-center justify-center">
            <AreaChart width={105} height={24} data={sparklineData}>
              <YAxis hide domain={['auto', 'auto']} />
              <Area
                type="monotone"
                dataKey="latencyMs"
                stroke="#10B981"
                strokeWidth={1.5}
                fill="#10B981"
                fillOpacity={0.2}
                isAnimationActive={false}
              />
            </AreaChart>
          </div>
        </div>

        {/* Metric Counters */}
        <div className="flex items-center gap-4 bg-[#18181b] px-3.5 py-1.5 rounded-lg border border-[#383842]">
          {/* Total Evaluated */}
          <div className="text-right">
            <div className="text-xs uppercase tracking-wider text-gray-400">
              Evaluated
            </div>
            <div className="text-sm font-semibold text-white font-mono tabular-nums">
              {telemetryStats.totalScanned.toLocaleString()}
            </div>
          </div>

          <div className="h-6 w-px bg-[#383842]" />

          {/* Flagged Matches */}
          <div className="text-right">
            <div className="text-xs uppercase tracking-wider text-gray-400 flex items-center gap-1">
              <ShieldAlert className="w-3 h-3 text-[#F59E0B]" />
              <span>Matches</span>
            </div>
            <div className="text-sm font-semibold text-[#F59E0B] font-mono tabular-nums">
              {telemetryStats.totalAlerts.toLocaleString()}
            </div>
          </div>

          <div className="h-6 w-px bg-[#383842]" />

          {/* Avg Latency */}
          <div className="text-right">
            <div className="text-xs uppercase tracking-wider text-gray-400">
              Avg Latency
            </div>
            <div className="text-sm font-semibold text-[#10B981] font-mono tabular-nums">
              {formatLatency(telemetryStats.avgLatencyMs)}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
