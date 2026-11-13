import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ScoutDatabase } from '../src/db.js';
import type { CompiledTaskSpec, InferenceTelemetryItem } from '@ofln-scout/shared';

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
});
