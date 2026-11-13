import { create } from 'zustand';
import type {
  CompiledTaskSpec,
  InferenceTelemetryItem,
  Job,
  AgentAction,
  BrowserSnapshot,
  SystemPerformanceMetrics,
} from '@ofln-scout/shared';

export interface DaemonStatus {
  isRunning: boolean;
  layaReady: boolean;
  activeTaskId: string | null;
}

export type CompilationStatus = 'idle' | 'compiling' | 'ready' | 'error';
export type AppTab = 'workbench' | 'jobs' | 'status';

export interface LatencyPoint {
  time: string;
  latencyMs: number;
}

export interface TelemetryStats {
  totalScanned: number;
  totalAlerts: number;
  avgLatencyMs: number;
  latencyHistory: LatencyPoint[];
}

export interface ScoutState {
  // Navigation
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;

  // Connection & Daemon Status
  wsConnected: boolean;
  daemonStatus: DaemonStatus;
  isLaunching: boolean;
  isStopping: boolean;
  compilationStatus: CompilationStatus;
  compilationMessage: string;
  currentSpec: CompiledTaskSpec | null;

  // Models (System 2 Ollama)
  selectedModel: string;
  availableModels: string[];
  ollamaOnline: boolean;

  // Real-time Feeds
  inferenceFeed: InferenceTelemetryItem[];
  alerts: InferenceTelemetryItem[];
  telemetryStats: TelemetryStats;
  latestSnapshot: BrowserSnapshot | null;
  agentActions: AgentAction[];

  // Multi-Job State
  jobs: Job[];
  activeJobId: string | null;

  // System Performance & Monitoring
  metrics: SystemPerformanceMetrics | null;
  metricsHistory: SystemPerformanceMetrics[];

  // Actions
  setConnected: (connected: boolean) => void;
  setStatus: (status: DaemonStatus) => void;
  setIsLaunching: (isLaunching: boolean) => void;
  setIsStopping: (isStopping: boolean) => void;
  setCompilation: (
    status: CompilationStatus,
    message: string,
    spec?: CompiledTaskSpec
  ) => void;
  setSpec: (spec: CompiledTaskSpec | null) => void;
  setSelectedModel: (model: string) => void;
  setModelsList: (models: string[], selectedModel?: string, ollamaOnline?: boolean) => void;
  addInference: (item: InferenceTelemetryItem) => void;
  addAlert: (item: InferenceTelemetryItem) => void;
  clearAlerts: () => void;
  setLatestSnapshot: (snapshot: BrowserSnapshot | null) => void;
  addAction: (action: AgentAction) => void;
  clearActions: () => void;
  setJobs: (jobs: Job[]) => void;
  updateJobStatus: (jobId: string, status: string, activeRunId?: string) => void;
  setActiveJobId: (id: string | null) => void;
  setMetrics: (metrics: SystemPerformanceMetrics) => void;
  startFreshRun: () => void;
  reset: () => void;
}

export function formatLatency(val: number): string {
  if (typeof val !== 'number' || !isFinite(val) || isNaN(val) || val < 0) {
    return '0.0 ms';
  }
  return `${val.toFixed(1)} ms`;
}

const initialDaemonStatus: DaemonStatus = {
  isRunning: false,
  layaReady: false,
  activeTaskId: null,
};

const initialStats: TelemetryStats = {
  totalScanned: 0,
  totalAlerts: 0,
  avgLatencyMs: 0,
  latencyHistory: [],
};

const DEFAULT_MODELS = [
  'qwen2.5:7b-instruct-q4_K_M',
  'llama3.2:3b',
  'deepseek-r1:8b',
  'mistral:7b',
];

const MAX_FEED_ITEMS = 100;
const MAX_HISTORY_ITEMS = 30;
const MAX_ACTION_ITEMS = 200;
const MAX_METRICS_HISTORY = 60;

