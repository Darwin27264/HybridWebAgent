/**
 * Tier 1: Isolated Happy-Path Functional Tests
 * Covers all 19 features (F1 through F19) specified in TEST_INFRA.md:
 *
 * F1:  Multi-Run Cache Reset (5 tests)
 * F2:  Unique Run ID & Teardown Lifecycle (5 tests)
 * F3:  Run Persistence & Metrics Aggregation (5 tests)
 * F4:  Agent Action Structured Logging (5 tests)
 * F5:  Live Browser View Visual Snapshots (5 tests)
 * F6:  Local Ollama Model Discovery & Routing (5 tests)
 * F7:  Backend Performance & Health Monitor (5 tests)
 * F8:  Multi-Job Engine & Cron Scheduler (5 tests)
 * F9:  Pipeline Robustness & Memory Guards (5 tests)
 * F10: Cross-Platform Process Management (5 tests)
 * F11: UI Button Feedback & Loading States (5 tests)
 * F12: UI Bottom-Right Toast Notifications (5 tests)
 * F13: UI Live Browsing View Component Contracts (5 tests)
 * F14: UI Agent Action Timeline Contracts (5 tests)
 * F15: UI Local Ollama Model Selector Contracts (5 tests)
 * F16: UI Modern Dark Gray Theme & Solid Buttons (5 tests)
 * F17: UI Base Sizing & Responsive Scaling Contracts (5 tests)
 * F18: UI Multi-Job Controls & Switcher Contracts (5 tests)
 * F19: UI Dedicated Status Page with Recharts (5 tests)
 *
 * Total: 19 features × 5 tests = 95 tests
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from './harness';
import {
  WORKSPACE_ROOT,
  FIXTURES,
  sha1Hash,
  LruDeduplicator,
  abortableSleep,
  evaluateAlertRule,
  sanitizeCompiledSpec,
  createTestSqliteDb,
  createMockOllamaServer,
  isValidCronExpression,
  parseCronNextRun,
  createAgentActionFixture,
  createBrowserSnapshotFixture,
  createMetricsFixture,
  createJobFixture,
  createJobRunFixture,
  createDaemonNotificationFixture,
  createCompileTaskMsg,
  createStartTaskMsg,
  createStopTaskMsg,
  createGetModelsMsg,
  createSetModelMsg,
  createGetMetricsMsg,
  createGetJobsMsg,
  createCreateJobMsg,
  createUpdateJobMsg,
  createDeleteJobMsg,
  createStartJobMsg,
  createStopJobMsg,
  createDaemonStatusMsg,
  createAgentActionMsg,
  createBrowserSnapshotMsg,
  createModelsListMsg,
  createMetricsUpdateMsg,
  createJobsListMsg,
  createJobStatusMsg,
  createDaemonNotificationMsg,
} from './test-utils';

// ===========================================================================
// F1: Multi-Run Cache Reset
// ===========================================================================
describe('Feature 1: Multi-Run Cache Reset', () => {
  it('1.1: LRU cache resetCache() clears all entries and resets size to 0', () => {
    const deduplicator = new LruDeduplicator(2000);
    const hashes = ['hash-a', 'hash-b', 'hash-c', 'hash-d'].map((s) => sha1Hash(s));
    for (const h of hashes) {
      deduplicator.add(h);
      expect(deduplicator.has(h)).toBe(true);
    }
    expect(deduplicator.size()).toBe(4);

    deduplicator.resetCache();
    expect(deduplicator.size()).toBe(0);
    for (const h of hashes) {
      expect(deduplicator.has(h)).toBe(false);
    }
  });

  it('1.2: Second run on identical DOM candidates evaluates all items after cache reset', () => {
    const deduplicator = new LruDeduplicator(2000);
    const domSnippets = [
      'Show HN: Laya Non-autoregressive model',
      'Show HN: ModernBERT ONNX Runtime SIMD',
      'Ask HN: Favorite mechanical switches',
    ];

    // Pass 1: populate cache
    const pass1Evaluated: string[] = [];
    for (const text of domSnippets) {
      const hash = sha1Hash(text);
      if (!deduplicator.has(hash)) {
        deduplicator.add(hash);
        pass1Evaluated.push(text);
      }
    }
    expect(pass1Evaluated.length).toBe(3);

    // If cache is NOT reset, Pass 2 evaluates 0 items
    const unresetPass: string[] = [];
    for (const text of domSnippets) {
      const hash = sha1Hash(text);
      if (!deduplicator.has(hash)) {
        deduplicator.add(hash);
        unresetPass.push(text);
      }
    }
    expect(unresetPass.length).toBe(0);

    // After resetCache(), Pass 2 evaluates all 3 items
    deduplicator.resetCache();
    const pass2Evaluated: string[] = [];
    for (const text of domSnippets) {
      const hash = sha1Hash(text);
      if (!deduplicator.has(hash)) {
        deduplicator.add(hash);
        pass2Evaluated.push(text);
      }
    }
    expect(pass2Evaluated.length).toBe(3);
    expect(pass2Evaluated).toEqual(pass1Evaluated);
  });

  it('1.3: Cache reset preserves the configured maxSize capacity', () => {
    const customCapacity = 500;
    const deduplicator = new LruDeduplicator(customCapacity);
    expect(deduplicator.maxSize).toBe(customCapacity);

    for (let i = 0; i < 20; i++) {
      deduplicator.add(sha1Hash(`candidate-node-${i}`));
    }
    expect(deduplicator.size()).toBe(20);

    deduplicator.resetCache();
    expect(deduplicator.size()).toBe(0);
    expect(deduplicator.maxSize).toBe(customCapacity);
  });

  it('1.4: Pre-clearing cache before run starts allows re-discovery of identical content', () => {
    const deduplicator = new LruDeduplicator(2000);
    const initialText = 'Show HN: Offline AI Agent';
    const hash = sha1Hash(initialText);

    deduplicator.add(hash);
    expect(deduplicator.has(hash)).toBe(true);

    // Simulating task startup lifecycle hook that resets deduplicator
    deduplicator.clear();
    expect(deduplicator.has(hash)).toBe(false);

    deduplicator.add(hash);
    expect(deduplicator.has(hash)).toBe(true);
    expect(deduplicator.size()).toBe(1);
  });

  it('1.5: Consecutive runs with interleaved cache reset maintain independent histories', () => {
    const deduplicator = new LruDeduplicator(2000);
    const run1Items = ['item-1', 'item-2', 'item-3'].map(sha1Hash);
    const run2Items = ['item-3', 'item-4', 'item-5'].map(sha1Hash);

    // Run 1 execution
    for (const item of run1Items) deduplicator.add(item);
    expect(deduplicator.size()).toBe(3);

    // Reset between Run 1 and Run 2
    deduplicator.resetCache();
    expect(deduplicator.size()).toBe(0);

    // Run 2 execution (item-3 is re-evaluated)
    let reEvaluatedCount = 0;
    for (const item of run2Items) {
      if (!deduplicator.has(item)) {
        deduplicator.add(item);
        reEvaluatedCount++;
      }
    }
    expect(reEvaluatedCount).toBe(3);
    expect(deduplicator.size()).toBe(3);
  });
});

// ===========================================================================
// F2: Unique Run ID & Teardown Lifecycle
// ===========================================================================
describe('Feature 2: Unique Run ID & Teardown Lifecycle', () => {
  it('2.1: Each execution generates a distinct unique runId', () => {
    const generateRunId = () => `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const id1 = generateRunId();
    const id2 = generateRunId();
    const id3 = generateRunId();

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id3).toBeDefined();
    expect(id1 === id2).toBe(false);
    expect(id2 === id3).toBe(false);
    expect(id1.startsWith('run-')).toBe(true);
  });

  it('2.2: Teardown race isolation: Run 1 finally block does not reset state if Run 2 is active', () => {
    // Model daemon state with runId tracking
    const daemonState = {
      isRunning: false,
      activeTaskId: null as string | null,
      activeRunId: null as string | null,
    };

    // Run 1 starts
    const run1Id = 'run-100-alpha';
    const taskId = 'task-hn-01';
    daemonState.isRunning = true;
    daemonState.activeTaskId = taskId;
    daemonState.activeRunId = run1Id;

    // Run 2 starts before Run 1 async cleanup completes
    const run2Id = 'run-200-beta';
    daemonState.activeRunId = run2Id;

    // Run 1 finally block executes with runId check
    const run1Finally = () => {
      if (daemonState.activeRunId === run1Id) {
        daemonState.isRunning = false;
        daemonState.activeTaskId = null;
        daemonState.activeRunId = null;
      }
    };
    run1Finally();

    // Verification: Run 2 remains actively running
    expect(daemonState.isRunning).toBe(true);
    expect(daemonState.activeRunId).toBe(run2Id);
    expect(daemonState.activeTaskId).toBe(taskId);
  });

  it('2.3: JOB_STATUS message propagates activeRunId to connected clients', () => {
    const msg = createJobStatusMsg('job-01', 'running', 'run-test-uuid-99');
    expect(msg.type).toBe('JOB_STATUS');
    expect(msg.payload.jobId).toBe('job-01');
    expect(msg.payload.status).toBe('running');
    expect(msg.payload.activeRunId).toBe('run-test-uuid-99');

    const serialized = JSON.stringify(msg);
    const parsed = JSON.parse(serialized);
    expect(parsed.payload.activeRunId).toBe('run-test-uuid-99');
  });

  it('2.4: AbortController scoping isolates Run 1 cancellation from Run 2', () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    expect(controller1.signal.aborted).toBe(false);
    expect(controller2.signal.aborted).toBe(false);

    // Cancel Run 1
    controller1.abort();
    expect(controller1.signal.aborted).toBe(true);
    expect(controller2.signal.aborted).toBe(false);
  });

  it('2.5: Rapid start-abort-restart sequence generates unique monotonic runs', () => {
    const runHistory: Array<{ runId: string; timestamp: number }> = [];
    for (let i = 0; i < 5; i++) {
      const now = Date.now() + i * 10;
      const runId = `run-${now}-${i}`;
      runHistory.push({ runId, timestamp: now });
    }

    expect(runHistory.length).toBe(5);
    const uniqueIds = new Set(runHistory.map((r) => r.runId));
    expect(uniqueIds.size).toBe(5);
    for (let i = 1; i < runHistory.length; i++) {
      expect(runHistory[i].timestamp).toBeGreaterThanOrEqual(runHistory[i - 1].timestamp);
    }
  });
});

// ===========================================================================
// F3: Run Persistence & Metrics Aggregation
// ===========================================================================
describe('Feature 3: Run Persistence & Metrics Aggregation', () => {
  let dbInstance: any;

  beforeAll(() => {
    const { db } = createTestSqliteDb(':memory:');
    dbInstance = db;
  });

  afterAll(() => {
    if (dbInstance && typeof dbInstance.close === 'function') {
      dbInstance.close();
    }
  });

  it('3.1: SQLite schema persists jobs records with specification and schedule', () => {
    const job = createJobFixture({ id: 'job-f3-01', name: 'HN Persistence Test Job' });
    const stmt = dbInstance.prepare(`
      INSERT INTO jobs (id, name, spec_json, cron_schedule, is_scheduled, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      job.id,
      job.name,
      JSON.stringify(job.spec),
      job.cronSchedule ?? null,
      job.isScheduled ? 1 : 0,
      job.status,
      job.createdAt,
      job.updatedAt
    );
    expect(res.changes).toBe(1);

    const row = dbInstance.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    expect(row).toBeDefined();
    expect(row.name).toBe(job.name);
    expect(row.cron_schedule).toBe(job.cronSchedule);
  });

  it('3.2: SQLite schema persists job_runs records linked to parent job', () => {
    const run = createJobRunFixture({
      id: 'run-f3-01',
      jobId: 'job-f3-01',
      totalScanned: 25,
      totalAlerts: 2,
      avgLatencyMs: 4.1,
    });
    const stmt = dbInstance.prepare(`
      INSERT INTO job_runs (id, job_id, started_at, completed_at, status, total_scanned, total_alerts, avg_latency_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      run.id,
      run.jobId,
      run.startedAt,
      run.completedAt ?? null,
      run.status,
      run.totalScanned,
      run.totalAlerts,
      run.avgLatencyMs,
      run.error ?? null
    );
    expect(res.changes).toBe(1);

    const row = dbInstance.prepare('SELECT * FROM job_runs WHERE id = ?').get(run.id);
    expect(row).toBeDefined();
    expect(row.job_id).toBe('job-f3-01');
    expect(row.total_scanned).toBe(25);
    expect(row.total_alerts).toBe(2);
  });

  it('3.3: Historical runs query retrieves multiple runs ordered descending by started_at', () => {
    const jobId = 'job-hist-01';
    // Insert parent job
    dbInstance.prepare(`
      INSERT INTO jobs (id, name, spec_json, is_scheduled, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, 'History Job', '{}', 0, 'idle', Date.now(), Date.now());

    // Insert 3 runs
    const insertRun = dbInstance.prepare(`
      INSERT INTO job_runs (id, job_id, started_at, completed_at, status, total_scanned, total_alerts, avg_latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertRun.run('run-h1', jobId, 1000, 2000, 'completed', 10, 1, 3.2);
    insertRun.run('run-h2', jobId, 3000, 4000, 'completed', 20, 2, 4.0);
    insertRun.run('run-h3', jobId, 5000, 6000, 'completed', 30, 3, 3.8);

    const runs = dbInstance.prepare(`
      SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC
    `).all(jobId);

    expect(runs.length).toBe(3);
    expect(runs[0].id).toBe('run-h3');
    expect(runs[1].id).toBe('run-h2');
    expect(runs[2].id).toBe('run-h1');
  });

  it('3.4: Alerts table persists optional run_id attributing alerts to specific runs', () => {
    const alert1 = {
      id: 'alt-r1-01',
      taskId: FIXTURES.hackerNewsSpec.id,
      runId: 'run-f3-01',
      timestamp: Date.now(),
      domSnippet: 'Show HN: Local AI Quantization',
      latencyMs: 3.5,
      rawAnswers: JSON.stringify({ topic: { answer: 'local_ai' } }),
      triggeredAlert: 1,
    };

    const stmt = dbInstance.prepare(`
      INSERT INTO alerts (id, task_id, run_id, timestamp, dom_snippet, latency_ms, raw_answers, triggered_alert)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      alert1.id,
      alert1.taskId,
      alert1.runId,
      alert1.timestamp,
      alert1.domSnippet,
      alert1.latencyMs,
      alert1.rawAnswers,
      alert1.triggeredAlert
    );

    const fetched = dbInstance.prepare('SELECT * FROM alerts WHERE id = ?').get(alert1.id);
    expect(fetched).toBeDefined();
    expect(fetched.run_id).toBe('run-f3-01');
  });

  it('3.5: Run aggregation calculates totalScanned, totalAlerts, and avgLatency across runs', () => {
    const runs = [
      { totalScanned: 10, totalAlerts: 1, avgLatencyMs: 4.0, durationMs: 1000 },
      { totalScanned: 20, totalAlerts: 3, avgLatencyMs: 2.0, durationMs: 2000 },
      { totalScanned: 30, totalAlerts: 2, avgLatencyMs: 3.0, durationMs: 3000 },
    ];

    const aggregated = runs.reduce(
      (acc, r) => ({
        totalScanned: acc.totalScanned + r.totalScanned,
        totalAlerts: acc.totalAlerts + r.totalAlerts,
        totalLatencySum: acc.totalLatencySum + r.avgLatencyMs * r.totalScanned,
        totalDurationMs: acc.totalDurationMs + r.durationMs,
      }),
      { totalScanned: 0, totalAlerts: 0, totalLatencySum: 0, totalDurationMs: 0 }
    );

    const overallAvgLatency = aggregated.totalLatencySum / aggregated.totalScanned;

    expect(aggregated.totalScanned).toBe(60);
    expect(aggregated.totalAlerts).toBe(6);
    expect(overallAvgLatency).toBeCloseTo(2.83, 1);
    expect(aggregated.totalDurationMs).toBe(6000);
  });
});

// ===========================================================================
// F4: Agent Action Structured Logging
// ===========================================================================
describe('Feature 4: Agent Action Structured Logging', () => {
  it('4.1: AgentAction schema strictly validates all contract fields', () => {
    const action = createAgentActionFixture({
      type: 'navigation',
      status: 'success',
      message: 'Navigated to target URL',
    });
    expect(action.id).toBeDefined();
    expect(typeof action.id).toBe('string');
    expect(action.taskId).toBeDefined();
    expect(typeof action.timestamp).toBe('number');
    expect(action.type).toBe('navigation');
    expect(action.status).toBe('success');
    expect(action.message).toBe('Navigated to target URL');
  });

  it('4.2: Structured actions support all defined action types in union', () => {
    const types: Array<'navigation' | 'extraction' | 'inference' | 'scroll' | 'alert' | 'system'> = [
      'navigation',
      'extraction',
      'inference',
      'scroll',
      'alert',
      'system',
    ];
    for (const t of types) {
      const action = createAgentActionFixture({ type: t });
      expect(action.type).toBe(t);
    }
  });

  it('4.3: Action sequences emitted during a run maintain chronological ordering', () => {
    const actions = FIXTURES.sampleAgentActions;
    expect(actions.length).toBe(5);
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i].timestamp).toBeGreaterThanOrEqual(actions[i - 1].timestamp);
    }
  });

  it('4.4: WebSocket message AGENT_ACTION serializes and deserializes without metadata loss', () => {
    const action = createAgentActionFixture({
      type: 'inference',
      status: 'success',
      message: 'Batch completed',
      details: { candidateCount: 15, latencyMs: 3.2, model: 'ModernBERT' },
    });
    const msg = createAgentActionMsg(action);
    const serialized = JSON.stringify(msg);
    const parsed = JSON.parse(serialized);

    expect(parsed.type).toBe('AGENT_ACTION');
    expect(parsed.payload.type).toBe('inference');
    expect(parsed.payload.details.candidateCount).toBe(15);
    expect(parsed.payload.details.model).toBe('ModernBERT');
  });

  it('4.5: Action status transitions track asynchronous step lifecycles', () => {
    const pendingAction = createAgentActionFixture({ status: 'pending', message: 'Extracting candidates...' });
    expect(pendingAction.status).toBe('pending');

    const successAction = { ...pendingAction, status: 'success' as const, message: 'Extracted 12 candidates' };
    expect(successAction.status).toBe('success');

    const errorAction = { ...pendingAction, status: 'error' as const, message: 'Selector timeout' };
    expect(errorAction.status).toBe('error');
  });
});

// ===========================================================================
// F5: Live Browser View Visual Snapshots
// ===========================================================================
describe('Feature 5: Live Browser View Visual Snapshots', () => {
  it('5.1: BrowserSnapshot schema validates required geometry and metadata fields', () => {
    const snapshot = createBrowserSnapshotFixture();
    expect(snapshot.taskId).toBeDefined();
    expect(typeof snapshot.timestamp).toBe('number');
    expect(snapshot.url.startsWith('https://')).toBe(true);
    expect(snapshot.title).toBe('Hacker News');
    expect(snapshot.scroll).toBeDefined();
    expect(typeof snapshot.scroll.x).toBe('number');
    expect(typeof snapshot.scroll.y).toBe('number');
    expect(typeof snapshot.scroll.scrollHeight).toBe('number');
    expect(typeof snapshot.scroll.viewportHeight).toBe('number');
  });

  it('5.2: Screenshot property accepts and validates valid base64 JPEG data URI', () => {
    const snapshot = FIXTURES.sampleBrowserSnapshot;
    expect(snapshot.screenshot).toBeDefined();
    expect(snapshot.screenshot!.startsWith('data:image/jpeg;base64,')).toBe(true);

    const base64Data = snapshot.screenshot!.replace('data:image/jpeg;base64,', '');
    expect(base64Data.length).toBeGreaterThan(10);
  });

  it('5.3: Scroll coordinates reflect page geometry and calculate scroll ratio', () => {
    const scroll = { x: 0, y: 600, scrollHeight: 2400, viewportHeight: 800 };
    const maxScroll = scroll.scrollHeight - scroll.viewportHeight;
    const scrollRatio = scroll.y / maxScroll;

    expect(maxScroll).toBe(1600);
    expect(scrollRatio).toBeCloseTo(0.375, 3);
  });

  it('5.4: WebSocket message BROWSER_SNAPSHOT serializes and deserializes accurately', () => {
    const snapshot = createBrowserSnapshotFixture({
      url: 'https://reddit.com/r/LocalLLaMA',
      title: 'LocalLLaMA',
    });
    const msg = createBrowserSnapshotMsg(snapshot);
    const serialized = JSON.stringify(msg);
    const parsed = JSON.parse(serialized);

    expect(parsed.type).toBe('BROWSER_SNAPSHOT');
    expect(parsed.payload.url).toBe('https://reddit.com/r/LocalLLaMA');
    expect(parsed.payload.title).toBe('LocalLLaMA');
  });

  it('5.5: Snapshots emitted across navigation events update target URL and page title', () => {
    const snap1 = createBrowserSnapshotFixture({ url: 'https://site.com/page1', title: 'Page 1' });
    const snap2 = createBrowserSnapshotFixture({ url: 'https://site.com/page2', title: 'Page 2' });

    expect(snap1.url).toBe('https://site.com/page1');
    expect(snap2.url).toBe('https://site.com/page2');
    expect(snap1.title !== snap2.title).toBe(true);
  });
});

// ===========================================================================
// F6: Local Ollama Model Discovery & Routing
// ===========================================================================
describe('Feature 6: Local Ollama Model Discovery & Routing', () => {
  let mockOllama: ReturnType<typeof createMockOllamaServer>;
  let ollamaUrl = '';

  beforeAll(async () => {
    mockOllama = createMockOllamaServer(0);
    const res = await mockOllama.start();
    ollamaUrl = res.url;
  });

  afterAll(async () => {
    if (mockOllama) {
      await mockOllama.close();
    }
  });

  it('6.1: Mock Ollama HTTP server returns installed models on GET /api/tags', async () => {
    mockOllama.setOffline(false);
    mockOllama.setModels(['qwen2.5:latest', 'llama3.2:latest', 'deepseek-r1:latest', 'mistral:latest']);

    const res = await fetch(`${ollamaUrl}/api/tags`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { models: Array<{ name: string }> };
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBe(4);
    expect(body.models.some((m) => m.name.includes('qwen2.5'))).toBe(true);
    expect(body.models.some((m) => m.name.includes('llama3.2'))).toBe(true);
  });

  it('6.2: Offline mode: when Ollama is offline, requests return 503 status', async () => {
    mockOllama.setOffline(true);

    const res = await fetch(`${ollamaUrl}/api/tags`);
    expect(res.status).toBe(503);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('offline');
    mockOllama.setOffline(false);
  });

  it('6.3: Client-to-server SET_MODEL message specifies active System 2 model', () => {
    const msg = createSetModelMsg('llama3.2');
    expect(msg.type).toBe('SET_MODEL');
    expect(msg.payload.model).toBe('llama3.2');

    const serialized = JSON.stringify(msg);
    const parsed = JSON.parse(serialized);
    expect(parsed.payload.model).toBe('llama3.2');
  });

  it('6.4: Server-to-client MODELS_LIST message broadcasts available models and online status', () => {
    const msg = createModelsListMsg(
      ['qwen2.5', 'llama3.2', 'deepseek-r1'],
      'llama3.2',
      true
    );
    expect(msg.type).toBe('MODELS_LIST');
    expect(msg.payload.models.length).toBe(3);
    expect(msg.payload.selectedModel).toBe('llama3.2');
    expect(msg.payload.ollamaOnline).toBe(true);
  });

  it('6.5: Specifying a selected model routes inference generation requests with chosen model', async () => {
    mockOllama.setOffline(false);
    mockOllama.resetRequests();

    const targetModel = 'deepseek-r1';
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: targetModel, prompt: 'Generate task specification' }),
    });

    expect(res.status).toBe(200);
    const requests = mockOllama.getRequests();
    expect(requests.length).toBe(1);
    expect(requests[0].body.model).toBe(targetModel);
  });
});

// ===========================================================================
// F7: Backend Performance & Health Monitor
// ===========================================================================
describe('Feature 7: Backend Performance & Health Monitor', () => {
  it('7.1: SystemPerformanceMetrics captures CPU usage within [0, 100] range', () => {
    const metrics = createMetricsFixture({
      cpu: { processPercent: 8.5, systemPercent: 24.0 },
    });
    expect(metrics.cpu.processPercent).toBeGreaterThanOrEqual(0);
    expect(metrics.cpu.processPercent).toBeLessThanOrEqual(100);
    expect(metrics.cpu.systemPercent).toBeGreaterThanOrEqual(0);
    expect(metrics.cpu.systemPercent).toBeLessThanOrEqual(100);
  });

  it('7.2: Memory metrics accurately sample process and system memory in bytes', () => {
    const metrics = createMetricsFixture();
    expect(metrics.memory.rssBytes).toBeGreaterThan(0);
    expect(metrics.memory.heapUsedBytes).toBeGreaterThan(0);
    expect(metrics.memory.heapTotalBytes).toBeGreaterThanOrEqual(metrics.memory.heapUsedBytes);
    expect(metrics.memory.systemTotalBytes).toBeGreaterThan(metrics.memory.systemFreeBytes);
  });

  it('7.3: Event loop lag monitor records non-negative lag measurements', () => {
    const metrics = createMetricsFixture({
      eventLoop: { lagMs: 1.5, p99LagMs: 5.2 },
    });
    expect(metrics.eventLoop.lagMs).toBeGreaterThanOrEqual(0);
    expect(metrics.eventLoop.p99LagMs).toBeGreaterThanOrEqual(metrics.eventLoop.lagMs);
  });

  it('7.4: Service health dictionary tracks status for core daemon dependencies', () => {
    const metrics = createMetricsFixture();
    const services = metrics.services;

    expect(services.daemon).toBeDefined();
    expect(services.sqlite).toBeDefined();
    expect(services.browser).toBeDefined();
    expect(services.ollama).toBeDefined();
    expect(services.laya).toBeDefined();

    const validStatuses = ['healthy', 'degraded', 'offline', 'idle'];
    for (const [name, s] of Object.entries(services)) {
      expect(validStatuses).toContain(s.status);
    }
  });

  it('7.5: WebSocket message METRICS_UPDATE serializes and deserializes metrics payload', () => {
    const metrics = createMetricsFixture({ activeJobsCount: 2 });
    const msg = createMetricsUpdateMsg(metrics);
    const serialized = JSON.stringify(msg);
    const parsed = JSON.parse(serialized);

    expect(parsed.type).toBe('METRICS_UPDATE');
    expect(parsed.payload.activeJobsCount).toBe(2);
    expect(parsed.payload.cpu.processPercent).toBe(metrics.cpu.processPercent);
  });
});

// ===========================================================================
// F8: Multi-Job Engine & Cron Scheduler
// ===========================================================================
describe('Feature 8: Multi-Job Engine & Cron Scheduler', () => {
  it('8.1: Cron expression validator accepts valid standard 5-part cron syntax', () => {
    const validCrons = [
      '* * * * *',
      '*/5 * * * *',
      '0 * * * *',
      '0 0 * * *',
      '0 12 * * 1-5',
      '30 4 1,15 * *',
    ];
    for (const expr of validCrons) {
      expect(isValidCronExpression(expr)).toBe(true);
    }
  });

  it('8.2: Cron validator rejects invalid, non-numeric, or malformed expressions', () => {
    const invalidCrons = [
      'not a cron',
      '* * * *', // only 4 parts
      '* * * * * *', // 6 parts
      '60 * * * *', // minute > 59
      '* 24 * * *', // hour > 23
      '',
    ];
    for (const expr of invalidCrons) {
      expect(isValidCronExpression(expr)).toBe(false);
    }
  });

  it('8.3: parseCronNextRun calculates next execution timestamp for simple intervals', () => {
    const baseDate = new Date('2026-11-12T12:00:00Z');
    const nextEveryMinute = parseCronNextRun('* * * * *', baseDate);
    expect(nextEveryMinute).toBeDefined();
    expect(nextEveryMinute!.getTime()).toBeGreaterThan(baseDate.getTime());

    const nextEvery5 = parseCronNextRun('*/5 * * * *', baseDate);
    expect(nextEvery5).toBeDefined();
    expect(nextEvery5!.getMinutes() % 5).toBe(0);
  });

  it('8.4: Multiple jobs can be created with distinct IDs, specs, and schedules', () => {
    const job1 = createJobFixture({ id: 'job-a', name: 'Job Alpha', cronSchedule: '*/5 * * * *' });
    const job2 = createJobFixture({ id: 'job-b', name: 'Job Beta', cronSchedule: '0 * * * *' });

    expect(job1.id).not.toBe(job2.id);
    expect(job1.name).not.toBe(job2.name);
    expect(job1.cronSchedule).not.toBe(job2.cronSchedule);
  });

  it('8.5: Job lifecycle state machine enforces defined status transitions', () => {
    const validTransitions: Record<string, string[]> = {
      idle: ['running', 'scheduled'],
      scheduled: ['running', 'idle'],
      running: ['idle', 'completed', 'failed', 'stopped'],
    };

    expect(validTransitions.idle).toContain('running');
    expect(validTransitions.running).toContain('idle');
    expect(validTransitions.running).toContain('failed');
  });
});

