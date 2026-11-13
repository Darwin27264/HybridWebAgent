// packages/shared/src/types.ts

export type LayaPrimitiveType = 'choice' | 'noul' | 'score';

export interface LayaChoiceQuestion {
  type: 'choice';
  question: string;
  options: Record<string, string> | string[]; // Max 20 distinct options, <192 tokens total
}

export interface LayaNoulQuestion {
  type: 'noul';
  statement: string; // Yes/No proposition evaluated for P(true)
}

export interface LayaScoreQuestion {
  type: 'score';
  question: string;
  rubric: Record<number, string>; // Ordered rubric levels
}

export type LayaQuestionMap = Record<
  string,
  LayaChoiceQuestion | LayaNoulQuestion | LayaScoreQuestion
>;

export interface AlertRule {
  questionKey: string;
  operator: 'equals' | 'gte' | 'boolean_true';
  targetValue: string | number | boolean;
  minAnswerConfidence: number; // Must gate on answer_confidence (0.50 - 0.99)
}

export interface CompiledTaskSpec {
  id: string;
  name: string;
  userGoal: string;
  targetUrl: string;
  domSelector: string;
  pollIntervalMs: number;
  scrollStepPx: number;
  questions: LayaQuestionMap;
  alertRule: AlertRule;
  createdAt: number;
}

export interface InferenceTelemetryItem {
  id: string;
  taskId: string;
  timestamp: number;
  domSnippet: string;
  latencyMs: number;
  rawAnswers: Record<
    string,
    {
      answer: string | number | boolean;
      answer_confidence: number;
      confidence?: number;
      distribution?: Record<string, number>;
    }
  >;
  triggeredAlert: boolean;
}

export interface Job {
  id: string;
  name: string;
  spec: CompiledTaskSpec;
  cronSchedule?: string;
  isScheduled: boolean;
  status: 'idle' | 'running' | 'scheduled' | 'paused' | 'error';
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface JobRun {
  id: string;
  jobId: string;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  totalScanned: number;
  totalAlerts: number;
  avgLatencyMs: number;
  error?: string;
}

export interface RunAggregation {
  runId: string;
  totalScanned: number;
  totalAlerts: number;
  avgLatencyMs: number;
  durationMs: number;
  topMatches: InferenceTelemetryItem[];
}

export interface AgentAction {
  id: string;
  taskId: string;
  timestamp: number;
  type: 'navigation' | 'extraction' | 'inference' | 'scroll' | 'alert' | 'system';
  status: 'pending' | 'success' | 'warning' | 'error';
  message: string;
  details?: Record<string, any>;
}

export interface BrowserSnapshot {
  taskId: string;
  timestamp: number;
  url: string;
  title: string;
  screenshot?: string; // base64 JPEG data URI
  scroll: {
    x: number;
    y: number;
    scrollHeight: number;
    viewportHeight: number;
  };
}

export interface ServiceHealthItem {
  name: string;
  status: 'healthy' | 'degraded' | 'offline' | 'idle';
  message?: string;
  latencyMs?: number;
  details?: Record<string, any>;
}

export interface SystemPerformanceMetrics {
  timestamp: number;
  cpu: { processPercent: number; systemPercent: number };
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    systemFreeBytes: number;
    systemTotalBytes: number;
  };
  eventLoop: { lagMs: number; p99LagMs: number };
  services: Record<string, ServiceHealthItem>;
  activeJobsCount: number;
}

export interface JobSchedule {
  jobId: string;
  cronExpression?: string;
  intervalMs?: number;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
}

// --- Loop Detection & Steering Contracts ---

export type SystemTwoSteeringAction =
  | { action: 'paginate'; selector: string; text?: string }
  | { action: 'navigate'; url: string }
  | { action: 'switch_tab'; tabIndex?: number; url?: string }
  | { action: 'adjust_strategy'; newSelector?: string; scrollStepPx?: number }
  | { action: 'terminate'; reason: 'goal_completed' | 'unachievable' | 'exhausted'; message: string };

export interface HandoverContext {
  taskId: string;
  runId: string;
  userGoal: string;
  targetUrl: string;
  currentUrl: string;
  pageTitle: string;
  stuckReason: 'bottom_of_page' | 'no_new_items' | 'repeated_actions' | 'selector_empty';
  scrollState: {
    y: number;
    scrollHeight: number;
    viewportHeight: number;
  };
  totalScanned: number;
  totalAlerts: number;
  consecutiveEmptyCycles: number;
  interactiveElements: Array<{
    selector: string;
    text: string;
    href?: string;
    tag: string;
  }>;
}