export const useScoutStore = create<ScoutState>((set) => ({
  activeTab: 'workbench',
  setActiveTab: (activeTab: AppTab) => set({ activeTab }),

  wsConnected: false,
  daemonStatus: initialDaemonStatus,
  isLaunching: false,
  isStopping: false,
  compilationStatus: 'idle',
  compilationMessage: 'Ready to compile task goal',
  currentSpec: null,

  selectedModel: 'qwen2.5:7b-instruct-q4_K_M',
  availableModels: DEFAULT_MODELS,
  ollamaOnline: true,

  inferenceFeed: [],
  alerts: [],
  telemetryStats: initialStats,
  latestSnapshot: null,
  agentActions: [],

  jobs: [],
  activeJobId: null,

  metrics: null,
  metricsHistory: [],

  setConnected: (connected: boolean) =>
    set((state) => {
      if (!connected) {
        // Disconnection event resets active latency display to 0 or idle state per Boundary 8.5
        return {
          wsConnected: false,
          isLaunching: false,
          isStopping: false,
          telemetryStats: {
            ...state.telemetryStats,
            avgLatencyMs: 0,
          },
        };
      }
      return { wsConnected: true };
    }),

  setStatus: (daemonStatus: DaemonStatus) =>
    set((state) => ({
      daemonStatus,
      isLaunching: daemonStatus.isRunning ? false : state.isLaunching,
      isStopping: !daemonStatus.isRunning ? false : state.isStopping,
    })),

  setIsLaunching: (isLaunching: boolean) => set({ isLaunching }),
  setIsStopping: (isStopping: boolean) => set({ isStopping }),

  setCompilation: (
    compilationStatus: CompilationStatus,
    compilationMessage: string,
    spec?: CompiledTaskSpec
  ) =>
    set((state) => ({
      compilationStatus,
      compilationMessage,
      currentSpec: spec !== undefined ? spec : state.currentSpec,
    })),

  setSpec: (currentSpec: CompiledTaskSpec | null) =>
    set({ currentSpec }),

  setSelectedModel: (rawModel: string) =>
    set((state) => {
      const trimmed = (rawModel || '').trim();
      if (!trimmed) {
        return state;
      }
      const availableModels = state.availableModels.includes(trimmed)
        ? state.availableModels
        : [...state.availableModels, trimmed];
      return { selectedModel: trimmed, availableModels };
    }),

  setModelsList: (models: string[], selectedModel?: string, ollamaOnline?: boolean) =>
    set((state) => {
      const mergedModels = models.length > 0 ? models : state.availableModels;
      return {
        availableModels: mergedModels,
        selectedModel: selectedModel || state.selectedModel,
        ollamaOnline: ollamaOnline !== undefined ? ollamaOnline : state.ollamaOnline,
      };
    }),

  addInference: (item: InferenceTelemetryItem) =>
    set((state) => {
      const validLatency =
        typeof item.latencyMs !== 'number' ||
        !isFinite(item.latencyMs) ||
        isNaN(item.latencyMs) ||
        item.latencyMs < 0
          ? 0
          : item.latencyMs;

      const newTotalScanned = state.telemetryStats.totalScanned + 1;
      const newAvgLatency =
        state.telemetryStats.totalScanned === 0
          ? validLatency
          : ((state.telemetryStats.avgLatencyMs * state.telemetryStats.totalScanned) + validLatency) /
            newTotalScanned;

      const newTotalAlerts = item.triggeredAlert
        ? state.telemetryStats.totalAlerts + 1
        : state.telemetryStats.totalAlerts;

      const timeLabel = new Date(item.timestamp || Date.now()).toLocaleTimeString();

      const updatedHistory = [
        ...state.telemetryStats.latencyHistory,
        { time: timeLabel, latencyMs: validLatency },
      ].slice(-MAX_HISTORY_ITEMS);

      // Prepend newest item, strictly capped at MAX_FEED_ITEMS
      const updatedFeed = [item, ...state.inferenceFeed].slice(0, MAX_FEED_ITEMS);

      return {
        inferenceFeed: updatedFeed,
        telemetryStats: {
          totalScanned: newTotalScanned,
          totalAlerts: newTotalAlerts,
          avgLatencyMs: newAvgLatency,
          latencyHistory: updatedHistory,
        },
      };
    }),

  addAlert: (item: InferenceTelemetryItem) =>
    set((state) => {
      if (state.alerts.some((a) => a.id === item.id)) {
        return state;
      }
      return {
        alerts: [item, ...state.alerts],
      };
    }),

  clearAlerts: () =>
    set((state) => ({
      alerts: [],
      telemetryStats: {
        ...state.telemetryStats,
        totalAlerts: 0,
      },
    })),

  setLatestSnapshot: (latestSnapshot: BrowserSnapshot | null) =>
    set({ latestSnapshot }),

  addAction: (action: AgentAction) =>
    set((state) => ({
      agentActions: [action, ...state.agentActions].slice(0, MAX_ACTION_ITEMS),
    })),

  clearActions: () =>
    set({ agentActions: [] }),

  setJobs: (jobs: Job[]) =>
    set((state) => ({
      jobs,
      activeJobId:
        state.activeJobId && !jobs.some((j) => j.id === state.activeJobId)
          ? (jobs[0]?.id ?? null)
          : state.activeJobId,
    })),

  updateJobStatus: (jobId: string, status: string, activeRunId?: string) =>
    set((state) => ({
      jobs: state.jobs.map((j) =>
        j.id === jobId
          ? {
              ...j,
              status: status as Job['status'],
              updatedAt: Date.now(),
              ...(activeRunId ? { lastRunAt: Date.now() } : {}),
            }
          : j
      ),
    })),

  setActiveJobId: (activeJobId: string | null) =>
    set({ activeJobId }),

  setMetrics: (metrics: SystemPerformanceMetrics) =>
    set((state) => ({
      metrics,
      metricsHistory: [...state.metricsHistory, metrics].slice(-MAX_METRICS_HISTORY),
    })),

  startFreshRun: () =>
    set({
      inferenceFeed: [],
      alerts: [],
      telemetryStats: { ...initialStats },
      agentActions: [],
      latestSnapshot: null,
      isLaunching: false,
      isStopping: false,
    }),

  reset: () =>
    set({
      activeTab: 'workbench',
      wsConnected: false,
      daemonStatus: initialDaemonStatus,
      isLaunching: false,
      isStopping: false,
      compilationStatus: 'idle',
      compilationMessage: 'Ready to compile task goal',
      currentSpec: null,
      selectedModel: 'qwen2.5:7b-instruct-q4_K_M',
      availableModels: DEFAULT_MODELS,
      ollamaOnline: true,
      inferenceFeed: [],
      alerts: [],
      telemetryStats: { ...initialStats },
      latestSnapshot: null,
      agentActions: [],
      jobs: [],
      activeJobId: null,
      metrics: null,
      metricsHistory: [],
    }),
}));