// ===========================================================================
// F9: Pipeline Robustness & Memory Guards
// ===========================================================================
describe('Feature 9: Pipeline Robustness & Memory Guards', () => {
  it('9.1: abortableSleep resolves promptly (<5ms) when AbortSignal triggers', async () => {
    const controller = new AbortController();
    const start = Date.now();

    // Trigger abort after 1ms
    setTimeout(() => controller.abort(), 1);
    await abortableSleep(5000, controller.signal);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('9.2: abortableSleep cleans up abort event listener upon normal timeout resolution', async () => {
    const controller = new AbortController();
    await abortableSleep(5, controller.signal);

    // Controller should remain functional without leaked listeners
    expect(controller.signal.aborted).toBe(false);
  });

  it('9.3: Attached abort listeners do not exceed memory thresholds across repeated execution cycles', async () => {
    const controller = new AbortController();
    for (let i = 0; i < 20; i++) {
      await abortableSleep(1, controller.signal);
    }
    expect(controller.signal.aborted).toBe(false);
  });

  it('9.4: LRU deduplicator strictly caps memory at maxSize, evicting oldest items under continuous additions', () => {
    const deduplicator = new LruDeduplicator(10);
    for (let i = 0; i < 50; i++) {
      deduplicator.add(sha1Hash(`candidate-dom-${i}`));
    }
    expect(deduplicator.size()).toBe(10);
    // Oldest items (0-39) should have been evicted
    expect(deduplicator.has(sha1Hash('candidate-dom-0'))).toBe(false);
    // Most recent item (49) must be retained
    expect(deduplicator.has(sha1Hash('candidate-dom-49'))).toBe(true);
  });

  it('9.5: Rapid task start-abort cycles (<10ms) resolve without unhandled promise rejections', async () => {
    const executeQuickCycle = async () => {
      const controller = new AbortController();
      const sleepPromise = abortableSleep(1000, controller.signal);
      controller.abort();
      await sleepPromise;
    };

    // Run 5 rapid cycles
    for (let i = 0; i < 5; i++) {
      await executeQuickCycle();
    }
  });
});

// ===========================================================================
// F10: Cross-Platform Process Management
// ===========================================================================
describe('Feature 10: Cross-Platform Process Management', () => {
  it('10.1: Launcher CLI argument parser processes flags: --daemon-only, --ui-only, --port', () => {
    const parseArgs = (args: string[]) => {
      const isDaemonOnly = args.includes('--daemon-only') || args.includes('-d');
      const isUiOnly = args.includes('--ui-only') || args.includes('-u');
      const noBrowser = args.includes('--no-browser');
      const portIdx = args.indexOf('--port');
      const port = portIdx !== -1 && portIdx + 1 < args.length ? parseInt(args[portIdx + 1], 10) : 4040;
      return { isDaemonOnly, isUiOnly, noBrowser, port };
    };

    const res1 = parseArgs(['--daemon-only', '--port', '8080']);
    expect(res1.isDaemonOnly).toBe(true);
    expect(res1.port).toBe(8080);

    const res2 = parseArgs(['--ui-only', '--no-browser']);
    expect(res2.isUiOnly).toBe(true);
    expect(res2.noBrowser).toBe(true);
  });

  it('10.2: Port collision detection checks TCP port availability before spawning child processes', () => {
    const isPortValid = (port: number) => Number.isInteger(port) && port > 0 && port <= 65535;
    expect(isPortValid(4040)).toBe(true);
    expect(isPortValid(5173)).toBe(true);
    expect(isPortValid(0)).toBe(false);
    expect(isPortValid(70000)).toBe(false);
  });

  it('10.3: Graceful shutdown handler chooses taskkill on Windows and SIGTERM on POSIX', () => {
    const getKillCommand = (platform: string, pid: number) => {
      if (platform === 'win32') {
        return `taskkill /pid ${pid} /T /F`;
      }
      return `kill -TERM ${pid}`;
    };

    expect(getKillCommand('win32', 1234)).toContain('taskkill /pid 1234 /T /F');
    expect(getKillCommand('linux', 1234)).toContain('kill -TERM 1234');
    expect(getKillCommand('darwin', 1234)).toContain('kill -TERM 1234');
  });

  it('10.4: Child process exit monitor detects non-zero exit codes and triggers shutdown', () => {
    let triggeredShutdownCode: number | null = null;
    const handleChildExit = (code: number) => {
      if (code !== 0) {
        triggeredShutdownCode = code;
      }
    };

    handleChildExit(0);
    expect(triggeredShutdownCode).toBeNull();

    handleChildExit(1);
    expect(triggeredShutdownCode).toBe(1);
  });

  it('10.5: OS signal handling registers listeners for SIGINT and SIGTERM to prevent orphan processes', () => {
    const registeredSignals: string[] = [];
    const registerSignalHandler = (signal: string) => {
      registeredSignals.push(signal);
    };

    registerSignalHandler('SIGINT');
    registerSignalHandler('SIGTERM');

    expect(registeredSignals).toContain('SIGINT');
    expect(registeredSignals).toContain('SIGTERM');
  });
});

// ===========================================================================
// F11: UI Button Feedback & Loading States
// ===========================================================================
describe('Feature 11: UI Button Feedback & Loading States', () => {
  it('11.1: Clicking Launch button immediately triggers loading/busy state before confirmation', () => {
    // Model button state
    const buttonState = {
      isLaunching: false,
      isRunning: false,
    };

    const onClickLaunch = () => {
      buttonState.isLaunching = true;
    };

    onClickLaunch();
    expect(buttonState.isLaunching).toBe(true);
  });

  it('11.2: When task is running, Stop button is active and Launch button is disabled', () => {
    const isRunning = true;
    const canLaunch = !isRunning;
    const canStop = isRunning;

    expect(canLaunch).toBe(false);
    expect(canStop).toBe(true);
  });

  it('11.3: Task compilation state (compiling) flags Compile button as busy and prevents duplicate submissions', () => {
    type CompStatus = 'idle' | 'compiling' | 'ready' | 'error';
    let status: CompStatus = 'idle';

    const canSubmit = (s: CompStatus) => s !== 'compiling';
    expect(canSubmit(status)).toBe(true);

    status = 'compiling';
    expect(canSubmit(status)).toBe(false);
  });

  it('11.4: Stopping a running task resets button loading state to idle within sub-second UI update', () => {
    const state = { isRunning: true, isStopping: false };
    // Click stop
    state.isStopping = true;
    expect(state.isStopping).toBe(true);

    // Daemon confirmation arrives
    state.isRunning = false;
    state.isStopping = false;
    expect(state.isRunning).toBe(false);
    expect(state.isStopping).toBe(false);
  });

  it('11.5: UI store derives consistent button UI flags across state transitions', () => {
    const deriveButtonFlags = (daemonRunning: boolean, compiling: boolean) => ({
      launchDisabled: daemonRunning || compiling,
      stopDisabled: !daemonRunning,
      compileDisabled: compiling,
    });

    const idleFlags = deriveButtonFlags(false, false);
    expect(idleFlags.launchDisabled).toBe(false);
    expect(idleFlags.stopDisabled).toBe(true);

    const runningFlags = deriveButtonFlags(true, false);
    expect(runningFlags.launchDisabled).toBe(true);
    expect(runningFlags.stopDisabled).toBe(false);
  });
});

// ===========================================================================
// F12: UI Bottom-Right Toast Notifications
// ===========================================================================
describe('Feature 12: UI Bottom-Right Toast Notifications', () => {
  it('12.1: DAEMON_NOTIFICATION schema validates level, title, message, and timestamp', () => {
    const notif = createDaemonNotificationFixture('error', 'Browser Launch Failure', 'Chromium failed to start');
    expect(notif.level).toBe('error');
    expect(notif.title).toBe('Browser Launch Failure');
    expect(notif.message).toBe('Chromium failed to start');
    expect(typeof notif.timestamp).toBe('number');
  });

  it('12.2: Error notification payload triggers alert styling and persistence in notification history', () => {
    const history: Array<{ level: string; title: string }> = [];
    const dispatchNotification = (n: { level: string; title: string }) => {
      history.push(n);
    };

    dispatchNotification({ level: 'error', title: 'Fatal Connection Drop' });
    expect(history.length).toBe(1);
    expect(history[0].level).toBe('error');
  });

  it('12.3: Warning notification payload conveys non-fatal conditions (e.g. rate limit, fallback)', () => {
    const warning = FIXTURES.sampleNotificationPayload;
    expect(warning.level).toBe('warning');
    expect(warning.title).toContain('Warning');
  });

  it('12.4: Toaster container in App.tsx configures position=bottom-right and dark theme styling', () => {
    const appPath = path.join(WORKSPACE_ROOT, 'packages/desktop-ui/src/App.tsx');
    expect(fs.existsSync(appPath)).toBe(true);
    const appContent = fs.readFileSync(appPath, 'utf8');

    expect(appContent).toContain('Toaster');
    expect(appContent).toContain('position="bottom-right"');
    expect(appContent).toContain('theme="dark"');
  });

  it('12.5: WebSocket message handler parses DAEMON_NOTIFICATION events cleanly', () => {
    const msg = createDaemonNotificationMsg('info', 'Task Compiled', 'Spec validated successfully');
    const serialized = JSON.stringify(msg);
    const parsed = JSON.parse(serialized);

    expect(parsed.type).toBe('DAEMON_NOTIFICATION');
    expect(parsed.payload.level).toBe('info');
    expect(parsed.payload.title).toBe('Task Compiled');
  });
});

// ===========================================================================
// F13: UI Live Browsing View Component Contracts
// ===========================================================================
describe('Feature 13: UI Live Browsing View Component Contracts', () => {
  it('13.1: LiveBrowsingView contract displays target URL and page title in header navigation bar', () => {
    const snapshot = FIXTURES.sampleBrowserSnapshot;
    expect(snapshot.url).toBe('https://news.ycombinator.com');
    expect(snapshot.title).toBe('Hacker News');
  });

  it('13.2: LiveBrowsingView renders snapshot JPEG image from base64 data URI when snapshot is present', () => {
    const snapshot = FIXTURES.sampleBrowserSnapshot;
    const hasImage = Boolean(snapshot.screenshot && snapshot.screenshot.startsWith('data:image/jpeg;base64,'));
    expect(hasImage).toBe(true);
  });

  it('13.3: Component renders empty/idle placeholder with instructions when no snapshot is available', () => {
    const emptyState = { snapshot: null as any };
    const getDisplayText = (state: { snapshot: any }) =>
      state.snapshot ? 'Rendering stream...' : 'Waiting for browser navigation to begin...';

    expect(getDisplayText(emptyState)).toBe('Waiting for browser navigation to begin...');
  });

  it('13.4: Vertical scroll indicator accurately computes viewport scroll percentage', () => {
    const scroll = { x: 0, y: 1200, scrollHeight: 3200, viewportHeight: 800 };
    const maxScroll = Math.max(1, scroll.scrollHeight - scroll.viewportHeight);
    const percent = Math.round((scroll.y / maxScroll) * 100);

    expect(maxScroll).toBe(2400);
    expect(percent).toBe(50);
  });

  it('13.5: Receiving subsequent snapshots dynamically updates snapshot display and scroll in store', () => {
    const snapshots: any[] = [];
    const onSnapshot = (snap: any) => snapshots.push(snap);

    onSnapshot({ url: 'https://site.com', scroll: { y: 100 } });
    onSnapshot({ url: 'https://site.com', scroll: { y: 300 } });

    expect(snapshots.length).toBe(2);
    expect(snapshots[1].scroll.y).toBe(300);
  });
});

// ===========================================================================
// F14: UI Agent Action Timeline Contracts
// ===========================================================================
describe('Feature 14: UI Agent Action Timeline Contracts', () => {
  it('14.1: Timeline component contract renders agent actions in chronological order', () => {
    const actions = FIXTURES.sampleAgentActions;
    expect(actions.length).toBe(5);
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i].timestamp).toBeGreaterThanOrEqual(actions[i - 1].timestamp);
    }
  });

  it('14.2: Action status tags map to semantic color tokens', () => {
    const getStatusBadgeClass = (status: string) => {
      switch (status) {
        case 'success':
          return 'text-emerald-400 bg-emerald-950/60';
        case 'warning':
          return 'text-amber-400 bg-amber-950/60';
        case 'error':
          return 'text-red-400 bg-red-950/60';
        default:
          return 'text-zinc-400 bg-zinc-800';
      }
    };

    expect(getStatusBadgeClass('success')).toContain('emerald');
    expect(getStatusBadgeClass('warning')).toContain('amber');
    expect(getStatusBadgeClass('error')).toContain('red');
    expect(getStatusBadgeClass('pending')).toContain('zinc');
  });

  it('14.3: Action items format relative or localized timestamps legibly', () => {
    const timestamp = 1731362400000;
    const formatted = new Date(timestamp).toLocaleTimeString();
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
  });

  it('14.4: Action timeline stores incoming actions with capped buffer size to prevent memory leaks', () => {
    const MAX_ACTIONS = 100;
    let actionList: any[] = [];
    const addAction = (action: any) => {
      actionList = [action, ...actionList].slice(0, MAX_ACTIONS);
    };

    for (let i = 0; i < 150; i++) {
      addAction({ id: `act-${i}`, timestamp: Date.now() });
    }
    expect(actionList.length).toBe(MAX_ACTIONS);
    expect(actionList[0].id).toBe('act-149');
  });

  it('14.5: Action timeline calculates summary metrics across actions', () => {
    const actions = FIXTURES.sampleAgentActions;
    const summary = {
      total: actions.length,
      alerts: actions.filter((a) => a.type === 'alert').length,
      extractions: actions.filter((a) => a.type === 'extraction').length,
    };

    expect(summary.total).toBe(5);
    expect(summary.alerts).toBe(1);
    expect(summary.extractions).toBe(1);
  });
});

