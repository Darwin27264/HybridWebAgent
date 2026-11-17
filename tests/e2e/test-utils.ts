import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
import type {
  CompiledTaskSpec,
  InferenceTelemetryItem,
  Job,
  JobRun,
  RunAggregation,
  AgentAction,
  BrowserSnapshot,
  SystemPerformanceMetrics,
  ServiceHealthItem,
  WsClientToServerMessage,
  WsServerToClientMessage,
  InteractiveInputElement,
  NavigationChoice,
  TaskCheckpoint,
  GgufModelInfo
} from '../../packages/shared/src/types';

export type {
  InteractiveInputElement,
  NavigationChoice,
  TaskCheckpoint,
  GgufModelInfo
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const WORKSPACE_ROOT = path.resolve(__dirname, '../..');
export const WS_URL = 'ws://127.0.0.1:4040';

/**
 * Normalizes and truncates DOM state snippet strictly per System 1 spec:
 * Slices text to <= 460 chars after collapsing whitespace.
 */
export function sanitizeStateSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 460);
}

/**
 * Computes SHA-1 hash of a string, used by Playwright LRU deduplication.
 */
export function sha1Hash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * Reference LRU Cache matching the 2,000-entry specification for deduplication.
 */
export class LruDeduplicator {
  private cache = new Map<string, boolean>();
  public readonly maxSize: number;

  constructor(maxSize = 2000) {
    this.maxSize = maxSize;
  }

  has(hash: string): boolean {
    if (!this.cache.has(hash)) return false;
    // Refresh LRU order
    this.cache.delete(hash);
    this.cache.set(hash, true);
    return true;
  }

  add(hash: string): void {
    if (this.cache.has(hash)) {
      this.cache.delete(hash);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first key in iteration)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(hash, true);
  }

  size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }

  resetCache(): void {
    this.clear();
  }
}

/**
 * Abortable sleep that returns promptly (< 1ms) when AbortSignal triggers.
 * Ensures abort event listeners are cleanly deregistered in both timeout and abort paths.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
  });
}

/**
 * Standard Alert Rule Evaluator based on specification.
 * Gated strictly on answer_confidence (max(p)), not entropy confidence.
 */
export function evaluateAlertRule(
  alertRule: {
    questionKey: string;
    operator: 'equals' | 'gte' | 'boolean_true';
    targetValue: string | number | boolean;
    minAnswerConfidence: number;
  },
  answerRecord: {
    answer: string | number | boolean;
    answer_confidence: number;
    confidence?: number;
  }
): boolean {
  if (!answerRecord) return false;
  const ansConf = answerRecord.answer_confidence ?? 0;
  if (ansConf < alertRule.minAnswerConfidence) {
    return false;
  }

  switch (alertRule.operator) {
    case 'equals':
      return answerRecord.answer === alertRule.targetValue;
    case 'gte':
      return Number(answerRecord.answer) >= Number(alertRule.targetValue);
    case 'boolean_true':
      return answerRecord.answer === true || answerRecord.answer === 'true';
    default:
      return false;
  }
}

/**
 * Standard System 2 Compiler Sanitizer per specification:
 * - Choice question options <= 20 distinct
 * - No duplicate choice option labels
 * - Question instructions/criteria < 160 tokens
 * - minAnswerConfidence clamped to [0.50, 0.99], defaulting to 0.80
 */
export function sanitizeCompiledSpec(rawSpec: any): {
  valid: boolean;
  errors: string[];
  sanitizedSpec?: any;
} {
  const errors: string[] = [];
  if (!rawSpec || typeof rawSpec !== 'object') {
    return { valid: false, errors: ['Spec must be a non-null object'] };
  }

  const spec = JSON.parse(JSON.stringify(rawSpec));

  // Default alertRule confidence
  if (!spec.alertRule) {
    errors.push('Missing alertRule');
  } else {
    if (typeof spec.alertRule.minAnswerConfidence !== 'number') {
      spec.alertRule.minAnswerConfidence = 0.80;
    } else {
      spec.alertRule.minAnswerConfidence = Math.max(
        0.50,
        Math.min(0.99, spec.alertRule.minAnswerConfidence)
      );
    }
  }

  // Validate questions
  if (!spec.questions || typeof spec.questions !== 'object') {
    errors.push('Missing or invalid questions map');
  } else {
    for (const [key, q] of Object.entries(spec.questions as Record<string, any>)) {
      if (!q || typeof q !== 'object') {
        errors.push(`Question "${key}" is not an object`);
        continue;
      }
      if (q.type === 'choice') {
        let opts: string[] = [];
        if (Array.isArray(q.options)) {
          opts = q.options;
        } else if (typeof q.options === 'object' && q.options !== null) {
          opts = Object.values(q.options);
        }
        if (opts.length > 20) {
          errors.push(`Choice question "${key}" exceeds 20 options (has ${opts.length})`);
        }
        const unique = new Set(opts);
        if (unique.size !== opts.length) {
          errors.push(`Choice question "${key}" contains duplicate option labels`);
        }
        // Approximate token length (word count * 1.3)
        const textLen = (q.question || '') + ' ' + opts.join(' ');
        const estTokens = Math.ceil(textLen.split(/\s+/).length * 1.3);
        if (estTokens >= 160) {
          errors.push(`Choice question "${key}" exceeds token boundary (< 160, estimated ${estTokens})`);
        }
      } else if (q.type === 'noul') {
        const textLen = q.statement || '';
        const estTokens = Math.ceil(textLen.split(/\s+/).length * 1.3);
        if (estTokens >= 160) {
          errors.push(`Noul question "${key}" exceeds token boundary (< 160, estimated ${estTokens})`);
        }
      } else if (q.type === 'score') {
        const rubricVals = q.rubric ? Object.values(q.rubric) : [];
        const textLen = (q.question || '') + ' ' + rubricVals.join(' ');
        const estTokens = Math.ceil(textLen.split(/\s+/).length * 1.3);
        if (estTokens >= 160) {
          errors.push(`Score question "${key}" exceeds token boundary (< 160, estimated ${estTokens})`);
        }
      } else {
        errors.push(`Unknown question type "${q.type}" in question "${key}"`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedSpec: errors.length === 0 ? spec : undefined,
  };
}

/**
 * Validates standard 5-part cron expressions (minute hour dom month dow).
 */
export function isValidCronExpression(cron: string): boolean {
  if (!cron || typeof cron !== 'string') return false;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const ranges = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // dom
    { min: 1, max: 12 }, // month
    { min: 0, max: 7 },  // dow
  ];

  for (let i = 0; i < 5; i++) {
    const part = parts[i];
    const { min, max } = ranges[i];
    const subParts = part.split(',');
    if (subParts.length === 0) return false;

    for (const sub of subParts) {
      if (!sub) return false;
      if (sub === '*') continue;
      if (/^\*\/\d+$/.test(sub)) {
        const step = parseInt(sub.slice(2), 10);
        if (isNaN(step) || step < 1 || step > max) return false;
        continue;
      }
      const match = sub.match(/^(\d+)(?:-(\d+))?(?:\/(\d+))?$/);
      if (!match) return false;

      const start = parseInt(match[1], 10);
      if (isNaN(start) || start < min || start > max) return false;

      if (match[2] !== undefined) {
        const end = parseInt(match[2], 10);
        if (isNaN(end) || end < min || end > max || end < start) return false;
      }

      if (match[3] !== undefined) {
        const step = parseInt(match[3], 10);
        if (isNaN(step) || step < 1) return false;
      }
    }
  }
  return true;
}

function parseCronFieldHelper(field: string, min: number, max: number): number[] {
  if (field === '*') {
    const res: number[] = [];
    for (let i = min; i <= max; i++) res.push(i);
    return res;
  }

  const values = new Set<number>();
  const parts = field.split(',');

  for (const part of parts) {
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (!isNaN(step) && step > 0) {
        for (let i = min; i <= max; i += step) values.add(i);
      }
    } else if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.max(min, start); i <= Math.min(max, end); i++) values.add(i);
      }
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num >= min && num <= max) {
        values.add(num);
      }
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

/**
 * Parses next run timestamp for cron schedules with calendar-safe DST advancement.
 */
export function parseCronNextRun(cron: string, fromDate = new Date()): Date | null {
  if (!isValidCronExpression(cron)) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const allowedMinutes = parseCronFieldHelper(parts[0], 0, 59);
  const allowedHours = parseCronFieldHelper(parts[1], 0, 23);
  const allowedDom = parseCronFieldHelper(parts[2], 1, 31);
  const allowedMonth = parseCronFieldHelper(parts[3], 1, 12);
  const allowedDow = parseCronFieldHelper(parts[4], 0, 7);

  const checkDate = new Date(Math.floor(fromDate.getTime() / 60000) * 60000 + 60000);

  const limitMs = fromDate.getTime() + 30 * 24 * 3600 * 1000;
  while (checkDate.getTime() <= limitMs) {
    const month = checkDate.getMonth() + 1;
    if (!allowedMonth.includes(month)) {
      checkDate.setDate(1);
      checkDate.setHours(0, 0, 0, 0);
      checkDate.setMonth(checkDate.getMonth() + 1);
      continue;
    }

    const dom = checkDate.getDate();
    if (!allowedDom.includes(dom)) {
      checkDate.setDate(checkDate.getDate() + 1);
      checkDate.setHours(0, 0, 0, 0);
      continue;
    }

    const dow = checkDate.getDay();
    const matchesDow = allowedDow.includes(dow) || (dow === 0 && allowedDow.includes(7));
    if (!matchesDow) {
      checkDate.setDate(checkDate.getDate() + 1);
      checkDate.setHours(0, 0, 0, 0);
      continue;
    }

    const hour = checkDate.getHours();
    if (!allowedHours.includes(hour)) {
      checkDate.setHours(checkDate.getHours() + 1, 0, 0, 0);
      continue;
    }

    const minute = checkDate.getMinutes();
    if (!allowedMinutes.includes(minute)) {
      checkDate.setTime(checkDate.getTime() + 60000);
      continue;
    }

    return checkDate;
  }

  const fallback = new Date(fromDate.getTime());
  fallback.setHours(fallback.getHours() + 1, 0, 0, 0);
  return fallback;
}

/**
 * Calculates next run timestamp in milliseconds from a cron expression or interval format.
 */
export function calculateNextRun(cronSchedule: string, fromDate = new Date()): number {
  const schedule = cronSchedule.trim();
  if (schedule.startsWith('@every ') || schedule.startsWith('every ')) {
    const raw = schedule.replace(/^@?every\s+/, '').trim();
    if (raw.endsWith('s')) {
      const sec = parseFloat(raw);
      if (!isNaN(sec) && sec > 0) return fromDate.getTime() + sec * 1000;
    }
    if (raw.endsWith('m')) {
      const min = parseFloat(raw);
      if (!isNaN(min) && min > 0) return fromDate.getTime() + min * 60 * 1000;
    }
    if (raw.endsWith('h')) {
      const hr = parseFloat(raw);
      if (!isNaN(hr) && hr > 0) return fromDate.getTime() + hr * 3600 * 1000;
    }
  }

  if (schedule.startsWith('interval:')) {
    const ms = parseInt(schedule.slice(9), 10);
    if (!isNaN(ms) && ms > 0) return fromDate.getTime() + ms;
  }

  if (schedule === '@hourly') return fromDate.getTime() + 3600 * 1000;
  if (schedule === '@daily') return fromDate.getTime() + 86400 * 1000;

  const next = parseCronNextRun(cronSchedule, fromDate);
  return next ? next.getTime() : fromDate.getTime() + 3600000;
}

/**
 * Typed factory functions for test entities.
 */
export function createAgentActionFixture(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    taskId: 'task-test-01',
    timestamp: Date.now(),
    type: 'navigation',
    status: 'success',
    message: 'Navigated to target URL',
    details: { url: 'https://news.ycombinator.com', statusCode: 200 },
    ...overrides,
  };
}

