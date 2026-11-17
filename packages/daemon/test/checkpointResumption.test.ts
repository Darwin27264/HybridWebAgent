import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ScoutWsServer } from '../src/wsServer.js';
import { ScoutDatabase } from '../src/db.js';
import {
  BrowserRunner,
  LruDeduplicator,
  sha1Hash,
  type CandidateElement
} from '../src/runner/browserRunner.js';
import { ResultsStore } from '../src/resultsStore.js';
import type {
  CompiledTaskSpec,
  TaskCheckpoint,
  WsServerToClientMessage,
  WsClientToServerMessage,
  AgentAction
} from '@ofln-scout/shared';

describe('Milestone 3: Runner Checkpointing & Daemon Resumption RPC', () => {
  let tmpDir: string;
  let db: ScoutDatabase;
  let activeClients: WebSocket[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-checkpoint-test-'));
    db = new ScoutDatabase(path.join(tmpDir, 'test.db'));
    activeClients = [];
  });

  afterEach(() => {
    for (const ws of activeClients) {
      try {
        ws.terminate();
      } catch {}
    }
    activeClients = [];
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  async function connectClient(port: number): Promise<{
    ws: WebSocket;
    messages: WsServerToClientMessage[];
    waitForMessage: (
      predicate?: (msg: WsServerToClientMessage) => boolean,
      timeoutMs?: number
    ) => Promise<WsServerToClientMessage>;
    send: (msg: WsClientToServerMessage) => void;
    close: () => Promise<void>;
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
      predicate?: (msg: WsServerToClientMessage) => boolean,
      timeoutMs = 4000
    ): Promise<WsServerToClientMessage> => {
      return new Promise<WsServerToClientMessage>((resolve, reject) => {
        if (predicate) {
          const index = messages.findIndex(predicate);
          if (index !== -1) {
            const found = messages[index];
            messages.splice(index, 1);
            return resolve(found);
          }
        } else if (messages.length > 0) {
          return resolve(messages.shift()!);
        }

        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(
            new Error(
              `waitForMessage timed out after ${timeoutMs}ms. Received ${messages.length} messages: ${JSON.stringify(
                messages.map((m) => m.type)
              )}`
            )
          );
        }, timeoutMs);

        const listener: Listener = (msg) => {
          if (!predicate || predicate(msg)) {
            clearTimeout(timer);
            listeners.delete(listener);
            const index = messages.indexOf(msg);
            if (index !== -1) {
              messages.splice(index, 1);
            }
            resolve(msg);
          }
        };

        listeners.add(listener);
      });
    };

    const send = (msg: WsClientToServerMessage) => {
      ws.send(JSON.stringify(msg));
    };

    const close = async () => {
      return new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          return resolve();
        }
        ws.once('close', () => resolve());
        ws.close();
      });
    };

    return { ws, messages, waitForMessage, send, close };
  }

  // =========================================================================
  // Suite 1: LruDeduplicator & BrowserRunner Checkpoint / Resumption Unit Tests
  // =========================================================================
  describe('Suite 1: BrowserRunner State Capture & Resumption Mechanics', () => {
    it('LruDeduplicator exports getHashes and imports loadHashes maintaining bounds', () => {
      const dedup = new LruDeduplicator(5);
      dedup.add('hash-1');
      dedup.add('hash-2');
      dedup.add('hash-3');

      const exported = dedup.getHashes();
      assert.deepEqual(exported, ['hash-1', 'hash-2', 'hash-3']);

      // Create a new instance and restore
      const restored = new LruDeduplicator(5);
      assert.equal(restored.size(), 0);
      restored.loadHashes(exported);
      assert.equal(restored.size(), 3);
      assert.equal(restored.has('hash-1'), true);
      assert.equal(restored.has('hash-2'), true);
      assert.equal(restored.has('hash-3'), true);
      assert.equal(restored.has('hash-4'), false);

      // Verify bounds enforcement
      restored.loadHashes(['hash-4', 'hash-5', 'hash-6', 'hash-7']);
      assert.equal(restored.size(), 5, 'Should evict oldest beyond maxSize');
    });

    it('BrowserRunner exposes getDeduplicationHashes and getCurrentState', async () => {
      const runner = new BrowserRunner({ headless: true });
      runner.loadDeduplicationHashes(['pre-1', 'pre-2']);
      assert.deepEqual(runner.getDeduplicationHashes(), ['pre-1', 'pre-2']);

      const state = await runner.getCurrentState();
      assert.equal(state.totalScanned, 0);
      assert.equal(state.totalAlerts, 0);
      assert.deepEqual(state.dedupHashes, ['pre-1', 'pre-2']);
      assert.deepEqual(state.scroll, { y: 0, scrollHeight: 0, viewportHeight: 0 });
    });

    it('BrowserRunner emits onCheckpoint hook and captures coordinates during run', async () => {
      const runner = new BrowserRunner({ headless: true });

      const pageHtml = `
        <!DOCTYPE html>
        <html>
          <body style="height: 3000px; padding: 20px;">
            <div class="item">Item Alpha</div>
            <div style="height: 600px;"></div>
            <div class="item">Item Beta</div>
            <div style="height: 600px;"></div>
            <div class="item">Item Gamma</div>
          </body>
        </html>
      `;
      const dataUri = `data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}`;

      const spec: CompiledTaskSpec = {
        id: 'task-chk-hook-1',
        name: 'Checkpoint Hook Test',
        userGoal: 'Test checkpoint callbacks',
        targetUrl: dataUri,
        domSelector: '.item',
        pollIntervalMs: 50,
        scrollStepPx: 400,
        questions: {
          q1: { type: 'noul', statement: 'Statement 1' }
        },
        alertRule: {
          questionKey: 'q1',
          operator: 'boolean_true',
          targetValue: true,
          minAnswerConfidence: 0.8
        },
        createdAt: Date.now()
      };

      const checkpointsEmitted: Partial<TaskCheckpoint>[] = [];
      const controller = new AbortController();

      const runPromise = runner.runTask(
        spec,
        async (_candidate) => {
          // let it scroll and emit checkpoints
        },
        controller.signal,
        undefined,
        undefined,
        () => 0,
        undefined,
        async (chk) => {
          checkpointsEmitted.push({ ...chk });
          if (checkpointsEmitted.length >= 2) {
            controller.abort();
          }
        }
      );

      await runPromise;

      assert.ok(checkpointsEmitted.length >= 2, 'Should emit at least 2 checkpoints during run');
      const first = checkpointsEmitted[0];
      assert.equal(first.taskId, spec.id);
      assert.ok(first.dedupHashes, 'Checkpoint should contain dedup hashes');
      assert.ok(first.scroll, 'Checkpoint should contain scroll coordinates');
    });

    it('BrowserRunner resumption restores scroll offset, dedup cache, counters, and skips prior elements', async () => {
      const runner = new BrowserRunner({ headless: true });

      const item1Text = 'Article 101 - Already Scanned';
      const item2Text = 'Article 102 - Already Scanned';
      const item3Text = 'Article 103 - Fresh New Item';

      const pageHtml = `
        <!DOCTYPE html>
        <html>
          <body style="height: 4000px; padding: 20px;">
            <div class="card">${item1Text}</div>
            <div class="card">${item2Text}</div>
            <div style="height: 1200px;"></div>
            <div class="card">${item3Text}</div>
          </body>
        </html>
      `;
      const dataUri = `data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}`;

      // Compute exact SHA-1 hashes that runner uses for item 1 & 2
      const hash1 = sha1Hash(JSON.stringify({ text: item1Text, link: '' }));
      const hash2 = sha1Hash(JSON.stringify({ text: item2Text, link: '' }));

      const spec: CompiledTaskSpec = {
        id: 'task-resume-runner-1',
        name: 'Resumption Integration Test',
        userGoal: 'Scout test page with resume',
        targetUrl: dataUri,
        domSelector: '.card',
        pollIntervalMs: 50,
        scrollStepPx: 300,
        questions: {
          q1: { type: 'noul', statement: 'Statement 1' }
        },
        alertRule: {
          questionKey: 'q1',
          operator: 'boolean_true',
          targetValue: true,
          minAnswerConfidence: 0.8
        },
        createdAt: Date.now()
      };

      const checkpoint: TaskCheckpoint = {
        id: 'chk-prior-1',
        taskId: spec.id,
        runId: 'run-prior-1',
        createdAt: Date.now() - 10000,
        updatedAt: Date.now() - 5000,
        status: 'stopped',
        targetUrl: dataUri,
        currentUrl: dataUri,
        pageTitle: 'Test Page',
        scroll: {
          y: 400,
          scrollHeight: 4000,
          viewportHeight: 720
        },
        totalScanned: 2,
        totalAlerts: 1,
        activeStepCount: 5,
        dedupHashes: [hash1, hash2]
      };

      const scannedCandidates: CandidateElement[] = [];
      const emittedActions: AgentAction[] = [];
      const controller = new AbortController();

      const runPromise = runner.runTask(
        spec,
        async (candidate) => {
          scannedCandidates.push(candidate);
          // When the fresh item 3 is scanned, abort
          if (candidate.text.includes('Fresh New Item')) {
            controller.abort();
          }
        },
        controller.signal,
        (action) => {
          emittedActions.push(action);
        },
        undefined,
        () => 1,
        checkpoint
      );

      await runPromise;

      // Verify resumption action was emitted
      const resumeAction = emittedActions.find(
        (a) => a.type === 'system' && a.message.includes('Resumed task execution from checkpoint')
      );
      assert.ok(resumeAction, 'System resumption AgentAction must be emitted');
      assert.match(resumeAction.message, /step 5/);

      // Verify Item 1 and Item 2 were skipped and NOT re-emitted
      assert.equal(
        scannedCandidates.some((c) => c.text.includes('Article 101')),
        false,
        'Article 101 must be skipped via pre-populated dedup cache'
      );
      assert.equal(
        scannedCandidates.some((c) => c.text.includes('Article 102')),
        false,
        'Article 102 must be skipped via pre-populated dedup cache'
      );
      assert.equal(
        scannedCandidates.some((c) => c.text.includes('Article 103')),
        true,
        'Article 103 must be evaluated as a novel candidate'
      );

      // Verify totalScanned resumed from baseline 2 and incremented to 3
      assert.equal(runner.totalScanned, 3, 'totalScanned must start at checkpoint baseline (2) + 1 = 3');
      assert.equal(runner.totalAlerts, 1, 'totalAlerts must preserve checkpoint baseline (1)');
    });
  });

  // =========================================================================
  // Suite 2: ScoutWsServer STOP_TASK & Database Checkpoint Persistence
  // =========================================================================
  describe('Suite 2: STOP_TASK Checkpoint Persistence & Broadcast', () => {
    it('STOP_TASK saves checkpoint to SQLite with status stopped and broadcasts CHECKPOINT_SAVED', async () => {
      const resultsStore = new ResultsStore({ filePath: ':memory:' });
      const runner = new BrowserRunner({ headless: true });
      const server = new ScoutWsServer({
        port: 0,
        db,
        browserRunner: runner,
        resultsStore
      });
      await server.waitForReady();

      const pageHtml = `
        <!DOCTYPE html>
        <html>
          <body style="height: 3000px;">
            <div class="row">Row 1</div>
            <div class="row">Row 2</div>
          </body>
        </html>
      `;
      const dataUri = `data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}`;

      const spec: CompiledTaskSpec = {
        id: 'task-stop-persist-1',
        name: 'Stop Persist Test',
        userGoal: 'Test stop persistence',
        targetUrl: dataUri,
        domSelector: '.row',
        pollIntervalMs: 50,
        scrollStepPx: 300,
        questions: {
          q: { type: 'noul', statement: 'Sample statement' }
        },
        alertRule: {
          questionKey: 'q',
          operator: 'boolean_true',
          targetValue: true,
          minAnswerConfidence: 0.8
        },
        createdAt: Date.now()
      };

      const client = await connectClient(server.port);
      // Consume initial DAEMON_STATUS
      await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

      // Start task via programmatic execution
      server.startExecution(spec).catch(() => {});

      // Wait for status running
      await client.waitForMessage(
        (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === true
      );

      // Let runner execute briefly
      await new Promise((r) => setTimeout(r, 150));

      // Send STOP_TASK
      client.send({ type: 'STOP_TASK' });

      // Expect CHECKPOINT_SAVED message
      const savedMsg = await client.waitForMessage((m) => m.type === 'CHECKPOINT_SAVED');
      assert.equal(savedMsg.type, 'CHECKPOINT_SAVED');
      assert.equal(savedMsg.payload.taskId, spec.id);
      assert.equal(savedMsg.payload.status, 'stopped');
      assert.ok(savedMsg.payload.id.startsWith('chk-'));

      // Expect stopped DAEMON_STATUS
      const stoppedStatus = await client.waitForMessage(
        (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === false
      );
      assert.equal(stoppedStatus.payload.isRunning, false);
      assert.equal(stoppedStatus.payload.activeTaskId, null);

      // Verify checkpoint is stored in SQLite database
      const dbCheckpoint = db.getLatestCheckpoint(spec.id);
      assert.ok(dbCheckpoint, 'Checkpoint must be saved in database');
      assert.equal(dbCheckpoint.taskId, spec.id);
      assert.equal(dbCheckpoint.status, 'stopped');
      assert.equal(dbCheckpoint.id, savedMsg.payload.id);

      await client.close();
      await server.close();
    });
  });

  // =========================================================================
  // Suite 3: ScoutWsServer RESUME_TASK Flow & Results Preservation
  // =========================================================================
  describe('Suite 3: RESUME_TASK Execution Flow & Results Preservation', () => {
    it('RESUME_TASK restores checkpoint from DB, preserves results, and launches runner', async () => {
      const resultsStore = new ResultsStore({ filePath: ':memory:' });
      const runner = new BrowserRunner({ headless: true });
      const mockLayaEngine: any = {
        isReady: true,
        evaluateDomBatch: async (text: string, taskSpec: CompiledTaskSpec) => ({
          id: `inf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          taskId: taskSpec.id,
          timestamp: Date.now(),
          domSnippet: text,
          latencyMs: 12,
          rawAnswers: { q: { answer: true, answer_confidence: 0.95 } },
          triggeredAlert: true
        })
      };
      const server = new ScoutWsServer({
        port: 0,
        db,
        browserRunner: runner,
        layaEngine: mockLayaEngine,
        resultsStore
      });
      await server.waitForReady();

      const pageHtml = `
        <!DOCTYPE html>
        <html>
          <body style="height: 3000px;">
            <div class="row">Existing Item 1</div>
            <div class="row">Existing Item 2</div>
            <div class="row">Resumed Discovered Item 3</div>
          </body>
        </html>
      `;
      const dataUri = `data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}`;

      const spec: CompiledTaskSpec = {
        id: 'task-resume-rpc-1',
        name: 'Resume RPC Test',
        userGoal: 'Test RESUME_TASK preservation',
        targetUrl: dataUri,
        domSelector: '.row',
        pollIntervalMs: 50,
        scrollStepPx: 300,
        questions: {
          q: { type: 'noul', statement: 'Statement' }
        },
        alertRule: {
          questionKey: 'q',
          operator: 'boolean_true',
          targetValue: true,
          minAnswerConfidence: 0.8
        },
        createdAt: Date.now()
      };

      // Persist task spec in DB
      db.insertTask(spec);

      // Initialize results store with 2 pre-existing items
      resultsStore.initTask(spec);
      resultsStore.recordItem({
        id: 'scraped-1',
        timestamp: new Date().toISOString(),
        text: 'Pre-existing Item 1',
        answers: { q: true },
        confidence: 0.95,
        triggeredAlert: true
      });
      resultsStore.recordItem({
        id: 'scraped-2',
        timestamp: new Date().toISOString(),
        text: 'Pre-existing Item 2',
        answers: { q: false },
        confidence: 0.85,
        triggeredAlert: false
      });
      assert.equal(resultsStore.getItems().length, 2);

      // Save a valid checkpoint in DB
      const checkpoint: TaskCheckpoint = {
        id: 'chk-resume-test-1',
        taskId: spec.id,
        runId: 'run-prior-rpc-1',
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 2000,
        status: 'stopped',
        targetUrl: dataUri,
        currentUrl: dataUri,
        scroll: { y: 250, scrollHeight: 3000, viewportHeight: 720 },
        totalScanned: 2,
        totalAlerts: 1,
        activeStepCount: 3,
        dedupHashes: [
          sha1Hash(JSON.stringify({ text: 'Existing Item 1', link: '' })),
          sha1Hash(JSON.stringify({ text: 'Existing Item 2', link: '' }))
        ]
      };
      db.saveCheckpoint(checkpoint);

      const client = await connectClient(server.port);
      await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

      // Send RESUME_TASK
      client.send({
        type: 'RESUME_TASK',
        payload: { taskId: spec.id, checkpointId: checkpoint.id }
      });

      // Expect DAEMON_STATUS with isRunning: true
      const runningStatus = await client.waitForMessage(
        (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === true
      );
      assert.equal(runningStatus.payload.isRunning, true);
      assert.equal(runningStatus.payload.activeTaskId, spec.id);

      // Expect resumption AgentAction
      const resumeAction = await client.waitForMessage(
        (m) =>
          m.type === 'AGENT_ACTION' &&
          m.payload.type === 'system' &&
          m.payload.message.includes('Resumed task execution from checkpoint')
      );
      assert.ok(resumeAction, 'Must broadcast resumption AGENT_ACTION');

      // Crucial verification: resultsStore items were NOT wiped or reset!
      assert.ok(
        resultsStore.getItems().length >= 2,
        'resultsStore items must be preserved on resumption'
      );
      assert.equal(resultsStore.getItems()[0].text, 'Pre-existing Item 1');

      // Clean stop
      client.send({ type: 'STOP_TASK' });
      await client.waitForMessage(
        (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === false
      );

      await client.close();
      await server.close();
    });
  });

  // =========================================================================
  // Suite 4: Client Connection DAEMON_STATUS & GET_CHECKPOINTS
  // =========================================================================
  describe('Suite 4: Client Reconnection & GET_CHECKPOINTS RPC', () => {
    it('connecting client receives lastCheckpoint in initial DAEMON_STATUS payload', async () => {
      const server = new ScoutWsServer({ port: 0, db });
      await server.waitForReady();

      const spec: CompiledTaskSpec = {
        id: 'task-reconnect-1',
        name: 'Reconnect Status Test',
        userGoal: 'Test lastCheckpoint on connect',
        targetUrl: 'https://example.com',
        domSelector: 'div',
        pollIntervalMs: 1000,
        scrollStepPx: 300,
        questions: {},
        alertRule: {
          questionKey: 'q',
          operator: 'boolean_true',
          targetValue: true,
          minAnswerConfidence: 0.8
        },
        createdAt: Date.now()
      };
      db.insertTask(spec);

      const chk: TaskCheckpoint = {
        id: 'chk-recon-101',
        taskId: spec.id,
        runId: 'run-recon-1',
        createdAt: Date.now() - 3000,
        updatedAt: Date.now() - 1000,
        status: 'stopped',
        targetUrl: 'https://example.com',
        currentUrl: 'https://example.com/page-2',
        scroll: { y: 1200, scrollHeight: 5000, viewportHeight: 800 },
        totalScanned: 15,
        totalAlerts: 3,
        activeStepCount: 8,
        dedupHashes: ['h1', 'h2']
      };
      db.saveCheckpoint(chk);

      // Connect new client
      const client = await connectClient(server.port);
      const initialStatus = await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

      assert.equal(initialStatus.type, 'DAEMON_STATUS');
      assert.ok(initialStatus.payload.lastCheckpoint, 'DAEMON_STATUS must include lastCheckpoint');
      assert.equal(initialStatus.payload.lastCheckpoint?.id, chk.id);
      assert.equal(initialStatus.payload.lastCheckpoint?.taskId, spec.id);
      assert.equal(initialStatus.payload.lastCheckpoint?.totalScanned, 15);
      assert.equal(initialStatus.payload.lastCheckpoint?.scroll.y, 1200);

      await client.close();
      await server.close();
    });

    it('handles GET_CHECKPOINTS and returns CHECKPOINTS_LIST in chronological order', async () => {
      const server = new ScoutWsServer({ port: 0, db });
      await server.waitForReady();

      const spec: CompiledTaskSpec = {
        id: 'task-list-chk-1',
        name: 'List Checkpoints Test',
        userGoal: 'Test GET_CHECKPOINTS',
        targetUrl: 'https://example.com/list',
        domSelector: 'div',
        pollIntervalMs: 1000,
        scrollStepPx: 300,
        questions: {},
        alertRule: {
          questionKey: 'q',
          operator: 'boolean_true',
          targetValue: true,
          minAnswerConfidence: 0.8
        },
        createdAt: Date.now()
      };
      db.insertTask(spec);

      const chk1: TaskCheckpoint = {
        id: 'chk-list-1',
        taskId: spec.id,
        runId: 'run-list-1',
        createdAt: 1000,
        updatedAt: 1000,
        status: 'stopped',
        targetUrl: spec.targetUrl,
        currentUrl: spec.targetUrl,
        scroll: { y: 200, scrollHeight: 2000, viewportHeight: 700 },
        totalScanned: 5,
        totalAlerts: 0,
        activeStepCount: 2,
        dedupHashes: ['h1']
      };

      const chk2: TaskCheckpoint = {
        id: 'chk-list-2',
        taskId: spec.id,
        runId: 'run-list-1',
        createdAt: 2000,
        updatedAt: 2000,
        status: 'stopped',
        targetUrl: spec.targetUrl,
        currentUrl: spec.targetUrl,
        scroll: { y: 500, scrollHeight: 2000, viewportHeight: 700 },
        totalScanned: 10,
        totalAlerts: 1,
        activeStepCount: 5,
        dedupHashes: ['h1', 'h2']
      };

      db.saveCheckpoint(chk1);
      db.saveCheckpoint(chk2);

      const client = await connectClient(server.port);
      await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

      client.send({
        type: 'GET_CHECKPOINTS',
        payload: { taskId: spec.id }
      });

      const listMsg = await client.waitForMessage((m) => m.type === 'CHECKPOINTS_LIST');
      assert.equal(listMsg.type, 'CHECKPOINTS_LIST');
      assert.equal(listMsg.payload.length, 2);
      // Ordered descending by updatedAt (newest first)
      assert.equal(listMsg.payload[0].id, 'chk-list-2');
      assert.equal(listMsg.payload[1].id, 'chk-list-1');

      await client.close();
      await server.close();
    });
  });

  // =========================================================================
  // Suite 5: Resilience, Edge Cases & Fallback Behaviors
  // =========================================================================
  describe('Suite 5: Resilience & Edge Cases', () => {
    it('RESUME_TASK with non-existent task or checkpoint notifies client with error notification', async () => {
      const server = new ScoutWsServer({ port: 0, db });
      await server.waitForReady();

      const client = await connectClient(server.port);
      await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

      // Attempt to resume non-existent task
      client.send({
        type: 'RESUME_TASK',
        payload: { taskId: 'non-existent-task-999' }
      });

      const errorNotification = await client.waitForMessage(
        (m) => m.type === 'DAEMON_NOTIFICATION' && m.payload.level === 'error'
      );
      assert.equal(errorNotification.type, 'DAEMON_NOTIFICATION');
      assert.equal(errorNotification.payload.level, 'error');
      assert.match(errorNotification.payload.message, /No checkpoint found/);

      // Verify server is not running and didn't crash
      assert.equal(server.getStatus().isRunning, false);

      await client.close();
      await server.close();
    });

    it('RESUME_TASK with explicit checkpointId restores that specific checkpoint', async () => {
      const resultsStore = new ResultsStore({ filePath: ':memory:' });
      const runner = new BrowserRunner({ headless: true });
      const mockLayaEngine: any = {
        isReady: true,
        evaluateDomBatch: async () => ({
          id: 'inf-batch',
          taskId: 'task-specific-chk-1',
          timestamp: Date.now(),
          domSnippet: 'test',
          latencyMs: 10,
          rawAnswers: {},
          triggeredAlert: false
        })
      };
      const server = new ScoutWsServer({
        port: 0,
        db,
        browserRunner: runner,
        layaEngine: mockLayaEngine,
        resultsStore
      });
      await server.waitForReady();

      const spec: CompiledTaskSpec = {
        id: 'task-specific-chk-1',
        name: 'Specific Checkpoint Test',
        userGoal: 'Test specific checkpoint resume',
        targetUrl: 'data:text/html,<html><body><div class="x">Item</div></body></html>',
        domSelector: '.x',
        pollIntervalMs: 50,
        scrollStepPx: 300,
        questions: {},
        alertRule: {
          questionKey: 'q',
          operator: 'boolean_true',
          targetValue: true,
          minAnswerConfidence: 0.8
        },
        createdAt: Date.now()
      };
      db.insertTask(spec);

      // Insert older checkpoint
      const chkOld: TaskCheckpoint = {
        id: 'chk-older-100',
        taskId: spec.id,
        runId: 'run-1',
        createdAt: 1000,
        updatedAt: 1000,
        status: 'stopped',
        targetUrl: spec.targetUrl,
        currentUrl: spec.targetUrl,
        scroll: { y: 150, scrollHeight: 1000, viewportHeight: 600 },
        totalScanned: 5,
        totalAlerts: 1,
        activeStepCount: 2,
        dedupHashes: ['h-old']
      };
      // Insert newer checkpoint
      const chkNew: TaskCheckpoint = {
        id: 'chk-newer-200',
        taskId: spec.id,
        runId: 'run-2',
        createdAt: 2000,
        updatedAt: 2000,
        status: 'stopped',
        targetUrl: spec.targetUrl,
        currentUrl: spec.targetUrl,
        scroll: { y: 450, scrollHeight: 1000, viewportHeight: 600 },
        totalScanned: 20,
        totalAlerts: 4,
        activeStepCount: 10,
        dedupHashes: ['h-old', 'h-new']
      };

      db.saveCheckpoint(chkOld);
      db.saveCheckpoint(chkNew);

      const client = await connectClient(server.port);
      await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

      // Request resume specifically with the older checkpointId
      client.send({
        type: 'RESUME_TASK',
        payload: { taskId: spec.id, checkpointId: 'chk-older-100' }
      });

      // Expect running status and resumption action indicating step 2 (from older checkpoint)
      const action = await client.waitForMessage(
        (m) =>
          m.type === 'AGENT_ACTION' &&
          m.payload.type === 'system' &&
          m.payload.message.includes('Resumed task execution from checkpoint')
      );
      assert.match(action.payload.message, /step 2/);
      assert.equal(action.payload.details?.checkpointId, 'chk-older-100');

      // Clean stop
      client.send({ type: 'STOP_TASK' });
      await client.waitForMessage(
        (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === false
      );

      await client.close();
      await server.close();
    });

    it('stopTask on idle server returns null without throwing', async () => {
      const server = new ScoutWsServer({ port: 0, db });
      await server.waitForReady();

      const result = await server.stopTask();
      assert.equal(result, null);
      assert.equal(server.getStatus().isRunning, false);

      await server.close();
    });

    it('operates in-memory when database is omitted and preserves lastKnownCheckpoint', async () => {
      const runner = new BrowserRunner({ headless: true });
      const server = new ScoutWsServer({ port: 0, browserRunner: runner });
      await server.waitForReady();

      const spec: CompiledTaskSpec = {
        id: 'task-in-memory-1',
        name: 'In-Memory Test',
        userGoal: 'Test in-memory fallback',
        targetUrl: 'data:text/html,<html><body><div class="box">Box</div></body></html>',
        domSelector: '.box',
        pollIntervalMs: 50,
        scrollStepPx: 300,
        questions: {},
        alertRule: {
          questionKey: 'q',
          operator: 'boolean_true',
          targetValue: true,
          minAnswerConfidence: 0.8
        },
        createdAt: Date.now()
      };

      const client = await connectClient(server.port);
      await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

      // Start task
      server.startExecution(spec).catch(() => {});
      await client.waitForMessage(
        (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === true
      );

      // Stop task
      const chk = await server.stopTask();
      assert.ok(chk, 'Must generate in-memory checkpoint');
      assert.equal(chk.taskId, spec.id);

      // Status payload in-memory should now have lastCheckpoint
      const status = server.getStatus();
      assert.equal(status.isRunning, false);
      assert.ok(status.lastCheckpoint, 'lastCheckpoint must be available in-memory');
      assert.equal(status.lastCheckpoint.id, chk.id);

      await client.close();
      await server.close();
    });
  });

  // =========================================================================
  // Suite 6: Concurrency & Re-Entrancy Resilience
  // =========================================================================
  describe('Suite 6: Concurrency & Re-Entrancy Resilience', () => {
    it('rapid back-to-back STOP_TASK calls do not trigger SQLite NOT NULL constraint failures or unhandled rejections', async () => {
      const resultsStore = new ResultsStore({ filePath: ':memory:' });
      const runner = new BrowserRunner({ headless: true });
      const server = new ScoutWsServer({
        port: 0,
        db,
        browserRunner: runner,
        resultsStore
      });
      await server.waitForReady();

      const pageHtml = `
        <!DOCTYPE html>
        <html>
          <body style="height: 3000px;">
            <div class="row">Item 1</div>
            <div class="row">Item 2</div>
          </body>
        </html>
      `;
      const dataUri = `data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}`;

      const spec: CompiledTaskSpec = {
        id: 'task-concurrency-stop-1',
        name: 'Concurrency Stop Test',
        userGoal: 'Test rapid back-to-back stops',
        targetUrl: dataUri,
        domSelector: '.row',
        pollIntervalMs: 50,
        scrollStepPx: 300,
        questions: {
          q: { type: 'noul', statement: 'Statement' }
        },
        alertRule: {
          questionKey: 'q',
          operator: 'boolean_true',
          targetValue: true,
          minAnswerConfidence: 0.8
        },
        createdAt: Date.now()
      };

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: any[]) => {
        warnings.push(args.map(String).join(' '));
        originalWarn(...args);
      };

      try {
        const client = await connectClient(server.port);
        await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

        // Start task
        server.startExecution(spec).catch(() => {});
        await client.waitForMessage(
          (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === true
        );

        // Allow runner to execute briefly
        await new Promise((r) => setTimeout(r, 100));

        // Fire rapid burst of duplicate STOP_TASK calls back-to-back over WebSocket
        client.send({ type: 'STOP_TASK' });
        client.send({ type: 'STOP_TASK' });
        client.send({ type: 'STOP_TASK' });

        // Wait for stopped status
        const stoppedStatus = await client.waitForMessage(
          (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === false
        );
        assert.equal(stoppedStatus.payload.isRunning, false);
        assert.equal(stoppedStatus.payload.activeTaskId, null);

        // Verify no NOT NULL constraint error occurred
        const constraintViolations = warnings.filter((w) =>
          w.includes('NOT NULL constraint failed')
        );
        assert.equal(
          constraintViolations.length,
          0,
          `Expected 0 constraint violations, found: ${constraintViolations.join('; ')}`
        );

        // Verify checkpoint was saved successfully with a valid non-null taskId
        const dbCheckpoint = db.getLatestCheckpoint(spec.id);
        assert.ok(dbCheckpoint, 'Checkpoint must be saved to DB');
        assert.equal(dbCheckpoint.taskId, spec.id);
        assert.equal(dbCheckpoint.status, 'stopped');

        // Also test direct programmatic re-entrancy via Promise.all([stopTask(), stopTask()])
        server.startExecution(spec).catch(() => {});
        await client.waitForMessage(
          (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === true
        );
        await new Promise((r) => setTimeout(r, 50));

        const [res1, res2, res3] = await Promise.all([
          server.stopTask(),
          server.stopTask(),
          server.stopTask()
        ]);

        const nonNullResults = [res1, res2, res3].filter(Boolean);
        assert.equal(
          nonNullResults.length,
          1,
          'Exactly one concurrent stopTask call should return the saved checkpoint'
        );
        assert.equal(nonNullResults[0]!.taskId, spec.id);

        const constraintViolationsAfter = warnings.filter((w) =>
          w.includes('NOT NULL constraint failed')
        );
        assert.equal(
          constraintViolationsAfter.length,
          0,
          `Expected 0 constraint violations after concurrent Promise.all, found: ${constraintViolationsAfter.join('; ')}`
        );

        await client.close();
        await server.close();
      } finally {
        console.warn = originalWarn;
      }
    });

    it('pipelined STOP_TASK immediately followed by RESUME_TASK safely captures checkpoint and transitions cleanly', async () => {
      const resultsStore = new ResultsStore({ filePath: ':memory:' });
      const runner = new BrowserRunner({ headless: true });
      const mockLayaEngine: any = {
        isReady: true,
        evaluateDomBatch: async (text: string, taskSpec: CompiledTaskSpec) => ({
          id: `inf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          taskId: taskSpec.id,
          timestamp: Date.now(),
          domSnippet: text,
          latencyMs: 15,
          rawAnswers: { q: { answer: true, answer_confidence: 0.9 } },
          triggeredAlert: true
        })
      };

      const server = new ScoutWsServer({
        port: 0,
        db,
        browserRunner: runner,
        layaEngine: mockLayaEngine,
        resultsStore
      });
      await server.waitForReady();

      const pageHtml = `
        <!DOCTYPE html>
        <html>
          <body style="height: 3000px;">
            <div class="row">Row Item 1</div>
            <div class="row">Row Item 2</div>
            <div class="row">Row Item 3</div>
          </body>
        </html>
      `;
      const dataUri = `data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}`;

      const spec: CompiledTaskSpec = {
        id: 'task-pipelined-stop-resume-1',
        name: 'Pipelined Stop Resume Test',
        userGoal: 'Test pipelined stop and resume',
        targetUrl: dataUri,
        domSelector: '.row',
        pollIntervalMs: 50,
        scrollStepPx: 300,
        questions: {
          q: { type: 'noul', statement: 'Statement' }
        },
        alertRule: {
          questionKey: 'q',
          operator: 'boolean_true',
          targetValue: true,
          minAnswerConfidence: 0.8
        },
        createdAt: Date.now()
      };

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: any[]) => {
        warnings.push(args.map(String).join(' '));
        originalWarn(...args);
      };

      try {
        const client = await connectClient(server.port);
        await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

        // Start task initially
        server.startExecution(spec).catch(() => {});
        await client.waitForMessage(
          (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === true
        );

        // Wait briefly for at least one inference item to process
        await client.waitForMessage(
          (m) => m.type === 'AGENT_ACTION' && m.payload.type === 'inference'
        );

        // Pipeline STOP_TASK immediately followed by RESUME_TASK with 0ms delay
        client.send({ type: 'STOP_TASK' });
        client.send({ type: 'RESUME_TASK', payload: { taskId: spec.id } });

        // 1. Verify CHECKPOINT_SAVED message is emitted with valid taskId
        const savedMsg = await client.waitForMessage((m) => m.type === 'CHECKPOINT_SAVED');
        assert.equal(savedMsg.payload.taskId, spec.id, 'Saved checkpoint taskId must match spec id');
        assert.notEqual(savedMsg.payload.taskId, null, 'Saved checkpoint taskId must not be null');
        assert.equal(savedMsg.payload.status, 'stopped');

        // 2. Verify server transitions to running status from resume
        const resumeAction = await client.waitForMessage(
          (m) =>
            m.type === 'AGENT_ACTION' &&
            m.payload.type === 'system' &&
            m.payload.message.includes('Resumed task execution from checkpoint')
        );
        assert.ok(resumeAction, 'Must emit resume AGENT_ACTION');

        // 3. Verify daemon status is running
        const runningStatus = await client.waitForMessage(
          (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === true
        );
        assert.equal(runningStatus.payload.isRunning, true);
        assert.equal(runningStatus.payload.activeTaskId, spec.id);

        // 4. Verify no SQLite NOT NULL or unhandled errors occurred
        const constraintViolations = warnings.filter((w) =>
          w.includes('NOT NULL constraint failed')
        );
        assert.equal(
          constraintViolations.length,
          0,
          `Expected 0 constraint violations, found: ${constraintViolations.join('; ')}`
        );

        // Clean shutdown: stop task
        client.send({ type: 'STOP_TASK' });
        await client.waitForMessage(
          (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === false
        );

        await client.close();
        await server.close();
      } finally {
        console.warn = originalWarn;
      }
    });
  });
});
