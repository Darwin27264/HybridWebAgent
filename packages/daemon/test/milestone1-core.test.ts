import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { ScoutDatabase } from '../src/db.js';
import { ScoutWsServer } from '../src/wsServer.js';
import { BrowserRunner, LruDeduplicator } from '../src/runner/browserRunner.js';
import { SystemMonitor } from '../src/engine/systemMonitor.js';
import {
  JobScheduler,
  parseCronField,
  matchesCron,
  calculateNextRun
} from '../src/scheduler.js';
import {
  fetchOllamaModels,
  DEFAULT_OLLAMA_MODELS,
  compileTask
} from '../src/engine/compiler.js';
import type {
  CompiledTaskSpec,
  InferenceTelemetryItem,
  Job,
  JobRun,
  WsServerToClientMessage,
  WsClientToServerMessage,
  AgentAction,
  BrowserSnapshot
} from '@ofln-scout/shared';

describe('Milestone 1 Core Backend Verification Suite', () => {
  let db: ScoutDatabase;
  const activeServers: ScoutWsServer[] = [];
  const activeClients: WebSocket[] = [];

  const mockSpec: CompiledTaskSpec = {
    id: 'spec-m1-01',
    name: 'M1 Test Spec',
    userGoal: 'Scout test page for verification',
    targetUrl: 'https://news.ycombinator.com',
    domSelector: '.athing',
    pollIntervalMs: 500,
    scrollStepPx: 300,
    questions: {
      topic: {
        type: 'choice',
        question: 'Topic?',
        options: ['ai', 'web', 'other']
      }
    },
    alertRule: {
      questionKey: 'topic',
      operator: 'equals',
      targetValue: 'ai',
      minAnswerConfidence: 0.8
    },
    createdAt: Date.now()
  };

  beforeEach(() => {
    db = new ScoutDatabase(':memory:');
  });

  afterEach(async () => {
    for (const ws of activeClients) {
      try {
        ws.terminate();
      } catch {}
    }
    activeClients.length = 0;

    for (const server of activeServers) {
      try {
        await server.close();
      } catch {}
    }
    activeServers.length = 0;

    if (db && db.isOpen) {
      db.close();
    }
  });

  async function connectClient(port: number): Promise<{
    ws: WebSocket;
    messages: WsServerToClientMessage[];
    waitForMessage: (
      predicate: (msg: WsServerToClientMessage) => boolean,
      timeoutMs?: number
    ) => Promise<WsServerToClientMessage>;
    send: (msg: WsClientToServerMessage) => void;
  }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    activeClients.push(ws);
    const messages: WsServerToClientMessage[] = [];
    type Listener = (msg: WsServerToClientMessage) => void;
    const listeners = new Set<Listener>();

    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as WsServerToClientMessage;
        messages.push(parsed);
        for (const listener of Array.from(listeners)) {
          listener(parsed);
        }
      } catch {}
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const waitForMessage = (
      predicate: (msg: WsServerToClientMessage) => boolean,
      timeoutMs = 4000
    ): Promise<WsServerToClientMessage> => {
      return new Promise<WsServerToClientMessage>((resolve, reject) => {
        const index = messages.findIndex(predicate);
        if (index !== -1) {
          const [found] = messages.splice(index, 1);
          resolve(found);
          return;
        }

        const timer = setTimeout(() => {
          listeners.delete(onMsg);
          reject(
            new Error(
              `Timed out waiting for message after ${timeoutMs}ms. Received: ${JSON.stringify(
                messages.map((m) => m.type)
              )}`
            )
          );
        }, timeoutMs);

        const onMsg: Listener = (msg) => {
          if (predicate(msg)) {
            clearTimeout(timer);
            listeners.delete(onMsg);
            const idx = messages.indexOf(msg);
            if (idx !== -1) {
              messages.splice(idx, 1);
            }
            resolve(msg);
          }
        };

        listeners.add(onMsg);
      });
    };

    return {
      ws,
      messages,
      waitForMessage,
      send: (msg) => ws.send(JSON.stringify(msg))
    };
  }

  // =========================================================================
  // 1. Multi-Run Execution & Cache Reset
  // =========================================================================
  describe('F1: Multi-Run Cache Reset & LRU Deduplication', () => {
    it('clears LRU deduplication cache on task start', async () => {
      const runner = new BrowserRunner({ headless: true });

      // Simulate first run putting hashes into cache
      runner.deduplicator.add('hash1');
      runner.deduplicator.add('hash2');
      assert.equal(runner.deduplicator.size(), 2);

      // Verify resetCache clears the cache
      runner.resetCache();
      assert.equal(runner.deduplicator.size(), 0);
      assert.equal(runner.deduplicator.has('hash1'), false);
    });

    it('allows identical DOM content on second run after cache reset', () => {
      const lru = new LruDeduplicator(100);
      const hash = 'sample-dom-hash-123';

      // Run 1: first check is false (process candidate), then added
      assert.equal(lru.has(hash), false);
      lru.add(hash);
      assert.equal(lru.has(hash), true);

      // Without reset, run 2 skips the candidate
      assert.equal(lru.has(hash), true);

      // With reset, run 2 correctly re-evaluates the candidate
      lru.clear();
      assert.equal(lru.has(hash), false);
    });
  });

  // =========================================================================
  // 2. Database Schema, Jobs, JobRuns & Run Aggregation
  // =========================================================================
  describe('F3: Database Persistence (Jobs, JobRuns, Run Aggregations)', () => {
    it('creates, retrieves, updates, and deletes jobs', () => {
      const job = db.createJob({
        name: 'HN Scraper Job',
        spec: mockSpec,
        cronSchedule: '*/5 * * * *',
        isScheduled: true
      });

      assert.ok(job.id.startsWith('job-'));
      assert.equal(job.name, 'HN Scraper Job');
      assert.equal(job.isScheduled, true);
      assert.equal(job.status, 'scheduled');

      // Get job
      const fetched = db.getJob(job.id);
      assert.ok(fetched);
      assert.equal(fetched?.id, job.id);
      assert.equal(fetched?.name, 'HN Scraper Job');

      // List jobs
      const jobsList = db.listJobs();
      assert.ok(jobsList.some((j) => j.id === job.id));

      // Update job
      const updated = db.updateJob(job.id, {
        name: 'Updated Scraper Name',
        isScheduled: false
      });
      assert.ok(updated);
      assert.equal(updated?.name, 'Updated Scraper Name');
      assert.equal(updated?.isScheduled, false);

      // Delete job
      const deleted = db.deleteJob(job.id);
      assert.equal(deleted, true);
      assert.equal(db.getJob(job.id), null);
    });

    it('creates, updates, and completes job runs with aggregation', () => {
      const job = db.createJob({
        name: 'Aggregation Job',
        spec: mockSpec
      });

      // Create Run
      const run = db.createRun({ jobId: job.id });
      assert.ok(run.id.startsWith('run-'));
      assert.equal(run.jobId, job.id);
      assert.equal(run.status, 'running');

      // Check job status updated to running
      const runningJob = db.getJob(job.id);
      assert.equal(runningJob?.status, 'running');

      // Save alerts with runId
      const alert1: InferenceTelemetryItem = {
        id: 'alt-1',
        taskId: mockSpec.id,
        timestamp: Date.now(),
        domSnippet: '<div>AI Agent announcement</div>',
        latencyMs: 32.5,
        rawAnswers: { topic: { answer: 'ai', answer_confidence: 0.95 } },
        triggeredAlert: true
      };
      const alert2: InferenceTelemetryItem = {
        id: 'alt-2',
        taskId: mockSpec.id,
        timestamp: Date.now() + 10,
        domSnippet: '<div>Another AI tool</div>',
        latencyMs: 28.0,
        rawAnswers: { topic: { answer: 'ai', answer_confidence: 0.88 } },
        triggeredAlert: true
      };
      db.saveAlert(alert1, run.id);
      db.saveAlert(alert2, run.id);

      // Complete Run
      const completed = db.completeRun(run.id, {
        status: 'completed',
        totalScanned: 25,
        totalAlerts: 2,
        avgLatencyMs: 30.25
      });
      assert.ok(completed);
      assert.equal(completed?.status, 'completed');
      assert.equal(completed?.totalScanned, 25);
      assert.equal(completed?.totalAlerts, 2);

      // Check job status reset to idle
      const idleJob = db.getJob(job.id);
      assert.equal(idleJob?.status, 'idle');

      // Run aggregation
      const agg = db.getRunAggregation(run.id);
      assert.ok(agg);
      assert.equal(agg?.runId, run.id);
      assert.equal(agg?.totalScanned, 25);
      assert.equal(agg?.totalAlerts, 2);
      assert.equal(agg?.topMatches.length, 2);
      assert.equal(agg?.topMatches[0].id, 'alt-2'); // newest first
    });
  });

  // =========================================================================
  // 3. System 2 Ollama Discovery & Routing
  // =========================================================================
  describe('F6: Ollama Model Discovery & Routing', () => {
    it('returns default models when Ollama is unreachable', async () => {
      // Query non-existent port
      const result = await fetchOllamaModels('http://127.0.0.1:59999');
      assert.equal(result.online, false);
      assert.ok(Array.isArray(result.models));
      assert.ok(result.models.includes('qwen2.5'));
      assert.ok(result.models.includes('llama3.2'));
    });

    it('compiles task and respects custom model selection fallback', async () => {
      const spec = await compileTask('Find local AI projects on Hacker News', 'custom-mistral-model');
      assert.ok(spec);
      assert.ok(spec.id);
      assert.ok(spec.questions);
      assert.ok(spec.alertRule);
    });
  });

  // =========================================================================
  // 4. System Performance Monitor
  // =========================================================================
  describe('F7: Backend Performance & Health Monitor', () => {
    it('samples CPU, memory, event loop lag, and services', () => {
      const monitor = new SystemMonitor({
        db,
        getActiveJobsCount: () => 3
      });

      const metrics = monitor.getMetrics();
      assert.ok(metrics.timestamp > 0);
      assert.ok(typeof metrics.cpu.processPercent === 'number');
      assert.ok(typeof metrics.cpu.systemPercent === 'number');

      // Memory checks
      assert.ok(metrics.memory.rssBytes > 0);
      assert.ok(metrics.memory.heapUsedBytes > 0);
      assert.ok(metrics.memory.systemTotalBytes > 0);

      // Event loop checks
      assert.ok(metrics.eventLoop.lagMs >= 0);
      assert.ok(metrics.eventLoop.p99LagMs >= 0);

      // Services health
      assert.ok(metrics.services.database);
      assert.equal(metrics.services.database.status, 'healthy');
      assert.equal(metrics.activeJobsCount, 3);

      monitor.stop();
    });
  });

  // =========================================================================
  // 5. Job Scheduler & Cron Engine
  // =========================================================================
  describe('F8: Multi-Job Engine & Cron Scheduler', () => {
    it('parses cron fields accurately', () => {
      assert.deepEqual(parseCronField('*', 0, 5), [0, 1, 2, 3, 4, 5]);
      assert.deepEqual(parseCronField('*/15', 0, 59), [0, 15, 30, 45]);
      assert.deepEqual(parseCronField('1-4', 0, 10), [1, 2, 3, 4]);
      assert.deepEqual(parseCronField('2,5,8', 0, 10), [2, 5, 8]);
    });

    it('matches cron dates correctly', () => {
      const date = new Date(2026, 10, 12, 14, 30, 0); // Month 10 is November (0-indexed)
      // "30 14 * * *" => 14:30
      assert.equal(matchesCron('30 14 * * *', date), true);
      assert.equal(matchesCron('15 14 * * *', date), false);
      assert.equal(matchesCron('*/10 * * * *', date), true);
    });

    it('calculates next execution timestamp for interval syntax', () => {
      const base = new Date(1731365000000);
      const next30s = calculateNextRun('@every 30s', base);
      assert.equal(next30s, base.getTime() + 30000);

      const next5m = calculateNextRun('@every 5m', base);
      assert.equal(next5m, base.getTime() + 300000);

      const nextInterval = calculateNextRun('interval:15000', base);
      assert.equal(nextInterval, base.getTime() + 15000);
    });

    it('enforces concurrency guard preventing overlapping runs', async () => {
      const scheduler = new JobScheduler({ db });
      const job = db.createJob({
        name: 'Concurrent Test Job',
        spec: mockSpec
      });

      let executionCount = 0;
      let resolveFirstRun: () => void;
      const firstRunPromise = new Promise<void>((r) => {
        resolveFirstRun = r;
      });

      scheduler.setTriggerHandler(async () => {
        executionCount++;
        await firstRunPromise;
      });

      // Start first execution (asynchronously waiting on firstRunPromise)
      const triggerPromise1 = scheduler.triggerJob(job.id);
      assert.equal(scheduler.isJobRunning(job.id), true);

      // Attempt second execution while first is still running
      const trigger2Result = await scheduler.triggerJob(job.id);
      assert.equal(trigger2Result, false, 'Concurrent trigger must be rejected by concurrency guard');
      assert.equal(executionCount, 1, 'Only first execution should have started');

      // Finish first execution
      resolveFirstRun!();
      await triggerPromise1;

      assert.equal(scheduler.isJobRunning(job.id), false);

      scheduler.stop();
    });
  });

  // =========================================================================
  // 6. WebSocket RPC Extensions & RunId Isolation
  // =========================================================================
  describe('F2 & Extended WebSocket RPC Protocol', () => {
    it('isolates run lifecycle via unique activeRunId', async () => {
      const server = new ScoutWsServer({ port: 0, db });
      activeServers.push(server);
      await server.waitForReady();

      const runId1 = await server.startExecution(mockSpec);
      assert.ok(runId1.startsWith('run-'));
      assert.equal(server.activeRunId, runId1);
      assert.equal(server.getStatus().isRunning, true);

      // Start run 2: should produce distinct runId
      const runId2 = await server.startExecution(mockSpec);
      assert.ok(runId2.startsWith('run-'));
      assert.notEqual(runId1, runId2);
      assert.equal(server.activeRunId, runId2);

      await server.close();
    });

    it('handles GET_MODELS and SET_MODEL RPC messages', async () => {
      const server = new ScoutWsServer({ port: 0, db });
      activeServers.push(server);
      await server.waitForReady();

      const client = await connectClient(server.port);

      // GET_MODELS
      client.send({ type: 'GET_MODELS' });
      const modelsMsg = await client.waitForMessage((m) => m.type === 'MODELS_LIST');
      assert.equal(modelsMsg.type, 'MODELS_LIST');
      if (modelsMsg.type === 'MODELS_LIST') {
        assert.ok(Array.isArray(modelsMsg.payload.models));
        assert.ok(modelsMsg.payload.models.includes('qwen2.5'));
      }

      // SET_MODEL
      client.send({ type: 'SET_MODEL', payload: { model: 'llama3.2:3b' } });
      const updatedModelsMsg = await client.waitForMessage(
        (m) => m.type === 'MODELS_LIST' && m.payload.selectedModel === 'llama3.2:3b'
      );
      assert.ok(updatedModelsMsg);
      assert.equal(server.selectedModel, 'llama3.2:3b');

      await server.close();
    });

    it('handles GET_METRICS and GET_JOBS RPC messages', async () => {
      const server = new ScoutWsServer({ port: 0, db });
      activeServers.push(server);
      await server.waitForReady();

      db.createJob({ name: 'Test Job Alpha', spec: mockSpec });

      const client = await connectClient(server.port);

      // GET_METRICS
      client.send({ type: 'GET_METRICS' });
      const metricsMsg = await client.waitForMessage((m) => m.type === 'METRICS_UPDATE');
      assert.equal(metricsMsg.type, 'METRICS_UPDATE');
      if (metricsMsg.type === 'METRICS_UPDATE') {
        assert.ok(metricsMsg.payload.cpu);
        assert.ok(metricsMsg.payload.memory);
      }

      // GET_JOBS
      client.send({ type: 'GET_JOBS' });
      const jobsMsg = await client.waitForMessage((m) => m.type === 'JOBS_LIST');
      assert.equal(jobsMsg.type, 'JOBS_LIST');
      if (jobsMsg.type === 'JOBS_LIST') {
        assert.ok(jobsMsg.payload.some((j) => j.name === 'Test Job Alpha'));
      }

      await server.close();
    });

    it('handles CREATE_JOB, UPDATE_JOB, and DELETE_JOB via WebSocket', async () => {
      const server = new ScoutWsServer({ port: 0, db });
      activeServers.push(server);
      await server.waitForReady();

      const client = await connectClient(server.port);

      // CREATE_JOB
      client.send({
        type: 'CREATE_JOB',
        payload: {
          name: 'Remote WS Job',
          spec: mockSpec,
          cronSchedule: '0 * * * *',
          isScheduled: true
        }
      });

      const listAfterCreate = await client.waitForMessage(
        (m) => m.type === 'JOBS_LIST' && m.payload.some((j) => j.name === 'Remote WS Job')
      );
      assert.ok(listAfterCreate);
      let createdJobId = '';
      if (listAfterCreate.type === 'JOBS_LIST') {
        const found = listAfterCreate.payload.find((j) => j.name === 'Remote WS Job');
        createdJobId = found!.id;
      }

      // UPDATE_JOB
      client.send({
        type: 'UPDATE_JOB',
        payload: {
          id: createdJobId,
          name: 'Renamed Remote Job'
        }
      });

      const listAfterUpdate = await client.waitForMessage(
        (m) => m.type === 'JOBS_LIST' && m.payload.some((j) => j.name === 'Renamed Remote Job')
      );
      assert.ok(listAfterUpdate);

      // DELETE_JOB
      client.send({
        type: 'DELETE_JOB',
        payload: { id: createdJobId }
      });

      const listAfterDelete = await client.waitForMessage(
        (m) => m.type === 'JOBS_LIST' && !m.payload.some((j) => j.id === createdJobId)
      );
      assert.ok(listAfterDelete);

      await server.close();
    });

    it('broadcasts AGENT_ACTION and ALERT_MATCH upon alert trigger', async () => {
      db.insertTask(mockSpec);
      const server = new ScoutWsServer({ port: 0, db });
      activeServers.push(server);
      await server.waitForReady();

      const client = await connectClient(server.port);

      const alertItem: InferenceTelemetryItem = {
        id: 'inf-act-01',
        taskId: mockSpec.id,
        timestamp: Date.now(),
        domSnippet: '<div class="athing">Show HN: Laya ModernBERT</div>',
        latencyMs: 19.5,
        rawAnswers: {
          topic: { answer: 'ai', answer_confidence: 0.94 }
        },
        triggeredAlert: true
      };

      server.emitInference(alertItem);

      const alertMsg = await client.waitForMessage((m) => m.type === 'ALERT_MATCH');
      assert.equal(alertMsg.type, 'ALERT_MATCH');

      const actionMsg = await client.waitForMessage(
        (m) => m.type === 'AGENT_ACTION' && m.payload.type === 'alert'
      );
      assert.equal(actionMsg.type, 'AGENT_ACTION');

      await server.close();
    });
  });
});
