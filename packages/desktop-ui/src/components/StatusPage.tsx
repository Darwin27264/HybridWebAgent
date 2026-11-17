import React, { useEffect } from 'react';
import {
  Activity,
  Cpu,
  Database,
  Globe,
  Brain,
  Wifi,
  Clock,
  Server,
  RefreshCw,
  HardDrive,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { useScoutStore } from '../store/useScoutStore';
import { wsClient } from '../lib/wsClient';
import type { ServiceHealthItem } from '@ofln-scout/shared';

export const StatusPage: React.FC = () => {
  const metrics = useScoutStore((state) => state.metrics);
  const metricsHistory = useScoutStore((state) => state.metricsHistory);
  const wsConnected = useScoutStore((state) => state.wsConnected);
  const daemonStatus = useScoutStore((state) => state.daemonStatus);
  const ollamaOnline = useScoutStore((state) => state.ollamaOnline);
  const selectedModel = useScoutStore((state) => state.selectedModel);
  const activeGgufModelId = useScoutStore((state) => state.activeGgufModelId);
  const gpuName = useScoutStore((state) => state.gpuName);

  // Poll metrics if needed on mount
  useEffect(() => {
    wsClient.getMetrics();
    const interval = setInterval(() => {
      if (wsClient.isConnected()) {
        wsClient.getMetrics();
      }
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // Format data points for charts
  const chartData = metricsHistory.length > 0
    ? metricsHistory.map((m) => ({
        time: new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        processCpu: Number(m.cpu.processPercent.toFixed(1)),
        systemCpu: Number(m.cpu.systemPercent.toFixed(1)),
        rssMb: Number((m.memory.rssBytes / (1024 * 1024)).toFixed(1)),
        heapUsedMb: Number((m.memory.heapUsedBytes / (1024 * 1024)).toFixed(1)),
        externalMb: Number((m.memory.externalBytes / (1024 * 1024)).toFixed(1)),
        lagMs: Number(m.eventLoop.lagMs.toFixed(2)),
        p99LagMs: Number(m.eventLoop.p99LagMs.toFixed(2)),
      }))
    : [
        {
          time: new Date().toLocaleTimeString(),
          processCpu: 0,
          systemCpu: 0,
          rssMb: 50,
          heapUsedMb: 25,
          externalMb: 5,
          lagMs: 0.1,
          p99LagMs: 0.2,
        },
      ];

  // Fallback service health calculation if not in metrics
  const services: Record<string, ServiceHealthItem> = metrics?.services || {
    websocket: {
      name: 'WebSocket RPC Bus',
      status: wsConnected ? 'healthy' : 'offline',
      message: wsConnected ? 'Port 4040 active' : 'Reconnecting...',
    },
    database: {
      name: 'SQLite WAL Database',
      status: 'healthy',
      message: 'WAL Mode / Foreign Keys ON',
    },
    layaEngine: {
      name: 'Laya ONNX Engine',
      status: daemonStatus.layaReady ? 'healthy' : 'idle',
      message: daemonStatus.layaReady ? 'ModernBERT ONNX Ready' : 'Initializing...',
    },
    browser: {
      name: 'Playwright Browser',
      status: daemonStatus.isRunning ? 'healthy' : 'idle',
      message: daemonStatus.isRunning ? 'Chromium runner active' : 'Standby',
    },
    ollama: {
      name: 'System 2 (Llama.cpp)',
      status: activeGgufModelId ? 'healthy' : (ollamaOnline ? 'healthy' : 'degraded'),
      message: activeGgufModelId
        ? `Model: ${activeGgufModelId} (${gpuName || 'GPU'})`
        : (ollamaOnline ? `Model: ${selectedModel}` : 'Offline - template fallback active'),
    },
  };

  const getServiceStatusBadge = (status: ServiceHealthItem['status']) => {
    switch (status) {
      case 'healthy':
        return (
          <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30">
            HEALTHY
          </span>
        );
      case 'degraded':
        return (
          <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
            DEGRADED
          </span>
        );
      case 'offline':
        return (
          <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/30">
            OFFLINE
          </span>
        );
      case 'idle':
      default:
        return (
          <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-[#18181b] text-gray-400 border border-[#383842]">
            IDLE
          </span>
        );
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Top Banner */}
      <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-[#10B981]/20 border border-[#10B981]/30 flex items-center justify-center">
            <Activity className="w-5 h-5 text-[#10B981]" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white flex items-center gap-2">
              <span>System Health & Performance Telemetry</span>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-[#18181b] text-gray-300 border border-[#383842]">
                Daemon Node.js Runtime
              </span>
            </h2>
            <p className="text-xs text-gray-400">
              Real-time resource utilization, event loop lag, and subsystem diagnostics
            </p>
          </div>
        </div>

        <button
          onClick={() => wsClient.getMetrics()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#18181b] border border-[#383842] hover:border-[#4d4d5a] text-xs text-gray-300 hover:text-white transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh Now</span>
        </button>
      </div>

      {/* 5 Core Service Health Cards */}
      <div>
        <h3 className="text-xs uppercase tracking-wider text-gray-400 font-semibold mb-3 flex items-center gap-1.5">
          <Server className="w-3.5 h-3.5 text-gray-400" />
          Core Subsystems Health (5 Services)
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
          {/* 1. WebSocket Bus */}
          <div className="bg-[#242427] border border-[#383842] rounded-xl p-4 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="w-8 h-8 rounded-lg bg-[#10B981]/15 border border-[#10B981]/30 flex items-center justify-center">
                  <Wifi className="w-4 h-4 text-[#10B981]" />
                </div>
                {getServiceStatusBadge(services.websocket?.status || (wsConnected ? 'healthy' : 'offline'))}
              </div>
              <h4 className="text-sm font-semibold text-white mb-0.5">WebSocket Bus</h4>
              <p className="text-xs text-gray-400 font-mono">127.0.0.1:4040</p>
            </div>
            <div className="mt-3 pt-2 border-t border-[#383842] text-[11px] text-gray-400">
              {services.websocket?.message || (wsConnected ? 'RPC connected' : 'Disconnected')}
            </div>
          </div>

          {/* 2. SQLite Database */}
          <div className="bg-[#242427] border border-[#383842] rounded-xl p-4 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="w-8 h-8 rounded-lg bg-[#06B6D4]/15 border border-[#06B6D4]/30 flex items-center justify-center">
                  <Database className="w-4 h-4 text-[#06B6D4]" />
                </div>
                {getServiceStatusBadge(services.database?.status || 'healthy')}
              </div>
              <h4 className="text-sm font-semibold text-white mb-0.5">SQLite Database</h4>
              <p className="text-xs text-gray-400 font-mono">WAL Persistence</p>
            </div>
            <div className="mt-3 pt-2 border-t border-[#383842] text-[11px] text-gray-400">
              {services.database?.message || 'Tasks & Alerts Tables'}
            </div>
          </div>

          {/* 3. ONNX Laya Engine */}
          <div className="bg-[#242427] border border-[#383842] rounded-xl p-4 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="w-8 h-8 rounded-lg bg-[#8B5CF6]/15 border border-[#8B5CF6]/30 flex items-center justify-center">
                  <Cpu className="w-4 h-4 text-[#8B5CF6]" />
                </div>
                {getServiceStatusBadge(services.layaEngine?.status || (daemonStatus.layaReady ? 'healthy' : 'idle'))}
              </div>
              <h4 className="text-sm font-semibold text-white mb-0.5">Laya ONNX Engine</h4>
              <p className="text-xs text-gray-400 font-mono">ModernBERT CPU</p>
            </div>
            <div className="mt-3 pt-2 border-t border-[#383842] text-[11px] text-gray-400">
              {services.layaEngine?.message || 'Non-autoregressive'}
            </div>
          </div>

          {/* 4. Playwright Browser */}
          <div className="bg-[#242427] border border-[#383842] rounded-xl p-4 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="w-8 h-8 rounded-lg bg-blue-500/15 border border-blue-500/30 flex items-center justify-center">
                  <Globe className="w-4 h-4 text-blue-400" />
                </div>
                {getServiceStatusBadge(services.browser?.status || (daemonStatus.isRunning ? 'healthy' : 'idle'))}
              </div>
              <h4 className="text-sm font-semibold text-white mb-0.5">Browser Runner</h4>
              <p className="text-xs text-gray-400 font-mono">Playwright Headless</p>
            </div>
            <div className="mt-3 pt-2 border-t border-[#383842] text-[11px] text-gray-400">
              {services.browser?.message || (daemonStatus.isRunning ? 'Active session' : 'Standby')}
            </div>
          </div>

          {/* 5. System 2 Llama.cpp Engine */}
          <div className="bg-[#242427] border border-[#383842] rounded-xl p-4 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="w-8 h-8 rounded-lg bg-[#8B5CF6]/15 border border-[#8B5CF6]/30 flex items-center justify-center">
                  <Brain className="w-4 h-4 text-[#8B5CF6]" />
                </div>
                {getServiceStatusBadge(services.ollama?.status || (activeGgufModelId ? 'healthy' : ollamaOnline ? 'healthy' : 'degraded'))}
              </div>
              <h4 className="text-sm font-semibold text-white mb-0.5">System 2 Engine</h4>
              <p className="text-xs text-gray-400 font-mono truncate">{activeGgufModelId || selectedModel}</p>
            </div>
            <div className="mt-3 pt-2 border-t border-[#383842] text-[11px] text-gray-400 truncate">
              {services.ollama?.message || (activeGgufModelId ? 'Llama.cpp GPU Ready' : 'Template Fallback')}
            </div>
          </div>
        </div>
      </div>

      {/* Visual Telemetry Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Chart 1: CPU Utilization */}
        <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col">
          <div className="flex items-center justify-between border-b border-[#383842] pb-3 mb-4">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[#10B981]" />
              <h4 className="text-sm font-semibold text-white">CPU Utilization (%)</h4>
            </div>
            {metrics && (
              <span className="text-xs font-mono text-gray-300">
                Process: <strong className="text-[#10B981]">{metrics.cpu.processPercent.toFixed(1)}%</strong> | System: {metrics.cpu.systemPercent.toFixed(1)}%
              </span>
            )}
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <XAxis dataKey="time" stroke="#71717a" fontSize={10} tickLine={false} />
                <YAxis stroke="#71717a" fontSize={10} tickLine={false} domain={[0, 100]} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#18181b', borderColor: '#383842', borderRadius: '8px', fontSize: '12px' }}
                />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                <Area
                  type="monotone"
                  dataKey="processCpu"
                  name="Daemon Process CPU"
                  stroke="#10B981"
                  fill="#10B981"
                  fillOpacity={0.25}
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="systemCpu"
                  name="Host System CPU"
                  stroke="#06B6D4"
                  fill="#06B6D4"
                  fillOpacity={0.1}
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 2: Memory Footprint */}
        <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col">
          <div className="flex items-center justify-between border-b border-[#383842] pb-3 mb-4">
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-[#8B5CF6]" />
              <h4 className="text-sm font-semibold text-white">Memory Allocation (MB)</h4>
            </div>
            {metrics && (
              <span className="text-xs font-mono text-gray-300">
                RSS: <strong className="text-[#8B5CF6]">{(metrics.memory.rssBytes / (1024 * 1024)).toFixed(1)} MB</strong> | Heap: {(metrics.memory.heapUsedBytes / (1024 * 1024)).toFixed(1)} MB
              </span>
            )}
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <XAxis dataKey="time" stroke="#71717a" fontSize={10} tickLine={false} />
                <YAxis stroke="#71717a" fontSize={10} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#18181b', borderColor: '#383842', borderRadius: '8px', fontSize: '12px' }}
                />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                <Area
                  type="monotone"
                  dataKey="rssMb"
                  name="RSS Memory (MB)"
                  stroke="#8B5CF6"
                  fill="#8B5CF6"
                  fillOpacity={0.25}
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="heapUsedMb"
                  name="V8 Heap Used (MB)"
                  stroke="#F59E0B"
                  fill="#F59E0B"
                  fillOpacity={0.15}
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 3: Event Loop Latency */}
        <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col lg:col-span-2">
          <div className="flex items-center justify-between border-b border-[#383842] pb-3 mb-4">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-[#06B6D4]" />
              <h4 className="text-sm font-semibold text-white">Node.js Event Loop Lag (ms)</h4>
            </div>
            {metrics && (
              <span className="text-xs font-mono text-gray-300">
                Current: <strong className="text-[#06B6D4]">{metrics.eventLoop.lagMs.toFixed(2)} ms</strong> | P99: {metrics.eventLoop.p99LagMs.toFixed(2)} ms
              </span>
            )}
          </div>

          <div className="h-60 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <XAxis dataKey="time" stroke="#71717a" fontSize={10} tickLine={false} />
                <YAxis stroke="#71717a" fontSize={10} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#18181b', borderColor: '#383842', borderRadius: '8px', fontSize: '12px' }}
                />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                <Line
                  type="monotone"
                  dataKey="lagMs"
                  name="Mean Lag (ms)"
                  stroke="#06B6D4"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="p99LagMs"
                  name="P99 Lag (ms)"
                  stroke="#F59E0B"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};
