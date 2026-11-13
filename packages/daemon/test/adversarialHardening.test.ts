import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { ScoutWsServer } from '../src/wsServer.js';
import { ScoutDatabase } from '../src/db.js';
import { JobScheduler, parseCronField, calculateNextRun } from '../src/scheduler.js';
import { BrowserRunner } from '../src/runner/browserRunner.js';
import { chromium } from 'playwright';
import type { CompiledTaskSpec, WsServerToClientMessage } from '@ofln-scout/shared';

const mockSpec: CompiledTaskSpec = {
  id: 'adv-task-1',
  name: 'Adversarial Verification Task',
  userGoal: 'Verify adversarial hardening against crashes and leaks',
  targetUrl: 'https://example.com',
  domSelector: 'article',
  pollIntervalMs: 500,
  scrollStepPx: 300,
  questions: [
    {
      id: 'q1',
      text: 'Is this an adversarial hardening probe?',
      type: 'choice',
      options: ['yes', 'no']
    }
  ],
  alertRules: [
    {
      questionId: 'q1',
      condition: 'equals',
      expectedAnswer: 'yes',
      confidenceThreshold: 0.75
    }
  ],
  createdAt: Date.now()
};

describe('Milestone 3 Phase 2: Tier 5 Adversarial Coverage Hardening', () => {
  // =========================================================================
  // 1. Fatal Process Crash on Malformed START_TASK (Unhandled Rejection)
  // =========================================================================
  describe('Vulnerability 1: Malformed START_TASK & RPC Payload Guards', () => {
    it('survives START_TASK with empty payload without crashing or unhandled rejection', async () => {
      const db = new ScoutDatabase(':memory:');
      const server = new ScoutWsServer({ port: 0, db });
      await server.waitForReady();

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });

      const messages: WsServerToClientMessage[] = [];
      ws.on('message', (data) => {
        try {
          messages.push(JSON.parse(data.toString()));
        } catch {}
      });

      // Send malformed START_TASK messages
      ws.send(JSON.stringify({ type: 'START_TASK', payload: {} }));
      ws.send(JSON.stringify({ type: 'START_TASK' }));
      ws.send(JSON.stringify({ type: 'START_TASK', payload: { spec: null } }));
      ws.send(JSON.stringify({ type: 'START_TASK', payload: { spec: {} } }));

      // Give server time to process
      await new Promise((r) => setTimeout(r, 200));

      // Server must remain alive and responsive
      assert.equal(server.getStatus().isRunning, false);

      // Verify that server emitted warning DAEMON_NOTIFICATION
      const warningNotif = messages.find(
        (m) => m.type === 'DAEMON_NOTIFICATION' && m.payload.level === 'warning'
      );
      assert.ok(warningNotif, 'Should have received DAEMON_NOTIFICATION warning for invalid spec');

      // Verify server safely accepts valid START_TASK subsequently
      ws.send(JSON.stringify({ type: 'START_TASK', payload: { spec: mockSpec } }));
      await new Promise((r) => setTimeout(r, 100));

      assert.equal(server.getStatus().isRunning, true);
      assert.equal(server.activeRunId?.startsWith('run-'), true);

      ws.close();
      await server.close();
      db.close();
    });

    it('survives all client RPC messages with null or missing payload without crashing', async () => {
      const db = new ScoutDatabase(':memory:');
      const server = new ScoutWsServer({ port: 0, db });
      await server.waitForReady();

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });

      const malformedPayloads = [
        { type: 'COMPILE_TASK', payload: {} },
        { type: 'COMPILE_TASK' },
        { type: 'SET_MODEL', payload: {} },
        { type: 'SET_MODEL' },
        { type: 'CREATE_JOB', payload: {} },
        { type: 'CREATE_JOB' },
        { type: 'UPDATE_JOB', payload: {} },
        { type: 'UPDATE_JOB' },
        { type: 'DELETE_JOB', payload: {} },
        { type: 'DELETE_JOB' },
        { type: 'START_JOB', payload: {} },
        { type: 'START_JOB' },
        { type: 'STOP_JOB', payload: {} },
        { type: 'STOP_JOB' }
      ];

      for (const msg of malformedPayloads) {
        ws.send(JSON.stringify(msg));
      }

      await new Promise((r) => setTimeout(r, 200));

      // Server must survive cleanly
      assert.ok(server.getStatus());

      ws.close();
      await server.close();
      db.close();
    });
  });

  // =========================================================================
  // 2. Concurrency Guard in JobScheduler & ScoutWsServer
  // =========================================================================
  describe('Vulnerability 2: Concurrency Guard & activeJobsCount Tracking', () => {
    it('accurately reflects activeJobsCount and blocks overlapping job triggers during run', async () => {
      const db = new ScoutDatabase(':memory:');
      const scheduler = new JobScheduler({ db });

      const job = db.createJob({
        name: 'Concurrent Test Job',
        spec: mockSpec
      });

      let executionStarted = false;
      let executionFinished = false;

      scheduler.setTriggerHandler(async () => {
        executionStarted = true;
        // Simulate execution taking 100ms
        await new Promise((resolve) => setTimeout(resolve, 100));
        executionFinished = true;
      });

      assert.equal(scheduler.isJobRunning(job.id), false);
      assert.equal(scheduler.activeJobsCount, 0);

      // Trigger job (starts async execution)
      const triggerPromise = scheduler.triggerJob(job.id);

      // Verify that while execution is running:
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(executionStarted, true);
      assert.equal(executionFinished, false);
      assert.equal(scheduler.isJobRunning(job.id), true);
      assert.equal(scheduler.activeJobsCount, 1);
      assert.deepEqual(scheduler.activeJobIds, [job.id]);

      // Attempt concurrent duplicate trigger: concurrency guard must reject
      const secondTrigger = await scheduler.triggerJob(job.id);
      assert.equal(secondTrigger, false, 'Concurrency guard should reject overlapping trigger');

      // Wait for primary execution to finish
      const primaryResult = await triggerPromise;
      assert.equal(primaryResult, true);
      assert.equal(executionFinished, true);

      // Verify teardown
      assert.equal(scheduler.isJobRunning(job.id), false);
      assert.equal(scheduler.activeJobsCount, 0);

      db.close();
    });
  });

  // =========================================================================
  // 3. Step Range Parsing Bug in parseCronField
  // =========================================================================
  describe('Vulnerability 3: Step Range Parsing in parseCronField', () => {
    it("correctly parses stepped ranges like '0-30/5' to exactly 7 items", () => {
      const res = parseCronField('0-30/5', 0, 59);
      assert.deepEqual(res, [0, 5, 10, 15, 20, 25, 30]);
      assert.equal(res.length, 7);
    });

    it("correctly parses stepped range '10-20/2'", () => {
      const res = parseCronField('10-20/2', 0, 59);
      assert.deepEqual(res, [10, 12, 14, 16, 18, 20]);
    });

    it("correctly parses standard range '1-5' and comma list '1,3,5'", () => {
      const range = parseCronField('1-5', 0, 59);
      assert.deepEqual(range, [1, 2, 3, 4, 5]);

      const list = parseCronField('1,3,5', 0, 59);
      assert.deepEqual(list, [1, 3, 5]);
    });
  });

  // =========================================================================
  // 4. 30-Day Search Horizon Bug in calculateNextRun
  // =========================================================================
  describe('Vulnerability 4: 366-Day Search Horizon in calculateNextRun', () => {
    it("correctly resolves annual schedule '0 0 1 12 *' (Dec 1st) from Jan 1st (>30 days away)", () => {
      const fromDate = new Date(2026, 0, 1, 0, 0, 0);
      const nextRunMs = calculateNextRun('0 0 1 12 *', fromDate);
      const nextDate = new Date(nextRunMs);

      assert.equal(nextDate.getMonth(), 11, 'Month must be December (11)');
      assert.equal(nextDate.getDate(), 1, 'Date must be the 1st');
      assert.equal(nextDate.getHours(), 0, 'Hour must be 0');
      assert.equal(nextDate.getMinutes(), 0, 'Minute must be 0');
    });

    it("correctly resolves quarterly schedule '0 0 1 7 *' (July 1st) from Jan 1st", () => {
      const fromDate = new Date(2026, 0, 1, 0, 0, 0);
      const nextRunMs = calculateNextRun('0 0 1 7 *', fromDate);
      const nextDate = new Date(nextRunMs);

      assert.equal(nextDate.getMonth(), 6, 'Month must be July (6)');
      assert.equal(nextDate.getDate(), 1, 'Date must be the 1st');
    });

    it('returns fast fallback without hanging on unparseable or out-of-bounds cron fields', () => {
      const fromDate = new Date('2026-01-01T00:00:00Z');
      const t0 = Date.now();
      const nextRunMs = calculateNextRun('99 * * * *', fromDate);
      const duration = Date.now() - t0;

      assert.ok(duration < 50, 'Should return fallback in <50ms without looping');
      assert.equal(nextRunMs, fromDate.getTime() + 3600000);
    });
  });

  // =========================================================================
  // 5. Resource Leak in browserRunner.ts if Context/Page Creation Fails
  // =========================================================================
  describe('Vulnerability 5: Browser Cleanup on Context/Page Failure', () => {
    it('closes browser if context creation throws to prevent process leakage', async () => {
      const runner = new BrowserRunner({ headless: true });
      let browserClosed = false;

      // Spy on chromium.launch to return a mock browser whose newContext rejects
      const originalLaunch = chromium.launch;
      (chromium as any).launch = async (...args: any[]) => {
        const realBrowser = await originalLaunch.apply(chromium, args as any);
        return {
          newContext: async () => {
            throw new Error('Simulated context creation failure (OOM)');
          },
          close: async () => {
            browserClosed = true;
            await realBrowser.close();
          }
        };
      };

      try {
        const controller = new AbortController();
        await assert.rejects(
          async () => {
            await runner.runTask(mockSpec, async () => {}, controller.signal);
          },
          /Playwright Chromium launch failed/
        );

        assert.equal(browserClosed, true, 'browser.close() must be called when context creation fails');
      } finally {
        (chromium as any).launch = originalLaunch;
      }
    });
  });

  // =========================================================================
  // 6. Safe Database Shutdown on Closed Database
  // =========================================================================
  describe('Vulnerability 6: Safe Database Operations on Closed SQLite Connection', () => {
    it('completeRun and database operations return null/safe values without throwing after db.close()', () => {
      const db = new ScoutDatabase(':memory:');
      const job = db.createJob({
        name: 'Shutdown Test Job',
        spec: mockSpec
      });
      const run = db.createRun({ jobId: job.id });

      // Close the database connection
      db.close();
      assert.equal(db.isOpen, false);

      // Operations on closed database must not throw SQLite 'The database connection is not open'
      assert.doesNotThrow(() => {
        const result = db.completeRun(run.id, {
          status: 'completed',
          totalScanned: 5,
          totalAlerts: 1,
          avgLatencyMs: 12.5
        });
        assert.equal(result, null);
      });

      assert.doesNotThrow(() => {
        const r = db.getRun(run.id);
        assert.equal(r, null);
      });

      assert.doesNotThrow(() => {
        const j = db.getJob(job.id);
        assert.equal(j, null);
      });

      assert.doesNotThrow(() => {
        const updated = db.updateJob(job.id, { status: 'idle' });
        assert.equal(updated, null);
      });

      assert.doesNotThrow(() => {
        db.saveAlert({
          id: 'alt-shutdown',
          taskId: mockSpec.id,
          timestamp: Date.now(),
          domSnippet: 'test',
          latencyMs: 10,
          rawAnswers: {},
          triggeredAlert: true
        });
      });
    });
  });
});