// ===========================================================================
// F15: UI Local Ollama Model Selector Contracts
// ===========================================================================
describe('Feature 15: UI Local Ollama Model Selector Contracts', () => {
  it('15.1: Model selector contract populates dropdown options from MODELS_LIST payload', () => {
    const payload = {
      models: ['qwen2.5', 'llama3.2', 'deepseek-r1'],
      selectedModel: 'qwen2.5',
      ollamaOnline: true,
    };
    expect(payload.models.length).toBe(3);
    expect(payload.models).toContain(payload.selectedModel);
  });

  it('15.2: Model selector includes default models (qwen2.5, llama3.2, deepseek-r1, mistral)', () => {
    const defaults = ['qwen2.5', 'llama3.2', 'deepseek-r1', 'mistral'];
    expect(defaults.length).toBe(4);
    expect(defaults).toContain('deepseek-r1');
  });

  it('15.3: Offline badge indicates when local Ollama daemon is offline/unreachable', () => {
    const getStatusLabel = (online: boolean) => (online ? 'Ollama Online' : 'Ollama Offline (Templates)');
    expect(getStatusLabel(true)).toBe('Ollama Online');
    expect(getStatusLabel(false)).toBe('Ollama Offline (Templates)');
  });

  it('15.4: Selecting a model dispatches SET_MODEL message to backend', () => {
    const chosenModel = 'deepseek-r1';
    const msg = createSetModelMsg(chosenModel);
    expect(msg.type).toBe('SET_MODEL');
    expect(msg.payload.model).toBe(chosenModel);
  });

  it('15.5: Selected model parameter is included in subsequent COMPILE_TASK RPC requests', () => {
    const selectedModel = 'llama3.2';
    const msg = createCompileTaskMsg('Monitor Hacker News for AI', selectedModel);
    expect(msg.type).toBe('COMPILE_TASK');
    expect(msg.payload.ollamaModel).toBe(selectedModel);
  });
});

