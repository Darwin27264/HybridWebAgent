import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { ScoutWsServer } from '../src/wsServer.js';
import { ScoutDatabase } from '../src/db.js';
import { ResultsStore } from '../src/resultsStore.js';
import type {
  CompiledTaskSpec,
  WsServerToClientMessage,
  WsClientToServerMessage,
  ScrapedItem,
} from '@ofln-scout/shared';

describe('ScoutWsServer Results & Steering Suite', () => {
  let db: ScoutDatabase;
  let server: ScoutWsServer;
  let store: ResultsStore;
  const activeClients: WebSocket[] = [];

  const mockSpec: CompiledTaskSpec = {
    id: 'ws-task-res-1',
    name: 'AI Agent Monitor',
    userGoal: 'Find autonomous AI agent projects and announcements',
    targetUrl: 'https://news.ycombinator.com',
    domSelector: '.athing',
    pollIntervalMs: 2000,
    scrollStepPx: 300,
    questions: {
      is_agent: {
        type: 'noul',
        statement: 'This post announces an autonomous AI agent',
      },
    },
    alertRule: {
      questionKey: 'is_agent',
      operator: 'boolean_true',
      targetValue: true,
      minAnswerConfidence: 0.8,
    },
    createdAt: 1731365000000,
  };

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
      timeoutMs = 4000
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
    store = new ResultsStore(':memory:');
    server = new ScoutWsServer({
      port: 0,
      host: '127.0.0.1',
      db,
      resultsStore: store,
    });
    await server.waitForReady();
  });

  afterEach(async () => {
    for (const ws of activeClients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    activeClients.length = 0;

    await server.close();
    db.close();
  });

  it('1. GET_RESULTS: returns RESULTS_UPDATE with markdown, stats, and items', async () => {
    const port = server.port;
    const client = await connectClient(port);

    // Populate ResultsStore with test items
    store.initTask(mockSpec);
    const item: ScrapedItem = {
      id: 'item-res-01',
      timestamp: '2026-11-12T15:00:00.000Z',
      text: 'Show HN: sysOne Autonomous Agent',
      link: 'https://news.ycombinator.com/item?id=999',
      answers: { topic: 'agent' },
      confidence: 0.95,
      triggeredAlert: true,
    };
    store.recordItem(item, 15.0);

    // Send GET_RESULTS
    client.send({ type: 'GET_RESULTS', payload: { taskId: mockSpec.id } });

    const msg = await client.waitForMessage((m) => m.type === 'RESULTS_UPDATE');
    assert.equal(msg.type, 'RESULTS_UPDATE');
    assert.equal(msg.payload.items.length, 1);
    assert.equal(msg.payload.items[0].id, 'item-res-01');
    assert.equal(msg.payload.stats.totalScanned, 1);
    assert.equal(msg.payload.stats.totalAlerts, 1);
    assert.ok(msg.payload.markdown.includes('Show HN: sysOne Autonomous Agent'));

    await client.close();
  });

  it('2. QUERY_RESULTS: answers aggregate and keyword questions', async () => {
    const port = server.port;
    const client = await connectClient(port);

    store.initTask(mockSpec);
    store.recordItem({
      id: 'item-q-01',
      timestamp: '2026-11-12T15:00:00.000Z',
      text: 'Show HN: Open-source browser agent with WebGPU acceleration',
      link: 'https://news.ycombinator.com/item?id=888',
      answers: { category: 'agent' },
      confidence: 0.92,
      triggeredAlert: true,
    });

    // Query aggregate
    client.send({
      type: 'QUERY_RESULTS',
      payload: { query: 'How many total items were scanned?' },
    });

    const aggResp = await client.waitForMessage((m) => m.type === 'QUERY_RESULTS_RESPONSE');
    assert.equal(aggResp.type, 'QUERY_RESULTS_RESPONSE');
    assert.ok(aggResp.payload.answer.includes('1 total scraped item(s)'));

    // Query keyword
    client.send({
      type: 'QUERY_RESULTS',
      payload: { query: 'Tell me about WebGPU browser agent' },
    });

    const kwResp = await client.waitForMessage((m) => m.type === 'QUERY_RESULTS_RESPONSE');
    assert.equal(kwResp.type, 'QUERY_RESULTS_RESPONSE');
    assert.ok(kwResp.payload.answer.includes('WebGPU acceleration'));
    assert.ok(kwResp.payload.answer.includes('https://news.ycombinator.com/item?id=888'));

    await client.close();
  });

  it('3. STEER_TASK: modifies active task spec and notifies connected clients', async () => {
    const port = server.port;
    const client = await connectClient(port);

    // Save spec to DB and set active
    db.insertTask(mockSpec);
    store.initTask(mockSpec);

    // Steer target URL and scroll speed
    client.send({
      type: 'STEER_TASK',
      payload: {
        instruction: 'Change url to https://reddit.com/r/localllama and scroll step 600',
        taskId: mockSpec.id,
      },
    });

    const steerResp = await client.waitForMessage((m) => m.type === 'STEER_TASK_RESPONSE');
    assert.equal(steerResp.type, 'STEER_TASK_RESPONSE');
    assert.equal(steerResp.payload.applied, true);
    assert.ok(steerResp.payload.explanation.includes('Updated target URL'));
    assert.ok(steerResp.payload.explanation.includes('600px'));

    // Verify DAEMON_NOTIFICATION was broadcast
    const notifMsg = await client.waitForMessage((m) => m.type === 'DAEMON_NOTIFICATION');
    assert.equal(notifMsg.type, 'DAEMON_NOTIFICATION');
    assert.equal(notifMsg.payload.title, 'Task Steered');

    await client.close();
  });

  it('4. STEER_TASK: handles unparseable instructions gracefully', async () => {
    const port = server.port;
    const client = await connectClient(port);

    db.insertTask(mockSpec);

    client.send({
      type: 'STEER_TASK',
      payload: {
        instruction: 'completely invalid gibberish nonsense that cannot be steered',
        taskId: mockSpec.id,
      },
    });

    const steerResp = await client.waitForMessage((m) => m.type === 'STEER_TASK_RESPONSE');
    assert.equal(steerResp.type, 'STEER_TASK_RESPONSE');
    assert.equal(steerResp.payload.applied, false);
    assert.ok(steerResp.payload.explanation.includes('Unable to parse'));

    await client.close();
  });

  it('5. Initial Connection Push: pushes RESULTS_UPDATE if results store has data', async () => {
    // Populate store prior to client connecting
    store.initTask(mockSpec);
    store.recordItem({
      id: 'pre-conn-01',
      timestamp: '2026-11-12T15:00:00.000Z',
      text: 'Pre-existing item',
      answers: {},
      confidence: 0.85,
      triggeredAlert: false,
    });

    const port = server.port;
    const client = await connectClient(port);

    const initialResults = await client.waitForMessage((m) => m.type === 'RESULTS_UPDATE');
    assert.equal(initialResults.type, 'RESULTS_UPDATE');
    assert.equal(initialResults.payload.items.length, 1);
    assert.equal(initialResults.payload.items[0].id, 'pre-conn-01');

    await client.close();
  });

  it('6. STEER_TASK: correctly routes to specified persisted taskId without corrupting unrelated activeSpec', async () => {
    const port = server.port;
    const client = await connectClient(port);

    const taskA: CompiledTaskSpec = {
      ...mockSpec,
      id: 'task-active-A',
      name: 'Task Alpha',
      targetUrl: 'https://alpha.example.com',
    };
    const taskB: CompiledTaskSpec = {
      ...mockSpec,
      id: 'task-persisted-B',
      name: 'Task Beta',
      targetUrl: 'https://beta.example.com',
    };

    db.insertTask(taskA);
    db.insertTask(taskB);

    // Make taskA the active task on the server
    (server as any).activeSpec = { ...taskA };
    (server as any).activeTaskId = taskA.id;

    // Send STEER_TASK explicitly targeting taskB
    client.send({
      type: 'STEER_TASK',
      payload: {
        instruction: 'change target url to https://beta-steered.example.com and scroll step 550',
        taskId: 'task-persisted-B',
      },
    });

    const steerResp = await client.waitForMessage((m) => m.type === 'STEER_TASK_RESPONSE');
    assert.equal(steerResp.type, 'STEER_TASK_RESPONSE');
    assert.equal(steerResp.payload.applied, true);

    // Verify taskB was updated in DB
    const updatedB = db.getTask('task-persisted-B');
    assert.ok(updatedB);
    assert.equal(updatedB.targetUrl, 'https://beta-steered.example.com');
    assert.equal(updatedB.scrollStepPx, 550);

    // Verify active taskA was NOT corrupted or mutated
    assert.equal((server as any).activeSpec.id, 'task-active-A');
    assert.equal((server as any).activeSpec.targetUrl, 'https://alpha.example.com');
    const dbTaskA = db.getTask('task-active-A');
    assert.ok(dbTaskA);
    assert.equal(dbTaskA.targetUrl, 'https://alpha.example.com');

    await client.close();
  });

  it('7. STEER_TASK: rejects non-existent taskId without corrupting activeSpec', async () => {
    const port = server.port;
    const client = await connectClient(port);

    const taskActive: CompiledTaskSpec = {
      ...mockSpec,
      id: 'task-active-running',
      targetUrl: 'https://original-active.com',
    };
    (server as any).activeSpec = { ...taskActive };
    (server as any).activeTaskId = taskActive.id;

    client.send({
      type: 'STEER_TASK',
      payload: {
        instruction: 'change target url to https://hacked.com',
        taskId: 'non-existent-task-id',
      },
    });

    const steerResp = await client.waitForMessage((m) => m.type === 'STEER_TASK_RESPONSE');
    assert.equal(steerResp.type, 'STEER_TASK_RESPONSE');
    assert.equal(steerResp.payload.applied, false);
    assert.equal(steerResp.payload.explanation, 'Task with ID "non-existent-task-id" not found');

    // Confirm activeSpec was untouched
    assert.equal((server as any).activeSpec.id, 'task-active-running');
    assert.equal((server as any).activeSpec.targetUrl, 'https://original-active.com');

    await client.close();
  });
});
