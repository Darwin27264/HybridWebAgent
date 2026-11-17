import { create } from 'zustand';
import type {
  CompiledTaskSpec,
  InferenceTelemetryItem,
  Job,
  AgentAction,
  BrowserSnapshot,
  SystemPerformanceMetrics,
  ScrapedItem,
  ResultStats,
  ModelStats,
  GgufModelInfo,
  TaskCheckpoint,
} from '@ofln-scout/shared';
import { wsClient } from '../lib/wsClient';

export interface DaemonStatus {
  isRunning: boolean;
  layaReady: boolean;
  activeTaskId: string | null;
  activeRunId?: string | null;
  lastCheckpoint?: TaskCheckpoint;
}

export type CompilationStatus = 'idle' | 'compiling' | 'ready' | 'error';
export type AppTab = 'workbench' | 'jobs' | 'status' | 'results';
export type WorkflowPage = 1 | 2 | 3 | 4;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  type: 'query' | 'steer';
  content: string;
  timestamp: number;
  meta?: {
    model?: string;
    applied?: boolean;
    explanation?: string;
  };
}

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
  currentPage: WorkflowPage;
  setPage: (page: WorkflowPage | number) => void;
  nextPage: () => void;
  prevPage: () => void;

  // Checkpointing & Resumption
  lastCheckpoint?: TaskCheckpoint;
  canResume: boolean;
  setLastCheckpoint: (chk: TaskCheckpoint) => void;
  resumeTask: (taskId?: string, checkpointId?: string) => Promise<void>;

  // Connection & Daemon Status
  wsConnected: boolean;
  daemonStatus: DaemonStatus;
  isLaunching: boolean;
  isStopping: boolean;
  compilationStatus: CompilationStatus;
  compilationMessage: string;
  currentSpec: CompiledTaskSpec | null;

  // Models (System 2 Ollama & Llama.cpp)
  selectedModel: string;
  availableModels: string[];
  ollamaOnline: boolean;
  ggufModels: GgufModelInfo[];
  activeGgufModelId: string | null;
  gpuName: string;
  gpuBackend: string;
  vramUsageMb: number;
  totalVramMb: number;

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

  // Results & Reporting
  resultsMarkdown: string;
  resultsSummary: string;
  resultsStats: ResultStats | null;
  resultsItems: ScrapedItem[];
  resultsLastUpdated: number | null;

  // System 2 Chat & Steering
  chatMessages: ChatMessage[];
  isChatLoading: boolean;

  // Dual-Brain Model Telemetry
  modelStats: ModelStats | null;

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
  setGgufModelsList: (payload: {
    models: GgufModelInfo[];
    activeModelId: string | null;
    gpuName: string;
    gpuBackend: string;
    vramUsageMb: number;
    totalVramMb: number;
  }) => void;
  updateModelDownloadProgress: (payload: {
    modelId: string;
    percent: number;
    downloadedMb: number;
    totalMb: number;
    speedMbps: number;
    status: 'downloading' | 'completed' | 'error' | 'cancelled';
    error?: string;
  }) => void;
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
  setResults: (payload: {
    markdown?: string;
    summary?: string;
    stats?: ResultStats;
    items?: ScrapedItem[];
    timestamp?: string | number;
  }) => void;
  addChatMessage: (msg: ChatMessage) => void;
  clearChatMessages: () => void;
  setChatLoading: (loading: boolean) => void;
  setModelStats: (stats: ModelStats) => void;
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

  currentPage: 1,
  setPage: (page: WorkflowPage | number) =>
    set(() => ({
      currentPage: Math.max(1, Math.min(4, Math.floor(page))) as WorkflowPage,
    })),
  nextPage: () =>
    set((state) => ({
      currentPage: Math.min(4, state.currentPage + 1) as WorkflowPage,
    })),
  prevPage: () =>
    set((state) => ({
      currentPage: Math.max(1, state.currentPage - 1) as WorkflowPage,
    })),

  lastCheckpoint: undefined,
  canResume: false,
  setLastCheckpoint: (lastCheckpoint: TaskCheckpoint) =>
    set((state) => ({
      lastCheckpoint,
      canResume: !state.daemonStatus.isRunning,
    })),
  resumeTask: async (taskId?: string, checkpointId?: string) => {
    wsClient.resumeTask(taskId, checkpointId);
    set({ currentPage: 3 });
  },

  wsConnected: false,
  daemonStatus: initialDaemonStatus,
  isLaunching: false,
  isStopping: false,
  compilationStatus: 'idle',
  compilationMessage: 'Ready to compile task goal',
  currentSpec: null,

  selectedModel: 'qwen2.5:1.5b',
  availableModels: DEFAULT_MODELS,
  ollamaOnline: true,
  ggufModels: [],
  activeGgufModelId: null,
  gpuName: 'Detecting GPU...',
  gpuBackend: 'vulkan',
  vramUsageMb: 0,
  totalVramMb: 0,

  inferenceFeed: [],
  alerts: [],
  telemetryStats: initialStats,
  latestSnapshot: null,
  agentActions: [],

  jobs: [],
  activeJobId: null,

  metrics: null,
  metricsHistory: [],

  resultsMarkdown: '',
  resultsSummary: '',
  resultsStats: null,
  resultsItems: [],
  resultsLastUpdated: null,

  chatMessages: [],
  isChatLoading: false,

  modelStats: null,

  setConnected: (connected: boolean) =>
    set((state) => {
      if (!connected) {
        // Disconnection event resets active latency display to 0 or idle state per Boundary 8.5
        return {
          wsConnected: false,
          isLaunching: false,
          isStopping: false,
          isChatLoading: false,
          telemetryStats: {
            ...state.telemetryStats,
            avgLatencyMs: 0,
          },
        };
      }
      return { wsConnected: true };
    }),

  setStatus: (daemonStatus: DaemonStatus) =>
    set((state) => {
      const lastCheckpoint = daemonStatus.lastCheckpoint !== undefined
        ? daemonStatus.lastCheckpoint
        : state.lastCheckpoint;
      const canResume = !!(lastCheckpoint && !daemonStatus.isRunning);
      return {
        daemonStatus,
        lastCheckpoint,
        canResume,
        isLaunching: daemonStatus.isRunning ? false : state.isLaunching,
        isStopping: !daemonStatus.isRunning ? false : state.isStopping,
      };
    }),

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

  setGgufModelsList: (payload) =>
    set(() => ({
      ggufModels: payload.models,
      activeGgufModelId: payload.activeModelId,
      gpuName: payload.gpuName,
      gpuBackend: payload.gpuBackend,
      vramUsageMb: payload.vramUsageMb,
      totalVramMb: payload.totalVramMb,
      ollamaOnline: payload.activeModelId !== null
    })),

  updateModelDownloadProgress: (payload) =>
    set((state) => {
      const updated = state.ggufModels.map((m) => {
        if (m.id !== payload.modelId) return m;
        return {
          ...m,
          downloaded: payload.status === 'completed' ? true : m.downloaded,
          isDownloading: payload.status === 'downloading',
          downloadProgress: payload.status === 'downloading'
            ? {
                percent: payload.percent,
                downloadedMb: payload.downloadedMb,
                totalMb: payload.totalMb,
                speedMbps: payload.speedMbps
              }
            : undefined
        };
      });
      return { ggufModels: updated };
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

  setResults: (payload) =>
    set((state) => ({
      resultsMarkdown: payload.markdown !== undefined ? payload.markdown : state.resultsMarkdown,
      resultsSummary: payload.summary !== undefined ? payload.summary : state.resultsSummary,
      resultsStats: payload.stats !== undefined ? payload.stats : state.resultsStats,
      resultsItems: payload.items !== undefined ? payload.items : state.resultsItems,
      resultsLastUpdated:
        payload.timestamp !== undefined
          ? (typeof payload.timestamp === 'string' ? new Date(payload.timestamp).getTime() : payload.timestamp)
          : Date.now(),
    })),

  addChatMessage: (msg: ChatMessage) =>
    set((state) => ({
      chatMessages: [...state.chatMessages, msg],
    })),

  clearChatMessages: () =>
    set({ chatMessages: [] }),

  setChatLoading: (isChatLoading: boolean) =>
    set({ isChatLoading }),

  setModelStats: (modelStats: ModelStats) =>
    set({ modelStats }),

  startFreshRun: () =>
    set({
      inferenceFeed: [],
      alerts: [],
      telemetryStats: { ...initialStats },
      agentActions: [],
      latestSnapshot: null,
      isLaunching: false,
      isStopping: false,
      resultsMarkdown: '',
      resultsSummary: '',
      resultsStats: null,
      resultsItems: [],
      resultsLastUpdated: null,
      chatMessages: [],
      isChatLoading: false,
    }),

  reset: () =>
    set({
      activeTab: 'workbench',
      currentPage: 1,
      canResume: false,
      lastCheckpoint: undefined,
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
      resultsMarkdown: '',
      resultsSummary: '',
      resultsStats: null,
      resultsItems: [],
      resultsLastUpdated: null,
      chatMessages: [],
      isChatLoading: false,
      modelStats: null,
    }),
}));