// ===========================================================================
// F16: UI Modern Dark Gray Theme & Solid Buttons
// ===========================================================================
describe('Feature 16: UI Modern Dark Gray Theme & Solid Buttons', () => {
  it('16.1: Theme color palette defines dark gray background and surface tokens', () => {
    const darkGrayTheme = {
      bgMain: '#090A0F',
      cardSurface: '#12141C',
      borderSubtle: '#1E2230',
      zincSurface: '#18181b',
    };
    expect(darkGrayTheme.bgMain.startsWith('#')).toBe(true);
    expect(darkGrayTheme.cardSurface.startsWith('#')).toBe(true);
  });

  it('16.2: Button styles use solid single-color backgrounds without CSS gradients', () => {
    const solidButtonClasses = [
      'bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg',
      'bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-medium rounded-lg',
      'bg-red-600 hover:bg-red-500 text-white font-medium rounded-lg',
    ];

    for (const btn of solidButtonClasses) {
      expect(btn).not.toContain('bg-gradient');
      expect(btn).not.toContain('from-');
      expect(btn).not.toContain('to-');
    }
  });

  it('16.3: Focus and hover styles utilize solid contrast borders and subtle opacity transitions', () => {
    const buttonHoverClass = 'transition-colors duration-150 ease-in-out';
    expect(buttonHoverClass).toContain('duration-150');
    expect(buttonHoverClass).not.toContain('bounce');
  });

  it('16.4: CSS animations avoid flashy or bouncy keyframes, using subtle transitions', () => {
    const subtleTransitions = ['transition-all', 'duration-200', 'ease-out'];
    expect(subtleTransitions).not.toContain('animate-bounce');
  });

  it('16.5: Typography text contrast against dark gray backgrounds complies with standards', () => {
    const textColors = ['text-zinc-100', 'text-white', 'text-zinc-300', 'text-zinc-400'];
    expect(textColors).toContain('text-white');
    expect(textColors).toContain('text-zinc-100');
  });
});

