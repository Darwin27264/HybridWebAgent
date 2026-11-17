import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ScoutDatabase } from '../src/db.js';
import type {
  CompiledTaskSpec,
  InferenceTelemetryItem,
  TaskCheckpoint,
  AgentAction
} from '@ofln-scout/shared';

describe('ScoutDatabase (Unit & Integration)', () => {
  let db: ScoutDatabase;

  const mockSpec: CompiledTaskSpec = {
    id: 'task-101',
    name: 'HN AI Monitor',
    userGoal: 'Find posts about local LLMs with > 50 points',
    targetUrl: 'https://news.ycombinator.com',
    domSelector: '.athing',
    pollIntervalMs: 5000,
    scrollStepPx: 400,
    questions: {
      is_local_ai: {
        type: 'noul',
        statement: 'This post discusses offline or local LLM inference'
      },
      sentiment: {
        type: 'choice',
        question: 'What is the sentiment towards the tool?',
        options: {
          pos: 'Positive',
          neu: 'Neutral',
          neg: 'Negative'
        }
      }
    },
    alertRule: {
      questionKey: 'is_local_ai',
      operator: 'boolean_true',
      targetValue: true,
      minAnswerConfidence: 0.85
    },
    createdAt: 1731360000000
  };

  const mockAlert1: InferenceTelemetryItem = {
    id: 'alert-1',
    taskId: 'task-101',
    timestamp: 1731360010000,
    domSnippet: '<tr class="athing"><td>Show HN: Local LLM in browser</td></tr>',
    latencyMs: 38.4,
    rawAnswers: {
      is_local_ai: {
        answer: true,
        answer_confidence: 0.94,
        confidence: 0.94
      }
    },
    triggeredAlert: true
  };

  const mockAlert2: InferenceTelemetryItem = {
    id: 'alert-2',
    taskId: 'task-101',
    timestamp: 1731360020000,
    domSnippet: '<tr class="athing"><td>Ask HN: Best offline vector DB?</td></tr>',
    latencyMs: 42.1,
    rawAnswers: {
      is_local_ai: {
        answer: true,
        answer_confidence: 0.89,
        confidence: 0.89
      }
    },
    triggeredAlert: true
  };

  beforeEach(() => {
    db = new ScoutDatabase(':memory:');
  });

  afterEach(() => {
    if (db.isOpen) {
      db.close();
    }
  });

  it('initializes PRAGMAs correctly', () => {
    const raw = db.rawDb;
    const synch = raw.pragma('synchronous', { simple: true });
    // In better-sqlite3: 1 = NORMAL
    assert.equal(synch, 1, 'synchronous should be NORMAL (1)');

    const fk = raw.pragma('foreign_keys', { simple: true });
    assert.equal(fk, 1, 'foreign_keys should be ON (1)');
  });

  it('inserts and retrieves a task specification', () => {
    db.insertTask(mockSpec);
    const retrieved = db.getTask(mockSpec.id);

    assert.ok(retrieved, 'retrieved task should not be null');
    assert.equal(retrieved.id, mockSpec.id);
    assert.equal(retrieved.name, mockSpec.name);
    assert.equal(retrieved.userGoal, mockSpec.userGoal);
    assert.equal(retrieved.targetUrl, mockSpec.targetUrl);
    assert.equal(retrieved.domSelector, mockSpec.domSelector);
    assert.equal(retrieved.pollIntervalMs, mockSpec.pollIntervalMs);
    assert.equal(retrieved.scrollStepPx, mockSpec.scrollStepPx);
    assert.deepEqual(retrieved.questions, mockSpec.questions);
    assert.deepEqual(retrieved.alertRule, mockSpec.alertRule);
    assert.equal(retrieved.createdAt, mockSpec.createdAt);
  });

  it('returns null for non-existent task id', () => {
    const nonExistent = db.getTask('non-existent-task-999');
    assert.equal(nonExistent, null);
  });

  it('updates task specification upon conflict without error', () => {
    db.insertTask(mockSpec);
    const updatedSpec: CompiledTaskSpec = {
      ...mockSpec,
      name: 'Updated Task Name',
      pollIntervalMs: 10000
    };
    db.insertTask(updatedSpec);

    const retrieved = db.getTask(mockSpec.id);
    assert.ok(retrieved);
    assert.equal(retrieved.name, 'Updated Task Name');
    assert.equal(retrieved.pollIntervalMs, 10000);
  });

  it('lists tasks in descending order of createdAt', () => {
    const specOld = { ...mockSpec, id: 'task-old', createdAt: 1000 };
    const specNew = { ...mockSpec, id: 'task-new', createdAt: 5000 };
    db.insertTask(specOld);
    db.insertTask(specNew);

    const list = db.listTasks();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'task-new');
    assert.equal(list[1].id, 'task-old');
  });

  it('enforces foreign key constraint when inserting alerts', () => {
    // Attempting to insert an alert for a task that does not exist should throw
    const orphanAlert = { ...mockAlert1, taskId: 'ghost-task-404' };
    assert.throws(
      () => {
        db.insertAlert(orphanAlert);
      },
      /FOREIGN KEY constraint failed/i
    );
  });

  it('inserts and lists alerts in descending timestamp order', () => {
    db.insertTask(mockSpec);
    db.insertAlert(mockAlert1); // timestamp 1731360010000
    db.insertAlert(mockAlert2); // timestamp 1731360020000

    const alerts = db.listAlerts();
    assert.equal(alerts.length, 2);
    // Descending order: alert-2 (newer) comes first
    assert.equal(alerts[0].id, 'alert-2');
    assert.equal(alerts[1].id, 'alert-1');
    assert.equal(alerts[0].latencyMs, 42.1);
    assert.deepEqual(alerts[0].rawAnswers, mockAlert2.rawAnswers);
    assert.equal(alerts[0].triggeredAlert, true);
  });

  it('filters alerts by taskId', () => {
    const task2: CompiledTaskSpec = {
      ...mockSpec,
      id: 'task-202'
    };
    db.insertTask(mockSpec);
    db.insertTask(task2);

    const alertTask2: InferenceTelemetryItem = {
      ...mockAlert1,
      id: 'alert-task-2',
      taskId: 'task-202'
    };

    db.insertAlert(mockAlert1);
    db.insertAlert(alertTask2);

    const filtered = db.listAlerts('task-202');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'alert-task-2');

    const filtered1 = db.listAlerts('task-101');
    assert.equal(filtered1.length, 1);
    assert.equal(filtered1[0].id, 'alert-1');
  });

  it('cascades delete from task to alerts', () => {
    db.insertTask(mockSpec);
    db.insertAlert(mockAlert1);
    db.insertAlert(mockAlert2);

    assert.equal(db.listAlerts().length, 2);

    // Delete task
    db.deleteTask(mockSpec.id);

    // Associated alerts should be deleted by cascade
    assert.equal(db.listAlerts().length, 0);
  });

  it('clears alerts by taskId or all alerts', () => {
    const task2: CompiledTaskSpec = {
      ...mockSpec,
      id: 'task-202'
    };
    db.insertTask(mockSpec);
    db.insertTask(task2);

    db.insertAlert(mockAlert1);
    db.insertAlert({ ...mockAlert2, id: 'alert-for-task2', taskId: 'task-202' });

    assert.equal(db.listAlerts().length, 2);

    // Clear alerts for task-101 only
    db.clearAlerts('task-101');
    assert.equal(db.listAlerts('task-101').length, 0);
    assert.equal(db.listAlerts('task-202').length, 1);

    // Clear all alerts
    db.clearAlerts();
    assert.equal(db.listAlerts().length, 0);
  });

  it('executes WAL checkpoint and closes connection cleanly', () => {
    assert.equal(db.isOpen, true);
    db.close();
    assert.equal(db.isOpen, false);
    // Double close should not throw
    db.close();
  });

  it('persists data across disk file reconnects', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-db-test-'));
    const tempDbPath = path.join(tempDir, 'test_scout.db');

    try {
      // 1. Open disk DB and insert data
      const diskDb = new ScoutDatabase(tempDbPath);
      const pragmaJournal = diskDb.rawDb.pragma('journal_mode', { simple: true });
      assert.equal(pragmaJournal, 'wal', 'Disk DB must use WAL journal mode');

      diskDb.insertTask(mockSpec);
      diskDb.insertAlert(mockAlert1);
      diskDb.close();

      // 2. Reopen DB from same file and verify contents exist
      const diskDbReopened = new ScoutDatabase(tempDbPath);
      const fetchedTask = diskDbReopened.getTask(mockSpec.id);
      assert.ok(fetchedTask);
      assert.equal(fetchedTask.name, mockSpec.name);

      const fetchedAlerts = diskDbReopened.listAlerts(mockSpec.id);
      assert.equal(fetchedAlerts.length, 1);
      assert.equal(fetchedAlerts[0].id, mockAlert1.id);

      diskDbReopened.close();
    } finally {
      // Cleanup temp files
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  // ===================== Checkpoint & Action Test Suites =====================

  it('saves, retrieves, and updates task checkpoints (CRUD)', () => {
    db.insertTask(mockSpec);

    const chk: TaskCheckpoint = {
      id: 'chk-001',
      taskId: mockSpec.id,
      runId: 'run-101',
      createdAt: 1731360000000,
      updatedAt: 1731360010000,
      status: 'paused',
      targetUrl: mockSpec.targetUrl,
      currentUrl: 'https://news.ycombinator.com/item?id=123',
      pageTitle: 'Item Detail',
      scroll: {
        y: 650,
        scrollHeight: 2400,
        viewportHeight: 800,
      },
      totalScanned: 25,
      totalAlerts: 3,
      activeStepCount: 8,
      dedupHashes: ['hash-a', 'hash-b'],
      modelConfig: {
        systemOneModel: 'modernbert-onnx-fp32',
        systemTwoModel: 'qwen2.5:3b',
      },
      wizardState: {
        currentPage: 3,
        userGoal: mockSpec.userGoal,
      },
      chatContext: [
        { role: 'user', text: 'Find offline tools', timestamp: 1731360001000 },
        { role: 'assistant', text: 'Searching...', timestamp: 1731360002000 },
      ],
    };

    db.saveCheckpoint(chk);

    const retrieved = db.getCheckpoint('chk-001');
    assert.ok(retrieved, 'retrieved checkpoint should not be null');
    assert.equal(retrieved.id, 'chk-001');
    assert.equal(retrieved.taskId, mockSpec.id);
    assert.equal(retrieved.runId, 'run-101');
    assert.equal(retrieved.createdAt, 1731360000000);
    assert.equal(retrieved.updatedAt, 1731360010000);
    assert.equal(retrieved.status, 'paused');
    assert.equal(retrieved.targetUrl, mockSpec.targetUrl);
    assert.equal(retrieved.currentUrl, 'https://news.ycombinator.com/item?id=123');
    assert.equal(retrieved.pageTitle, 'Item Detail');
    assert.deepEqual(retrieved.scroll, { y: 650, scrollHeight: 2400, viewportHeight: 800 });
    assert.equal(retrieved.totalScanned, 25);
    assert.equal(retrieved.totalAlerts, 3);
    assert.equal(retrieved.activeStepCount, 8);
    assert.deepEqual(retrieved.dedupHashes, ['hash-a', 'hash-b']);
    assert.deepEqual(retrieved.modelConfig, {
      systemOneModel: 'modernbert-onnx-fp32',
      systemTwoModel: 'qwen2.5:3b',
    });
    assert.deepEqual(retrieved.wizardState, {
      currentPage: 3,
      userGoal: mockSpec.userGoal,
    });
    assert.equal(retrieved.chatContext?.length, 2);
    assert.equal(retrieved.chatContext?.[0].role, 'user');
    assert.equal(retrieved.chatContext?.[1].text, 'Searching...');

    // Non-existent id
    assert.equal(db.getCheckpoint('non-existent-chk'), null);

    // Update on conflict
    const updatedChk: TaskCheckpoint = {
      ...chk,
      status: 'running',
      updatedAt: 1731360020000,
      totalScanned: 30,
      activeStepCount: 10,
    };
    db.saveCheckpoint(updatedChk);

    const retrievedAfterUpdate = db.getCheckpoint('chk-001');
    assert.ok(retrievedAfterUpdate);
    assert.equal(retrievedAfterUpdate.status, 'running');
    assert.equal(retrievedAfterUpdate.updatedAt, 1731360020000);
    assert.equal(retrievedAfterUpdate.totalScanned, 30);
    assert.equal(retrievedAfterUpdate.activeStepCount, 10);
  });

  it('retrieves latest checkpoint and lists multiple checkpoints by taskId ordered by updatedAt DESC', () => {
    db.insertTask(mockSpec);

    const baseCheckpoint = {
      taskId: mockSpec.id,
      runId: 'run-101',
      status: 'paused' as const,
      targetUrl: mockSpec.targetUrl,
      currentUrl: mockSpec.targetUrl,
      scroll: { y: 100, scrollHeight: 1000, viewportHeight: 500 },
      totalScanned: 10,
      totalAlerts: 1,
      activeStepCount: 3,
      dedupHashes: [],
    };

    db.saveCheckpoint({ ...baseCheckpoint, id: 'chk-1', createdAt: 1000, updatedAt: 2000 });
    db.saveCheckpoint({ ...baseCheckpoint, id: 'chk-2', createdAt: 1000, updatedAt: 4000 });
    db.saveCheckpoint({ ...baseCheckpoint, id: 'chk-3', createdAt: 1000, updatedAt: 3000 });

    const latest = db.getLatestCheckpoint(mockSpec.id);
    assert.ok(latest);
    assert.equal(latest.id, 'chk-2', 'latest should have updatedAt = 4000');

    const list = db.listCheckpoints(mockSpec.id);
    assert.equal(list.length, 3);
    assert.equal(list[0].id, 'chk-2');
    assert.equal(list[1].id, 'chk-3');
    assert.equal(list[2].id, 'chk-1');

    assert.equal(db.getLatestCheckpoint('ghost-task-id'), null);
    assert.deepEqual(db.listCheckpoints('ghost-task-id'), []);
  });

  it('deletes checkpoint by id', () => {
    db.insertTask(mockSpec);

    const chk: TaskCheckpoint = {
      id: 'chk-del',
      taskId: mockSpec.id,
      runId: 'run-del',
      createdAt: 1000,
      updatedAt: 1000,
      status: 'stopped',
      targetUrl: mockSpec.targetUrl,
      currentUrl: mockSpec.targetUrl,
      scroll: { y: 0, scrollHeight: 1000, viewportHeight: 800 },
      totalScanned: 0,
      totalAlerts: 0,
      activeStepCount: 0,
      dedupHashes: [],
    };

    db.saveCheckpoint(chk);
    assert.ok(db.getCheckpoint('chk-del'));

    const deleted = db.deleteCheckpoint('chk-del');
    assert.equal(deleted, true);
    assert.equal(db.getCheckpoint('chk-del'), null);

    // Deleting again returns false
    assert.equal(db.deleteCheckpoint('chk-del'), false);
  });

  it('enforces foreign key constraints and cascades deletion from task to checkpoints', () => {
    const orphanChk: TaskCheckpoint = {
      id: 'chk-orphan',
      taskId: 'ghost-task-999',
      runId: 'run-orphan',
      createdAt: 1000,
      updatedAt: 1000,
      status: 'paused',
      targetUrl: 'https://example.com',
      currentUrl: 'https://example.com',
      scroll: { y: 0, scrollHeight: 1000, viewportHeight: 800 },
      totalScanned: 0,
      totalAlerts: 0,
      activeStepCount: 0,
      dedupHashes: [],
    };

    assert.throws(
      () => {
        db.saveCheckpoint(orphanChk);
      },
      /FOREIGN KEY constraint failed/i
    );

    // Now test cascade deletion
    db.insertTask(mockSpec);
    db.saveCheckpoint({ ...orphanChk, id: 'chk-cascade-1', taskId: mockSpec.id });
    db.saveCheckpoint({ ...orphanChk, id: 'chk-cascade-2', taskId: mockSpec.id });

    assert.equal(db.listCheckpoints(mockSpec.id).length, 2);

    // Delete parent task
    db.deleteTask(mockSpec.id);

    // Checkpoints should be deleted by foreign key cascade
    assert.equal(db.listCheckpoints(mockSpec.id).length, 0);
    assert.equal(db.getCheckpoint('chk-cascade-1'), null);
    assert.equal(db.getCheckpoint('chk-cascade-2'), null);
  });

  it('persists and lists agent actions by runId ordered by timestamp ASC', () => {
    const act1: AgentAction = {
      id: 'act-1',
      taskId: mockSpec.id,
      timestamp: 3000,
      type: 'scroll',
      status: 'success',
      message: 'Scrolled 400px down',
    };
    const act2: AgentAction = {
      id: 'act-2',
      taskId: mockSpec.id,
      timestamp: 1000,
      type: 'navigation',
      status: 'success',
      message: 'Navigated to target URL',
    };
    const act3: AgentAction = {
      id: 'act-3',
      taskId: mockSpec.id,
      timestamp: 2000,
      type: 'interaction',
      status: 'success',
      message: 'Filled search input with "local LLM"',
      details: { selector: 'input#search-box', value: 'local LLM' },
    };
    const actOtherRun: AgentAction = {
      id: 'act-other',
      taskId: mockSpec.id,
      timestamp: 1500,
      type: 'alert',
      status: 'warning',
      message: 'Alert triggered',
    };

    db.saveAgentAction(act1, 'run-alpha');
    db.saveAgentAction(act2, 'run-alpha');
    db.saveAgentAction(act3, 'run-alpha');
    db.saveAgentAction(actOtherRun, 'run-beta');

    const alphaActions = db.listAgentActions('run-alpha');
    assert.equal(alphaActions.length, 3);
    // Ordered by timestamp ASC: act-2 (1000), act-3 (2000), act-1 (3000)
    assert.equal(alphaActions[0].id, 'act-2');
    assert.equal(alphaActions[1].id, 'act-3');
    assert.equal(alphaActions[2].id, 'act-1');

    assert.equal(alphaActions[1].type, 'interaction');
    assert.equal(alphaActions[1].message, 'Filled search input with "local LLM"');
    assert.deepEqual(alphaActions[1].details, { selector: 'input#search-box', value: 'local LLM' });
    assert.equal(alphaActions[1].taskId, mockSpec.id);

    const betaActions = db.listAgentActions('run-beta');
    assert.equal(betaActions.length, 1);
    assert.equal(betaActions[0].id, 'act-other');

    assert.deepEqual(db.listAgentActions('non-existent-run'), []);
  });

  it('auto-generates unique action id when id is omitted', () => {
    const actionWithoutId: any = {
      taskId: mockSpec.id,
      timestamp: Date.now(),
      type: 'system',
      status: 'success',
      message: 'Daemon initialized',
    };

    db.saveAgentAction(actionWithoutId, 'run-auto-id');
    const actions = db.listAgentActions('run-auto-id');
    assert.equal(actions.length, 1);
    assert.ok(actions[0].id.startsWith('act_'), 'id should start with act_');
  });

  it('persists checkpoints and agent actions across disk reconnects', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-chk-test-'));
    const tempDbPath = path.join(tempDir, 'test_checkpoints.db');

    try {
      const diskDb = new ScoutDatabase(tempDbPath);
      diskDb.insertTask(mockSpec);

      const chk: TaskCheckpoint = {
        id: 'chk-disk-01',
        taskId: mockSpec.id,
        runId: 'run-disk',
        createdAt: 1731360000000,
        updatedAt: 1731360010000,
        status: 'interrupted',
        targetUrl: mockSpec.targetUrl,
        currentUrl: mockSpec.targetUrl,
        scroll: { y: 800, scrollHeight: 3000, viewportHeight: 900 },
        totalScanned: 50,
        totalAlerts: 5,
        activeStepCount: 12,
        dedupHashes: ['h1', 'h2'],
        modelConfig: { systemOneModel: 'm1' },
      };
      diskDb.saveCheckpoint(chk);

      const action: AgentAction = {
        id: 'act-disk-01',
        taskId: mockSpec.id,
        timestamp: 1731360005000,
        type: 'interaction',
        status: 'success',
        message: 'Action on disk',
        details: { step: 12 },
      };
      diskDb.saveAgentAction(action, 'run-disk');
      diskDb.close();

      // Reopen from disk
      const reopenedDb = new ScoutDatabase(tempDbPath);
      const loadedChk = reopenedDb.getCheckpoint('chk-disk-01');
      assert.ok(loadedChk);
      assert.equal(loadedChk.status, 'interrupted');
      assert.equal(loadedChk.totalScanned, 50);
      assert.deepEqual(loadedChk.dedupHashes, ['h1', 'h2']);
      assert.deepEqual(loadedChk.modelConfig, { systemOneModel: 'm1' });

      const loadedActions = reopenedDb.listAgentActions('run-disk');
      assert.equal(loadedActions.length, 1);
      assert.equal(loadedActions[0].id, 'act-disk-01');
      assert.equal(loadedActions[0].type, 'interaction');
      assert.deepEqual(loadedActions[0].details, { step: 12 });

      reopenedDb.close();
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
