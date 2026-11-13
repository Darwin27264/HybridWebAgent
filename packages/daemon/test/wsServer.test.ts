import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { ScoutWsServer } from '../src/wsServer.js';
import { ScoutDatabase } from '../src/db.js';
import { ScoutDaemon } from '../src/index.js';
import type {
  CompiledTaskSpec,
  InferenceTelemetryItem,
  WsServerToClientMessage,
  WsClientToServerMessage
} from '@ofln-scout/shared';

describe('ScoutWsServer (Unit & Integration)', () => {
  let db: ScoutDatabase;
  let server: ScoutWsServer;
  const activeClients: WebSocket[] = [];

  const mockSpec: CompiledTaskSpec = {
    id: 'ws-task-1',
    name: 'GitHub Trending Alert',
    userGoal: 'Detect new repos with > 500 stars in TypeScript',
    targetUrl: 'https://github.com/trending/typescript',
    domSelector: 'article.Box-row',
    pollIntervalMs: 3000,
    scrollStepPx: 300,
    questions: {
      is_trending: {
        type: 'noul',
        statement: 'This repo has gained significant stars today'
      }
    },
    alertRule: {
      questionKey: 'is_trending',
      operator: 'boolean_true',
      targetValue: true,
      minAnswerConfidence: 0.8
    },
    createdAt: 1731365000000
  };

  const mockInference: InferenceTelemetryItem = {
    id: 'inf-101',
    taskId: 'ws-task-1',
    timestamp: 1731365010000,
    domSnippet: '<article class="Box-row"><h1>repo/example</h1></article>',
    latencyMs: 24.5,
    rawAnswers: {
      is_trending: {
        answer: true,
        answer_confidence: 0.91,
        confidence: 0.91
      }
    },
    triggeredAlert: true
  };

  /**
   * Helper to connect a WebSocket client to the test server and collect messages.
   */
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
      } catch {
        // ignore
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const waitForMessage = (
      predicate?: (msg: WsServerToClientMessage) => boolean,
      timeoutMs = 3000
    ): Promise<WsServerToClientMessage> => {
      return new Promise<WsServerToClientMessage>((resolve, reject) => {
        if (predicate) {
          const index = messages.findIndex(predicate);
          if (index !== -1) {
            const [found] = messages.splice(index, 1);
            return resolve(found);
          }
        } else if (messages.length > 0) {
          return resolve(messages.shift()!);
        }

        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(
            new Error(
              `Timed out waiting for message after ${timeoutMs}ms. Buffered messages: ${JSON.stringify(
                messages
              )}`
            )
          );
        }, timeoutMs);

        const listener: Listener = (msg) => {
          if (!predicate || predicate(msg)) {
            clearTimeout(timer);
            listeners.delete(listener);
            const idx = messages.indexOf(msg);
            if (idx !== -1) {
              messages.splice(idx, 1);
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
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          ws.once('close', resolve);
          ws.close();
        });
      }
    };

    return { ws, messages, waitForMessage, send, close };
  }

  beforeEach(async () => {
    db = new ScoutDatabase(':memory:');
    // Use port 0 for dynamic non-colliding port assignment
    server = new ScoutWsServer({ port: 0, db });
    await server.waitForReady();
  });

  afterEach(async () => {
    for (const client of activeClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.terminate();
      }
    }
    activeClients.length = 0;

    await server.close();
    db.close();
  });

  it('immediately sends DAEMON_STATUS upon client connection', async () => {
    const client = await connectClient(server.port);

    const initialMsg = await client.waitForMessage(
      (m) => m.type === 'DAEMON_STATUS'
    );

    assert.equal(initialMsg.type, 'DAEMON_STATUS');
    assert.deepEqual(initialMsg.payload, {
      isRunning: false,
      layaReady: false,
      activeTaskId: null
    });

    await client.close();
  });

  it('handles COMPILE_TASK and broadcasts COMPILATION_PROGRESS', async () => {
    const client = await connectClient(server.port);
    // Discard initial status
    await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

    client.send({
      type: 'COMPILE_TASK',
      payload: { userGoal: 'Monitor Rust releases' }
    });

    const progressMsg = await client.waitForMessage(
      (m) => m.type === 'COMPILATION_PROGRESS'
    );

    assert.equal(progressMsg.type, 'COMPILATION_PROGRESS');
    assert.equal(progressMsg.payload.status, 'compiling');
    assert.match(progressMsg.payload.message, /Monitor Rust releases/);

    await client.close();
  });

  it('handles START_TASK: saves spec to DB, updates activeTaskId and broadcasts DAEMON_STATUS', async () => {
    const client = await connectClient(server.port);
    await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

    client.send({
      type: 'START_TASK',
      payload: { spec: mockSpec }
    });

    const statusMsg = await client.waitForMessage(
      (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === true
    );

    assert.equal(statusMsg.type, 'DAEMON_STATUS');
    assert.equal(statusMsg.payload.isRunning, true);
    assert.equal(statusMsg.payload.activeTaskId, mockSpec.id);

    // Verify task is persisted in SQLite database
    const savedTask = db.getTask(mockSpec.id);
    assert.ok(savedTask, 'Task must be stored in DB on START_TASK');
    assert.equal(savedTask.name, mockSpec.name);

    await client.close();
  });

  it('handles STOP_TASK: halts active task, clears activeTaskId, broadcasts DAEMON_STATUS', async () => {
    const client = await connectClient(server.port);
    await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

    // First start
    client.send({
      type: 'START_TASK',
      payload: { spec: mockSpec }
    });
    await client.waitForMessage((m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === true);

    // Then stop
    client.send({
      type: 'STOP_TASK'
    });

    const stoppedStatus = await client.waitForMessage(
      (m) => m.type === 'DAEMON_STATUS' && m.payload.isRunning === false
    );

    assert.equal(stoppedStatus.payload.isRunning, false);
    assert.equal(stoppedStatus.payload.activeTaskId, null);
    assert.equal(server.getStatus().isRunning, false);
    assert.equal(server.getStatus().activeTaskId, null);

    await client.close();
  });

  it('handles CLEAR_ALERTS: clears DB alerts and broadcasts status confirmation', async () => {
    // Insert task and alert
    db.insertTask(mockSpec);
    db.insertAlert(mockInference);
    assert.equal(db.listAlerts().length, 1);

    const client = await connectClient(server.port);
    await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

    client.send({ type: 'CLEAR_ALERTS' });

    // Expect status broadcast confirmation
    await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

    // Verify DB alerts are cleared
    assert.equal(db.listAlerts().length, 0);

    await client.close();
  });

  it('broadcasts INFERENCE_EVENT and ALERT_MATCH to all connected clients', async () => {
    // Insert parent task first to satisfy FK
    db.insertTask(mockSpec);

    const client1 = await connectClient(server.port);
    const client2 = await connectClient(server.port);

    await client1.waitForMessage((m) => m.type === 'DAEMON_STATUS');
    await client2.waitForMessage((m) => m.type === 'DAEMON_STATUS');

    // Emit inference item with alert flag = true
    server.emitInference(mockInference);

    // Both clients should receive INFERENCE_EVENT and ALERT_MATCH
    const inf1 = await client1.waitForMessage((m) => m.type === 'INFERENCE_EVENT');
    const inf2 = await client2.waitForMessage((m) => m.type === 'INFERENCE_EVENT');
    assert.equal(inf1.payload.id, mockInference.id);
    assert.equal(inf2.payload.id, mockInference.id);

    const alert1 = await client1.waitForMessage((m) => m.type === 'ALERT_MATCH');
    const alert2 = await client2.waitForMessage((m) => m.type === 'ALERT_MATCH');
    assert.equal(alert1.payload.id, mockInference.id);
    assert.equal(alert2.payload.id, mockInference.id);

    // Alert should also be persisted in DB
    const persistedAlerts = db.listAlerts(mockSpec.id);
    assert.equal(persistedAlerts.length, 1);
    assert.equal(persistedAlerts[0].id, mockInference.id);

    await client1.close();
    await client2.close();
  });

  it('handles malformed JSON without crashing server', async () => {
    const client = await connectClient(server.port);
    await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');

    // Send invalid non-JSON data
    client.ws.send('{ this is not json !!!');

    // Send valid message afterwards to verify server is still responsive
    client.send({
      type: 'COMPILE_TASK',
      payload: { userGoal: 'Still alive' }
    });

    const progress = await client.waitForMessage((m) => m.type === 'COMPILATION_PROGRESS');
    assert.match(progress.payload.message, /Still alive/);

    await client.close();
  });

  it('tracks client connections and disconnections', async () => {
    assert.equal(server.connectedClientsCount, 0);

    const client1 = await connectClient(server.port);
    assert.equal(server.connectedClientsCount, 1);

    const client2 = await connectClient(server.port);
    assert.equal(server.connectedClientsCount, 2);

    await client1.close();
    // Allow brief event loop turn for close event
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.connectedClientsCount, 1);

    await client2.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.connectedClientsCount, 0);
  });

  it('gracefully closes all client connections and shuts down server', async () => {
    const client = await connectClient(server.port);
    assert.equal(client.ws.readyState, WebSocket.OPEN);

    await server.close();

    // Sockets should be closed
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      client.ws.readyState === WebSocket.CLOSING || client.ws.readyState === WebSocket.CLOSED,
      true
    );

    // Connecting to closed server should fail
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
          ws.once('open', resolve);
          ws.once('error', reject);
        })
    );
  });
});

describe('ScoutDaemon (Integration Lifecycle)', () => {
  it('initializes DB and WS server, starts and shuts down cleanly', async () => {
    const daemon = new ScoutDaemon({
      port: 0,
      dbPath: ':memory:'
    });

    await daemon.start();
    assert.ok(daemon.wsServer.port > 0);
    assert.equal(daemon.db.isOpen, true);

    const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsServer.port}`);
    const messagePromise = new Promise<string>((resolve) => {
      ws.once('message', (d) => resolve(d.toString()));
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const initialMsg = await messagePromise;
    const parsed = JSON.parse(initialMsg) as WsServerToClientMessage;
    assert.equal(parsed.type, 'DAEMON_STATUS');

    ws.terminate();
    await daemon.stop();
    assert.equal(daemon.db.isOpen, false);
  });
});