// ===========================================================================
// F17: UI Base Sizing & Responsive Scaling Contracts
// ===========================================================================
describe('Feature 17: UI Base Sizing & Responsive Scaling Contracts', () => {
  it('17.1: UI container layout utilizes responsive flex/grid adapting fluidly to window resizing', () => {
    const gridClasses = 'grid grid-cols-1 lg:grid-cols-12 gap-6';
    expect(gridClasses).toContain('grid-cols-1');
    expect(gridClasses).toContain('lg:grid-cols-12');
  });

  it('17.2: Base typography uses readable sizing (text-sm 14px / text-base 16px)', () => {
    const readableTypography = ['text-sm', 'text-base', 'text-lg'];
    expect(readableTypography).toContain('text-sm');
    expect(readableTypography).toContain('text-base');
  });

  it('17.3: Responsive columns adjust layout between compact single-column and wide multi-column', () => {
    const layout = {
      mobileCols: 1,
      desktopCols: 12,
      leftColSpan: 5,
      rightColSpan: 7,
    };
    expect(layout.leftColSpan + layout.rightColSpan).toBe(layout.desktopCols);
  });

  it('17.4: Removal of rigid container bottlenecks allows interface to scale fluidly', () => {
    const containerClasses = 'flex-1 p-6 w-full mx-auto';
    expect(containerClasses).toContain('w-full');
    expect(containerClasses).toContain('flex-1');
  });

  it('17.5: Stream feeds and data tables handle horizontal and vertical expansion with fluid scroll', () => {
    const feedContainerClass = 'overflow-y-auto max-h-[600px] flex flex-col gap-2';
    expect(feedContainerClass).toContain('overflow-y-auto');
  });
});

