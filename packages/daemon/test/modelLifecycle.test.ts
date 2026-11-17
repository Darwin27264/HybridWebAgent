import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { ScoutWsServer } from '../src/wsServer.js';
import { ScoutDatabase } from '../src/db.js';
import { LayaEngine } from '../src/engine/layaEngine.js';
import type {
  WsClientToServerMessage,
  WsServerToClientMessage,
  ModelStats
} from '@ofln-scout/shared';

interface TestClient {
  ws: WebSocket;
  messages: WsServerToClientMessage[];
  waitForMessage: (
    predicate: (msg: WsServerToClientMessage) => boolean,
    timeoutMs?: number
  ) => Promise<WsServerToClientMessage>;
  send: (msg: WsClientToServerMessage) => void;
  close: () => Promise<void>;
}

function connectClient(port: number): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages: WsServerToClientMessage[] = [];
    const waiters: Array<{
      predicate: (msg: WsServerToClientMessage) => boolean;
      resolve: (msg: WsServerToClientMessage) => void;
    }> = [];

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsServerToClientMessage;
        messages.push(msg);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].predicate(msg)) {
            const w = waiters.splice(i, 1)[0];
            w.resolve(msg);
          }
        }
      } catch {}
    });

    ws.on('open', () => {
      const client: TestClient = {
        ws,
        messages,
        waitForMessage: (predicate, timeoutMs = 3000) => {
          const existing = messages.find(predicate);
          if (existing) return Promise.resolve(existing);

          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.resolve === res);
              if (idx !== -1) waiters.splice(idx, 1);
              rej(new Error(`Timeout waiting for message matching predicate after ${timeoutMs}ms`));
            }, timeoutMs);

            waiters.push({
              predicate,
              resolve: (msg) => {
                clearTimeout(timer);
                res(msg);
              }
            });
          });
        },
        send: (msg) => {
          ws.send(JSON.stringify(msg));
        },
        close: () => {
          return new Promise<void>((res) => {
            if (ws.readyState === WebSocket.CLOSED) {
              res();
              return;
            }
            ws.once('close', () => res());
            ws.close();
          });
        }
      };
      resolve(client);
    });

    ws.on('error', (err) => reject(err));
  });
}

describe('Model Loading Lifecycle & MODEL_STATS Suite', () => {
  let db: ScoutDatabase;
  let server: ScoutWsServer;
  const activeClients: TestClient[] = [];

  beforeEach(async () => {
    db = new ScoutDatabase(':memory:');
    server = new ScoutWsServer({ port: 0, db });
    await server.waitForReady();
  });

  afterEach(async () => {
    for (const c of activeClients) {
      await c.close();
    }
    activeClients.length = 0;
    await server.close();
    db.close();
  });

  it('pushes MODEL_STATS immediately upon client connection', async () => {
    const client = await connectClient(server.port);
    activeClients.push(client);

    const statsMsg = await client.waitForMessage((m) => m.type === 'MODEL_STATS');
    assert.equal(statsMsg.type, 'MODEL_STATS');
    assert.ok(statsMsg.payload.systemOne);
    assert.ok(statsMsg.payload.systemTwo);
    assert.equal(typeof statsMsg.payload.systemOne.status, 'string');
    assert.equal(typeof statsMsg.payload.systemTwo.status, 'string');
  });

  it('strictly preserves DAEMON_STATUS backward compatibility when no engine is attached', async () => {
    const client = await connectClient(server.port);
    activeClients.push(client);

    const initialMsg = await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');
    assert.equal(initialMsg.type, 'DAEMON_STATUS');
    // Exact property count check matching wsServer.test.ts:179
    assert.deepEqual(initialMsg.payload, {
      isRunning: false,
      layaReady: false,
      activeTaskId: null
    });
  });

  it('attaches activeModel metadata to DAEMON_STATUS when layaEngine is present', async () => {
    const engine = new LayaEngine();
    const serverWithEngine = new ScoutWsServer({ port: 0, db, layaEngine: engine });
    await serverWithEngine.waitForReady();

    const client = await connectClient(serverWithEngine.port);
    activeClients.push(client);

    const statusMsg = await client.waitForMessage((m) => m.type === 'DAEMON_STATUS');
    assert.equal(statusMsg.type, 'DAEMON_STATUS');
    assert.ok(statusMsg.payload.activeModel);
    assert.ok(statusMsg.payload.activeModel.systemOne);
    assert.ok(statusMsg.payload.activeModel.systemTwo);

    await serverWithEngine.close();
  });

  it('broadcasts MODEL_STATS when setLayaReady is invoked', async () => {
    const client = await connectClient(server.port);
    activeClients.push(client);

    // Consume initial MODEL_STATS
    await client.waitForMessage((m) => m.type === 'MODEL_STATS');

    server.setLayaReady(true);

    const updatedMsg = await client.waitForMessage(
      (m) => m.type === 'MODEL_STATS' && m.payload.systemOne.status === 'ready'
    );
    assert.equal(updatedMsg.payload.systemOne.status, 'ready');

    server.setLayaReady(false);
    const idleMsg = await client.waitForMessage(
      (m) => m.type === 'MODEL_STATS' && m.payload.systemOne.status === 'idle'
    );
    assert.equal(idleMsg.payload.systemOne.status, 'idle');
  });

  it('handles GET_MODEL_STATS RPC message and returns MODEL_STATS response', async () => {
    const client = await connectClient(server.port);
    activeClients.push(client);

    // Discard initial connect messages
    await client.waitForMessage((m) => m.type === 'MODEL_STATS');

    client.send({ type: 'GET_MODEL_STATS' });

    const reply = await client.waitForMessage((m) => m.type === 'MODEL_STATS');
    assert.equal(reply.type, 'MODEL_STATS');
    assert.ok(reply.payload.systemOne);
    assert.ok(reply.payload.systemTwo);
  });

  it('updates System 2 status and broadcasts MODEL_STATS on SET_MODEL', async () => {
    const client = await connectClient(server.port);
    activeClients.push(client);

    // Discard initial messages
    await client.waitForMessage((m) => m.type === 'MODEL_STATS');

    client.send({
      type: 'SET_MODEL',
      payload: { model: 'llama3.3:70b' }
    });

    const loadingOrReadyStats = await client.waitForMessage(
      (m) => m.type === 'MODEL_STATS' && m.payload.systemTwo.modelName === 'llama3.3:70b'
    );
    assert.equal(loadingOrReadyStats.payload.systemTwo.modelName, 'llama3.3:70b');
  });

  it('broadcasts MODEL_STATS with loading and ready states on COMPILE_TASK', async () => {
    const client = await connectClient(server.port);
    activeClients.push(client);

    await client.waitForMessage((m) => m.type === 'MODEL_STATS');

    client.send({
      type: 'COMPILE_TASK',
      payload: { userGoal: 'Monitor tech headlines' }
    });

    // Should receive compilation progress and model stats
    const progressMsg = await client.waitForMessage(
      (m) => m.type === 'COMPILATION_PROGRESS' && m.payload.status === 'ready'
    );
    assert.equal(progressMsg.type, 'COMPILATION_PROGRESS');

    const finalStats = server.getModelStats();
    assert.equal(finalStats.systemTwo.status, 'ready');
  });
});
