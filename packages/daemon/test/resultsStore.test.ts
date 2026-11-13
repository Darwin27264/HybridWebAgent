import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ResultsStore, resolveResultsPath } from '../src/resultsStore.js';
import type { TaskMetadata } from '../src/resultsStore.js';
import type { ScrapedItem } from '@ofln-scout/shared';

describe('ResultsStore & Markdown Persistence Suite', () => {
  let tempDir: string;
  let tempFilePath: string;

  const mockMeta: TaskMetadata = {
    taskId: 'task-test-01',
    taskName: 'HN AI Monitor',
    userGoal: 'Scrape Hacker News for AI agent announcements',
    targetUrl: 'https://news.ycombinator.com',
    startTime: '2026-11-12T15:00:00.000Z',
    systemOneModel: 'Laya ModernBERT (ONNX Runtime CPU)',
    systemTwoModel: 'qwen2.5',
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-results-test-'));
    tempFilePath = path.join(tempDir, 'results.md');
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it('1. Path Resolution: supports custom path, :memory: mode, and default resolution', () => {
    // Memory mode
    const memStore = new ResultsStore(':memory:');
    assert.equal(memStore.getResultsPath(), ':memory:');

    // Custom path
    const customStore = new ResultsStore(tempFilePath);
    assert.equal(customStore.getResultsPath(), path.resolve(tempFilePath));

    // Options object
    const optStore = new ResultsStore({ filePath: ':memory:' });
    assert.equal(optStore.getResultsPath(), ':memory:');

    // Env var override
    const originalEnv = process.env.SCOUT_RESULTS_PATH;
    try {
      process.env.SCOUT_RESULTS_PATH = path.join(tempDir, 'env-results.md');
      assert.equal(resolveResultsPath(), path.resolve(tempDir, 'env-results.md'));
    } finally {
      process.env.SCOUT_RESULTS_PATH = originalEnv;
    }
  });

  it('2. initTask: writes markdown header metadata and initializes zero stats', () => {
    const store = new ResultsStore(tempFilePath);
    store.initTask(mockMeta);

    const md = store.getMarkdown();
    assert.ok(md.includes('# sysOne Scout Results'));
    assert.ok(md.includes('- **Task ID**: `task-test-01`'));
    assert.ok(md.includes('- **Task Name**: HN AI Monitor'));
    assert.ok(md.includes('- **Goal**: Scrape Hacker News for AI agent announcements'));
    assert.ok(md.includes('- **Target URL**: https://news.ycombinator.com'));
    assert.ok(md.includes('- **System 1 Model**: Laya ModernBERT (ONNX Runtime CPU)'));
    assert.ok(md.includes('- **System 2 Model**: qwen2.5'));
    assert.ok(md.includes('| **Total Scanned** | 0 |'));

    // Check file on disk
    assert.ok(fs.existsSync(tempFilePath));
    const fileContent = fs.readFileSync(tempFilePath, 'utf-8');
    assert.equal(fileContent, md);
  });

  it('3. initTask: supports CompiledTaskSpec with id instead of taskId', () => {
    const store = new ResultsStore(':memory:');
    store.initTask({
      id: 'task-spec-99',
      name: 'GitHub Monitor',
      userGoal: 'Scout trending repos',
      targetUrl: 'https://github.com/trending',
      createdAt: 1700000000000,
    });

    const meta = store.getTaskMetadata();
    assert.ok(meta);
    assert.equal(meta.taskId, 'task-spec-99');
    assert.equal(meta.taskName, 'GitHub Monitor');
    assert.equal(meta.userGoal, 'Scout trending repos');
    assert.ok(meta.startTime);
  });

  it('4. recordItem & addItem: accumulates items, recalculates stats and match rate, updates top categories', () => {
    const store = new ResultsStore(':memory:');
    store.initTask(mockMeta);

    const item1: ScrapedItem = {
      id: 'inf-001',
      timestamp: '2026-11-12T15:05:00.000Z',
      text: 'Show HN: Laya Non-autoregressive inference',
      link: 'https://news.ycombinator.com/item?id=1',
      answers: { topic: 'ai' },
      confidence: 0.95,
      triggeredAlert: true,
    };

    const item2: ScrapedItem = {
      id: 'inf-002',
      timestamp: '2026-11-12T15:06:00.000Z',
      text: 'Ask HN: Best mechanical keyboard for coding?',
      link: 'https://news.ycombinator.com/item?id=2',
      answers: { topic: 'hardware' },
      confidence: 0.88,
      triggeredAlert: false,
    };

    store.recordItem(item1, 20.0);
    store.addItem(item2, 30.0);

    const items = store.getItems();
    assert.equal(items.length, 2);
    assert.equal(items[0].id, 'inf-001');
    assert.equal(items[1].id, 'inf-002');
    assert.equal(store.getItem('inf-001')?.id, 'inf-001');
    assert.equal(store.getItem('nonexistent'), undefined);

    const stats = store.getStats();
    assert.equal(stats.totalScanned, 2);
    assert.equal(stats.totalAlerts, 1);
    assert.equal(stats.matchRatePercent, 50.0);
    assert.equal(stats.avgLatencyMs, 25.0);
    assert.equal(stats.topCategories['ai'], 1);
    assert.equal(stats.topCategories['hardware'], 1);

    const md = store.getMarkdown();
    assert.ok(md.includes('| `inf-001` | 15:05:00 |'));
    assert.ok(md.includes('🚨 **Yes**'));
    assert.ok(md.includes('| `inf-002` | 15:06:00 |'));
    assert.ok(md.includes('No'));
  });

  it('5. updateSummary & setSummary: dynamically updates executive narrative and merges stats overrides', () => {
    const store = new ResultsStore(':memory:');
    store.initTask(mockMeta);

    store.updateSummary('Scanned 15 pages. Found 3 critical AI agent launches.', {
      avgLatencyMs: 18.5,
    });

    assert.equal(store.getSummary(), 'Scanned 15 pages. Found 3 critical AI agent launches.');
    assert.equal(store.getStats().avgLatencyMs, 18.5);

    const md = store.getMarkdown();
    assert.ok(md.includes('Scanned 15 pages. Found 3 critical AI agent launches.'));
    assert.ok(md.includes('| **Average Latency** | 18.5 ms |'));

    // Test setSummary alias
    store.setSummary('Updated narrative summary');
    assert.equal(store.getSummary(), 'Updated narrative summary');
  });

  it('6. Formatting & Escaping: handles markdown table pipes, multi-line snippets, and missing links', () => {
    const store = new ResultsStore(':memory:');
    store.initTask(mockMeta);

    const messyItem: ScrapedItem = {
      id: 'inf-pipe',
      timestamp: '2026-11-12T15:10:00.000Z',
      text: 'Title with | pipes | and \n multiple \n newlines',
      link: undefined,
      answers: {},
      confidence: 0.75,
      triggeredAlert: false,
    };

    store.recordItem(messyItem);
    const md = store.getMarkdown();

    // In table row: pipes must be escaped and newlines replaced
    assert.ok(md.includes('Title with \\| pipes \\| and   multiple   newlines'));
    assert.ok(md.includes('—')); // Missing link displayed as dash

    // In detailed log: original multi-line text is rendered as blockquote
    assert.ok(md.includes('> Title with | pipes | and'));
  });

  it('7. clear: resets internal state and empties destination file', () => {
    const store = new ResultsStore(tempFilePath);
    store.initTask(mockMeta);
    store.recordItem({
      id: 'inf-clear',
      timestamp: '2026-11-12T15:12:00.000Z',
      text: 'Clear test',
      answers: {},
      confidence: 0.9,
      triggeredAlert: true,
    });

    assert.equal(store.getItems().length, 1);
    assert.ok(fs.readFileSync(tempFilePath, 'utf-8').length > 0);

    store.clear();
    assert.equal(store.getItems().length, 0);
    assert.equal(store.getStats().totalScanned, 0);
    assert.equal(store.getTaskMetadata(), null);
    assert.equal(fs.readFileSync(tempFilePath, 'utf-8'), '');
  });

  it('8. Prototype property collision: safe aggregation for Object.prototype property names', () => {
    const store = new ResultsStore(':memory:');
    store.initTask(mockMeta);

    store.recordItem({
      id: 'proto-01',
      timestamp: '2026-11-12T15:20:00.000Z',
      text: 'Prototype property collision test item 1',
      answers: {
        category: 'toString',
        helper: 'valueOf',
      },
      confidence: 0.95,
      triggeredAlert: true,
    });

    store.recordItem({
      id: 'proto-02',
      timestamp: '2026-11-12T15:21:00.000Z',
      text: 'Prototype property collision test item 2',
      answers: {
        type: 'constructor',
        fallback: 'toString',
      },
      confidence: 0.90,
      triggeredAlert: false,
    });

    const stats = store.getStats();
    assert.equal(typeof stats.topCategories['toString'], 'number');
    assert.equal(stats.topCategories['toString'], 2);
    assert.equal(typeof stats.topCategories['valueOf'], 'number');
    assert.equal(stats.topCategories['valueOf'], 1);
    assert.equal(typeof stats.topCategories['constructor'], 'number');
    assert.equal(stats.topCategories['constructor'], 1);

    const md = store.getMarkdown();
    assert.ok(!md.includes('NaN%'), 'Markdown must not contain NaN%');
    assert.ok(md.includes('- **toString**: 2 (100.0%)'));
    assert.ok(md.includes('- **valueOf**: 1 (50.0%)'));
    assert.ok(md.includes('- **constructor**: 1 (50.0%)'));
  });

  it('9. Undefined item.text: renders markdown detailed log without crashing', () => {
    const store = new ResultsStore(':memory:');
    store.initTask(mockMeta);

    // Record item with undefined text
    store.recordItem({
      id: 'no-text-01',
      timestamp: '2026-11-12T15:30:00.000Z',
      text: undefined as any,
      answers: { category: 'fallback' },
      confidence: 0.8,
      triggeredAlert: true,
    });

    assert.doesNotThrow(() => {
      const md = store.getMarkdown();
      assert.ok(md.includes('#### 1. Item `no-text-01`'));
      assert.ok(md.includes('- **Text**:'));
      assert.ok(md.includes('  > '));
    });
  });

  it('10. __proto__ category: retains numeric count in topCategories and displays in markdown ### Top Categories', () => {
    const store = new ResultsStore(':memory:');
    store.initTask(mockMeta);

    store.recordItem({
      id: 'proto-exact-1',
      timestamp: '2026-11-12T16:00:00.000Z',
      text: 'Proto exact check item 1',
      answers: { category: '__proto__' },
      confidence: 0.85,
      triggeredAlert: true,
    });

    store.recordItem({
      id: 'proto-exact-2',
      timestamp: '2026-11-12T16:01:00.000Z',
      text: 'Proto exact check item 2',
      answers: { category: '__proto__' },
      confidence: 0.90,
      triggeredAlert: true,
    });

    const stats = store.getStats();
    assert.equal(typeof stats.topCategories['__proto__'], 'number', "topCategories['__proto__'] must be a number");
    assert.equal(stats.topCategories['__proto__'], 2, "topCategories['__proto__'] count must be 2");
    assert.notDeepEqual(stats.topCategories['__proto__'], {}, "topCategories['__proto__'] must not be an empty prototype object");

    const md = store.getMarkdown();
    assert.ok(md.includes('### Top Categories'), 'Markdown must have ### Top Categories');
    assert.ok(md.includes('- **__proto__**: 2 (100.0%)'), 'Markdown must render __proto__ count and percentage');

    // Also verify updateSummary with __proto__ in topCategories
    store.updateSummary('Updated summary with proto stats', {
      topCategories: { ['__proto__']: 5 },
    });
    const updatedStats = store.getStats();
    assert.equal(typeof updatedStats.topCategories['__proto__'], 'number');
    assert.equal(updatedStats.topCategories['__proto__'], 5);
  });
});