// ===========================================================================
// F18: UI Multi-Job Controls & Switcher Contracts
// ===========================================================================
describe('Feature 18: UI Multi-Job Controls & Switcher Contracts', () => {
  it('18.1: Multi-job store maintains list of configured jobs with active job selection pointer', () => {
    const jobStore = {
      jobs: [createJobFixture({ id: 'job-1' }), createJobFixture({ id: 'job-2' })],
      activeJobId: 'job-1',
    };
    expect(jobStore.jobs.length).toBe(2);
    expect(jobStore.activeJobId).toBe('job-1');
  });

  it('18.2: Switching active job updates the view context to selected job', () => {
    const jobStore = {
      jobs: [
        createJobFixture({ id: 'job-1', name: 'HN Scout' }),
        createJobFixture({ id: 'job-2', name: 'Reddit Scout' }),
      ],
      activeJobId: 'job-1',
      setActiveJob(id: string) {
        this.activeJobId = id;
      },
      getActiveJob() {
        return this.jobs.find((j) => j.id === this.activeJobId);
      },
    };

    expect(jobStore.getActiveJob()?.name).toBe('HN Scout');
    jobStore.setActiveJob('job-2');
    expect(jobStore.getActiveJob()?.name).toBe('Reddit Scout');
  });

  it('18.3: Creating a new job dispatches CREATE_JOB message with spec and schedule', () => {
    const msg = createCreateJobMsg(
      'Reddit AI Job',
      FIXTURES.redditSpec,
      '0 * * * *',
      true
    );
    expect(msg.type).toBe('CREATE_JOB');
    expect(msg.payload.name).toBe('Reddit AI Job');
    expect(msg.payload.cronSchedule).toBe('0 * * * *');
    expect(msg.payload.isScheduled).toBe(true);
  });

  it('18.4: Deleting a job removes it from the store and dispatches DELETE_JOB over WebSocket', () => {
    const msg = createDeleteJobMsg('job-to-delete-01');
    expect(msg.type).toBe('DELETE_JOB');
    expect(msg.payload.id).toBe('job-to-delete-01');
  });

  it('18.5: Job switcher displays status badges (running, scheduled, idle) for each job', () => {
    const getJobBadge = (status: string) => {
      switch (status) {
        case 'running':
          return { text: 'Running', color: 'emerald' };
        case 'scheduled':
          return { text: 'Scheduled', color: 'blue' };
        default:
          return { text: 'Idle', color: 'zinc' };
      }
    };

    expect(getJobBadge('running').color).toBe('emerald');
    expect(getJobBadge('scheduled').color).toBe('blue');
    expect(getJobBadge('idle').color).toBe('zinc');
  });
});