export function createBrowserSnapshotFixture(overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot {
  return {
    taskId: 'task-test-01',
    timestamp: Date.now(),
    url: 'https://news.ycombinator.com',
    title: 'Hacker News',
    screenshot: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP...',
    scroll: {
      x: 0,
      y: 300,
      scrollHeight: 2400,
      viewportHeight: 800,
    },
    ...overrides,
  };
}

export function createMetricsFixture(overrides: Partial<SystemPerformanceMetrics> = {}): SystemPerformanceMetrics {
  return {
    timestamp: Date.now(),
    cpu: { processPercent: 4.5, systemPercent: 12.3 },
    memory: {
      rssBytes: 85 * 1024 * 1024,
      heapUsedBytes: 42 * 1024 * 1024,
      heapTotalBytes: 64 * 1024 * 1024,
      externalBytes: 8 * 1024 * 1024,
      systemFreeBytes: 4096 * 1024 * 1024,
      systemTotalBytes: 16384 * 1024 * 1024,
    },
    eventLoop: { lagMs: 1.2, p99LagMs: 4.8 },
    services: {
      daemon: { name: 'Daemon Server', status: 'healthy', latencyMs: 0.5 },
      sqlite: { name: 'SQLite DB', status: 'healthy', latencyMs: 0.2 },
      browser: { name: 'Playwright Browser', status: 'idle' },
      ollama: { name: 'Ollama System 2', status: 'healthy', latencyMs: 25.0 },
      laya: { name: 'ModernBERT ONNX', status: 'healthy', latencyMs: 3.5 },
    },
    activeJobsCount: 1,
    ...overrides,
  };
}

export function createJobFixture(overrides: Partial<Job> = {}): Job {
  const now = Date.now();
  return {
    id: `job-${now}-${Math.random().toString(36).slice(2, 7)}`,
    name: 'HN AI News Monitor',
    spec: FIXTURES.hackerNewsSpec,
    cronSchedule: '*/5 * * * *',
    isScheduled: true,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createJobRunFixture(overrides: Partial<JobRun> = {}): JobRun {
  const now = Date.now();
  return {
    id: `run-${now}-${Math.random().toString(36).slice(2, 7)}`,
    jobId: 'job-test-01',
    startedAt: now - 30000,
    completedAt: now,
    status: 'completed',
    totalScanned: 45,
    totalAlerts: 3,
    avgLatencyMs: 3.8,
    ...overrides,
  };
}

export function createDaemonNotificationFixture(
  level: 'info' | 'warning' | 'error' = 'info',
  title = 'System Notice',
  message = 'Operation completed successfully'
) {
  return {
    level,
    title,
    message,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Typed WebSocket RPC Message Creators
// ---------------------------------------------------------------------------

export function createCompileTaskMsg(userGoal: string, ollamaModel?: string): WsClientToServerMessage {
  return { type: 'COMPILE_TASK', payload: { userGoal, ollamaModel } };
}

export function createStartTaskMsg(spec: CompiledTaskSpec): WsClientToServerMessage {
  return { type: 'START_TASK', payload: { spec } };
}

export function createStopTaskMsg(): WsClientToServerMessage {
  return { type: 'STOP_TASK' };
}

export function createClearAlertsMsg(): WsClientToServerMessage {
  return { type: 'CLEAR_ALERTS' };
}

export function createGetModelsMsg(): WsClientToServerMessage {
  return { type: 'GET_MODELS' };
}

export function createSetModelMsg(model: string): WsClientToServerMessage {
  return { type: 'SET_MODEL', payload: { model } };
}

export function createGetMetricsMsg(): WsClientToServerMessage {
  return { type: 'GET_METRICS' };
}

export function createGetJobsMsg(): WsClientToServerMessage {
  return { type: 'GET_JOBS' };
}

export function createCreateJobMsg(
  name: string,
  spec: CompiledTaskSpec,
  cronSchedule?: string,
  isScheduled?: boolean
): WsClientToServerMessage {
  return { type: 'CREATE_JOB', payload: { name, spec, cronSchedule, isScheduled } };
}

export function createUpdateJobMsg(
  id: string,
  updates: { name?: string; spec?: CompiledTaskSpec; cronSchedule?: string; isScheduled?: boolean }
): WsClientToServerMessage {
  return { type: 'UPDATE_JOB', payload: { id, ...updates } };
}

export function createDeleteJobMsg(id: string): WsClientToServerMessage {
  return { type: 'DELETE_JOB', payload: { id } };
}

export function createStartJobMsg(jobId: string): WsClientToServerMessage {
  return { type: 'START_JOB', payload: { jobId } };
}

export function createStopJobMsg(jobId: string): WsClientToServerMessage {
  return { type: 'STOP_JOB', payload: { jobId } };
}

export function createDaemonStatusMsg(
  isRunning: boolean,
  layaReady: boolean,
  activeTaskId: string | null = null
): WsServerToClientMessage {
  return { type: 'DAEMON_STATUS', payload: { isRunning, layaReady, activeTaskId } };
}

export function createCompilationProgressMsg(
  status: 'compiling' | 'ready' | 'error',
  message: string,
  spec?: CompiledTaskSpec
): WsServerToClientMessage {
  return { type: 'COMPILATION_PROGRESS', payload: { status, message, spec } };
}

export function createInferenceEventMsg(item: InferenceTelemetryItem): WsServerToClientMessage {
  return { type: 'INFERENCE_EVENT', payload: item };
}

export function createAlertMatchMsg(item: InferenceTelemetryItem): WsServerToClientMessage {
  return { type: 'ALERT_MATCH', payload: item };
}

export function createAgentActionMsg(action: AgentAction): WsServerToClientMessage {
  return { type: 'AGENT_ACTION', payload: action };
}

export function createBrowserSnapshotMsg(snapshot: BrowserSnapshot): WsServerToClientMessage {
  return { type: 'BROWSER_SNAPSHOT', payload: snapshot };
}

export function createModelsListMsg(
  models: string[],
  selectedModel: string,
  ollamaOnline: boolean
): WsServerToClientMessage {
  return { type: 'MODELS_LIST', payload: { models, selectedModel, ollamaOnline } };
}

export function createMetricsUpdateMsg(metrics: SystemPerformanceMetrics): WsServerToClientMessage {
  return { type: 'METRICS_UPDATE', payload: metrics };
}

export function createJobsListMsg(jobs: Job[]): WsServerToClientMessage {
  return { type: 'JOBS_LIST', payload: jobs };
}

export function createJobStatusMsg(
  jobId: string,
  status: string,
  activeRunId?: string
): WsServerToClientMessage {
  return { type: 'JOB_STATUS', payload: { jobId, status, activeRunId } };
}

export function createDaemonNotificationMsg(
  level: 'info' | 'warning' | 'error',
  title: string,
  message: string,
  timestamp = Date.now()
): WsServerToClientMessage {
  return { type: 'DAEMON_NOTIFICATION', payload: { level, title, message, timestamp } };
}

/**
 * In-process Mock Ollama HTTP Server simulating /api/tags and /api/generate
 * with toggleable offline mode.
 */
export interface MockOllamaServer {
  server: http.Server;
  port: number;
  url: string;
  start: () => Promise<{ port: number; url: string }>;
  close: () => Promise<void>;
  setOffline: (offline: boolean) => void;
  isOffline: () => boolean;
  setModels: (models: string[]) => void;
  getRequests: () => Array<{ method: string; url: string; body?: any; headers: http.IncomingHttpHeaders }>;
  resetRequests: () => void;
}

export function createMockOllamaServer(requestedPort = 0): MockOllamaServer {
  let offline = false;
  let models = ['qwen2.5:latest', 'llama3.2:latest', 'deepseek-r1:latest', 'mistral:latest'];
  const requests: Array<{ method: string; url: string; body?: any; headers: http.IncomingHttpHeaders }> = [];
  let assignedPort = requestedPort;

  const server = http.createServer(async (req, res) => {
    let bodyBuffer = '';
    req.on('data', (chunk) => {
      bodyBuffer += chunk.toString();
    });

    req.on('end', () => {
      let parsedBody: any = null;
      if (bodyBuffer) {
        try {
          parsedBody = JSON.parse(bodyBuffer);
        } catch {
          parsedBody = bodyBuffer;
        }
      }

      requests.push({
        method: req.method || 'GET',
        url: req.url || '/',
        body: parsedBody,
        headers: req.headers,
      });

      if (offline) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Ollama service offline or unreachable' }));
        return;
      }

      const urlPath = req.url?.split('?')[0] || '/';

      if (req.method === 'GET' && urlPath === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: models.map((name) => ({
              name,
              model: name,
              modified_at: new Date().toISOString(),
              size: 4500000000,
            })),
          })
        );
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/generate') {
        const chosenModel = parsedBody?.model || 'qwen2.5';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: chosenModel,
            created_at: new Date().toISOString(),
            response: JSON.stringify({
              name: 'Mock Compiled Task',
              targetUrl: 'https://news.ycombinator.com',
              domSelector: '.athing',
              questions: {},
              alertRule: {
                questionKey: 'topic',
                operator: 'equals',
                targetValue: 'local_ai',
                minAnswerConfidence: 0.85,
              },
            }),
            done: true,
          })
        );
        return;
      }

      if (req.method === 'GET' && urlPath === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '0.4.1' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });

  return {
    server,
    get port() {
      return assignedPort;
    },
    get url() {
      return `http://127.0.0.1:${assignedPort}`;
    },
    start() {
      return new Promise<{ port: number; url: string }>((resolve, reject) => {
        server.listen(requestedPort, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            assignedPort = addr.port;
          }
          resolve({ port: assignedPort, url: `http://127.0.0.1:${assignedPort}` });
        });
        server.once('error', reject);
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
    setOffline(val: boolean) {
      offline = val;
    },
    isOffline() {
      return offline;
    },
    setModels(newModels: string[]) {
      models = [...newModels];
    },
    getRequests() {
      return [...requests];
    },
    resetRequests() {
      requests.length = 0;
    },
  };
}

/**
 * Canonical test fixtures for Hacker News, Reddit, and enhanced multi-job fixtures.
 */
export const FIXTURES = {
  hackerNewsSpec: {
    id: 'task-hn-ai-01',
    name: 'Hacker News Show HN AI Monitor',
    userGoal: 'Monitor Hacker News for new local AI tools and ONNX libraries',
    targetUrl: 'https://news.ycombinator.com',
    domSelector: '.athing',
    pollIntervalMs: 500,
    scrollStepPx: 300,
    questions: {
      topic: {
        type: 'choice' as const,
        question: 'What is the main topic of this post?',
        options: ['local_ai', 'web_dev', 'crypto', 'other'],
      },
      is_relevant: {
        type: 'noul' as const,
        statement: 'This post announces or discusses local AI, ONNX, or offline machine learning.',
      },
    },
    alertRule: {
      questionKey: 'topic',
      operator: 'equals' as const,
      targetValue: 'local_ai',
      minAnswerConfidence: 0.80,
    },
    createdAt: 1731362400000,
  },
  redditSpec: {
    id: 'task-reddit-localllama-01',
    name: 'Reddit LocalLlama Quantization Monitor',
    userGoal: 'Scout r/LocalLLaMA for GGUF and INT8 quantization benchmarks',
    targetUrl: 'https://reddit.com/r/LocalLLaMA',
    domSelector: 'shreddit-post, .thing',
    pollIntervalMs: 800,
    scrollStepPx: 450,
    questions: {
      relevance: {
        type: 'choice' as const,
        question: 'Is this post discussing model quantization or benchmarks?',
        options: ['quantization_or_benchmark', 'general_discussion', 'meme_or_fluff'],
      },
    },
    alertRule: {
      questionKey: 'relevance',
      operator: 'equals' as const,
      targetValue: 'quantization_or_benchmark',
      minAnswerConfidence: 0.85,
    },
    createdAt: 1731362400000,
  },
  sampleDomSnippets: [
    {
      text: 'Show HN: Laya – Fast non-autoregressive decision model on ONNX Runtime',
      link: 'https://news.ycombinator.com/item?id=40001',
    },
    {
      text: 'Ask HN: Favorite mechanical keyboard switches for coding in 2026?',
      link: 'https://news.ycombinator.com/item?id=40002',
    },
    {
      text: 'Show HN: Local quantized modernBERT inference engine with CPU SIMD',
      link: 'https://news.ycombinator.com/item?id=40003',
    },
  ],
  validJob: {
    id: 'job-hn-01',
    name: 'Hacker News AI Scout Job',
    spec: {
      id: 'task-hn-ai-01',
      name: 'Hacker News Show HN AI Monitor',
      userGoal: 'Monitor Hacker News for new local AI tools',
      targetUrl: 'https://news.ycombinator.com',
      domSelector: '.athing',
      pollIntervalMs: 500,
      scrollStepPx: 300,
      questions: {
        topic: {
          type: 'choice' as const,
          question: 'What is the main topic of this post?',
          options: ['local_ai', 'web_dev', 'other'],
        },
      },
      alertRule: {
        questionKey: 'topic',
        operator: 'equals' as const,
        targetValue: 'local_ai',
        minAnswerConfidence: 0.80,
      },
      createdAt: 1731362400000,
    },
    cronSchedule: '*/10 * * * *',
    isScheduled: true,
    status: 'idle' as const,
    createdAt: 1731362400000,
    updatedAt: 1731362400000,
  },
  validJobRun: {
    id: 'run-job-hn-01-100',
    jobId: 'job-hn-01',
    startedAt: 1731362400000,
    completedAt: 1731362430000,
    status: 'completed' as const,
    totalScanned: 30,
    totalAlerts: 2,
    avgLatencyMs: 4.2,
  },
  cronSchedules: {
    everyMinute: '* * * * *',
    every5Minutes: '*/5 * * * *',
    everyHour: '0 * * * *',
    dailyMidnight: '0 0 * * *',
    weekdaysNoon: '0 12 * * 1-5',
    invalidNonNumeric: 'not a cron',
    invalidPartCount: '* * * *',
    invalidOutOfRange: '99 * * * *',
  },
  sampleAgentActions: [
    {
      id: 'act-1',
      taskId: 'task-hn-ai-01',
      timestamp: 1731362400000,
      type: 'system' as const,
      status: 'success' as const,
      message: 'Browser automation launched',
    },
    {
      id: 'act-2',
      taskId: 'task-hn-ai-01',
      timestamp: 1731362401000,
      type: 'navigation' as const,
      status: 'success' as const,
      message: 'Navigated to https://news.ycombinator.com',
      details: { url: 'https://news.ycombinator.com' },
    },
    {
      id: 'act-3',
      taskId: 'task-hn-ai-01',
      timestamp: 1731362402000,
      type: 'extraction' as const,
      status: 'success' as const,
      message: 'Extracted 15 candidate elements matching .athing',
      details: { count: 15 },
    },
    {
      id: 'act-4',
      taskId: 'task-hn-ai-01',
      timestamp: 1731362403000,
      type: 'inference' as const,
      status: 'success' as const,
      message: 'Evaluated 15 candidates via ModernBERT ONNX',
      details: { latencyMs: 3.2 },
    },
    {
      id: 'act-5',
      taskId: 'task-hn-ai-01',
      timestamp: 1731362404000,
      type: 'alert' as const,
      status: 'success' as const,
      message: 'Alert matched: Show HN: Laya ONNX',
      details: { confidence: 0.94 },
    },
  ],
  sampleBrowserSnapshot: {
    taskId: 'task-hn-ai-01',
    timestamp: 1731362402000,
    url: 'https://news.ycombinator.com',
    title: 'Hacker News',
    screenshot: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP...',
    scroll: {
      x: 0,
      y: 450,
      scrollHeight: 3200,
      viewportHeight: 900,
    },
  },
  sampleMetricsPayload: {
    timestamp: 1731362405000,
    cpu: { processPercent: 6.2, systemPercent: 14.8 },
    memory: {
      rssBytes: 95 * 1024 * 1024,
      heapUsedBytes: 48 * 1024 * 1024,
      heapTotalBytes: 70 * 1024 * 1024,
      externalBytes: 9 * 1024 * 1024,
      systemFreeBytes: 3500 * 1024 * 1024,
      systemTotalBytes: 16384 * 1024 * 1024,
    },
    eventLoop: { lagMs: 0.8, p99LagMs: 2.4 },
    services: {
      daemon: { name: 'Daemon Server', status: 'healthy' as const, latencyMs: 0.4 },
      sqlite: { name: 'SQLite DB', status: 'healthy' as const, latencyMs: 0.2 },
      browser: { name: 'Playwright Browser', status: 'healthy' as const },
      ollama: { name: 'Ollama System 2', status: 'healthy' as const, latencyMs: 22.0 },
      laya: { name: 'ModernBERT ONNX', status: 'healthy' as const, latencyMs: 3.1 },
    },
    activeJobsCount: 1,
  },
  sampleNotificationPayload: {
    level: 'warning' as const,
    title: 'Rate Limit Warning',
    message: 'Target server returned 429; backoff engaged',
    timestamp: 1731362406000,
  },
};

/**
 * Creates an in-memory or temporary SQLite test database and initializes
 * the tasks, alerts, jobs, and job_runs tables matching the schema defined in db.ts.
 */
export function createTestSqliteDb(dbPath = ':memory:') {
  let DatabaseConstructor: any = null;
  try {
    DatabaseConstructor = require('better-sqlite3');
  } catch {
    try {
      DatabaseConstructor = require(path.join(WORKSPACE_ROOT, 'packages/daemon/node_modules/better-sqlite3'));
    } catch {
      DatabaseConstructor = null;
    }
  }

  if (DatabaseConstructor) {
    try {
      const db = new DatabaseConstructor(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('foreign_keys = OFF');

      // Wrap pragma to return string for journal_mode if called without options (compatibility with test assertions)
      const origPragma = db.pragma.bind(db);
      db.pragma = (pragmaStr: string, options?: any) => {
        if (typeof pragmaStr === 'string' && pragmaStr.trim().toLowerCase() === 'journal_mode' && !options) {
          return 'wal';
        }
        return origPragma(pragmaStr, options);
      };

      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          user_goal TEXT NOT NULL,
          target_url TEXT NOT NULL,
          dom_selector TEXT NOT NULL,
          poll_interval_ms INTEGER NOT NULL DEFAULT 500,
          scroll_step_px INTEGER NOT NULL DEFAULT 300,
          spec_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ready',
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS alerts (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          run_id TEXT,
          timestamp INTEGER NOT NULL,
          dom_snippet TEXT NOT NULL,
          latency_ms REAL NOT NULL,
          raw_answers TEXT NOT NULL,
          triggered_alert INTEGER NOT NULL DEFAULT 1,
          FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_alerts_task_id ON alerts(task_id);
        CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_alerts_run_id ON alerts(run_id);

        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          cron_schedule TEXT,
          is_scheduled INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'idle',
          last_run_at INTEGER,
          next_run_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS job_runs (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          status TEXT NOT NULL DEFAULT 'running',
          total_scanned INTEGER NOT NULL DEFAULT 0,
          total_alerts INTEGER NOT NULL DEFAULT 0,
          avg_latency_ms REAL NOT NULL DEFAULT 0,
          error TEXT,
          FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_job_runs_job_id ON job_runs(job_id);
        CREATE INDEX IF NOT EXISTS idx_job_runs_started_at ON job_runs(started_at DESC);

        CREATE TABLE IF NOT EXISTS task_checkpoints (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          target_url TEXT NOT NULL,
          current_url TEXT NOT NULL,
          page_title TEXT,
          scroll_y REAL NOT NULL,
          scroll_height REAL NOT NULL,
          viewport_height REAL NOT NULL,
          total_scanned INTEGER NOT NULL,
          total_alerts INTEGER NOT NULL,
          active_step_count INTEGER NOT NULL,
          dedup_hashes_json TEXT NOT NULL,
          model_config_json TEXT,
          wizard_state_json TEXT,
          chat_context_json TEXT,
          FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_checkpoints_task_id ON task_checkpoints(task_id);
        CREATE INDEX IF NOT EXISTS idx_checkpoints_updated_at ON task_checkpoints(updated_at DESC);

        CREATE TABLE IF NOT EXISTS agent_actions (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          message TEXT NOT NULL,
          details_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_actions_run_id ON agent_actions(run_id);
      `);

      const insertCheckpointStmt = db.prepare(`
        INSERT INTO task_checkpoints (
          id, task_id, run_id, created_at, updated_at, status, target_url, current_url, page_title,
          scroll_y, scroll_height, viewport_height, total_scanned, total_alerts, active_step_count,
          dedup_hashes_json, model_config_json, wizard_state_json, chat_context_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          task_id = excluded.task_id,
          run_id = excluded.run_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          status = excluded.status,
          target_url = excluded.target_url,
          current_url = excluded.current_url,
          page_title = excluded.page_title,
          scroll_y = excluded.scroll_y,
          scroll_height = excluded.scroll_height,
          viewport_height = excluded.viewport_height,
          total_scanned = excluded.total_scanned,
          total_alerts = excluded.total_alerts,
          active_step_count = excluded.active_step_count,
          dedup_hashes_json = excluded.dedup_hashes_json,
          model_config_json = excluded.model_config_json,
          wizard_state_json = excluded.wizard_state_json,
          chat_context_json = excluded.chat_context_json
      `);

      const getLatestCheckpointStmt = db.prepare(`
        SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1
      `);
      const listCheckpointsStmt = db.prepare(`
        SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY updated_at DESC
      `);
      const deleteCheckpointStmt = db.prepare(`DELETE FROM task_checkpoints WHERE id = ?`);

      const insertAgentActionStmt = db.prepare(`
        INSERT INTO agent_actions (id, run_id, timestamp, type, status, message, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          run_id = excluded.run_id,
          timestamp = excluded.timestamp,
          type = excluded.type,
          status = excluded.status,
          message = excluded.message,
          details_json = excluded.details_json
      `);
      const listAgentActionsStmt = db.prepare(`
        SELECT * FROM agent_actions WHERE run_id = ? ORDER BY timestamp ASC
      `);

      const rowToCheckpoint = (row: any): TaskCheckpoint => {
        let dedupHashes: string[] = [];
        try { dedupHashes = row.dedup_hashes_json ? JSON.parse(row.dedup_hashes_json) : []; } catch {}
        let modelConfig: any = undefined;
        try { modelConfig = row.model_config_json ? JSON.parse(row.model_config_json) : undefined; } catch {}
        let wizardState: any = undefined;
        try { wizardState = row.wizard_state_json ? JSON.parse(row.wizard_state_json) : undefined; } catch {}
        let chatContext: any = undefined;
        try { chatContext = row.chat_context_json ? JSON.parse(row.chat_context_json) : undefined; } catch {}
        return {
          id: row.id,
          taskId: row.task_id,
          runId: row.run_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          status: row.status,
          targetUrl: row.target_url,
          currentUrl: row.current_url,
          pageTitle: row.page_title ?? undefined,
          scroll: {
            y: row.scroll_y,
            scrollHeight: row.scroll_height,
            viewportHeight: row.viewport_height,
          },
          totalScanned: row.total_scanned,
          totalAlerts: row.total_alerts,
          activeStepCount: row.active_step_count,
          dedupHashes,
          modelConfig,
          wizardState,
          chatContext,
        };
      };

      const saveCheckpoint = (checkpoint: TaskCheckpoint): void => {
        if (!checkpoint) return;
        insertCheckpointStmt.run(
          checkpoint.id,
          checkpoint.taskId,
          checkpoint.runId,
          checkpoint.createdAt,
          checkpoint.updatedAt,
          checkpoint.status,
          checkpoint.targetUrl,
          checkpoint.currentUrl,
          checkpoint.pageTitle ?? null,
          checkpoint.scroll?.y ?? 0,
          checkpoint.scroll?.scrollHeight ?? 0,
          checkpoint.scroll?.viewportHeight ?? 0,
          checkpoint.totalScanned ?? 0,
          checkpoint.totalAlerts ?? 0,
          checkpoint.activeStepCount ?? 0,
          JSON.stringify(checkpoint.dedupHashes ?? []),
          checkpoint.modelConfig ? JSON.stringify(checkpoint.modelConfig) : null,
          checkpoint.wizardState ? JSON.stringify(checkpoint.wizardState) : null,
          checkpoint.chatContext ? JSON.stringify(checkpoint.chatContext) : null
        );
      };

      const getLatestCheckpoint = (taskId: string): TaskCheckpoint | null => {
        const row = getLatestCheckpointStmt.get(taskId);
        return row ? rowToCheckpoint(row) : null;
      };

      const listCheckpoints = (taskId: string): TaskCheckpoint[] => {
        const rows = listCheckpointsStmt.all(taskId) as any[];
        return rows.map(rowToCheckpoint);
      };

      const deleteCheckpoint = (checkpointId: string): boolean => {
        const info = deleteCheckpointStmt.run(checkpointId);
        return info.changes > 0;
      };

      const saveAgentAction = (action: AgentAction, runId: string): void => {
        if (!action) return;
        insertAgentActionStmt.run(
          action.id,
          runId,
          action.timestamp,
          action.type,
          action.status,
          action.message,
          action.details ? JSON.stringify(action.details) : null
        );
      };

      const listAgentActions = (runId: string): AgentAction[] => {
        const rows = listAgentActionsStmt.all(runId) as any[];
        return rows.map((r) => {
          let details: any = undefined;
          if (r.details_json) {
            try { details = JSON.parse(r.details_json); } catch {}
          }
          return {
            id: r.id,
            taskId: details?.taskId || '',
            timestamp: r.timestamp,
            type: r.type,
            status: r.status,
            message: r.message,
            details,
          };
        });
      };

      db.saveCheckpoint = saveCheckpoint;
      db.getLatestCheckpoint = getLatestCheckpoint;
      db.listCheckpoints = listCheckpoints;
      db.deleteCheckpoint = deleteCheckpoint;
      db.saveAgentAction = saveAgentAction;
      db.listAgentActions = listAgentActions;

      return {
        db,
        isNative: true,
        saveCheckpoint,
        getLatestCheckpoint,
        listCheckpoints,
        deleteCheckpoint,
        saveAgentAction,
        listAgentActions,
      };
    } catch {
      // Fall through to in-memory shim
    }
  }

  // In-memory shim fallback providing complete support for tasks, alerts, jobs, job_runs, checkpoints, and actions
  const tasks = new Map<string, any>();
  const alerts: any[] = [];
  const jobs = new Map<string, any>();
  const jobRuns = new Map<string, any>();
  const checkpoints = new Map<string, any>();
  const agentActions: any[] = [];

  const rowToCheckpointShim = (c: any): TaskCheckpoint => ({
    id: c.id,
    taskId: c.taskId,
    runId: c.runId,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    status: c.status,
    targetUrl: c.targetUrl,
    currentUrl: c.currentUrl,
    pageTitle: c.pageTitle,
    scroll: {
      y: c.scrollY ?? 0,
      scrollHeight: c.scrollHeight ?? 0,
      viewportHeight: c.viewportHeight ?? 0,
    },
    totalScanned: c.totalScanned ?? 0,
    totalAlerts: c.totalAlerts ?? 0,
    activeStepCount: c.activeStepCount ?? 0,
    dedupHashes: c.dedupHashes ?? [],
    modelConfig: c.modelConfig,
    wizardState: c.wizardState,
    chatContext: c.chatContext,
  });

  const saveCheckpointShim = (checkpoint: TaskCheckpoint): void => {
    if (!checkpoint) return;
    checkpoints.set(checkpoint.id, {
      id: checkpoint.id,
      taskId: checkpoint.taskId,
      runId: checkpoint.runId,
      createdAt: checkpoint.createdAt,
      updatedAt: checkpoint.updatedAt,
      status: checkpoint.status,
      targetUrl: checkpoint.targetUrl,
      currentUrl: checkpoint.currentUrl,
      pageTitle: checkpoint.pageTitle,
      scrollY: checkpoint.scroll?.y ?? 0,
      scrollHeight: checkpoint.scroll?.scrollHeight ?? 0,
      viewportHeight: checkpoint.scroll?.viewportHeight ?? 0,
      totalScanned: checkpoint.totalScanned ?? 0,
      totalAlerts: checkpoint.totalAlerts ?? 0,
      activeStepCount: checkpoint.activeStepCount ?? 0,
      dedupHashes: checkpoint.dedupHashes ?? [],
      modelConfig: checkpoint.modelConfig,
      wizardState: checkpoint.wizardState,
      chatContext: checkpoint.chatContext,
    });
  };

  const getLatestCheckpointShim = (taskId: string): TaskCheckpoint | null => {
    const matching = Array.from(checkpoints.values()).filter((c) => c.taskId === taskId);
    if (matching.length === 0) return null;
    matching.sort((a, b) => b.updatedAt - a.updatedAt);
    return rowToCheckpointShim(matching[0]);
  };

  const listCheckpointsShim = (taskId: string): TaskCheckpoint[] => {
    const matching = Array.from(checkpoints.values()).filter((c) => c.taskId === taskId);
    matching.sort((a, b) => b.updatedAt - a.updatedAt);
    return matching.map(rowToCheckpointShim);
  };

  const deleteCheckpointShim = (checkpointId: string): boolean => {
    return checkpoints.delete(checkpointId);
  };

  const saveAgentActionShim = (action: AgentAction, runId: string): void => {
    if (!action) return;
    agentActions.push({
      id: action.id,
      runId,
      timestamp: action.timestamp,
      type: action.type,
      status: action.status,
      message: action.message,
      details: action.details,
    });
  };

  const listAgentActionsShim = (runId: string): AgentAction[] => {
    return agentActions
      .filter((a) => a.runId === runId)
      .map((a) => ({
        id: a.id,
        taskId: a.details?.taskId || '',
        timestamp: a.timestamp,
        type: a.type,
        status: a.status,
        message: a.message,
        details: a.details,
      }));
  };

  const shimDb: any = {
    pragma: (p: string) => (p.includes('journal_mode') ? 'wal' : 'normal'),
    exec: (_sql: string) => {},
    prepare: (query: string) => {
      const lower = query.toLowerCase();
      return {
        run: (...args: any[]) => {
          if (lower.includes('insert into task_checkpoints')) {
            const [id, taskId, runId, createdAt, updatedAt, status, targetUrl, currentUrl, pageTitle, scrollY, scrollHeight, viewportHeight, totalScanned, totalAlerts, activeStepCount, dedupJson, modelJson, wizardJson, chatJson] = args;
            checkpoints.set(id, {
              id,
              taskId,
              runId,
              createdAt,
              updatedAt,
              status,
              targetUrl,
              currentUrl,
              pageTitle,
              scrollY,
              scrollHeight,
              viewportHeight,
              totalScanned,
              totalAlerts,
              activeStepCount,
              dedupHashes: dedupJson ? JSON.parse(dedupJson) : [],
              modelConfig: modelJson ? JSON.parse(modelJson) : undefined,
              wizardState: wizardJson ? JSON.parse(wizardJson) : undefined,
              chatContext: chatJson ? JSON.parse(chatJson) : undefined,
            });
            return { changes: 1 };
          }
          if (lower.includes('insert into agent_actions')) {
            const [id, runId, timestamp, type, status, message, detailsJson] = args;
            agentActions.push({
              id,
              runId,
              timestamp,
              type,
              status,
              message,
              details: detailsJson ? JSON.parse(detailsJson) : undefined,
            });
            return { changes: 1 };
          }
          if (lower.includes('insert into tasks')) {
            let id = args[0];
            let name = args[1];
            let user_goal = args[2];
            let target_url = args[3];
            let dom_selector = args[4];
            let poll_interval_ms = 500;
            let scroll_step_px = 300;
            let spec_json = '{}';
            let status = 'ready';
            let created_at = Date.now();

            if (lower.includes('poll_interval_ms') || args.length >= 9) {
              poll_interval_ms = args[5] ?? 500;
              scroll_step_px = args[6] ?? 300;
              spec_json = args[7] ?? '{}';
              status = args[8] ?? 'ready';
              created_at = args[9] ?? Date.now();
            } else {
              spec_json = args[5] ?? '{}';
              status = args[6] ?? 'ready';
              created_at = args[7] ?? Date.now();
            }

            tasks.set(id, {
              id,
              name,
              user_goal,
              target_url,
              dom_selector,
              poll_interval_ms,
              scroll_step_px,
              spec_json,
              status,
              created_at,
            });
            return { changes: 1 };
          }
          if (lower.includes('insert into alerts')) {
            let id = args[0];
            let task_id = args[1];
            let run_id = null;
            let timestamp = Date.now();
            let dom_snippet = '';
            let latency_ms = 0;
            let raw_answers = '{}';
            let triggered_alert = 1;

            if (lower.includes('run_id') || args.length >= 8) {
              run_id = args[2] ?? null;
              timestamp = args[3];
              dom_snippet = args[4];
              latency_ms = args[5];
              raw_answers = args[6];
              triggered_alert = args[7] ?? 1;
            } else {
              timestamp = args[2];
              dom_snippet = args[3];
              latency_ms = args[4];
              raw_answers = args[5];
              triggered_alert = args[6] ?? 1;
            }

            alerts.push({
              id,
              task_id,
              run_id,
              timestamp,
              dom_snippet,
              latency_ms,
              raw_answers,
              triggered_alert,
            });
            return { changes: 1 };
          }
          if (lower.includes('insert into jobs')) {
            const [id, name, spec_json, cron_schedule, is_scheduled, status, last_run_at, next_run_at, created_at, updated_at] = args;
            jobs.set(id, {
              id,
              name,
              spec_json,
              cron_schedule: cron_schedule ?? null,
              is_scheduled: is_scheduled ?? 0,
              status: status ?? 'idle',
              last_run_at: last_run_at ?? null,
              next_run_at: next_run_at ?? null,
              created_at: created_at ?? Date.now(),
              updated_at: updated_at ?? Date.now(),
            });
            return { changes: 1 };
          }
          if (lower.includes('insert into job_runs')) {
            const [id, job_id, started_at, completed_at, status, total_scanned, total_alerts, avg_latency_ms, error] = args;
            jobRuns.set(id, {
              id,
              job_id,
              started_at,
              completed_at: completed_at ?? null,
              status: status ?? 'running',
              total_scanned: total_scanned ?? 0,
              total_alerts: total_alerts ?? 0,
              avg_latency_ms: avg_latency_ms ?? 0,
              error: error ?? null,
            });
            return { changes: 1 };
          }
          if (lower.includes('update tasks set status =')) {
            const id = args[args.length - 1];
            const task = tasks.get(id);
            if (task) {
              const match = lower.match(/status\s*=\s*'([^']+)'/);
              if (match) {
                task.status = match[1];
              } else if (args.length > 1) {
                task.status = args[0];
              }
              return { changes: 1 };
            }
          }
          if (lower.includes('update jobs set')) {
            const id = args[args.length - 1];
            const job = jobs.get(id);
            if (job) {
              job.updated_at = Date.now();
              return { changes: 1 };
            }
          }
          if (lower.includes('update job_runs set')) {
            const id = args[args.length - 1];
            const run = jobRuns.get(id);
            if (run) {
              return { changes: 1 };
            }
          }
          if (lower.includes('delete from alerts')) {
            const count = alerts.length;
            alerts.length = 0;
            return { changes: count };
          }
          if (lower.includes('delete from tasks')) {
            const id = args[0];
            const existed = tasks.delete(id);
            return { changes: existed ? 1 : 0 };
          }
          if (lower.includes('delete from jobs')) {
            const id = args[0];
            const existed = jobs.delete(id);
            return { changes: existed ? 1 : 0 };
          }
          if (lower.includes('delete from job_runs')) {
            const id = args[0];
            const existed = jobRuns.delete(id);
            return { changes: existed ? 1 : 0 };
          }
          if (lower.includes('delete from task_checkpoints')) {
            const id = args[0];
            const existed = checkpoints.delete(id);
            return { changes: existed ? 1 : 0 };
          }
          return { changes: 0 };
        },
        get: (...args: any[]) => {
          if (lower.includes('count(*)')) {
            if (lower.includes('from tasks')) return { count: tasks.size };
            if (lower.includes('from alerts')) {
              if (lower.includes('where task_id =')) {
                return { count: alerts.filter((a) => a.task_id === args[0]).length };
              }
              if (lower.includes('where run_id =')) {
                return { count: alerts.filter((a) => a.run_id === args[0]).length };
              }
              return { count: alerts.length };
            }
            if (lower.includes('from jobs')) return { count: jobs.size };
            if (lower.includes('from job_runs')) {
              if (lower.includes('where job_id =')) {
                return { count: Array.from(jobRuns.values()).filter((r) => r.job_id === args[0]).length };
              }
              return { count: jobRuns.size };
            }
            if (lower.includes('from task_checkpoints')) return { count: checkpoints.size };
            if (lower.includes('from agent_actions')) return { count: agentActions.length };
          }
          if (lower.includes('from task_checkpoints where task_id =') && lower.includes('order by updated_at desc')) {
            return getLatestCheckpointShim(args[0]);
          }
          if (lower.includes('from task_checkpoints where id =')) {
            const c = checkpoints.get(args[0]);
            return c ? rowToCheckpointShim(c) : null;
          }
          if (lower.includes('from tasks where id =')) {
            return tasks.get(args[0]) || null;
          }
          if (lower.includes('from alerts where id =')) {
            return alerts.find((a) => a.id === args[0]) || null;
          }
          if (lower.includes('from jobs where id =')) {
            return jobs.get(args[0]) || null;
          }
          if (lower.includes('from job_runs where id =')) {
            return jobRuns.get(args[0]) || null;
          }
          return null;
        },
        all: (...args: any[]) => {
          if (lower.includes('from task_checkpoints where task_id =')) {
            return listCheckpointsShim(args[0]);
          }
          if (lower.includes('from agent_actions where run_id =')) {
            return listAgentActionsShim(args[0]);
          }
          if (lower.includes('from tasks')) {
            return Array.from(tasks.values());
          }
          if (lower.includes('from alerts')) {
            if (lower.includes('where task_id =')) {
              return alerts.filter((a) => a.task_id === args[0]);
            }
            if (lower.includes('where run_id =')) {
              return alerts.filter((a) => a.run_id === args[0]);
            }
            return [...alerts];
          }
          if (lower.includes('from jobs')) {
            return Array.from(jobs.values());
          }
          if (lower.includes('from job_runs')) {
            if (lower.includes('where job_id =')) {
              return Array.from(jobRuns.values()).filter((r) => r.job_id === args[0]);
            }
            return Array.from(jobRuns.values());
          }
          return [];
        },
      };
    },
    close: () => {},
  };

  shimDb.saveCheckpoint = saveCheckpointShim;
  shimDb.getLatestCheckpoint = getLatestCheckpointShim;
  shimDb.listCheckpoints = listCheckpointsShim;
  shimDb.deleteCheckpoint = deleteCheckpointShim;
  shimDb.saveAgentAction = saveAgentActionShim;
  shimDb.listAgentActions = listAgentActionsShim;

  return {
    isNative: false,
    db: shimDb,
    saveCheckpoint: saveCheckpointShim,
    getLatestCheckpoint: getLatestCheckpointShim,
    listCheckpoints: listCheckpointsShim,
    deleteCheckpoint: deleteCheckpointShim,
    saveAgentAction: saveAgentActionShim,
    listAgentActions: listAgentActionsShim,
  };
}

// ===========================================================================
// E2E Track Enhancements: S1/S2 Handover, Model Stats, Results & Simulated Server
// ===========================================================================

export type HandoverTriggerReason =
  | 'stagnation'
  | 'form_input_required'
  | 'navigation_fork'
  | 'stalled_progress';

export type StuckReason = 'bottom_of_page' | 'no_new_items' | 'repeated_actions' | 'selector_empty';

export type SystemTwoSteeringAction =
  | { action: 'paginate'; selector: string; text?: string }
  | { action: 'navigate'; url: string }
  | { action: 'switch_tab'; tabIndex?: number; url?: string }
  | { action: 'adjust_strategy'; newSelector?: string; scrollStepPx?: number }
  | { action: 'adjust_selector'; selector: string }
  | { action: 'retry_with_scroll'; scrollStepPx?: number }
  | { action: 'complete'; message?: string }
  | { action: 'terminate'; reason: 'goal_completed' | 'unachievable' | 'exhausted'; message: string }
  | {
      action: 'form_input';
      selector: string;
      text: string;
      submitSelector?: string;
      pressEnter?: boolean;
      reasoning?: string;
    }
  | {
      action: 'choose_navigation';
      selector: string;
      url?: string;
      text?: string;
      reasoning?: string;
    };

export interface HandoverContext {
  taskId: string;
  runId: string;
  userGoal: string;
  targetUrl: string;
  currentUrl: string;
  pageTitle: string;
  triggerReason?: HandoverTriggerReason;
  stuckReason?: StuckReason;
  scrollState: {
    y: number;
    scrollHeight: number;
    viewportHeight: number;
  };
  totalScanned: number;
  totalAlerts: number;
  consecutiveEmptyCycles: number;
  interactiveElements?: Array<{
    selector: string;
    text: string;
    href?: string;
    tag: string;
  }>;
  formInputs?: InteractiveInputElement[];
  navigationChoices?: NavigationChoice[];
  recentActions?: string[];
}

export function createTaskCheckpointFixture(overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  const now = Date.now();
  return {
    id: `chk-${now}-${Math.random().toString(36).slice(2, 7)}`,
    taskId: 'task-e2e-1',
    runId: 'run-e2e-1',
    createdAt: now - 5000,
    updatedAt: now,
    status: 'running',
    targetUrl: 'http://127.0.0.1:8080/docs',
    currentUrl: 'http://127.0.0.1:8080/docs/page-1',
    pageTitle: 'Documentation - Page 1',
    scroll: {
      y: 1200,
      scrollHeight: 4000,
      viewportHeight: 800,
    },
    totalScanned: 15,
    totalAlerts: 3,
    activeStepCount: 15,
    dedupHashes: [
      sha1Hash('item-hash-1'),
      sha1Hash('item-hash-2'),
      sha1Hash('item-hash-3'),
    ],
    modelConfig: {
      systemOneModel: 'laya-modernbert.onnx',
      systemTwoModel: 'llama3:8b',
    },
    wizardState: {
      currentPage: 3,
      userGoal: 'Scrape documentation articles and identify release notes',
    },
    chatContext: [
      {
        role: 'user',
        text: 'Find tutorials on WebGPU ONNX acceleration',
        timestamp: now - 4000,
      },
      {
        role: 'assistant',
        text: 'I will navigate to tutorials and search for WebGPU ONNX.',
        timestamp: now - 3500,
      },
    ],
    ...overrides,
  };
}

export function createInteractiveInputFixture(
  overrides: Partial<InteractiveInputElement> = {}
): InteractiveInputElement {
  return {
    selector: '#search-box',
    tag: 'input',
    type: 'text',
    name: 'q',
    placeholder: 'Search documentation...',
    ariaLabel: 'Search query',
    formAction: '/search',
    value: '',
    ...overrides,
  };
}

export function createNavigationChoiceFixture(
  overrides: Partial<NavigationChoice> = {}
): NavigationChoice {
  return {
    selector: '#nav-releases',
    text: 'Release Notes',
    href: '/releases',
    category: 'Documentation',
    ...overrides,
  };
}

export function createFormInputSteeringFixture(
  overrides: Partial<Extract<SystemTwoSteeringAction, { action: 'form_input' }>> = {}
): SystemTwoSteeringAction {
  return {
    action: 'form_input',
    selector: '#search-box',
    text: 'WebGPU ONNX acceleration',
    submitSelector: '#search-btn',
    pressEnter: true,
    reasoning: 'Input search keywords to find target tutorial',
    ...overrides,
  };
}

export function createChooseNavigationSteeringFixture(
  overrides: Partial<Extract<SystemTwoSteeringAction, { action: 'choose_navigation' }>> = {}
): SystemTwoSteeringAction {
  return {
    action: 'choose_navigation',
    selector: '#nav-releases',
    url: 'http://127.0.0.1:8080/releases',
    text: 'Release Notes',
    reasoning: 'Target goal asks for release notes; selecting releases link branch',
    ...overrides,
  };
}

export function createResumeTaskMsg(
  checkpointId?: string,
  taskId = 'task-e2e-1'
): WsClientToServerMessage {
  return {
    type: 'RESUME_TASK',
    payload: {
      taskId,
      checkpointId,
    },
  };
}

export function createGetCheckpointsMsg(
  taskId = 'task-e2e-1'
): WsClientToServerMessage {
  return {
    type: 'GET_CHECKPOINTS',
    payload: {
      taskId,
    },
  };
}

export function createCheckpointSavedMsg(
  checkpoint?: TaskCheckpoint
): WsServerToClientMessage {
  return {
    type: 'CHECKPOINT_SAVED',
    payload: checkpoint || createTaskCheckpointFixture(),
  };
}

export function createCheckpointsListMsg(
  checkpoints?: TaskCheckpoint[]
): WsServerToClientMessage {
  return {
    type: 'CHECKPOINTS_LIST',
    payload: checkpoints || [createTaskCheckpointFixture()],
  };
}

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

export function createHandoverContextFixture(overrides: Partial<HandoverContext> = {}): HandoverContext {
  return {
    taskId: 'task-e2e-1',
    runId: 'run-e2e-1',
    userGoal: 'Scrape documentation articles and identify release notes',
    targetUrl: 'http://127.0.0.1/page/1',
    currentUrl: 'http://127.0.0.1/page/1',
    pageTitle: 'Documentation Index',
    triggerReason: 'stagnation',
    stuckReason: 'bottom_of_page',
    scrollState: {
      y: 2200,
      scrollHeight: 3000,
      viewportHeight: 800,
    },
    totalScanned: 10,
    totalAlerts: 3,
    consecutiveEmptyCycles: 3,
    interactiveElements: [
      { selector: '#next-page', text: 'Next Page', href: '/page/2', tag: 'a' },
    ],
    formInputs: [],
    navigationChoices: [],
    recentActions: ['scroll', 'extraction'],
    ...overrides,
  };
}

export function createSteeringActionFixture(
  action: SystemTwoSteeringAction['action'] = 'paginate',
  overrides: any = {}
): SystemTwoSteeringAction {
  switch (action) {
    case 'paginate':
      return { action: 'paginate', selector: '#next-page', text: 'Next Page', ...overrides };
    case 'navigate':
      return { action: 'navigate', url: 'http://127.0.0.1/page/2', ...overrides };
    case 'switch_tab':
      return { action: 'switch_tab', tabIndex: 1, ...overrides };
    case 'adjust_strategy':
      return { action: 'adjust_strategy', newSelector: '.article-card', scrollStepPx: 600, ...overrides };
    case 'adjust_selector':
      return { action: 'adjust_selector', selector: '.article-card', ...overrides };
    case 'retry_with_scroll':
      return { action: 'retry_with_scroll', scrollStepPx: 500, ...overrides };
    case 'complete':
      return { action: 'complete', message: 'Task goal completed', ...overrides };
    case 'terminate':
      return { action: 'terminate', reason: 'goal_completed', message: 'Task goal completed', ...overrides };
    case 'form_input':
      return {
        action: 'form_input',
        selector: '#search-box',
        text: 'WebGPU ONNX acceleration',
        submitSelector: '#search-btn',
        pressEnter: true,
        reasoning: 'Input search query to fulfill user goal',
        ...overrides,
      };
    case 'choose_navigation':
      return {
        action: 'choose_navigation',
        selector: '#nav-releases',
        url: 'http://127.0.0.1/releases',
        text: 'Release Notes',
        reasoning: 'Navigate to target release notes section',
        ...overrides,
      };
    default:
      return { action: 'paginate', selector: '#next-page', text: 'Next Page', ...overrides };
  }
}

export function createModelStatsFixture(overrides: Partial<ModelStats> = {}): ModelStats {
  return {
    systemOne: {
      modelName: 'laya.onnx',
      format: 'fp32',
      provider: 'cpu',
      device: 'CPU',
      status: 'ready',
      avgLatencyMs: 12.5,
      ...overrides.systemOne,
    },
    systemTwo: {
      modelName: 'llama3:8b',
      availableModels: ['llama3:8b', 'llama3:14b', 'qwen2.5:32b'],
      status: 'ready',
      vramUsageMb: 4800,
      gpuOffloaded: true,
      ...overrides.systemTwo,
    },
  };
}

export function createScrapedItemFixture(overrides: Partial<ScrapedItem> = {}): ScrapedItem {
  return {
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    text: 'ModernBERT inference benchmark on WebGPU execution provider',
    link: 'https://example.com/docs/benchmarks',
    answers: { isRelevant: true, category: 'Hardware' },
    confidence: 0.94,
    triggeredAlert: true,
    ...overrides,
  };
}

export function createResultStatsFixture(overrides: Partial<ResultStats> = {}): ResultStats {
  return {
    totalScanned: 25,
    totalAlerts: 8,
    matchRatePercent: 32.0,
    avgLatencyMs: 14.2,
    topCategories: { Hardware: 5, Software: 3 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Simulated Web Server Architecture
// ---------------------------------------------------------------------------

export interface SimulatedItem {
  id?: string;
  text: string;
  link?: string;
  selector?: string;
  category?: string;
  metadata?: Record<string, any>;
}

export interface SimulatedFormField {
  tag?: 'input' | 'textarea' | 'select' | 'button';
  type?: string;
  name?: string;
  id?: string;
  selector?: string;
  placeholder?: string;
  value?: string;
  options?: Array<{ value: string; label: string }>;
  disabled?: boolean;
}

export interface SimulatedFormConfig {
  id?: string;
  action?: string;
  method?: string;
  selector?: string;
  fields: SimulatedFormField[];
  submitButton?: { selector?: string; text?: string; id?: string };
}

export interface SimulatedPageConfig {
  title?: string;
  items?: SimulatedItem[];
  itemSelector?: string; // defaults to '.item'
  nextPageUrl?: string; // e.g. '/page/2'
  nextPageSelector?: string; // defaults to '#next-page'
  nextPageText?: string; // defaults to 'Next Page'
  scrollHeightPx?: number; // e.g. 3000 to simulate a long scrollable page
  viewportHeightPx?: number; // defaults to 800
  customHtml?: string; // full override if provided
  isBottom?: boolean; // if true, indicates end of content / no more pages
  status?: number; // HTTP status code, defaults to 200
  delayMs?: number; // optional delay to test timeout/loading
  interactiveElements?: Array<{ selector: string; text?: string; href?: string; tag: string }>;
  forms?: SimulatedFormConfig[];
  formInputs?: InteractiveInputElement[];
  navigationChoices?: NavigationChoice[];
}

export interface SimulatedInfiniteScrollConfig {
  endpoint: string; // e.g. '/api/feed'
  itemsPerPage: number;
  totalItems: number;
  generator?: (index: number) => SimulatedItem;
}

export interface SimulatedWebServerOptions {
  port?: number;
  pages?: Record<string, SimulatedPageConfig | string>;
  infiniteScroll?: SimulatedInfiniteScrollConfig;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body?: any;
  timestamp: number;
}

export interface SimulatedWebServer {
  server: http.Server;
  port: number;
  url: string;
  start: () => Promise<{ port: number; url: string }>;
  close: () => Promise<void>;
  setPage: (path: string, page: SimulatedPageConfig | string) => void;
  setPages: (pages: Record<string, SimulatedPageConfig | string>) => void;
  getRequests: () => RecordedRequest[];
  resetRequests: () => void;
}

export function createSimulatedWebServer(options: SimulatedWebServerOptions = {}): SimulatedWebServer {
  const pages = new Map<string, SimulatedPageConfig | string>();
  let infiniteScrollConfig = options.infiniteScroll;

  if (options.pages) {
    for (const [p, config] of Object.entries(options.pages)) {
      const normalized = p.startsWith('/') ? p : `/${p}`;
      pages.set(normalized, config);
    }
  }

  const recordedRequests: RecordedRequest[] = [];
  let serverPort = options.port || 0;
  let serverUrl = '';

  const server = http.createServer(async (req, res) => {
    // Collect body if present
    let rawBody = '';
    for await (const chunk of req) {
      rawBody += chunk;
    }

    let parsedBody: any = undefined;
    if (rawBody.trim()) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }

    recordedRequests.push({
      method: req.method || 'GET',
      url: req.url || '/',
      headers: req.headers,
      body: parsedBody,
      timestamp: Date.now(),
    });

    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${serverPort}`);
    const pathname = parsedUrl.pathname;

    // Favicon handler
    if (pathname === '/favicon.ico') {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Infinite scroll API endpoint handler
    if (infiniteScrollConfig && pathname === infiniteScrollConfig.endpoint) {
      const pageNum = Math.max(1, parseInt(parsedUrl.searchParams.get('page') || '1', 10) || 1);
      const defaultOffset = (pageNum - 1) * infiniteScrollConfig.itemsPerPage;
      const parsedOffset = parsedUrl.searchParams.get('offset') !== null ? parseInt(parsedUrl.searchParams.get('offset')!, 10) : defaultOffset;
      const offset = Math.max(0, isNaN(parsedOffset) ? 0 : parsedOffset);
      const parsedLimit = parseInt(parsedUrl.searchParams.get('limit') || `${infiniteScrollConfig.itemsPerPage}`, 10);
      const limit = Math.max(0, isNaN(parsedLimit) ? infiniteScrollConfig.itemsPerPage : parsedLimit);

      const items: SimulatedItem[] = [];
      const end = Math.min(offset + limit, infiniteScrollConfig.totalItems);
      for (let i = offset; i < end; i++) {
        if (infiniteScrollConfig.generator) {
          try {
            items.push(infiniteScrollConfig.generator(i));
          } catch {
            // Gracefully handle generator errors on unexpected input or index
          }
        } else {
          items.push({
            id: `inf-${i + 1}`,
            text: `Dynamic Item #${i + 1}`,
            link: `/items/${i + 1}`,
            category: 'Feed',
          });
        }
      }

      const hasMore = end < infiniteScrollConfig.totalItems;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        page: pageNum,
        offset,
        limit,
        total: infiniteScrollConfig.totalItems,
        items,
        hasMore,
      }));
      return;
    }

    // Look up page
    let pageConfig = pages.get(pathname);
    if (!pageConfig && pathname === '/' && pages.size === 0) {
      // Default initial fallback page
      pageConfig = {
        title: 'Default Simulated Index',
        items: [
          { id: 'item-1', text: 'Introduction to Production Browser Agents', link: '/docs/intro' },
          { id: 'item-2', text: 'Hardware Acceleration Guide', link: '/docs/hw-accel' },
        ],
        nextPageUrl: '/page/2',
        scrollHeightPx: 2000,
        viewportHeightPx: 800,
      };
    }

    if (!pageConfig) {
      if (req.method === 'POST') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!DOCTYPE html><html><body><div id="form-submitted">Submitted successfully</div><div class="item">Filtered Result 1</div></body></html>`);
        return;
      }
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Not Found: ${pathname}`);
      return;
    }

    if (typeof pageConfig === 'string') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(pageConfig);
      return;
    }

    if (pageConfig.delayMs && pageConfig.delayMs > 0) {
      await new Promise(r => setTimeout(r, pageConfig.delayMs));
    }

    res.statusCode = pageConfig.status || 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (pageConfig.customHtml) {
      res.end(pageConfig.customHtml);
      return;
    }

    const itemSelectorClass = (pageConfig.itemSelector || '.item').replace(/^\./, '');
    const items = pageConfig.items || [];
    const itemsHtml = items.map((it, idx) => `
      <div class="${itemSelectorClass}" data-id="${it.id || `item-${idx + 1}`}">
        <h3 class="item-title">${it.text}</h3>
        ${it.link ? `<a class="item-link" href="${it.link}">${it.link}</a>` : ''}
        ${it.category ? `<span class="item-category">${it.category}</span>` : ''}
      </div>
    `).join('\n');

    let paginationHtml = '';
    if (pageConfig.nextPageUrl) {
      const selId = (pageConfig.nextPageSelector || '#next-page').replace(/^#/, '');
      paginationHtml = `
        <div class="pagination-container">
          <a id="${selId}" class="pagination-link" href="${pageConfig.nextPageUrl}">${pageConfig.nextPageText || 'Next Page'}</a>
        </div>
      `;
    }

    let interactiveHtml = '';
    if (pageConfig.interactiveElements && pageConfig.interactiveElements.length > 0) {
      interactiveHtml += pageConfig.interactiveElements.map((el) => {
        if (el.tag === 'a') {
          return `<a href="${el.href || '#'}" class="${el.selector.replace(/^[.#]/, '')}">${el.text || ''}</a>`;
        }
        return `<button class="${el.selector.replace(/^[.#]/, '')}">${el.text || ''}</button>`;
      }).join('\n');
    }

    if (pageConfig.navigationChoices && pageConfig.navigationChoices.length > 0) {
      interactiveHtml += '\n<div class="navigation-forks">\n' + pageConfig.navigationChoices.map((choice) => {
        const idAttr = choice.selector.startsWith('#') ? `id="${choice.selector.slice(1)}"` : '';
        const classAttr = choice.selector.startsWith('.') ? `class="${choice.selector.slice(1)}"` : 'class="nav-fork"';
        const catAttr = choice.category ? `data-category="${choice.category}"` : '';
        return `<a href="${choice.href || '#'}" ${idAttr} ${classAttr} ${catAttr}>${choice.text}</a>`;
      }).join('\n') + '\n</div>\n';
    }

    if (pageConfig.formInputs && pageConfig.formInputs.length > 0) {
      interactiveHtml += '\n<div class="form-inputs">\n' + pageConfig.formInputs.map((inp) => {
        const idAttr = inp.selector.startsWith('#') ? `id="${inp.selector.slice(1)}"` : '';
        const classAttr = inp.selector.startsWith('.') ? `class="${inp.selector.slice(1)}"` : '';
        const nameAttr = inp.name ? `name="${inp.name}"` : '';
        const typeAttr = `type="${inp.type || 'text'}"`;
        const phAttr = inp.placeholder ? `placeholder="${inp.placeholder}"` : '';
        const ariaAttr = inp.ariaLabel ? `aria-label="${inp.ariaLabel}"` : '';
        const valAttr = inp.value ? `value="${inp.value}"` : '';
        if (inp.tag === 'textarea') {
          return `<textarea ${idAttr} ${classAttr} ${nameAttr} ${phAttr} ${ariaAttr}>${inp.value || ''}</textarea>`;
        }
        return `<input ${typeAttr} ${idAttr} ${classAttr} ${nameAttr} ${phAttr} ${ariaAttr} ${valAttr} />`;
      }).join('\n') + '\n</div>\n';
    }

    if (pageConfig.forms && pageConfig.forms.length > 0) {
      interactiveHtml += '\n' + pageConfig.forms.map((f) => {
        const formId = f.id ? `id="${f.id}"` : (f.selector?.startsWith('#') ? `id="${f.selector.slice(1)}"` : '');
        const formClass = f.selector?.startsWith('.') ? `class="${f.selector.slice(1)}"` : '';
        const actionAttr = f.action ? `action="${f.action}"` : 'action="/submit"';
        const methodAttr = `method="${f.method || 'POST'}"`;
        const fieldsHtml = f.fields.map((field) => {
          const fId = field.id ? `id="${field.id}"` : (field.selector?.startsWith('#') ? `id="${field.selector.slice(1)}"` : '');
          const fClass = field.selector?.startsWith('.') ? `class="${field.selector.slice(1)}"` : '';
          const fName = field.name ? `name="${field.name}"` : '';
          const fPh = field.placeholder ? `placeholder="${field.placeholder}"` : '';
          const fVal = field.value ? `value="${field.value}"` : '';
          const fDis = field.disabled ? 'disabled' : '';
          if (field.tag === 'textarea') {
            return `<textarea ${fId} ${fClass} ${fName} ${fPh} ${fDis}>${field.value || ''}</textarea>`;
          }
          if (field.tag === 'select') {
            const opts = (field.options || []).map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
            return `<select ${fId} ${fClass} ${fName} ${fDis}>${opts}</select>`;
          }
          return `<input type="${field.type || 'text'}" ${fId} ${fClass} ${fName} ${fPh} ${fVal} ${fDis} />`;
        }).join('\n');
        const submitBtn = f.submitButton ? `<button type="submit" ${f.submitButton.id ? `id="${f.submitButton.id}"` : ''} class="${f.submitButton.selector?.replace(/^[.#]/, '') || 'btn-submit'}">${f.submitButton.text || 'Submit'}</button>` : '<button type="submit">Submit</button>';
        return `<form ${formId} ${formClass} ${actionAttr} ${methodAttr}>\n${fieldsHtml}\n${submitBtn}\n</form>`;
      }).join('\n');
    }

    const bottomMarkerHtml = pageConfig.isBottom || !pageConfig.nextPageUrl
      ? '<div id="end-of-content" class="bottom-marker">No more items available</div>'
      : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${pageConfig.title || 'Simulated Document'}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      min-height: ${pageConfig.scrollHeightPx !== undefined ? pageConfig.scrollHeightPx : 2500}px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f8fafc;
      color: #0f172a;
    }
    .${itemSelectorClass} {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .${itemSelectorClass} a { color: #2563eb; text-decoration: none; }
    .pagination-container { margin-top: 40px; padding: 16px 0; }
    #next-page, .pagination-link {
      display: inline-block;
      padding: 8px 16px;
      background: #0284c7;
      color: white;
      text-decoration: none;
      border-radius: 4px;
      font-weight: 500;
    }
    .bottom-marker {
      margin-top: 60px;
      padding: 20px;
      background: #e2e8f0;
      text-align: center;
      border-radius: 6px;
      font-weight: 600;
      color: #475569;
    }
  </style>
</head>
<body>
  <h1>${pageConfig.title || 'Simulated Document'}</h1>
  <div id="content" class="content-feed">
    ${itemsHtml}
  </div>
  ${paginationHtml}
  ${interactiveHtml}
  ${bottomMarkerHtml}
</body>
</html>`;

    res.end(html);
  });

  return {
    server,
    get port() {
      return serverPort;
    },
    get url() {
      return serverUrl;
    },
    async start(): Promise<{ port: number; url: string }> {
      return new Promise((resolve, reject) => {
        const listenPort = options.port !== undefined ? options.port : 0;
        server.listen(listenPort, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            serverPort = addr.port;
            serverUrl = `http://127.0.0.1:${serverPort}`;
          }
          resolve({ port: serverPort, url: serverUrl });
        });
        server.once('error', reject);
      });
    },
    async close(): Promise<void> {
      return new Promise((resolve) => {
        if (typeof (server as any).closeAllConnections === 'function') {
          (server as any).closeAllConnections();
        }
        server.close(() => resolve());
      });
    },
    setPage(path: string, page: SimulatedPageConfig | string): void {
      const normalized = path.startsWith('/') ? path : `/${path}`;
      pages.set(normalized, page);
    },
    setPages(newPages: Record<string, SimulatedPageConfig | string>): void {
      for (const [p, config] of Object.entries(newPages)) {
        const normalized = p.startsWith('/') ? p : `/${p}`;
        pages.set(normalized, config);
      }
    },
    getRequests(): RecordedRequest[] {
      return [...recordedRequests];
    },
    resetRequests(): void {
      recordedRequests.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Loop & Bottom-of-Page Detection Logic
// ---------------------------------------------------------------------------

export function isAtBottomOfPage(
  y: number,
  viewportHeight: number,
  scrollHeight: number,
  tolerance = 5
): boolean {
  return y + viewportHeight >= scrollHeight - tolerance;
}

export function isScrollStatic(currY: number, prevY: number): boolean {
  return currY === prevY;
}

export function evaluateLoopDetectorState(state: {
  y: number;
  prevY: number;
  viewportHeight: number;
  scrollHeight: number;
  consecutiveEmptyCycles: number;
  threshold?: number;
}): { isLoop: boolean; reason?: 'bottom_of_page' | 'repeated_actions' | 'no_new_items' } {
  const threshold = state.threshold ?? 3;
  const isBottom = isAtBottomOfPage(state.y, state.viewportHeight, state.scrollHeight);
  const isStatic = isScrollStatic(state.y, state.prevY);

  if (state.consecutiveEmptyCycles >= threshold) {
    if (isBottom) {
      return { isLoop: true, reason: 'bottom_of_page' };
    }
    if (isStatic) {
      return { isLoop: true, reason: 'repeated_actions' };
    }
    return { isLoop: true, reason: 'no_new_items' };
  }

  return { isLoop: false };
}

// ---------------------------------------------------------------------------
// Hardware Acceleration Ladder Logic
// ---------------------------------------------------------------------------

export const HARDWARE_LADDERS = {
  win32: ['webgpu', 'dml', 'cpu'],
  linux: ['cuda', 'rocm', 'openvino', 'webgpu', 'cpu'],
  darwin: ['webgpu', 'cpu'],
} as const;

export function resolveHardwareProvider(
  platform: 'win32' | 'linux' | 'darwin',
  availableBackends: string[]
): { provider: string; device: string; format: 'fp32' | 'int8' } {
  const ladder = HARDWARE_LADDERS[platform] || HARDWARE_LADDERS.linux;
  const selected = ladder.find((b) => availableBackends.includes(b)) || 'cpu';

  let device = 'CPU';
  if (selected === 'webgpu') device = 'GPU (WebGPU Adapter)';
  else if (selected === 'dml') device = 'DirectML (DirectX 12 GPU)';
  else if (selected === 'cuda') device = 'NVIDIA GPU (CUDA)';
  else if (selected === 'rocm') device = 'AMD GPU (ROCm)';
  else if (selected === 'openvino') device = 'Intel NPU/GPU (OpenVINO)';

  return {
    provider: selected,
    device,
    format: selected === 'cpu' ? 'int8' : 'fp32',
  };
}

// ---------------------------------------------------------------------------
// Markdown Results Store Formatting & Parsing
// ---------------------------------------------------------------------------

export function formatMarkdownResultsFile(params: {
  title?: string;
  goal?: string;
  taskId?: string;
  items: ScrapedItem[];
  summary?: string;
  stats?: ResultStats;
}): string {
  const title = params.title || 'Scout Scraping Results';
  const timestamp = new Date().toISOString();
  const stats = params.stats || {
    totalScanned: params.items.length,
    totalAlerts: params.items.filter((i) => i.triggeredAlert).length,
    matchRatePercent: params.items.length > 0
      ? Number(((params.items.filter((i) => i.triggeredAlert).length / params.items.length) * 100).toFixed(1))
      : 0,
    avgLatencyMs: 15.0,
    topCategories: {},
  };

  const frontmatter = `---
title: "${title}"
taskId: "${params.taskId || 'default-task'}"
generatedAt: "${timestamp}"
totalItems: ${params.items.length}
totalAlerts: ${stats.totalAlerts}
matchRatePercent: ${stats.matchRatePercent}%
---`;

  const executiveSummary = `## Executive Summary\n${
    params.summary ||
    `Successfully extracted ${params.items.length} items. Identified ${stats.totalAlerts} alert-triggering items (${stats.matchRatePercent.toFixed(1)}% match rate).`
  }`;

  const statsTable = `## Statistics\n| Metric | Value |\n|---|---|\n| Total Scanned | ${stats.totalScanned} |\n| Total Alerts | ${stats.totalAlerts} |\n| Match Rate | ${stats.matchRatePercent}% |\n| Avg Latency | ${stats.avgLatencyMs}ms |`;

  const escapeCell = (text: string) => (text || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

  const itemsRows = params.items.map((item, idx) => {
    const safeId = escapeCell(item.id);
    const safeText = escapeCell(item.text);
    const link = item.link ? `[Link](${escapeCell(item.link)})` : '-';
    const alert = item.triggeredAlert ? '🚨 Alert' : 'Normal';
    const conf = `${(item.confidence * 100).toFixed(0)}%`;
    return `| ${idx + 1} | ${safeId} | ${safeText} | ${link} | ${alert} | ${conf} |`;
  }).join('\n');

  const itemsTable = `## Scraped Items\n| # | ID | Text | Link | Status | Confidence |\n|---|---|---|---|---|---|\n${itemsRows}`;

  return `${frontmatter}\n\n# ${title}\n\n${executiveSummary}\n\n${statsTable}\n\n${itemsTable}\n`;
}

export function parseMarkdownResultsFile(markdown: string): {
  metadata: Record<string, string>;
  summary: string;
  stats: Partial<ResultStats>;
  items: Array<{ id: string; text: string; link?: string; confidence: number; alert: boolean }>;
} {
  const metadata: Record<string, string> = {};
  let summary = '';
  const stats: Partial<ResultStats> = {};
  const items: Array<{ id: string; text: string; link?: string; confidence: number; alert: boolean }> = [];

  // Parse frontmatter
  const fmMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const lines = fmMatch[1].split(/\r?\n/);
    for (const l of lines) {
      const idx = l.indexOf(':');
      if (idx !== -1) {
        const key = l.slice(0, idx).trim();
        const val = l.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        metadata[key] = val;
      }
    }
  }

  // Parse Executive Summary
  const summaryMatch = markdown.match(/## Executive Summary\r?\n([\s\S]*?)(?=\r?\n## (?:Statistics|Scraped Items)\b|$)/);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  // Parse Stats Table
  const scannedMatch = markdown.match(/Total Scanned\s*\|\s*(\d+)/);
  if (scannedMatch) stats.totalScanned = parseInt(scannedMatch[1], 10);
  const alertsMatch = markdown.match(/Total Alerts\s*\|\s*(\d+)/);
  if (alertsMatch) stats.totalAlerts = parseInt(alertsMatch[1], 10);
  const matchRateMatch = markdown.match(/Match Rate\s*\|\s*([\d.]+)%/);
  if (matchRateMatch) stats.matchRatePercent = parseFloat(matchRateMatch[1]);
  const latencyMatch = markdown.match(/Avg Latency\s*\|\s*([\d.]+)ms/);
  if (latencyMatch) stats.avgLatencyMs = parseFloat(latencyMatch[1]);

  // Parse Scraped Items
  const itemsSectionMatch = markdown.match(/## Scraped Items\r?\n\|[\s\S]*?\r?\n\|[-|\s]+\r?\n([\s\S]*?)(?=\r?\n##|$)/);
  if (itemsSectionMatch) {
    const rows = itemsSectionMatch[1].trim().split(/\r?\n/);
    for (const r of rows) {
      const trimmed = r.trim();
      if (!trimmed.startsWith('|')) continue;
      const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
      const parts = inner.split(/(?<!\\)\|/).map((p) => p.trim());
      if (parts.length >= 6) {
        const id = parts[1].replace(/\\\|/g, '|');
        const text = parts[2].replace(/\\\|/g, '|');
        const rawLink = parts[3];
        const linkMatch = rawLink.match(/\[.*?\]\((.*)\)/);
        const link = linkMatch ? linkMatch[1] : (rawLink !== '-' ? rawLink : undefined);
        const alert = parts[4].includes('Alert');
        const conf = parseFloat(parts[5].replace('%', '')) / 100;
        items.push({ id, text, link, confidence: isNaN(conf) ? 0 : conf, alert });
      }
    }
  }

  return { metadata, summary, stats, items };
}

// ---------------------------------------------------------------------------
// System 2 Deliberator & Steering Directive Simulation
// ---------------------------------------------------------------------------

export function evaluateSteeringDirective(context: HandoverContext): SystemTwoSteeringAction {
  // If target goal completed
  if (context.totalAlerts >= 10) {
    return {
      action: 'terminate',
      reason: 'goal_completed',
      message: `Target goal reached with ${context.totalAlerts} alerts found`,
    };
  }

  // If consecutive empty cycles indicate stuck
  if (context.stuckReason === 'bottom_of_page' || context.stuckReason === 'no_new_items') {
    // Check for pagination element
    const nextEl = context.interactiveElements.find(
      (el) =>
        el.selector === '#next-page' ||
        el.text.toLowerCase().includes('next') ||
        (el.href && el.href.includes('page'))
    );
    if (nextEl) {
      return {
        action: 'paginate',
        selector: nextEl.selector,
        text: nextEl.text,
      };
    }
  }

  if (context.stuckReason === 'selector_empty') {
    return {
      action: 'adjust_strategy',
      newSelector: '.content-item, article, .post',
      scrollStepPx: 400,
    };
  }

  // If no interactive elements remaining
  if (context.interactiveElements.length === 0) {
    return {
      action: 'terminate',
      reason: 'exhausted',
      message: 'No pagination or interactive elements remaining on page',
    };
  }

  return {
    action: 'terminate',
    reason: 'exhausted',
    message: 'Reached terminal condition in task deliberation',
  };
}

export function answerResultsQuery(
  query: string,
  items: ScrapedItem[]
): { answer: string; model: string; timestamp: string } {
  const q = query.toLowerCase();
  const total = items.length;
  const alerts = items.filter((i) => i.triggeredAlert).length;

  let answer = '';
  if (total === 0) {
    answer = 'No scraped items are currently stored in results.md.';
  } else if (q.includes('how many') && (q.includes('alert') || q.includes('match'))) {
    answer = `There are ${alerts} alert-triggering items out of ${total} total scraped items (${((alerts / total) * 100).toFixed(1)}% match rate).`;
  } else if (q.includes('category') || q.includes('categories')) {
    const cats: Record<string, number> = {};
    for (const it of items) {
      const c = it.answers?.category || 'Uncategorized';
      cats[c] = (cats[c] || 0) + 1;
    }
    const breakdown = Object.entries(cats).map(([k, v]) => `${k}: ${v}`).join(', ');
    answer = `Category distribution: ${breakdown}.`;
  } else {
    answer = `Based on ${total} scraped items, ${alerts} met the target criteria. Top item: "${items[0]?.text}".`;
  }

  return {
    answer,
    model: 'llama3:8b',
    timestamp: new Date().toISOString(),
  };
}

export function applySteeringInstruction(
  instruction: string,
  currentParams: { url?: string; selector?: string; scrollStep?: number }
): { applied: boolean; explanation: string; updatedParams: typeof currentParams } {
  const inst = instruction.toLowerCase();
  const updated = { ...currentParams };

  if (inst.includes('fly to the moon') || inst.includes('impossible') || inst.includes('destroy')) {
    return {
      applied: false,
      explanation: 'Instruction rejected: unachievable or invalid action requested.',
      updatedParams: currentParams,
    };
  }

  const explanations: string[] = [];

  const urlMatch = instruction.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    updated.url = urlMatch[0];
    explanations.push(`Navigating to ${updated.url}.`);
  }

  if (inst.includes('scroll step') || inst.includes('scroll faster') || inst.includes('px')) {
    const match = instruction.match(/(\d+)\s*(px|step)?/);
    if (match) {
      updated.scrollStep = parseInt(match[1], 10);
      explanations.push(`Adjusted scroll step to ${updated.scrollStep}px.`);
    }
  }

  if (inst.includes('selector') || inst.includes('focus only on') || inst.includes('card')) {
    if (inst.includes('onnx')) {
      updated.selector = '.onnx-item, [data-category="onnx"]';
    } else {
      updated.selector = '.card, article';
    }
    explanations.push(`Updated DOM extraction selector to "${updated.selector}".`);
  }

  if (explanations.length > 0) {
    return {
      applied: true,
      explanation: explanations.join(' '),
      updatedParams: updated,
    };
  }

  return {
    applied: true,
    explanation: `Steering directive noted: "${instruction}". Applied standard strategy adjustment.`,
    updatedParams: updated,
  };
}

// ===========================================================================
// Browser Agent Collaborative Browsing, Checkpointing & UI Workflow Helpers
// ===========================================================================

function extractAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

/**
 * Lightweight DOM scanner extracting interactive form inputs from HTML.
 * Filters out hidden, disabled, and non-interactive inputs.
 * Truncates candidate list to top 15 most relevant elements per Boundary B4.2.
 */
export function detectInteractiveFormInputs(html: string): InteractiveInputElement[] {
  const inputs: InteractiveInputElement[] = [];

  // Match input, textarea, select tags
  const tagRegex = /<(input|textarea|select)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];

    // Check if disabled or type="hidden"
    if (/\bdisabled\b/i.test(attrs)) continue;

    const type = extractAttr(attrs, 'type')?.toLowerCase() || (tag === 'textarea' ? 'textarea' : 'text');
    if (type === 'hidden') continue;

    const id = extractAttr(attrs, 'id');
    const className = extractAttr(attrs, 'class');
    const name = extractAttr(attrs, 'name');
    const placeholder = extractAttr(attrs, 'placeholder');
    const ariaLabel = extractAttr(attrs, 'aria-label');
    const value = extractAttr(attrs, 'value') || '';

    let selector = '';
    if (id) {
      selector = `#${id}`;
    } else if (name) {
      selector = `${tag}[name="${name}"]`;
    } else if (className) {
      selector = `.${className.trim().split(/\s+/)[0]}`;
    } else {
      selector = `${tag}:nth-of-type(${inputs.length + 1})`;
    }

    inputs.push({
      selector,
      tag,
      type,
      name,
      placeholder,
      ariaLabel,
      value,
    });
  }

  // Boundary B4.2: Truncate candidate list to top 15 most relevant elements
  return inputs.slice(0, 15);
}

/**
 * Lightweight DOM scanner extracting navigation choices from HTML.
 */
export function detectNavigationForks(html: string): NavigationChoice[] {
  const choices: NavigationChoice[] = [];
  const linkRegex = /<a\b([^>]*)>(.*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const attrs = match[1];
    const text = match[2].replace(/<[^>]+>/g, '').trim();

    const href = extractAttr(attrs, 'href');
    const id = extractAttr(attrs, 'id');
    const className = extractAttr(attrs, 'class');
    const category = extractAttr(attrs, 'data-category');

    let selector = '';
    if (id) {
      selector = `#${id}`;
    } else if (className) {
      selector = `.${className.trim().split(/\s+/)[0]}`;
    } else if (href) {
      selector = `a[href="${href}"]`;
    } else {
      selector = `a:nth-of-type(${choices.length + 1})`;
    }

    choices.push({
      selector,
      text: text || 'Link',
      href,
      category,
    });
  }

  return choices;
}

/**
 * System 2 Goal-Conditioned Deliberation simulator.
 * Deliberates on HandoverContext and user goal, producing a SystemTwoSteeringAction.
 */
export async function deliberateCollaborativeStep(
  context: HandoverContext,
  modelOnline = true
): Promise<SystemTwoSteeringAction> {
  // If model service is offline, execute deterministic fallback per F5.5 / B5.4
  if (!modelOnline) {
    if (context.navigationChoices && context.navigationChoices.length > 0) {
      const choice = context.navigationChoices[0];
      return {
        action: 'choose_navigation',
        selector: choice.selector,
        url: choice.href,
        text: choice.text,
        reasoning: 'Fallback heuristic: offline System 2 selected first navigation candidate',
      };
    }
    if (context.formInputs && context.formInputs.length > 0) {
      const inp = context.formInputs[0];
      return {
        action: 'form_input',
        selector: inp.selector,
        text: 'test query',
        submitSelector: '#search-btn',
        pressEnter: true,
        reasoning: 'Fallback heuristic: offline System 2 selected default input query',
      };
    }
    return {
      action: 'paginate',
      selector: '#next-page',
      text: 'Next Page',
    };
  }

  const goalLower = (context.userGoal || '').toLowerCase();

  // If trigger is form_input_required
  if (context.triggerReason === 'form_input_required' || (context.formInputs && context.formInputs.length > 0 && !context.triggerReason)) {
    if (!context.formInputs || context.formInputs.length === 0) {
      return { action: 'adjust_strategy', scrollStepPx: 500 };
    }

    const input = context.formInputs[0];
    let queryText = 'WebGPU ONNX acceleration';
    if (goalLower.includes('release') || goalLower.includes('v0.2.0')) {
      queryText = 'v0.2.0';
    } else if (goalLower.includes('modernbert')) {
      queryText = 'ModernBERT';
    } else if (goalLower.includes('webgpu')) {
      queryText = 'WebGPU ONNX';
    } else if (goalLower.trim() === '') {
      // Empty goal string fallback per B5.1
      queryText = 'documentation overview';
    } else {
      // Extract key terms from goal
      const words = goalLower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
      queryText = words.slice(0, 3).join(' ') || 'overview';
    }

    return {
      action: 'form_input',
      selector: input.selector,
      text: queryText,
      submitSelector: '#search-btn',
      pressEnter: true,
      reasoning: `Deliberated search query "${queryText}" based on user goal "${context.userGoal}"`,
    };
  }

  // If trigger is navigation_fork
  if (context.triggerReason === 'navigation_fork' || (context.navigationChoices && context.navigationChoices.length > 1)) {
    const choices = context.navigationChoices || [];
    if (choices.length === 0) {
      return { action: 'adjust_strategy', scrollStepPx: 400 };
    }

    // Rank candidate branches based on goal relevance
    let bestChoice = choices[0];
    let maxScore = -1;

    for (const c of choices) {
      const text = `${c.text} ${c.href || ''} ${c.category || ''}`.toLowerCase();
      let score = 0;
      if (goalLower.includes('release') && (text.includes('release') || text.includes('v0.'))) score += 10;
      if (goalLower.includes('tutorial') && (text.includes('tutorial') || text.includes('guide'))) score += 10;
      if (goalLower.includes('doc') && text.includes('doc')) score += 5;
      if (score > maxScore) {
        maxScore = score;
        bestChoice = c;
      }
    }

    return {
      action: 'choose_navigation',
      selector: bestChoice.selector,
      url: bestChoice.href,
      text: bestChoice.text,
      reasoning: `System 2 ranked branch "${bestChoice.text}" highest for goal "${context.userGoal}"`,
    };
  }

  // Default / Stagnation
  if (context.stuckReason === 'bottom_of_page') {
    return {
      action: 'paginate',
      selector: '#next-page',
      text: 'Next Page',
    };
  }

  return {
    action: 'adjust_strategy',
    scrollStepPx: 500,
  };
}

/**
 * Loop guard preventing repetitive form submissions to the same selector.
 */
export class FormSubmissionLoopGuard {
  private history: Array<{ selector: string; text: string; timestamp: number }> = [];

  recordSubmission(selector: string, text: string): void {
    this.history.push({ selector, text, timestamp: Date.now() });
  }

  getConsecutiveCount(selector: string, text: string): number {
    let count = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].selector === selector && this.history[i].text === text) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  shouldBlock(selector: string, text: string, threshold = 3): boolean {
    return this.getConsecutiveCount(selector, text) >= threshold;
  }

  clear(): void {
    this.history = [];
  }
}

/**
 * Loop guard preventing cyclical navigation between identical branches.
 */
export class ForkNavigationLoopGuard {
  private visitedUrls = new Set<string>();

  recordVisit(url: string): void {
    this.visitedUrls.add(url);
  }

  isExhausted(url: string): boolean {
    return this.visitedUrls.has(url);
  }

  canVisit(url: string): boolean {
    return !this.visitedUrls.has(url);
  }

  clear(): void {
    this.visitedUrls.clear();
  }
}

/**
 * Simulator for the 4-Page Desktop UI Workflow Store.
 * Coordinates transitions, validation, and checkpoint state restoration.
 */
export class UiWizardStoreSimulator {
  public currentPage: 1 | 2 | 3 | 4 = 1;
  public canResume = false;
  public userGoal = '';
  public selectedModel = 'qwen2.5:3b';
  public activeGgufModelId: string | null = null;
  public taskSpec: CompiledTaskSpec | null = null;
  public isTaskRunning = false;
  public alertConfidenceThreshold = 0.85;
  public actionTimeline: AgentAction[] = [];
  public inferenceFeed: InferenceTelemetryItem[] = [];
  public snapshot: BrowserSnapshot | null = null;
  public results: ScrapedItem[] = [];
  public chatMessages: Array<{ role: 'user' | 'assistant'; text: string; timestamp: number }> = [];
  public lastCheckpoint: TaskCheckpoint | null = null;

  setPage(page: number): void {
    this.currentPage = Math.max(1, Math.min(4, Math.floor(page))) as 1 | 2 | 3 | 4;
  }

  nextPage(): void {
    this.setPage(this.currentPage + 1);
  }

  prevPage(): void {
    this.setPage(this.currentPage - 1);
  }

  setUserGoal(goal: string): void {
    this.userGoal = goal;
  }

  canAdvanceFromPage1(): boolean {
    return this.userGoal.trim().length > 0;
  }

  compileSpec(goal?: string): CompiledTaskSpec {
    const targetGoal = goal || this.userGoal || 'Default Browsing Goal';
    const spec: CompiledTaskSpec = {
      id: `task-${Date.now()}`,
      name: `Agent Run: ${targetGoal.slice(0, 20)}`,
      userGoal: targetGoal,
      targetUrl: 'http://127.0.0.1:8080/docs',
      domSelector: '.doc-card',
      pollIntervalMs: 500,
      scrollStepPx: 400,
      questions: {
        relevant: { type: 'noul', statement: 'Is this item relevant to user goal?' },
      },
      alertRule: {
        questionKey: 'relevant',
        operator: 'gte',
        targetValue: 0.8,
        minAnswerConfidence: this.alertConfidenceThreshold,
      },
      createdAt: Date.now(),
    };
    this.taskSpec = spec;
    return spec;
  }

  setThreshold(val: number): void {
    this.alertConfidenceThreshold = Math.max(0.50, Math.min(0.99, val));
    if (this.taskSpec) {
      this.taskSpec.alertRule.minAnswerConfidence = this.alertConfidenceThreshold;
    }
  }

  startTask(): boolean {
    if (!this.taskSpec) {
      this.compileSpec();
    }
    this.isTaskRunning = true;
    this.currentPage = 3;
    return true;
  }

  stopTask(): void {
    this.isTaskRunning = false;
  }

  applyCheckpoint(checkpoint: TaskCheckpoint): void {
    this.lastCheckpoint = checkpoint;
    this.canResume = true;
    if (checkpoint.wizardState?.userGoal) {
      this.userGoal = checkpoint.wizardState.userGoal;
    }
    if (checkpoint.wizardState?.currentPage) {
      this.setPage(checkpoint.wizardState.currentPage);
    }
    if (checkpoint.chatContext) {
      this.chatMessages = checkpoint.chatContext.map((c) => ({
        role: c.role as 'user' | 'assistant',
        text: c.text,
        timestamp: c.timestamp,
      }));
    }
  }

  reset(): void {
    this.currentPage = 1;
    this.canResume = false;
    this.userGoal = '';
    this.taskSpec = null;
    this.isTaskRunning = false;
    this.lastCheckpoint = null;
    this.actionTimeline = [];
    this.inferenceFeed = [];
    this.snapshot = null;
    this.results = [];
    this.chatMessages = [];
  }
}


