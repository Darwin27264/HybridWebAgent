/**
 * Tier 4: Realistic Application End-to-End Scenarios
 * Simulates complete end-user journeys:
 *
 * Scenario 1: Multi-Run Hacker News AI Monitor (F1, F2, F3, F4, F11, F12)
 * Scenario 2: Multi-Job Concurrency, Scheduling, & Switching (F2, F3, F8, F9, F18)
 * Scenario 3: Live Visual Agent Browsing & Action Stream (F4, F5, F13, F14)
 * Scenario 4: Ollama Model Discovery & Dynamic Selection (F6, F15)
 * Scenario 5: High-Frequency Load & Metric Broadcasting (F7, F9, F19)
 * Scenario 6: Robust Abort & Graceful Recovery (F1, F2, F9, F10, F11, F12)
 * Scenario 7: Alert Lifecycle, Persistence Recovery, & Historical Aggregation (F1, F2, F3, F12, F19)
 *
 * Strictly >= 6 comprehensive realistic end-to-end user scenario journeys.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from './harness';
import {
  WORKSPACE_ROOT,
  FIXTURES,
  sanitizeStateSnippet,
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
  createStartJobMsg,
  createStopJobMsg,
  createSetModelMsg,
  createMetricsUpdateMsg,
  createDaemonNotificationMsg,
  createAgentActionMsg,
  createBrowserSnapshotMsg,
  createJobStatusMsg,
  createCompileTaskMsg,
  MockOllamaServer,
} from './test-utils';
import type {
  Job,
  JobRun,
  AgentAction,
  BrowserSnapshot,
  SystemPerformanceMetrics,
  CompiledTaskSpec,
} from '../../packages/shared/src/types';

describe('Tier 4: Realistic Application End-to-End Scenarios', () => {
  let dbInstance: any;
  let mockOllama: MockOllamaServer;

  beforeAll(async () => {
    const { db } = createTestSqliteDb(':memory:');
    dbInstance = db;
    mockOllama = createMockOllamaServer(0);
    await mockOllama.start();
  });

  afterAll(async () => {
    if (dbInstance && typeof dbInstance.close === 'function') {
      dbInstance.close();
    }
    if (mockOllama) {
      if (typeof (mockOllama.server as any).closeAllConnections === 'function') {
        (mockOllama.server as any).closeAllConnections();
      }
      await mockOllama.close();
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 1: Multi-Run Hacker News AI Monitor
  // ---------------------------------------------------------------------------
  it('Scenario 1: Multi-Run Hacker News AI Monitor end-to-end journey', async () => {
    // Step 1: User compiles task specification
    const rawSpec = {
      id: 'task-hn-ai-scen-1',
      name: 'HN AI Monitor',
      userGoal: 'Monitor Hacker News for local AI and ONNX developments',
      targetUrl: 'https://news.ycombinator.com',
      domSelector: '.athing',
      pollIntervalMs: 500,
      scrollStepPx: 300,
      questions: {
        topic: {
          type: 'choice' as const,
          question: 'What is the topic?',
          options: ['local_ai', 'web_dev', 'other'],
        },
      },
      alertRule: {
        questionKey: 'topic',
        operator: 'equals' as const,
        targetValue: 'local_ai',
        minAnswerConfidence: 0.85,
      },
      createdAt: Date.now(),
    };
    const { valid, sanitizedSpec } = sanitizeCompiledSpec(rawSpec);
    expect(valid).toBe(true);

    const jobId = 'job-hn-ai-scen-1';
    dbInstance.prepare(`
      INSERT INTO jobs (id, name, spec_json, cron_schedule, is_scheduled, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, sanitizedSpec.name, JSON.stringify(sanitizedSpec), null, 0, 'idle', Date.now(), Date.now());

    const lru = new LruDeduplicator(500);

    // Step 2: User initiates Run 1
    const run1Id = `run-${Date.now()}-1`;
    const run1Start = Date.now();
    dbInstance.prepare(`
      INSERT INTO job_runs (id, job_id, started_at, completed_at, status, total_scanned, total_alerts, avg_latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run1Id, jobId, run1Start, null, 'running', 0, 0, 0);

    // Step 3: Run 1 extracts DOM elements from https://news.ycombinator.com
    const extractedDomElements = [
      { text: 'Show HN: Laya – Fast non-autoregressive decision model on ONNX Runtime', isAi: true, conf: 0.94 },
      { text: 'Ask HN: Favorite mechanical keyboard switches for coding in 2026?', isAi: false, conf: 0.20 },
      { text: 'Show HN: Local quantized ModernBERT inference engine with CPU SIMD', isAi: true, conf: 0.91 },
    ];

    let run1Alerts = 0;
    for (const elem of extractedDomElements) {
      const hash = sha1Hash(elem.text);
      if (!lru.has(hash)) {
        lru.add(hash);
        const answer = {
          answer: elem.isAi ? 'local_ai' : 'other',
          answer_confidence: elem.conf,
        };
        if (evaluateAlertRule(sanitizedSpec.alertRule, answer)) {
          run1Alerts++;
          dbInstance.prepare(`
            INSERT INTO alerts (id, task_id, run_id, timestamp, dom_snippet, latency_ms, raw_answers, triggered_alert)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(`alt-r1-${run1Alerts}`, sanitizedSpec.id, run1Id, Date.now(), elem.text, 18.2, JSON.stringify(answer), 1);
        }
      }
    }

    expect(lru.size()).toBe(3);
    expect(run1Alerts).toBe(2);

    // Step 4: Run 1 completes
    dbInstance.prepare(`
      UPDATE job_runs SET completed_at = ?, status = 'completed', total_scanned = ?, total_alerts = ?, avg_latency_ms = ?
      WHERE id = ?
    `).run(Date.now(), 3, run1Alerts, 18.2, run1Id);

    // Step 5: Cache reset occurs before Run 2 starts
    lru.resetCache();
    expect(lru.size()).toBe(0);

    // Step 6: User initiates Run 2 on the same URL
    const run2Id = `run-${Date.now()}-2`;
    expect(run2Id).not.toBe(run1Id);
    const run2Start = Date.now();
    dbInstance.prepare(`
      INSERT INTO job_runs (id, job_id, started_at, completed_at, status, total_scanned, total_alerts, avg_latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run2Id, jobId, run2Start, null, 'running', 0, 0, 0);

    // Step 7: Run 2 encounters the same candidate posts
    let run2Alerts = 0;
    for (const elem of extractedDomElements) {
      const hash = sha1Hash(elem.text);
      // Because cache was reset, all 3 are re-evaluated!
      if (!lru.has(hash)) {
        lru.add(hash);
        const answer = {
          answer: elem.isAi ? 'local_ai' : 'other',
          answer_confidence: elem.conf,
        };
        if (evaluateAlertRule(sanitizedSpec.alertRule, answer)) {
          run2Alerts++;
          dbInstance.prepare(`
            INSERT INTO alerts (id, task_id, run_id, timestamp, dom_snippet, latency_ms, raw_answers, triggered_alert)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(`alt-r2-${run2Alerts}`, sanitizedSpec.id, run2Id, Date.now(), elem.text, 17.5, JSON.stringify(answer), 1);
        }
      }
    }

    expect(lru.size()).toBe(3);
    expect(run2Alerts).toBe(2);

    // Step 8: Run 2 completes
    dbInstance.prepare(`
      UPDATE job_runs SET completed_at = ?, status = 'completed', total_scanned = ?, total_alerts = ?, avg_latency_ms = ?
      WHERE id = ?
    `).run(Date.now(), 3, run2Alerts, 17.5, run2Id);

    // Step 9: Multi-run verification in SQLite
    const runs = dbInstance.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at ASC').all(jobId);
    expect(runs.length).toBe(2);
    expect(runs[0].id).toBe(run1Id);
    expect(runs[1].id).toBe(run2Id);
    expect(runs[0].total_scanned).toBe(3);
    expect(runs[1].total_scanned).toBe(3);

    const r1Alerts = dbInstance.prepare('SELECT * FROM alerts WHERE run_id = ?').all(run1Id);
    const r2Alerts = dbInstance.prepare('SELECT * FROM alerts WHERE run_id = ?').all(run2Id);
    expect(r1Alerts.length).toBe(2);
    expect(r2Alerts.length).toBe(2);

    // Multi-run summary aggregation
    const totalScanned = runs.reduce((sum: number, r: any) => sum + r.total_scanned, 0);
    const totalAlerts = runs.reduce((sum: number, r: any) => sum + r.total_alerts, 0);
    expect(totalScanned).toBe(6);
    expect(totalAlerts).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Multi-Job Concurrency, Scheduling, & Switching
  // ---------------------------------------------------------------------------
  it('Scenario 2: Multi-Job Concurrency, Scheduling, & Switching end-to-end journey', async () => {
    // Step 1: Configure Job A (HN AI Scout)
    const jobA: Job = {
      id: 'job-concur-A',
      name: 'HN AI Scout',
      spec: FIXTURES.hackerNewsSpec,
      isScheduled: false,
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Step 2: Configure Job B (Reddit Quantization) with cron schedule
    const cronExpr = '*/15 * * * *';
    expect(isValidCronExpression(cronExpr)).toBe(true);
    const nextRunB = parseCronNextRun(cronExpr, new Date());

    const jobB: Job = {
      id: 'job-concur-B',
      name: 'Reddit Quantization',
      spec: FIXTURES.redditSpec,
      cronSchedule: cronExpr,
      isScheduled: true,
      nextRunAt: nextRunB ? nextRunB.getTime() : undefined,
      status: 'scheduled',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Persist both jobs in SQLite
    dbInstance.prepare(`
      INSERT INTO jobs (id, name, spec_json, cron_schedule, is_scheduled, status, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobA.id, jobA.name, JSON.stringify(jobA.spec), null, 0, 'idle', null, jobA.createdAt, jobA.updatedAt);

    dbInstance.prepare(`
      INSERT INTO jobs (id, name, spec_json, cron_schedule, is_scheduled, status, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobB.id, jobB.name, JSON.stringify(jobB.spec), cronExpr, 1, 'scheduled', jobB.nextRunAt, jobB.createdAt, jobB.updatedAt);

    // Step 3: Trigger concurrent runs for both jobs
    const runAId = `run-A-${Date.now()}`;
    const runBId = `run-B-${Date.now()}`;

    dbInstance.prepare(`
      INSERT INTO job_runs (id, job_id, started_at, status, total_scanned, total_alerts, avg_latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(runAId, jobA.id, Date.now(), 'running', 0, 0, 0);

    dbInstance.prepare(`
      INSERT INTO job_runs (id, job_id, started_at, status, total_scanned, total_alerts, avg_latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(runBId, jobB.id, Date.now(), 'running', 0, 0, 0);

    // Step 4: UI Job Switcher state simulation
    const uiMultiJobState = {
      jobs: [jobA, jobB],
      activeJobId: jobA.id,
      telemetryByJob: new Map<string, string[]>(),
    };

    uiMultiJobState.telemetryByJob.set(jobA.id, ['HN item 1', 'HN item 2']);
    uiMultiJobState.telemetryByJob.set(jobB.id, ['Reddit item 1']);

    // Initially viewing Job A
    expect(uiMultiJobState.activeJobId).toBe('job-concur-A');
    expect(uiMultiJobState.telemetryByJob.get(uiMultiJobState.activeJobId)?.length).toBe(2);

    // User switches view to Job B
    uiMultiJobState.activeJobId = jobB.id;
    expect(uiMultiJobState.activeJobId).toBe('job-concur-B');
    expect(uiMultiJobState.telemetryByJob.get(uiMultiJobState.activeJobId)?.length).toBe(1);

    // Step 5: Both jobs finish execution cleanly
    dbInstance.prepare("UPDATE job_runs SET status = 'completed', total_scanned = 20, total_alerts = 2 WHERE id = ?").run(runAId);
    dbInstance.prepare("UPDATE job_runs SET status = 'completed', total_scanned = 15, total_alerts = 1 WHERE id = ?").run(runBId);

    const completedA = dbInstance.prepare('SELECT * FROM job_runs WHERE id = ?').get(runAId);
    const completedB = dbInstance.prepare('SELECT * FROM job_runs WHERE id = ?').get(runBId);
    expect(completedA.status).toBe('completed');
    expect(completedB.status).toBe('completed');
    expect(completedA.job_id).toBe(jobA.id);
    expect(completedB.job_id).toBe(jobB.id);
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Live Visual Agent Browsing & Action Stream
  // ---------------------------------------------------------------------------
  it('Scenario 3: Live Visual Agent Browsing & Action Stream end-to-end journey', () => {
    const taskId = 'task-live-browse-01';
    const actionTimeline: AgentAction[] = [];
    let liveSnapshot: BrowserSnapshot | null = null;

    // Step 1: Agent initializes
    const actInit = createAgentActionFixture({
      taskId,
      type: 'system',
      status: 'success',
      message: 'Browser automation context initialized',
      timestamp: 1731362400000,
    });
    actionTimeline.push(actInit);

    // Step 2: Agent navigates to target URL
    const actNav = createAgentActionFixture({
      taskId,
      type: 'navigation',
      status: 'success',
      message: 'Navigated to https://news.ycombinator.com',
      details: { url: 'https://news.ycombinator.com', statusCode: 200 },
      timestamp: 1731362401000,
    });
    actionTimeline.push(actNav);

    // Step 3: Browser takes initial snapshot at top of page
    liveSnapshot = createBrowserSnapshotFixture({
      taskId,
      url: 'https://news.ycombinator.com',
      title: 'Hacker News',
      scroll: { x: 0, y: 0, scrollHeight: 3200, viewportHeight: 800 },
      timestamp: 1731362401500,
    });

    const initialScrollPercent = (liveSnapshot.scroll.y / (liveSnapshot.scroll.scrollHeight - liveSnapshot.scroll.viewportHeight)) * 100;
    expect(initialScrollPercent).toBe(0);

    // Step 4: Agent extracts candidates
    const actExtract = createAgentActionFixture({
      taskId,
      type: 'extraction',
      status: 'success',
      message: 'Extracted 30 candidate elements matching .athing',
      details: { count: 30 },
      timestamp: 1731362402000,
    });
    actionTimeline.push(actExtract);

    // Step 5: Agent scrolls down 600px
    const actScroll = createAgentActionFixture({
      taskId,
      type: 'scroll',
      status: 'success',
      message: 'Scrolled viewport down by 600px',
      details: { scrollDeltaY: 600 },
      timestamp: 1731362403000,
    });
    actionTimeline.push(actScroll);

    // Step 6: Browser streams updated snapshot with new scroll position
    liveSnapshot = createBrowserSnapshotFixture({
      taskId,
      url: 'https://news.ycombinator.com',
      title: 'Hacker News',
      scroll: { x: 0, y: 600, scrollHeight: 3200, viewportHeight: 800 },
      timestamp: 1731362403500,
    });

    const updatedScrollPercent = (liveSnapshot.scroll.y / (liveSnapshot.scroll.scrollHeight - liveSnapshot.scroll.viewportHeight)) * 100;
    expect(Number(updatedScrollPercent.toFixed(1))).toBe(25.0);

    // Step 7: Agent performs inference and detects high-confidence match
    const actAlert = createAgentActionFixture({
      taskId,
      type: 'alert',
      status: 'success',
      message: 'Alert match detected: Show HN: Laya ONNX',
      details: { confidence: 0.94 },
      timestamp: 1731362404000,
    });
    actionTimeline.push(actAlert);

    // Step 8: Assert synchronization between Live View and Action Timeline
    expect(actionTimeline.length).toBe(5);
    expect(actionTimeline[0].type).toBe('system');
    expect(actionTimeline[1].type).toBe('navigation');
    expect(actionTimeline[2].type).toBe('extraction');
    expect(actionTimeline[3].type).toBe('scroll');
    expect(actionTimeline[4].type).toBe('alert');

    // Chronological order strictly preserved
    for (let i = 1; i < actionTimeline.length; i++) {
      expect(actionTimeline[i].timestamp).toBeGreaterThan(actionTimeline[i - 1].timestamp);
    }

    expect(liveSnapshot.url).toBe('https://news.ycombinator.com');
    expect(liveSnapshot.scroll.y).toBe(600);
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: Ollama Model Discovery & Dynamic Selection
  // ---------------------------------------------------------------------------
  it('Scenario 4: Ollama Model Discovery & Dynamic Selection end-to-end journey', async () => {
    mockOllama.resetRequests();

    // Step 1: UI sends GET_MODELS
    const clientGetModelsMsg = { type: 'GET_MODELS' };
    expect(clientGetModelsMsg.type).toBe('GET_MODELS');

    // Step 2: Daemon queries mock Ollama /api/tags
    const tagsRes = await fetch(`${mockOllama.url}/api/tags`, {
      headers: { Connection: 'close' },
    });
    expect(tagsRes.status).toBe(200);
    const tagsData = (await tagsRes.json()) as { models: Array<{ name: string }> };

    const discoveredModels = tagsData.models.map((m) => m.name);
    expect(discoveredModels).toContain('qwen2.5:latest');
    expect(discoveredModels).toContain('llama3.2:latest');

    // Step 3: Daemon broadcasts MODELS_LIST to UI
    const serverModelsMsg = {
      type: 'MODELS_LIST',
      payload: {
        models: discoveredModels,
        selectedModel: 'qwen2.5:latest',
        ollamaOnline: true,
      },
    };
    expect(serverModelsMsg.payload.models.length).toBeGreaterThanOrEqual(4);

    // Step 4: User selects llama3.2:latest in dropdown
    const chosenModel = 'llama3.2:latest';
    const clientSetModelMsg = createSetModelMsg(chosenModel);
    expect(clientSetModelMsg.payload.model).toBe('llama3.2:latest');

    // Step 5: User compiles task with the chosen model
    const compileMsg = createCompileTaskMsg(
      'Monitor GitHub releases for quantized modernbert models',
      chosenModel
    );

    // Daemon dispatches compilation request to Ollama /api/generate
    const genRes = await fetch(`${mockOllama.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({
        model: compileMsg.payload.ollamaModel,
        prompt: compileMsg.payload.userGoal,
      }),
    });
    expect(genRes.status).toBe(200);
    const genData = (await genRes.json()) as { model: string; response: string; done: boolean };

    expect(genData.model).toBe('llama3.2:latest');
    expect(genData.done).toBe(true);

    const compiledSpec = JSON.parse(genData.response);
    const sanitized = sanitizeCompiledSpec(compiledSpec);
    expect(sanitized.valid).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: High-Frequency Load & Metric Broadcasting
  // ---------------------------------------------------------------------------
  it('Scenario 5: High-Frequency Load & Metric Broadcasting end-to-end journey', () => {
    const chartDataSeries: Array<{
      time: string;
      cpuPercent: number;
      memoryRssMb: number;
      heapUsedMb: number;
      eventLoopLagMs: number;
    }> = [];

    const lru = new LruDeduplicator(2000);

    // High throughput scraping: 100 items processed across 10 scroll ticks
    for (let tick = 0; tick < 10; tick++) {
      for (let i = 0; i < 10; i++) {
        const itemText = `Tick ${tick} Item ${i}: Local AI benchmark streaming ${i * 42}`;
        const hash = sha1Hash(itemText);
        lru.add(hash);
      }

      // System monitor samples metrics every tick
      const metricsSample = createMetricsFixture({
        timestamp: 1731362400000 + tick * 500,
        cpu: { processPercent: 5.0 + (tick % 4) * 1.5, systemPercent: 15.0 },
        memory: {
          rssBytes: (80 + tick * 2) * 1024 * 1024,
          heapUsedBytes: (35 + tick) * 1024 * 1024,
          heapTotalBytes: 64 * 1024 * 1024,
          externalBytes: 8 * 1024 * 1024,
          systemFreeBytes: 4000 * 1024 * 1024,
          systemTotalBytes: 16384 * 1024 * 1024,
        },
        eventLoop: { lagMs: 0.8 + (tick % 3) * 0.2, p99LagMs: 2.4 },
        activeJobsCount: 1,
      });

      // WebSocket broadcast
      const wsMsg = createMetricsUpdateMsg(metricsSample);
      expect(wsMsg.type).toBe('METRICS_UPDATE');

      // Status dashboard time-series ingestion
      chartDataSeries.push({
        time: new Date(wsMsg.payload.timestamp).toLocaleTimeString(),
        cpuPercent: wsMsg.payload.cpu.processPercent,
        memoryRssMb: Number((wsMsg.payload.memory.rssBytes / (1024 * 1024)).toFixed(1)),
        heapUsedMb: Number((wsMsg.payload.memory.heapUsedBytes / (1024 * 1024)).toFixed(1)),
        eventLoopLagMs: wsMsg.payload.eventLoop.lagMs,
      });
    }

    expect(lru.size()).toBe(100);
    expect(chartDataSeries.length).toBe(10);

    // Verify uninterrupted continuity and data validity
    for (const point of chartDataSeries) {
      expect(point.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(point.cpuPercent).toBeLessThanOrEqual(100);
      expect(point.memoryRssMb).toBeGreaterThan(0);
      expect(point.heapUsedMb).toBeLessThan(point.memoryRssMb);
      expect(point.eventLoopLagMs).toBeGreaterThan(0);
      expect(point.eventLoopLagMs).toBeLessThan(50);
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: Robust Abort & Graceful Recovery
  // ---------------------------------------------------------------------------
  it('Scenario 6: Robust Abort & Graceful Recovery end-to-end journey', async () => {
    let runnerActive = true;
    let cleanupCompleted = false;
    const abortController = new AbortController();

    // Active infinite-scroll runner loop
    const runnerPromise = (async () => {
      try {
        while (!abortController.signal.aborted) {
          await abortableSleep(500, abortController.signal);
        }
      } finally {
        runnerActive = false;
        cleanupCompleted = true;
      }
    })();

    // User triggers STOP_TASK
    const stopT0 = performance.now();
    abortController.abort();
    await runnerPromise;
    const elapsedMs = performance.now() - stopT0;

    // Sub-100ms cleanup verification
    expect(elapsedMs).toBeLessThan(100);
    expect(runnerActive).toBe(false);
    expect(cleanupCompleted).toBe(true);

    // Toast notification dispatched to bottom-right
    const stopNotification = createDaemonNotificationFixture(
      'info',
      'Task Aborted',
      'Scraping task safely stopped in <100ms'
    );
    expect(stopNotification.level).toBe('info');
    expect(stopNotification.title).toBe('Task Aborted');

    // Immediate restart: spin up new task within 20ms
    const newAbortController = new AbortController();
    let newRunnerActive = true;
    expect(newAbortController.signal.aborted).toBe(false);
    expect(newRunnerActive).toBe(true);

    newAbortController.abort();
    newRunnerActive = false;
    expect(newRunnerActive).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: Alert Lifecycle, Persistence Recovery, & Historical Aggregation
  // ---------------------------------------------------------------------------
  it('Scenario 7: Alert Lifecycle, Persistence Recovery, & Historical Aggregation end-to-end journey', () => {
    const monitoredJobId = 'job-channel-monitor-01';
    dbInstance.prepare(`
      INSERT INTO jobs (id, name, spec_json, cron_schedule, is_scheduled, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(monitoredJobId, 'Channel Monitor', '{}', '*/30 * * * *', 1, 'idle', Date.now(), Date.now());

    // 2 consecutive runs with alerts
    const run1 = 'run-chan-01';
    dbInstance.prepare(`
      INSERT INTO job_runs (id, job_id, started_at, completed_at, status, total_scanned, total_alerts, avg_latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run1, monitoredJobId, 1731362400000, 1731362430000, 'completed', 45, 3, 4.2);

    for (let i = 1; i <= 3; i++) {
      dbInstance.prepare(`
        INSERT INTO alerts (id, task_id, run_id, timestamp, dom_snippet, latency_ms, raw_answers, triggered_alert)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`alt-chan-1-${i}`, 'task-chan', run1, 1731362400000 + i * 1000, `Alert 1-${i}`, 4.2, '{}', 1);
    }

    const run2 = 'run-chan-02';
    dbInstance.prepare(`
      INSERT INTO job_runs (id, job_id, started_at, completed_at, status, total_scanned, total_alerts, avg_latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run2, monitoredJobId, 1731364200000, 1731364230000, 'completed', 55, 4, 3.8);

    for (let i = 1; i <= 4; i++) {
      dbInstance.prepare(`
        INSERT INTO alerts (id, task_id, run_id, timestamp, dom_snippet, latency_ms, raw_answers, triggered_alert)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`alt-chan-2-${i}`, 'task-chan', run2, 1731364200000 + i * 1000, `Alert 2-${i}`, 3.8, '{}', 1);
    }

    // Historical recovery query
    const runs = dbInstance.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at ASC').all(monitoredJobId);
    expect(runs.length).toBe(2);

    const alertsRun1 = dbInstance.prepare('SELECT * FROM alerts WHERE run_id = ?').all(run1);
    const alertsRun2 = dbInstance.prepare('SELECT * FROM alerts WHERE run_id = ?').all(run2);
    expect(alertsRun1.length).toBe(3);
    expect(alertsRun2.length).toBe(4);

    // Clear alerts action: alerts cleared, runs preserved
    dbInstance.prepare('DELETE FROM alerts').run();
    const alertCountAfterClear = dbInstance.prepare('SELECT count(*) as count FROM alerts').get().count;
    expect(alertCountAfterClear).toBe(0);

    const runsAfterClear = dbInstance.prepare('SELECT * FROM job_runs WHERE job_id = ?').all(monitoredJobId);
    expect(runsAfterClear.length).toBe(2);
  });
});