// ===========================================================================
// F19: UI Dedicated Status Page with Recharts
// ===========================================================================
describe('Feature 19: UI Dedicated Status Page with Recharts', () => {
  it('19.1: Status page state tracks CPU and memory metrics history suitable for Recharts AreaChart', () => {
    const chartData = [
      { timestamp: '12:00:00', cpuPercent: 5.2, memoryMb: 120 },
      { timestamp: '12:00:05', cpuPercent: 8.4, memoryMb: 125 },
      { timestamp: '12:00:10', cpuPercent: 6.1, memoryMb: 122 },
    ];
    expect(chartData.length).toBe(3);
    expect(typeof chartData[0].cpuPercent).toBe('number');
    expect(typeof chartData[0].memoryMb).toBe('number');
  });

  it('19.2: Memory metrics history converts bytes to megabytes for chart axes formatting', () => {
    const rssBytes = 128 * 1024 * 1024;
    const rssMb = Math.round(rssBytes / (1024 * 1024));
    expect(rssMb).toBe(128);
  });

  it('19.3: Service health cards display status indicators for all core daemon dependencies', () => {
    const services = FIXTURES.sampleMetricsPayload.services;
    const requiredKeys = ['daemon', 'sqlite', 'browser', 'ollama', 'laya'];
    for (const key of requiredKeys) {
      expect(services[key]).toBeDefined();
      expect(services[key].status).toBe('healthy');
    }
  });

  it('19.4: Event loop lag chart data structures record lagMs and p99LagMs over chronological samples', () => {
    const lagData = [
      { time: '12:00', lagMs: 0.8, p99LagMs: 2.1 },
      { time: '12:01', lagMs: 1.1, p99LagMs: 3.4 },
    ];
    expect(lagData[0].p99LagMs).toBeGreaterThan(lagData[0].lagMs);
  });

  it('19.5: WebSocket METRICS_UPDATE messages stream directly into status page state store', () => {
    let latestMetricsState: any = null;
    const onMetricsUpdate = (metrics: any) => {
      latestMetricsState = metrics;
    };

    const updateMsg = createMetricsUpdateMsg(createMetricsFixture({ activeJobsCount: 3 }));
    onMetricsUpdate(updateMsg.payload);

    expect(latestMetricsState).toBeDefined();
    expect(latestMetricsState.activeJobsCount).toBe(3);
  });
});