// --- Model Loading & Telemetry Contracts ---

export type ModelLoadingStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ModelStats {
  systemOne: {
    modelName: string;
    format: 'fp32' | 'int8';
    provider: string; // 'webgpu' | 'dml' | 'cuda' | 'rocm' | 'openvino' | 'cpu'
    device: string;
    status: ModelLoadingStatus;
    avgLatencyMs: number;
    error?: string;
  };
  systemTwo: {
    modelName: string;
    availableModels: string[];
    status: ModelLoadingStatus;
    vramUsageMb?: number;
    gpuOffloaded?: boolean;
    error?: string;
  };
}

// --- Results Store Contracts ---

export interface ScrapedItem {
  id: string;
  timestamp: string;
  text: string;
  link?: string;
  answers: Record<string, any>;
  confidence: number;
  triggeredAlert: boolean;
}

export interface ResultStats {
  totalScanned: number;
  totalAlerts: number;
  matchRatePercent: number;
  avgLatencyMs: number;
  topCategories: Record<string, number>;
}

export type WsClientToServerMessage =
  | { type: 'COMPILE_TASK'; payload: { userGoal: string; ollamaModel?: string } }
  | { type: 'START_TASK'; payload: { spec: CompiledTaskSpec } }
  | { type: 'STOP_TASK' }
  | { type: 'CLEAR_ALERTS' }
  | { type: 'GET_MODELS' }
  | { type: 'SET_MODEL'; payload: { model: string } }
  | { type: 'GET_METRICS' }
  | { type: 'GET_JOBS' }
  | { type: 'CREATE_JOB'; payload: { name: string; spec: CompiledTaskSpec; cronSchedule?: string; isScheduled?: boolean } }
  | { type: 'UPDATE_JOB'; payload: { id: string; name?: string; spec?: CompiledTaskSpec; cronSchedule?: string; isScheduled?: boolean } }
  | { type: 'DELETE_JOB'; payload: { id: string } }
  | { type: 'START_JOB'; payload: { jobId: string } }
  | { type: 'STOP_JOB'; payload: { jobId: string } }
  | { type: 'QUERY_RESULTS'; payload: { query: string; taskId?: string } }
  | { type: 'STEER_TASK'; payload: { instruction: string; taskId?: string } }
  | { type: 'GET_RESULTS'; payload: { taskId?: string } }
  | { type: 'GET_MODEL_STATS' };

export type WsServerToClientMessage =
  | {
      type: 'DAEMON_STATUS';
      payload: {
        isRunning: boolean;
        layaReady: boolean;
        activeTaskId: string | null;
        activeRunId?: string | null;
        activeModel?: {
          systemOne?: {
            name: string;
            format: 'fp32' | 'int8';
            provider: string;
            device?: string;
            status: ModelLoadingStatus;
          };
          systemTwo?: {
            name: string;
            status: ModelLoadingStatus;
            gpuOffloaded?: boolean;
            vramUsageMb?: number;
          };
        };
        modelStats?: ModelStats;
      };
    }
  | { type: 'COMPILATION_PROGRESS'; payload: { status: 'compiling' | 'ready' | 'error'; message: string; spec?: CompiledTaskSpec } }
  | { type: 'INFERENCE_EVENT'; payload: InferenceTelemetryItem }
  | { type: 'ALERT_MATCH'; payload: InferenceTelemetryItem }
  | { type: 'AGENT_ACTION'; payload: AgentAction }
  | { type: 'BROWSER_SNAPSHOT'; payload: BrowserSnapshot }
  | { type: 'MODELS_LIST'; payload: { models: string[]; selectedModel: string; ollamaOnline: boolean } }
  | { type: 'METRICS_UPDATE'; payload: SystemPerformanceMetrics }
  | { type: 'JOBS_LIST'; payload: Job[] }
  | { type: 'JOB_STATUS'; payload: { jobId: string; status: string; activeRunId?: string } }
  | { type: 'DAEMON_NOTIFICATION'; payload: { level: 'info' | 'warning' | 'error'; title: string; message: string; timestamp: number } }
  | { type: 'QUERY_RESULTS_RESPONSE'; payload: { query: string; answer: string; timestamp: string; model: string } }
  | { type: 'STEER_TASK_RESPONSE'; payload: { instruction: string; explanation: string; applied: boolean; timestamp: string } }
  | { type: 'RESULTS_UPDATE'; payload: { markdown: string; summary: string; stats: ResultStats; items: ScrapedItem[]; timestamp: string } }
  | { type: 'MODEL_STATS'; payload: ModelStats };
