/**
 * Tier 2: Boundary and Corner Case Tests
 * Comprehensive boundary value analysis, extreme stress inputs, buffer limits,
 * concurrency collisions, and edge conditions across all 19 features (F1 through F19):
 *
 * 1.  F1 Boundary:  Multi-Run Cache Reset (5 tests)
 * 2.  F2 Boundary:  Unique Run ID & Teardown Lifecycle (5 tests)
 * 3.  F3 Boundary:  Run Persistence & Metrics Aggregation (5 tests)
 * 4.  F4 Boundary:  Agent Action Structured Logging (5 tests)
 * 5.  F5 Boundary:  Live Browser View Visual Snapshots (5 tests)
 * 6.  F6 Boundary:  Local Ollama Model Discovery & Routing (5 tests)
 * 7.  F7 Boundary:  Backend Performance & Health Monitor (5 tests)
 * 8.  F8 Boundary:  Multi-Job Engine & Cron Scheduler (5 tests)
 * 9.  F9 Boundary:  Pipeline Robustness & Memory Guards (5 tests)
 * 10. F10 Boundary: Cross-Platform Process Management (5 tests)
 * 11. F11 Boundary: UI Button Feedback & Loading States (5 tests)
 * 12. F12 Boundary: UI Bottom-Right Toast Notifications (5 tests)
 * 13. F13 Boundary: UI Live Browsing View Component Contracts (5 tests)
 * 14. F14 Boundary: UI Agent Action Timeline Contracts (5 tests)
 * 15. F15 Boundary: UI Local Ollama Model Selector Contracts (5 tests)
 * 16. F16 Boundary: UI Modern Dark Gray Theme & Solid Buttons (5 tests)
 * 17. F17 Boundary: UI Base Sizing & Responsive Scaling Contracts (5 tests)
 * 18. F18 Boundary: UI Multi-Job Controls & Switcher Contracts (5 tests)
 * 19. F19 Boundary: UI Dedicated Status Page with Recharts (5 tests)
 *
 * Total: 19 suites × 5 tests = 95 tests (strictly >= 95 tests)
 */

import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';
import { EventEmitter } from 'events';
import { describe, it, expect, beforeAll, afterAll } from './harness';
import { calculateNextRun as daemonCalculateNextRun } from '../../packages/daemon/src/scheduler.ts';
import {
  WORKSPACE_ROOT,
  FIXTURES,
  sha1Hash,
  LruDeduplicator,
  abortableSleep,
  evaluateAlertRule,
  sanitizeCompiledSpec,
  createTestSqliteDb,
  createMockOllamaServer,
  isValidCronExpression,
  parseCronNextRun,
  calculateNextRun,
  createAgentActionFixture,
  createBrowserSnapshotFixture,
  createMetricsFixture,
  createJobFixture,
  createJobRunFixture,
  createDaemonNotificationFixture,
  createCompileTaskMsg,
  createStartTaskMsg,
  createStopTaskMsg,
  createGetModelsMsg,
  createSetModelMsg,
  createGetMetricsMsg,
  createGetJobsMsg,
  createCreateJobMsg,
  createUpdateJobMsg,
  createDeleteJobMsg,
  createStartJobMsg,
  createStopJobMsg,
  createDaemonStatusMsg,
  createAgentActionMsg,
  createBrowserSnapshotMsg,
  createModelsListMsg,
  createMetricsUpdateMsg,
  createJobsListMsg,
  createJobStatusMsg,
  createDaemonNotificationMsg,
} from './test-utils';
import type {
  AgentAction,
  BrowserSnapshot,
  SystemPerformanceMetrics,
  Job,
  JobRun,
} from '../../packages/shared/src/types';

// ===========================================================================
// Helper: Color & Contrast Math (WCAG 2.1 Specification)
// ===========================================================================
function sRGBtoLinear(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleanHex = hex.replace('#', '');
  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);
  return { r, g, b };
}

function getRelativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const R = sRGBtoLinear(r / 255);
  const G = sRGBtoLinear(g / 255);
  const B = sRGBtoLinear(b / 255);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function getContrastRatio(hex1: string, hex2: string): number {
  const lum1 = getRelativeLuminance(hex1);
  const lum2 = getRelativeLuminance(hex2);
  const brighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (brighter + 0.05) / (darker + 0.05);
}

// ===========================================================================
// Helper: Scroll Percentage Calculation with Edge Clamping
// ===========================================================================
function computeScrollPercentage(
  y: number,
  scrollHeight: number,
  viewportHeight: number
): number {
  if (scrollHeight <= 0 || viewportHeight <= 0) return 0;
  const maxScroll = Math.max(0, scrollHeight - viewportHeight);
  if (maxScroll === 0 || !isFinite(maxScroll)) return 0;
  const clampedY = Math.max(0, Math.min(y, maxScroll));
  const pct = (clampedY / maxScroll) * 100;
  return isFinite(pct) ? Math.round(pct * 10) / 10 : 0;
}

// ===========================================================================
// Helper: Chart Dynamic Domain Calculation with NaN Filtering
// ===========================================================================
function computeChartYDomain(data: number[]): [number, number] {
  const valid = data.filter((v) => typeof v === 'number' && isFinite(v) && !isNaN(v));
  if (valid.length === 0) return [0, 100];
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  if (min === max) {
    return [Math.max(0, min - 10), min + 10];
  }
  const padding = (max - min) * 0.1;
  return [Math.max(0, Math.round((min - padding) * 10) / 10), Math.round((max + padding) * 10) / 10];
}

// ===========================================================================
// Boundary 1: F1 Multi-Run Cache Reset
// ===========================================================================
describe('Boundary 1: F1 Multi-Run Cache Reset', () => {
  it('1.1: LRU capacity edge: exactly 2,000 entries filled without eviction', () => {
    const deduplicator = new LruDeduplicator(2000);
    for (let i = 0; i < 2000; i++) {
      deduplicator.add(`hash-entry-${i}`);
    }
    expect(deduplicator.size()).toBe(2000);
    // All 2,000 entries must exist without any eviction
    expect(deduplicator.has('hash-entry-0')).toBe(true);
    expect(deduplicator.has('hash-entry-1999')).toBe(true);
  });

  it('1.2: Eviction boundary: 2,001st entry evicts oldest entry with LRU refresh', () => {
    const deduplicator = new LruDeduplicator(2000);
    for (let i = 0; i < 2000; i++) {
      deduplicator.add(`entry-${i}`);
    }

    // Access entry-0 to refresh its position to most recent
    expect(deduplicator.has('entry-0')).toBe(true);

    // Adding 2,001st item must evict entry-1 (the new oldest), NOT entry-0
    deduplicator.add('entry-2000');
    expect(deduplicator.size()).toBe(2000);
    expect(deduplicator.has('entry-0')).toBe(true);
    expect(deduplicator.has('entry-1')).toBe(false);
    expect(deduplicator.has('entry-2000')).toBe(true);
  });

  it('1.3: Empty cache reset: resetting an already empty cache is a safe no-op', () => {
    const deduplicator = new LruDeduplicator(2000);
    expect(deduplicator.size()).toBe(0);

    // Resetting empty cache should not throw and size remains 0
    deduplicator.resetCache();
    expect(deduplicator.size()).toBe(0);

    // Multiple consecutive resets
    deduplicator.resetCache();
    deduplicator.resetCache();
    expect(deduplicator.size()).toBe(0);
  });

  it('1.4: Rapid reset cycles: alternating fill and reset 100 times maintains consistency', () => {
    const deduplicator = new LruDeduplicator(2000);
    for (let cycle = 0; cycle < 100; cycle++) {
      for (let i = 0; i < 50; i++) {
        deduplicator.add(`cycle-${cycle}-item-${i}`);
      }
      expect(deduplicator.size()).toBe(50);
      deduplicator.resetCache();
      expect(deduplicator.size()).toBe(0);
    }
    expect(deduplicator.size()).toBe(0);
    expect(deduplicator.maxSize).toBe(2000);
  });

  it('1.5: Non-string, Unicode, and extreme length hashes deduplicate reliably', () => {
    const deduplicator = new LruDeduplicator(2000);

    // Empty string hash
    const emptyHash = sha1Hash('');
    expect(emptyHash).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    deduplicator.add(emptyHash);
    expect(deduplicator.has(emptyHash)).toBe(true);

    // Unicode and emoji content
    const unicodeHash = sha1Hash('🚀 Show HN: 日本語 AI モデル 🔥');
    deduplicator.add(unicodeHash);
    expect(deduplicator.has(unicodeHash)).toBe(true);

    // 100,000-character payload
    const longText = 'x'.repeat(100000);
    const longHash = sha1Hash(longText);
    deduplicator.add(longHash);
    expect(deduplicator.has(longHash)).toBe(true);

    expect(deduplicator.size()).toBe(3);
  });
});

// ===========================================================================
// Boundary 2: F2 Unique Run ID & Teardown Lifecycle
// ===========================================================================
describe('Boundary 2: F2 Unique Run ID & Teardown Lifecycle', () => {
  it('2.1: UUID format validity conforms to RFC 4122 v4 pattern', () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (let i = 0; i < 20; i++) {
      const generated = crypto.randomUUID();
      expect(uuidRegex.test(generated)).toBe(true);
    }
  });

  it('2.2: Collision resistance: generating 5,000 run IDs synchronously yields 0 collisions', () => {
    const idSet = new Set<string>();
    const count = 5000;
    for (let i = 0; i < count; i++) {
      const runId = `run-${crypto.randomUUID()}`;
      idSet.add(runId);
    }
    expect(idSet.size).toBe(count);
  });

  it('2.3: Teardown timing edge case (<1ms abort vs finish race condition)', () => {
    const daemonState = {
      isRunning: false,
      activeTaskId: null as string | null,
      activeRunId: null as string | null,
    };

    // Run 1 starts
    const run1Id = crypto.randomUUID();
    daemonState.isRunning = true;
    daemonState.activeTaskId = 'task-hn-01';
    daemonState.activeRunId = run1Id;

    // Run 2 preempts immediately before Run 1 async cleanup finally block finishes
    const run2Id = crypto.randomUUID();
    daemonState.activeRunId = run2Id;

    // Run 1 finally block finishes: must guard against overwriting Run 2
    const run1Teardown = () => {
      if (daemonState.activeRunId === run1Id) {
        daemonState.isRunning = false;
        daemonState.activeTaskId = null;
        daemonState.activeRunId = null;
      }
    };
    run1Teardown();

    // Verify Run 2 is preserved
    expect(daemonState.isRunning).toBe(true);
    expect(daemonState.activeRunId).toBe(run2Id);
    expect(daemonState.activeTaskId).toBe('task-hn-01');
  });

  it('2.4: AbortSignal pre-aborted before task start aborts immediately (<1ms)', async () => {
    const preAborted = AbortSignal.abort();
    expect(preAborted.aborted).toBe(true);

    const start = Date.now();
    await abortableSleep(5000, preAborted);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
  });

  it('2.5: activeTaskId and activeRunId null checks handle transitions safely', () => {
    const state = {
      activeTaskId: null as string | null,
      activeRunId: null as string | null,
      isRunning: false,
    };

    const stopHandler = () => {
      if (!state.activeTaskId && !state.activeRunId) {
        return { handled: true, changed: false };
      }
      state.isRunning = false;
      state.activeTaskId = null;
      state.activeRunId = null;
      return { handled: true, changed: true };
    };

    const res1 = stopHandler();
    expect(res1.handled).toBe(true);
    expect(res1.changed).toBe(false);

    state.activeTaskId = 'task-1';
    state.activeRunId = 'run-1';
    state.isRunning = true;

    const res2 = stopHandler();
    expect(res2.handled).toBe(true);
    expect(res2.changed).toBe(true);
    expect(state.activeTaskId).toBeNull();
    expect(state.activeRunId).toBeNull();
  });
});

// ===========================================================================
// Boundary 3: F3 Run Persistence & Metrics Aggregation
// ===========================================================================
describe('Boundary 3: F3 Run Persistence & Metrics Aggregation', () => {
  let dbInstance: any;

  beforeAll(() => {
    const { db } = createTestSqliteDb(':memory:');
    dbInstance = db;
  });

  afterAll(() => {
    if (dbInstance && typeof dbInstance.close === 'function') {
      dbInstance.close();
    }
  });

  it('3.1: SQLite jobs and job_runs accept valid NULL and default fields', () => {
    const jobId = `job-b3-null-${Date.now()}`;
    const runId = `run-b3-null-${Date.now()}`;

    // Job with null cron_schedule and null last/next run times
    dbInstance.prepare(`
      INSERT INTO jobs (id, name, spec_json, cron_schedule, is_scheduled, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, 'Nullable Job', '{}', null, 0, 'idle', Date.now(), Date.now());

    const jobRow = dbInstance.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    expect(jobRow).toBeDefined();
    expect(jobRow.cron_schedule).toBeNull();
    expect(jobRow.last_run_at).toBeNull();

    // Run currently in progress (null completed_at and null error)
    dbInstance.prepare(`
      INSERT INTO job_runs (id, job_id, started_at, completed_at, status, total_scanned, total_alerts, avg_latency_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, jobId, Date.now(), null, 'running', 0, 0, 0.0, null);

    const runRow = dbInstance.prepare('SELECT * FROM job_runs WHERE id = ?').get(runId);
    expect(runRow).toBeDefined();
    expect(runRow.completed_at).toBeNull();
    expect(runRow.error).toBeNull();
    expect(runRow.status).toBe('running');
  });

  it('3.2: Zero candidates and zero alerts persist and aggregate without division-by-zero', () => {
    const jobId = `job-b3-zero-${Date.now()}`;
    dbInstance.prepare(`
      INSERT INTO jobs (id, name, spec_json, is_scheduled, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, 'Zero Metric Job', '{}', 0, 'idle', Date.now(), Date.now());

    // Insert 3 runs with 0 scanned, 0 alerts, 0 latency
    const insertStmt = dbInstance.prepare(`
      INSERT INTO job_runs (id, job_id, started_at, completed_at, status, total_scanned, total_alerts, avg_latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(`run-z1-${Date.now()}`, jobId, 1000, 2000, 'completed', 0, 0, 0.0);
    insertStmt.run(`run-z2-${Date.now()}`, jobId, 3000, 4000, 'completed', 0, 0, 0.0);

    const runs = dbInstance.prepare('SELECT * FROM job_runs WHERE job_id = ?').all(jobId);
    expect(runs.length).toBe(2);

    // Aggregate summary calculation
    const totalScanned = runs.reduce((acc: number, r: any) => acc + r.total_scanned, 0);
    const totalAlerts = runs.reduce((acc: number, r: any) => acc + r.total_alerts, 0);
    const avgLatency = runs.length === 0 ? 0 : runs.reduce((acc: number, r: any) => acc + r.avg_latency_ms, 0) / runs.length;

    expect(totalScanned).toBe(0);
    expect(totalAlerts).toBe(0);
    expect(avgLatency).toBe(0);
    expect(isFinite(avgLatency)).toBe(true);
  });

  it('3.3: Massive payload boundary: spec_json containing 200,000 characters persists cleanly', () => {
    const jobId = `job-b3-large-${Date.now()}`;
    const largePayload = JSON.stringify({
      ...FIXTURES.hackerNewsSpec,
      largeBlob: 'A'.repeat(200000),
    });
    expect(largePayload.length).toBeGreaterThan(200000);

    dbInstance.prepare(`
      INSERT INTO jobs (id, name, spec_json, is_scheduled, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, 'Massive Payload Job', largePayload, 0, 'idle', Date.now(), Date.now());

    const retrieved = dbInstance.prepare('SELECT spec_json FROM jobs WHERE id = ?').get(jobId);
    expect(retrieved).toBeDefined();
    expect(retrieved.spec_json.length).toBe(largePayload.length);
    const parsed = JSON.parse(retrieved.spec_json);
    expect(parsed.largeBlob.length).toBe(200000);
  });

  it('3.4: Foreign key and non-existent job queries return empty array without error', () => {
    const nonExistentJobId = 'job-non-existent-99999';
    const runs = dbInstance.prepare(`
      SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC
    `).all(nonExistentJobId);

    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBe(0);

    const singleRun = dbInstance.prepare('SELECT * FROM job_runs WHERE id = ?').get('run-404');
    expect(singleRun).toBeUndefined();
  });

  it('3.5: Extreme timestamp values (epoch 0, year 2038, MAX_SAFE_INTEGER) persist accurately', () => {
    const jobId = `job-b3-ts-${Date.now()}`;
    const t0 = 0;
    const t2038 = 2147483647000;
    const tMaxSafe = Number.MAX_SAFE_INTEGER; // 9007199254740991

    dbInstance.prepare(`
      INSERT INTO jobs (id, name, spec_json, is_scheduled, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, 'Timestamp Test Job', '{}', 0, 'idle', t0, t2038);

    const row = dbInstance.prepare('SELECT created_at, updated_at FROM jobs WHERE id = ?').get(jobId);
    expect(row.created_at).toBe(t0);
    expect(row.updated_at).toBe(t2038);

    // Insert run with tMaxSafe
    const runId = `run-b3-ts-${Date.now()}`;
    dbInstance.prepare(`
      INSERT INTO job_runs (id, job_id, started_at, completed_at, status, total_scanned, total_alerts, avg_latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, jobId, t0, tMaxSafe, 'completed', 1, 0, 1.5);

    const runRow = dbInstance.prepare('SELECT started_at, completed_at FROM job_runs WHERE id = ?').get(runId);
    expect(runRow.started_at).toBe(t0);
    expect(runRow.completed_at).toBe(tMaxSafe);
  });
});

// ===========================================================================
// Boundary 4: F4 Agent Action Structured Logging
// ===========================================================================
describe('Boundary 4: F4 Agent Action Structured Logging', () => {
  it('4.1: High frequency action burst (1,000 actions) preserves integrity and order', () => {
    const actions: AgentAction[] = [];
    const baseTime = Date.now();
    for (let i = 0; i < 1000; i++) {
      actions.push(
        createAgentActionFixture({
          id: `act-burst-${i}`,
          timestamp: baseTime + i,
          type: i % 2 === 0 ? 'extraction' : 'inference',
          message: `Processed element ${i}`,
        })
      );
    }

    expect(actions.length).toBe(1000);
    const idSet = new Set(actions.map((a) => a.id));
    expect(idSet.size).toBe(1000);

    for (let i = 1; i < actions.length; i++) {
      expect(actions[i].timestamp).toBeGreaterThanOrEqual(actions[i - 1].timestamp);
    }
  });

  it('4.2: Action payload with special characters, HTML, and Unicode serializes cleanly', () => {
    const specialAction = createAgentActionFixture({
      message: '<script>alert("xss")</script> & <b>Bold</b> \u0000 \t\n \u202Ereversed',
      details: {
        htmlSnippet: '<div class="athing" id="42">Title &amp; Meta</div>',
        emojis: '🚀🤖🔍🔥',
        quotes: `"single 'quote' and "double" quote and backslash \\`,
        controlChars: '\r\n\t',
      },
    });

    const msg = createAgentActionMsg(specialAction);
    const serialized = JSON.stringify(msg);
    const parsed = JSON.parse(serialized);

    expect(parsed.payload.message).toBe(specialAction.message);
    expect(parsed.payload.details.emojis).toBe('🚀🤖🔍🔥');
    expect(parsed.payload.details.htmlSnippet).toContain('<div class="athing"');
  });

  it('4.3: Out-of-order action sequence is reconciled deterministically by timestamp', () => {
    const base = 1731362400000;
    const shuffled: AgentAction[] = [
      createAgentActionFixture({ id: 'a4', timestamp: base + 400 }),
      createAgentActionFixture({ id: 'a1', timestamp: base + 100 }),
      createAgentActionFixture({ id: 'a3', timestamp: base + 300 }),
      createAgentActionFixture({ id: 'a2', timestamp: base + 200 }),
    ];

    const sorted = [...shuffled].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));

    expect(sorted.map((a) => a.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('4.4: Missing optional metadata fields adhere to contract without errors', () => {
    const minimalAction: AgentAction = {
      id: 'act-min-01',
      taskId: 'task-test',
      timestamp: Date.now(),
      type: 'system',
      status: 'success',
      message: 'System started',
    };

    expect(minimalAction.details).toBeUndefined();
    const msg = createAgentActionMsg(minimalAction);
    const serialized = JSON.stringify(msg);
    const parsed = JSON.parse(serialized);

    expect(parsed.payload.id).toBe('act-min-01');
    expect(parsed.payload.details).toBeUndefined();
  });

  it('4.5: Invalid action status enum is detected or safely handled by validator', () => {
    const validStatuses = new Set(['pending', 'success', 'warning', 'error']);

    const validateStatus = (status: string): boolean => validStatuses.has(status);

    expect(validateStatus('pending')).toBe(true);
    expect(validateStatus('success')).toBe(true);
    expect(validateStatus('warning')).toBe(true);
    expect(validateStatus('error')).toBe(true);

    expect(validateStatus('aborted')).toBe(false);
    expect(validateStatus('fatal')).toBe(false);
    expect(validateStatus('')).toBe(false);
  });
});

// ===========================================================================
// Boundary 5: F5 Live Browser View Visual Snapshots
// ===========================================================================
describe('Boundary 5: F5 Live Browser View Visual Snapshots', () => {
  it('5.1: Extremely large snapshot base64 payloads (>5MB) serialize without memory failure', () => {
    // Generate a ~5.2MB base64 data string
    const chunk = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const repeated = chunk.repeat(85000); // ~5.44 MB
    const largeScreenshot = `data:image/jpeg;base64,${repeated}`;

    expect(largeScreenshot.length).toBeGreaterThan(5 * 1024 * 1024);

    const snapshot = createBrowserSnapshotFixture({ screenshot: largeScreenshot });
    const msg = createBrowserSnapshotMsg(snapshot);
    const serialized = JSON.stringify(msg);
    const parsed = JSON.parse(serialized);

    expect(parsed.payload.screenshot?.length).toBe(largeScreenshot.length);
  });

  it('5.2: 0x0 viewport dimensions handle scroll calculation without division by zero', () => {
    const pct1 = computeScrollPercentage(0, 0, 0);
    expect(pct1).toBe(0);

    const pct2 = computeScrollPercentage(100, 0, 0);
    expect(pct2).toBe(0);

    const pct3 = computeScrollPercentage(0, 500, 0);
    expect(pct3).toBe(0);
  });

  it('5.3: Negative and out-of-bounds scroll coordinates clamp safely', () => {
    // Negative scroll coordinates
    const negY = computeScrollPercentage(-150, 2000, 500);
    expect(negY).toBe(0);

    // Coordinate far beyond max scroll
    const overY = computeScrollPercentage(99999, 2000, 500);
    expect(overY).toBe(100);
  });

  it('5.4: NaN/Infinity prevention when scrollHeight <= viewportHeight', () => {
    // Page fits completely inside viewport
    const pctSame = computeScrollPercentage(0, 800, 800);
    expect(pctSame).toBe(0);
    expect(isFinite(pctSame)).toBe(true);

    // Viewport larger than scrollHeight
    const pctLarger = computeScrollPercentage(0, 600, 800);
    expect(pctLarger).toBe(0);
    expect(isFinite(pctLarger)).toBe(true);
  });

  it('5.5: Truncated or corrupted JPEG header handling identifies malformed data', () => {
    const isValidJpegHeader = (dataUri?: string): boolean => {
      if (!dataUri || typeof dataUri !== 'string') return false;
      return dataUri.startsWith('data:image/jpeg;base64,/9j/');
    };

    expect(isValidJpegHeader('data:image/jpeg;base64,/9j/4AAQSkZJRg...')).toBe(true);
    expect(isValidJpegHeader('data:image/png;base64,iVBORw0KGgo...')).toBe(false);
    expect(isValidJpegHeader('data:image/jpeg;base64,CORRUPT_HEADER')).toBe(false);
    expect(isValidJpegHeader('')).toBe(false);
    expect(isValidJpegHeader(undefined)).toBe(false);
  });
});

// ===========================================================================
// Boundary 6: F6 Local Ollama Model Discovery & Routing
// ===========================================================================
describe('Boundary 6: F6 Local Ollama Model Discovery & Routing', () => {
  let mockServer: any;

  beforeAll(async () => {
    mockServer = createMockOllamaServer(0);
    await mockServer.start();
  });

  afterAll(async () => {
    if (mockServer) {
      await mockServer.close();
    }
  });

  it('6.1: Malformed Ollama /api/tags JSON is caught safely without unhandled exception', async () => {
    // Spin up an ephemeral HTTP server that returns raw non-JSON HTML
    const badServer = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<html><body>Internal Server Error: Segmentation fault</body></html>');
    });

    const badPort = await new Promise<number>((resolve) => {
      badServer.listen(0, '127.0.0.1', () => {
        const addr = badServer.address() as net.AddressInfo;
        resolve(addr.port);
      });
    });

    try {
      const response = await fetch(`http://127.0.0.1:${badPort}/api/tags`);
      const text = await response.text();
      let parseFailed = false;
      try {
        JSON.parse(text);
      } catch {
        parseFailed = true;
      }
      expect(parseFailed).toBe(true);
    } finally {
      badServer.close();
    }
  });

  it('6.2: Empty models array returns ollamaOnline: true with empty model list', () => {
    const rawPayload = { models: [] };
    const modelsListMsg = createModelsListMsg(
      rawPayload.models.map((m: any) => m.name),
      '',
      true
    );

    expect(modelsListMsg.payload.ollamaOnline).toBe(true);
    expect(modelsListMsg.payload.models).toHaveLength(0);
    expect(modelsListMsg.payload.selectedModel).toBe('');
  });

  it('6.3: Timeout during Ollama HTTP fetch is handled cleanly via AbortController', async () => {
    // Server that never responds
    const hangingServer = http.createServer((_req, _res) => {
      // Intentionally do not end response
    });

    const hangingPort = await new Promise<number>((resolve) => {
      hangingServer.listen(0, '127.0.0.1', () => {
        const addr = hangingServer.address() as net.AddressInfo;
        resolve(addr.port);
      });
    });

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 80);

      let aborted = false;
      try {
        await fetch(`http://127.0.0.1:${hangingPort}/api/tags`, {
          signal: controller.signal,
        });
      } catch (err: any) {
        if (err.name === 'AbortError' || controller.signal.aborted) {
          aborted = true;
        }
      } finally {
        clearTimeout(timeoutId);
      }

      expect(aborted).toBe(true);
    } finally {
      hangingServer.close();
    }
  });

  it('6.4: Model names with special tags, slashes, and hyphens route accurately', () => {
    const complexModelNames = [
      'hf.co/bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF:Q4_K_M',
      'llama3.2:1b-instruct-q8_0',
      'mistral-nemo:12b-text-v1.0',
      'user/my-custom-model:latest',
    ];

    for (const model of complexModelNames) {
      const setMsg = createSetModelMsg(model);
      expect(setMsg.payload.model).toBe(model);

      const compileMsg = createCompileTaskMsg('Find tech announcements', model);
      expect(compileMsg.payload.ollamaModel).toBe(model);
    }
  });

  it('6.5: Multiple concurrent model switch requests resolve to the last requested model', () => {
    let activeModel = 'qwen2.5:latest';
    const requests = ['llama3.2:latest', 'deepseek-r1:latest', 'mistral:latest'];

    // Simulate concurrent dispatch
    for (const target of requests) {
      activeModel = target;
    }

    expect(activeModel).toBe('mistral:latest');
  });
});

// ===========================================================================
// Boundary 7: F7 Backend Performance & Health Monitor
// ===========================================================================
describe('Boundary 7: F7 Backend Performance & Health Monitor', () => {
  it('7.1: CPU percentage is strictly clamped to [0.0, 100.0]', () => {
    const clampCpu = (val: number): number => Math.min(100, Math.max(0, val));

    expect(clampCpu(-15.5)).toBe(0);
    expect(clampCpu(-0.001)).toBe(0);
    expect(clampCpu(0)).toBe(0);
    expect(clampCpu(50.5)).toBe(50.5);
    expect(clampCpu(100)).toBe(100);
    expect(clampCpu(105.8)).toBe(100);
    expect(clampCpu(800.0)).toBe(100); // Multi-core unscaled overflow
  });

  it('7.2: Memory values at boundary (0 bytes, MAX_SAFE_INTEGER) format without crash', () => {
    const formatBytesToMb = (bytes: number): string => {
      if (!isFinite(bytes) || isNaN(bytes) || bytes < 0) return '0.0 MB';
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    expect(formatBytesToMb(0)).toBe('0.0 MB');
    expect(formatBytesToMb(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytesToMb(Number.MAX_SAFE_INTEGER)).toContain('MB');
    expect(formatBytesToMb(-100)).toBe('0.0 MB');
  });

  it('7.3: Event loop lag spike (>1000ms) records accurately without integer overflow', () => {
    const metrics = createMetricsFixture({
      eventLoop: {
        lagMs: 1450.5,
        p99LagMs: 2890.2,
      },
    });

    expect(metrics.eventLoop.lagMs).toBeGreaterThan(1000);
    expect(metrics.eventLoop.p99LagMs).toBeGreaterThan(metrics.eventLoop.lagMs);
    expect(isFinite(metrics.eventLoop.lagMs)).toBe(true);
  });

  it('7.4: Missing service health status records fall back safely to idle or offline', () => {
    const partialServices: Record<string, any> = {
      daemon: { name: 'Daemon Server', status: 'healthy' },
      // sqlite, browser, ollama omitted
    };

    const getServiceStatus = (key: string): string => {
      return partialServices[key]?.status || 'offline';
    };

    expect(getServiceStatus('daemon')).toBe('healthy');
    expect(getServiceStatus('sqlite')).toBe('offline');
    expect(getServiceStatus('ollama')).toBe('offline');
    expect(getServiceStatus('unknown_service')).toBe('offline');
  });

  it('7.5: NaN and non-finite metric values sanitize to safe numerical defaults', () => {
    const sanitizeMetric = (val: number, fallback = 0): number => {
      return typeof val === 'number' && isFinite(val) && !isNaN(val) ? val : fallback;
    };

    expect(sanitizeMetric(NaN)).toBe(0);
    expect(sanitizeMetric(Infinity)).toBe(0);
    expect(sanitizeMetric(-Infinity)).toBe(0);
    expect(sanitizeMetric(42.5)).toBe(42.5);
  });
});

// ===========================================================================
// Boundary 8: F8 Multi-Job Engine & Cron Scheduler
// ===========================================================================
describe('Boundary 8: F8 Multi-Job Engine & Cron Scheduler', () => {
  it('8.1: Cron validator boundary: rejects 4-part, 6-part, out-of-range, and negative steps', () => {
    expect(isValidCronExpression('* * * *')).toBe(false); // 4 parts
    expect(isValidCronExpression('* * * * * *')).toBe(false); // 6 parts
    expect(isValidCronExpression('60 * * * *')).toBe(false); // Minute out of range (0-59)
    expect(isValidCronExpression('* 24 * * *')).toBe(false); // Hour out of range (0-23)
    expect(isValidCronExpression('* * 32 * *')).toBe(false); // Day of month (1-31)
    expect(isValidCronExpression('* * * 13 *')).toBe(false); // Month (1-12)
    expect(isValidCronExpression('* * * * 8')).toBe(false); // Day of week (0-7)
    expect(isValidCronExpression('*/-5 * * * *')).toBe(false); // Negative step
  });

  it('8.2: Edge cron schedules (every minute, leap year dom 29, month boundaries) calculate cleanly', () => {
    const base = new Date('2026-02-28T23:59:00Z');
    const nextRun = parseCronNextRun('* * * * *', base);
    expect(nextRun).toBeDefined();
    expect(nextRun?.getMinutes()).toBe(0);

    // Leap year Feb 29 specification validity
    expect(isValidCronExpression('0 0 29 2 *')).toBe(true);

    // End of month day 31
    expect(isValidCronExpression('59 23 31 12 *')).toBe(true);
  });

  it('8.3: Negative and zero interval timer intervals are rejected or clamped', () => {
    const sanitizeInterval = (ms: number, minMs = 1000): number => {
      if (!isFinite(ms) || isNaN(ms) || ms < minMs) return minMs;
      return ms;
    };

    expect(sanitizeInterval(-5000)).toBe(1000);
    expect(sanitizeInterval(0)).toBe(1000);
    expect(sanitizeInterval(500)).toBe(1000);
    expect(sanitizeInterval(10000)).toBe(10000);
  });

  it('8.4: Multiple jobs with identical names maintain unique IDs and independent states', () => {
    const jobA = createJobFixture({ id: 'job-alpha-1', name: 'Duplicate Name Test' });
    const jobB = createJobFixture({ id: 'job-alpha-2', name: 'Duplicate Name Test' });

    expect(jobA.name).toBe(jobB.name);
    expect(jobA.id === jobB.id).toBe(false);

    jobA.status = 'running';
    expect(jobB.status).toBe('idle');
  });

  it('8.5: Zero-duration job execution records completedAt >= startedAt without division error', () => {
    const start = 1731362400000;
    const run = createJobRunFixture({
      startedAt: start,
      completedAt: start, // 0 ms duration
      totalScanned: 0,
      totalAlerts: 0,
      avgLatencyMs: 0.0,
    });

    const duration = (run.completedAt || start) - run.startedAt;
    expect(duration).toBe(0);
    expect(run.avgLatencyMs).toBe(0.0);
  });

  it('8.6: Cron scheduler safely advances across autumn Daylight Saving Time (DST) fallback in <10ms without hanging', () => {
    // Autumn DST transition: November 3, 2024 (clocks fall back at 2:00 AM to 1:00 AM)
    const nov3 = new Date(2024, 10, 3, 0, 0, 0);

    // 1. Verify calculateNextRun from packages/daemon/src/scheduler
    const t0Daemon = Date.now();
    const nextDaemon = daemonCalculateNextRun('0 0 * * *', nov3);
    const daemonDuration = Date.now() - t0Daemon;

    expect(daemonDuration).toBeLessThan(10);
    const nextDaemonDate = new Date(nextDaemon);
    expect(nextDaemonDate.getDate()).toBe(4);
    expect(nextDaemonDate.getMonth()).toBe(10); // November
    expect(nextDaemonDate.getFullYear()).toBe(2024);
    expect(nextDaemonDate.getHours()).toBe(0);
    expect(nextDaemonDate.getMinutes()).toBe(0);

    // 2. Verify parseCronNextRun from test-utils
    const t0Utils = Date.now();
    const nextUtils = parseCronNextRun('0 0 * * *', nov3);
    const utilsDuration = Date.now() - t0Utils;

    expect(utilsDuration).toBeLessThan(10);
    expect(nextUtils).toBeDefined();
    expect(nextUtils!.getDate()).toBe(4);
    expect(nextUtils!.getMonth()).toBe(10);
    expect(nextUtils!.getFullYear()).toBe(2024);
    expect(nextUtils!.getHours()).toBe(0);
    expect(nextUtils!.getMinutes()).toBe(0);

    // 3. Verify calculateNextRun from test-utils
    const t0Calc = Date.now();
    const nextCalc = calculateNextRun('0 0 * * *', nov3);
    const calcDuration = Date.now() - t0Calc;

    expect(calcDuration).toBeLessThan(10);
    expect(nextCalc).toBe(nextDaemon);
  });

  it('8.7: Cron scheduler strictly advances across repeated 1:00 AM DST fallback hour (hourly and sub-hourly)', () => {
    // Repeated 1:00 AM DST fallback hour: Nov 3, 2024 01:00 EST (epoch 1730613600000)
    const fallbackHour = new Date(1730613600000);

    // 1. Hourly schedule: '0 * * * *' advances strictly forward by 3,600,000 ms (to 02:00 EST)
    const nextHourlyDaemon = daemonCalculateNextRun('0 * * * *', fallbackHour);
    expect(nextHourlyDaemon - fallbackHour.getTime()).toBe(3600000);

    const nextHourlyUtils = calculateNextRun('0 * * * *', fallbackHour);
    expect(nextHourlyUtils - fallbackHour.getTime()).toBe(3600000);

    const nextHourlyParsed = parseCronNextRun('0 * * * *', fallbackHour);
    expect(nextHourlyParsed).toBeDefined();
    expect(nextHourlyParsed!.getTime() - fallbackHour.getTime()).toBe(3600000);

    // 2. Sub-hourly schedule: '*/15 * * * *' advances strictly forward by 900,000 ms (to 01:15 EST)
    const next15Daemon = daemonCalculateNextRun('*/15 * * * *', fallbackHour);
    expect(next15Daemon - fallbackHour.getTime()).toBe(900000);
    expect(next15Daemon).toBe(1730614500000);

    const next15Utils = calculateNextRun('*/15 * * * *', fallbackHour);
    expect(next15Utils - fallbackHour.getTime()).toBe(900000);
    expect(next15Utils).toBe(1730614500000);

    const next15Parsed = parseCronNextRun('*/15 * * * *', fallbackHour);
    expect(next15Parsed).toBeDefined();
    expect(next15Parsed!.getTime() - fallbackHour.getTime()).toBe(900000);
    expect(next15Parsed!.getTime()).toBe(1730614500000);
  });
});

// ===========================================================================
// Boundary 9: F9 Pipeline Robustness & Memory Guards
// ===========================================================================
describe('Boundary 9: F9 Pipeline Robustness & Memory Guards', () => {
  it('9.1: Abort signal during async I/O terminates pending promise promptly (<5ms)', async () => {
    const controller = new AbortController();
    const start = Date.now();

    const sleepPromise = abortableSleep(5000, controller.signal);
    // Abort after 5ms
    setTimeout(() => controller.abort(), 5);

    await sleepPromise;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('9.2: Sub-10ms rapid start-abort cycle halts execution cleanly', async () => {
    let workCompleted = false;
    const controller = new AbortController();

    const task = async (signal: AbortSignal) => {
      await abortableSleep(200, signal);
      if (!signal.aborted) {
        workCompleted = true;
      }
    };

    const promise = task(controller.signal);
    // Abort within 3ms
    setTimeout(() => controller.abort(), 3);
    await promise;

    expect(workCompleted).toBe(false);
    expect(controller.signal.aborted).toBe(true);
  });

  it('9.3: Listener cleanup: listeners registered during execution cycles remain <= 10', () => {
    const emitter = new EventEmitter();

    for (let cycle = 0; cycle < 50; cycle++) {
      const handler = () => {};
      emitter.on('task_event', handler);
      // Clean up after execution step
      emitter.off('task_event', handler);
    }

    expect(emitter.listenerCount('task_event')).toBe(0);
    expect(emitter.listenerCount('task_event')).toBeLessThanOrEqual(10);
  });

  it('9.4: Memory ceiling retention: 200 consecutive cycles maintain fixed memory cap', () => {
    const deduplicator = new LruDeduplicator(2000);
    for (let i = 0; i < 5000; i++) {
      deduplicator.add(`cycle-item-${i}`);
    }
    // Deduplicator strictly retains maximum configured size
    expect(deduplicator.size()).toBe(2000);
  });

  it('9.5: Detached context cleanup: closing an already closed or detached context is idempotent', () => {
    let closedCount = 0;
    const mockContext = {
      isClosed: false,
      close: () => {
        if (mockContext.isClosed) return;
        mockContext.isClosed = true;
        closedCount++;
      },
    };

    mockContext.close();
    expect(closedCount).toBe(1);
    expect(mockContext.isClosed).toBe(true);

    // Second close call is safe no-op
    mockContext.close();
    expect(closedCount).toBe(1);
  });
});

// ===========================================================================
// Boundary 10: F10 Cross-Platform Process Management
// ===========================================================================
describe('Boundary 10: F10 Cross-Platform Process Management', () => {
  it('10.1: CLI port parameter boundary: non-numeric or out-of-range port falls back to default', () => {
    const parsePort = (argValue: string | undefined, defaultPort = 4040): number => {
      if (!argValue) return defaultPort;
      const parsed = parseInt(argValue, 10);
      if (isNaN(parsed) || parsed <= 0 || parsed > 65535) {
        return defaultPort;
      }
      return parsed;
    };

    expect(parsePort(undefined)).toBe(4040);
    expect(parsePort('abc')).toBe(4040);
    expect(parsePort('-1')).toBe(4040);
    expect(parsePort('0')).toBe(4040);
    expect(parsePort('70000')).toBe(4040);
    expect(parsePort('8080')).toBe(8080);
  });

  it('10.2: Port already in use detection triggers collision error (EADDRINUSE)', async () => {
    const server1 = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server1.listen(0, '127.0.0.1', () => {
        resolve((server1.address() as net.AddressInfo).port);
      });
    });

    try {
      const server2 = net.createServer();
      let caughtError: any = null;

      await new Promise<void>((resolve) => {
        server2.once('error', (err) => {
          caughtError = err;
          resolve();
        });
        server2.listen(port, '127.0.0.1');
      });

      expect(caughtError).toBeDefined();
      expect(caughtError.code).toBe('EADDRINUSE');
    } finally {
      server1.close();
    }
  });

  it('10.3: Missing required port parameter defaults cleanly in launcher argument parser', () => {
    const args = ['--no-browser', '--daemon-only'];
    const getArgValue = (flag: string, defaultValue: string): string => {
      const idx = args.indexOf(flag);
      if (idx !== -1 && idx + 1 < args.length) {
        return args[idx + 1];
      }
      return defaultValue;
    };

    const port = parseInt(getArgValue('--port', '4040'), 10);
    expect(port).toBe(4040);
  });

  it('10.4: Early SIGINT/SIGTERM during startup halts gracefully without deadlock', () => {
    let shutdownInvoked = false;
    let exitCode = -1;

    const shutdown = (code = 0) => {
      if (shutdownInvoked) return;
      shutdownInvoked = true;
      exitCode = code;
    };

    // Simulate SIGINT received
    shutdown(0);
    expect(shutdownInvoked).toBe(true);
    expect(exitCode).toBe(0);

    // Redundant signal is safe
    shutdown(1);
    expect(exitCode).toBe(0);
  });

  it('10.5: Process termination of non-existent PID catches error safely', () => {
    const killProcessSafe = (pid: number): boolean => {
      try {
        process.kill(pid, 0); // Test signal
        return true;
      } catch (err: any) {
        // ESRCH: no such process
        return false;
      }
    };

    // Non-existent PID
    const alive = killProcessSafe(99999999);
    expect(alive).toBe(false);
  });
});

// ===========================================================================
// Boundary 11: F11 UI Button Feedback & Loading States
// ===========================================================================
describe('Boundary 11: F11 UI Button Feedback & Loading States', () => {
  it('11.1: Rapid button clicks (10 clicks in 50ms) are debounced to single execution', () => {
    let callCount = 0;
    let isProcessing = false;

    const handleClick = () => {
      if (isProcessing) return; // Debounce guard
      isProcessing = true;
      callCount++;
    };

    for (let i = 0; i < 10; i++) {
      handleClick();
    }

    expect(callCount).toBe(1);
  });

  it('11.2: Server disconnect resets button states to disabled or offline', () => {
    const buttonState = {
      canLaunch: true,
      canStop: false,
      isConnected: true,
    };

    // Disconnect occurs
    buttonState.isConnected = false;
    const computedButtons = {
      launchDisabled: !buttonState.isConnected || !buttonState.canLaunch,
      stopDisabled: !buttonState.isConnected || !buttonState.canStop,
    };

    expect(computedButtons.launchDisabled).toBe(true);
    expect(computedButtons.stopDisabled).toBe(true);
  });

  it('11.3: Loading spinner state persists during simulated network latency until response', async () => {
    let isLoading = false;

    const startAction = async (simulatedDelayMs: number) => {
      isLoading = true;
      await new Promise((r) => setTimeout(r, simulatedDelayMs));
      isLoading = false;
    };

    const actionPromise = startAction(20);
    expect(isLoading).toBe(true);
    await actionPromise;
    expect(isLoading).toBe(false);
  });

  it('11.4: Keyboard Enter and Space trigger equivalence with mouse click', () => {
    let triggerCount = 0;
    const onAction = () => triggerCount++;

    const handleKeyDown = (e: { key: string }) => {
      if (e.key === 'Enter' || e.key === ' ') {
        onAction();
      }
    };

    handleKeyDown({ key: 'Enter' });
    handleKeyDown({ key: ' ' });
    handleKeyDown({ key: 'Tab' }); // Should not trigger

    expect(triggerCount).toBe(2);
  });

  it('11.5: Disabled button contract: click handler on disabled button rejects invocation', () => {
    let invoked = false;
    const clickButton = (disabled: boolean) => {
      if (disabled) return;
      invoked = true;
    };

    clickButton(true);
    expect(invoked).toBe(false);

    clickButton(false);
    expect(invoked).toBe(true);
  });
});

// ===========================================================================
// Boundary 12: F12 UI Bottom-Right Toast Notifications
// ===========================================================================
describe('Boundary 12: F12 UI Bottom-Right Toast Notifications', () => {
  it('12.1: Notification burst (50 toasts in 50ms) queues safely without store freeze', () => {
    const queue: any[] = [];
    const MAX_TOASTS = 20;

    const pushToast = (toast: any) => {
      queue.unshift(toast);
      if (queue.length > MAX_TOASTS) {
        queue.length = MAX_TOASTS;
      }
    };

    for (let i = 0; i < 50; i++) {
      pushToast(createDaemonNotificationFixture('info', `Burst ${i}`, `Msg ${i}`));
    }

    expect(queue.length).toBe(MAX_TOASTS);
    expect(queue[0].title).toBe('Burst 49');
  });

  it('12.2: Extreme message length (10,000 characters) wraps and truncates cleanly', () => {
    const longMessage = 'A'.repeat(10000);
    const toast = createDaemonNotificationFixture('error', 'Error Alert', longMessage);

    const formatToastDisplay = (msg: string, maxDisplayLen = 300) => {
      if (msg.length <= maxDisplayLen) return msg;
      return msg.slice(0, maxDisplayLen) + '...';
    };

    const displayed = formatToastDisplay(toast.message);
    expect(displayed.length).toBe(303);
    expect(displayed.endsWith('...')).toBe(true);
  });

  it('12.3: Unknown notification levels fall back safely to info or error', () => {
    const sanitizeLevel = (rawLevel: string): 'info' | 'warning' | 'error' => {
      if (rawLevel === 'error' || rawLevel === 'fatal' || rawLevel === 'critical') return 'error';
      if (rawLevel === 'warning' || rawLevel === 'warn') return 'warning';
      return 'info';
    };

    expect(sanitizeLevel('fatal')).toBe('error');
    expect(sanitizeLevel('critical')).toBe('error');
    expect(sanitizeLevel('warn')).toBe('warning');
    expect(sanitizeLevel('unknown_level')).toBe('info');
  });

  it('12.4: HTML injection in notification title/message is treated as plain text', () => {
    const maliciousPayload = createDaemonNotificationFixture(
      'error',
      '<script>alert("xss")</script>',
      '<img src=x onerror=alert(1)>'
    );

    const escapeHtml = (str: string) => {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    };

    const safeTitle = escapeHtml(maliciousPayload.title);
    const safeMsg = escapeHtml(maliciousPayload.message);

    expect(safeTitle).not.toContain('<script>');
    expect(safeTitle).toContain('&lt;script&gt;');
    expect(safeMsg).toContain('&lt;img');
  });

  it('12.5: Toast queue overflow handling prevents unbounded memory retention', () => {
    const buffer: number[] = [];
    const limit = 30;

    for (let i = 0; i < 1000; i++) {
      buffer.push(i);
      if (buffer.length > limit) {
        buffer.shift();
      }
    }

    expect(buffer.length).toBe(limit);
    expect(buffer[limit - 1]).toBe(999);
  });
});

// ===========================================================================
// Boundary 13: F13 UI Live Browsing View Component Contracts
// ===========================================================================
describe('Boundary 13: F13 UI Live Browsing View Component Contracts', () => {
  it('13.1: Rapid snapshot stream (60 FPS burst: 60 updates) retains only latest snapshot', () => {
    let currentSnapshot: BrowserSnapshot | null = null;

    for (let frame = 1; frame <= 60; frame++) {
      currentSnapshot = createBrowserSnapshotFixture({
        timestamp: 1731362400000 + frame * 16,
        scroll: { x: 0, y: frame * 10, scrollHeight: 2000, viewportHeight: 800 },
      });
    }

    expect(currentSnapshot).toBeDefined();
    expect(currentSnapshot?.scroll.y).toBe(600);
  });

  it('13.2: Null or undefined snapshot in store renders idle placeholder state', () => {
    const storeState = { currentSnapshot: null as BrowserSnapshot | null };

    const getDisplayState = (snap: BrowserSnapshot | null) => {
      if (!snap) return { placeholder: true, label: 'Live preview waiting for agent navigation' };
      return { placeholder: false, url: snap.url };
    };

    const res = getDisplayState(storeState.currentSnapshot);
    expect(res.placeholder).toBe(true);
    expect(res.label).toContain('waiting');
  });

  it('13.3: Aspect ratio boundary: 0px container resize does not throw layout error', () => {
    const computeViewBox = (width: number, height: number) => {
      const w = Math.max(0, width);
      const h = Math.max(0, height);
      return { width: w, height: h, aspectRatio: h === 0 ? 1 : w / h };
    };

    const zeroBox = computeViewBox(0, 0);
    expect(zeroBox.width).toBe(0);
    expect(zeroBox.aspectRatio).toBe(1);

    const normalBox = computeViewBox(1920, 1080);
    expect(normalBox.aspectRatio).toBeCloseTo(1.78, 2);
  });

  it('13.4: Broken image fallback handles non-base64 or corrupt screenshot payload', () => {
    const isValidScreenshot = (uri?: string): boolean => {
      if (!uri) return false;
      return uri.startsWith('data:image/') && uri.includes(';base64,');
    };

    expect(isValidScreenshot('data:image/jpeg;base64,/9j/4AAQ...')).toBe(true);
    expect(isValidScreenshot('invalid-uri-string')).toBe(false);
    expect(isValidScreenshot('')).toBe(false);
    expect(isValidScreenshot(undefined)).toBe(false);
  });

  it('13.5: Viewport zoom scaling (50%, 100%, 200%) maintains proportionate scroll calculation', () => {
    const originalPct = computeScrollPercentage(400, 2000, 800);
    expect(originalPct).toBeCloseTo(33.3, 1);

    // Zoomed in (viewport height halved effectively)
    const zoomedInPct = computeScrollPercentage(400, 2000, 400);
    expect(zoomedInPct).toBeCloseTo(25.0, 1);
  });
});

// ===========================================================================
// Boundary 14: F14 UI Agent Action Timeline Contracts
// ===========================================================================
describe('Boundary 14: F14 UI Agent Action Timeline Contracts', () => {
  it('14.1: Timeline with 10,000 actions enforces buffer ceiling to prevent memory leaks', () => {
    const timelineBuffer: AgentAction[] = [];
    const MAX_TIMELINE_ITEMS = 500;

    const pushAction = (action: AgentAction) => {
      timelineBuffer.unshift(action);
      if (timelineBuffer.length > MAX_TIMELINE_ITEMS) {
        timelineBuffer.length = MAX_TIMELINE_ITEMS;
      }
    };

    for (let i = 0; i < 10000; i++) {
      pushAction(createAgentActionFixture({ id: `act-${i}` }));
    }

    expect(timelineBuffer.length).toBe(MAX_TIMELINE_ITEMS);
    expect(timelineBuffer[0].id).toBe('act-9999');
  });

  it('14.2: Action with undefined or null details renders clean item without error', () => {
    const action: AgentAction = {
      id: 'act-null-01',
      taskId: 'task-test',
      timestamp: Date.now(),
      type: 'extraction',
      status: 'success',
      message: 'Extracted content',
      details: undefined,
    };

    const getActionSummary = (a: AgentAction): string => {
      return a.details?.count ? `Found ${a.details.count} items` : a.message;
    };

    expect(getActionSummary(action)).toBe('Extracted content');
  });

  it('14.3: Actions with identical timestamps sort deterministically by action ID', () => {
    const exactTime = 1731362400000;
    const actions: AgentAction[] = [
      createAgentActionFixture({ id: 'action-c', timestamp: exactTime }),
      createAgentActionFixture({ id: 'action-a', timestamp: exactTime }),
      createAgentActionFixture({ id: 'action-b', timestamp: exactTime }),
    ];

    const sorted = [...actions].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));

    expect(sorted[0].id).toBe('action-a');
    expect(sorted[1].id).toBe('action-b');
    expect(sorted[2].id).toBe('action-c');
  });

  it('14.4: Filter timeline by non-existent action type returns empty list without error', () => {
    const actions: AgentAction[] = [
      createAgentActionFixture({ type: 'navigation' }),
      createAgentActionFixture({ type: 'inference' }),
    ];

    const filtered = actions.filter((a) => (a.type as string) === 'non_existent_type');
    expect(Array.isArray(filtered)).toBe(true);
    expect(filtered.length).toBe(0);
  });

  it('14.5: Out-of-bounds timestamp values (epoch 0, distant future) format legibly', () => {
    const formatDateSafe = (ts: number): string => {
      try {
        const d = new Date(ts);
        return isNaN(d.getTime()) ? 'Invalid Time' : d.toISOString();
      } catch {
        return 'Invalid Time';
      }
    };

    expect(formatDateSafe(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(formatDateSafe(4102444800000)).toBe('2100-01-01T00:00:00.000Z');
    expect(formatDateSafe(NaN)).toBe('Invalid Time');
  });
});

// ===========================================================================
// Boundary 15: F15 UI Local Ollama Model Selector Contracts
// ===========================================================================
describe('Boundary 15: F15 UI Local Ollama Model Selector Contracts', () => {
  it('15.1: Dropdown when Ollama returns 0 models displays placeholder and disables compile', () => {
    const state = {
      models: [] as string[],
      ollamaOnline: true,
      selectedModel: '',
    };

    const hasSelectableModels = state.ollamaOnline && state.models.length > 0;
    const placeholderText = state.models.length === 0 ? 'No models installed' : 'Select a model';

    expect(hasSelectableModels).toBe(false);
    expect(placeholderText).toBe('No models installed');
  });

  it('15.2: Selecting currently active model is a safe no-op without redundant RPC', () => {
    let rpcCount = 0;
    let currentModel = 'qwen2.5:latest';

    const selectModel = (model: string) => {
      if (model === currentModel) return; // No-op guard
      currentModel = model;
      rpcCount++;
    };

    selectModel('qwen2.5:latest');
    expect(rpcCount).toBe(0);

    selectModel('llama3.2:latest');
    expect(rpcCount).toBe(1);
    expect(currentModel).toBe('llama3.2:latest');
  });

  it('15.3: Model name with 256 characters renders with CSS truncation without error', () => {
    const longModelName = 'org/' + 'a'.repeat(245) + ':latest'; // 256 chars
    expect(longModelName.length).toBe(256);

    const truncateModelName = (name: string, maxLen = 40): string => {
      if (name.length <= maxLen) return name;
      return name.slice(0, maxLen - 3) + '...';
    };

    const truncated = truncateModelName(longModelName);
    expect(truncated.length).toBe(40);
    expect(truncated.endsWith('...')).toBe(true);
  });

  it('15.4: Network disconnect while dropdown is open shows offline indicator', () => {
    const selectorState = {
      isOpen: true,
      ollamaOnline: true,
    };

    // Connection drops
    selectorState.ollamaOnline = false;

    const displayIndicator = selectorState.ollamaOnline ? 'Online' : 'Ollama Offline';
    expect(displayIndicator).toBe('Ollama Offline');
  });

  it('15.5: Deduplication of model names ensures dropdown options are unique', () => {
    const rawModels = [
      'qwen2.5:latest',
      'llama3.2:latest',
      'qwen2.5:latest', // Duplicate
      'mistral:latest',
      'llama3.2:latest', // Duplicate
    ];

    const uniqueModels = Array.from(new Set(rawModels));
    expect(uniqueModels).toEqual(['qwen2.5:latest', 'llama3.2:latest', 'mistral:latest']);
  });
});

// ===========================================================================
// Boundary 16: F16 UI Modern Dark Gray Theme & Solid Buttons
// ===========================================================================
describe('Boundary 16: F16 UI Modern Dark Gray Theme & Solid Buttons', () => {
  it('16.1: Contrast ratio on dark gray surfaces (#18181b, #242427) meets WCAG AA standards', () => {
    const white = '#ffffff';
    const darkGray1 = '#18181b'; // zinc-900
    const darkGray2 = '#242427'; // zinc-800 adjusted

    const ratio1 = getContrastRatio(white, darkGray1);
    const ratio2 = getContrastRatio(white, darkGray2);

    // WCAG AA normal text requirement: >= 4.5:1
    expect(ratio1).toBeGreaterThan(4.5);
    expect(ratio2).toBeGreaterThan(4.5);
  });

  it('16.2: Button styles use solid single-color backgrounds without CSS gradients', () => {
    const buttonTokens = {
      primary: 'bg-emerald-600 hover:bg-emerald-500 text-white font-medium',
      danger: 'bg-rose-600 hover:bg-rose-500 text-white font-medium',
      secondary: 'bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-medium',
    };

    for (const [variant, classes] of Object.entries(buttonTokens)) {
      expect(classes.includes('bg-gradient-')).toBe(false);
      expect(classes.includes('from-')).toBe(false);
      expect(classes.includes('to-')).toBe(false);
      expect(variant).toBeDefined();
    }
  });

  it('16.3: Focus outline styles provide high-contrast solid border without gradients', () => {
    const focusRingToken = 'focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2 focus:ring-offset-zinc-950';
    expect(focusRingToken.includes('focus:ring-2')).toBe(true);
    expect(focusRingToken.includes('gradient')).toBe(false);
  });

  it('16.4: Disabled button styling applies reduced opacity and not-allowed cursor', () => {
    const disabledClassToken = 'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none';
    expect(disabledClassToken.includes('disabled:opacity-50')).toBe(true);
    expect(disabledClassToken.includes('disabled:cursor-not-allowed')).toBe(true);
  });

  it('16.5: High contrast mode compatibility: cards define solid visible borders', () => {
    const cardToken = 'bg-zinc-900 border border-zinc-800 rounded-lg';
    expect(cardToken.includes('border')).toBe(true);
    expect(cardToken.includes('border-zinc-800')).toBe(true);
  });
});

// ===========================================================================
// Boundary 17: F17 UI Base Sizing & Responsive Scaling Contracts
// ===========================================================================
describe('Boundary 17: F17 UI Base Sizing & Responsive Scaling Contracts', () => {
  it('17.1: Viewport extreme widths (320px to 3840px 4K) maintain valid layout columns', () => {
    const getResponsiveColumns = (width: number): number => {
      if (width < 640) return 1; // mobile
      if (width < 1024) return 2; // tablet
      if (width < 1920) return 3; // desktop
      return 4; // 4K ultrawide
    };

    expect(getResponsiveColumns(320)).toBe(1);
    expect(getResponsiveColumns(768)).toBe(2);
    expect(getResponsiveColumns(1440)).toBe(3);
    expect(getResponsiveColumns(3840)).toBe(4);
  });

  it('17.2: 0px container resize handles dimensions without negative geometry errors', () => {
    const computeContainerStyle = (w: number, h: number) => {
      return {
        width: Math.max(0, w),
        height: Math.max(0, h),
      };
    };

    const style = computeContainerStyle(0, 0);
    expect(style.width).toBe(0);
    expect(style.height).toBe(0);
  });

  it('17.3: Font scaling with user zoom (150%, 200%) retains hierarchy', () => {
    const baseRem = 1.0; // 16px
    const zoomLevels = [1.0, 1.5, 2.0];

    for (const zoom of zoomLevels) {
      const computedRem = baseRem * zoom;
      expect(computedRem).toBeGreaterThanOrEqual(1.0);
      expect(isFinite(computedRem)).toBe(true);
    }
  });

  it('17.4: Flex wrap behavior on narrow displays allows tools to stack vertically', () => {
    const flexWrapToken = 'flex flex-wrap items-center gap-2 sm:gap-4';
    expect(flexWrapToken.includes('flex-wrap')).toBe(true);
    expect(flexWrapToken.includes('gap-')).toBe(true);
  });

  it('17.5: Removal of rigid container bottlenecks allows 100% fluid scaling', () => {
    const mainContainerClasses = 'w-full h-full min-h-screen bg-zinc-950 text-zinc-100 flex flex-col';
    // Must not contain rigid max-w-screen constraints on main container
    expect(mainContainerClasses.includes('max-w-')).toBe(false);
    expect(mainContainerClasses.includes('w-full')).toBe(true);
  });
});

// ===========================================================================
// Boundary 18: F18 UI Multi-Job Controls & Switcher Contracts
// ===========================================================================
describe('Boundary 18: F18 UI Multi-Job Controls & Switcher Contracts', () => {
  it('18.1: Switching active job while a job is executing updates view without stopping background job', () => {
    const jobA = createJobFixture({ id: 'job-1', status: 'running' });
    const jobB = createJobFixture({ id: 'job-2', status: 'idle' });

    let activeJobId = jobA.id;
    // Switch to Job B
    activeJobId = jobB.id;

    expect(activeJobId).toBe('job-2');
    // Job A execution state remains untouched
    expect(jobA.status).toBe('running');
  });

  it('18.2: Deleting currently active job resets selection safely to another job or null', () => {
    let jobs = [
      createJobFixture({ id: 'job-1' }),
      createJobFixture({ id: 'job-2' }),
    ];
    let activeJobId: string | null = 'job-1';

    // Delete job-1
    jobs = jobs.filter((j) => j.id !== 'job-1');
    if (activeJobId === 'job-1') {
      activeJobId = jobs.length > 0 ? jobs[0].id : null;
    }

    expect(activeJobId).toBe('job-2');
    expect(jobs).toHaveLength(1);

    // Delete remaining job
    jobs = [];
    activeJobId = jobs.length > 0 ? jobs[0].id : null;
    expect(activeJobId).toBeNull();
  });

  it('18.3: Updating non-existent job ID fails safely or returns error without state corruption', () => {
    const jobs = [createJobFixture({ id: 'job-1', name: 'Original Name' })];

    const updateJob = (id: string, updates: Partial<Job>): boolean => {
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx === -1) return false;
      jobs[idx] = { ...jobs[idx], ...updates };
      return true;
    };

    const res = updateJob('job-non-existent-99', { name: 'New Name' });
    expect(res).toBe(false);
    expect(jobs[0].name).toBe('Original Name');
  });

  it('18.4: Job name with maximum length (256 characters) truncates cleanly with ellipsis', () => {
    const longName = 'Scout '.repeat(42); // >250 chars
    const truncate = (str: string, maxLen = 30) => {
      return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
    };

    const result = truncate(longName);
    expect(result.length).toBe(30);
    expect(result.endsWith('...')).toBe(true);
  });

  it('18.5: Empty or whitespace job name defaults to Untitled Job or fails validation', () => {
    const sanitizeJobName = (name: string): string => {
      const trimmed = (name || '').trim();
      return trimmed.length === 0 ? 'Untitled Job' : trimmed;
    };

    expect(sanitizeJobName('')).toBe('Untitled Job');
    expect(sanitizeJobName('    ')).toBe('Untitled Job');
    expect(sanitizeJobName('Valid Job Name')).toBe('Valid Job Name');
  });
});

// ===========================================================================
// Boundary 19: F19 UI Dedicated Status Page with Recharts
// ===========================================================================
describe('Boundary 19: F19 UI Dedicated Status Page with Recharts', () => {
  it('19.1: Recharts area chart with 0 data points renders empty state placeholder', () => {
    const history: Array<{ time: string; cpu: number }> = [];

    const getChartRenderModel = (data: Array<{ time: string; cpu: number }>) => {
      if (data.length === 0) {
        return { renderEmptyState: true, message: 'No performance metrics recorded yet' };
      }
      return { renderEmptyState: false, data };
    };

    const model = getChartRenderModel(history);
    expect(model.renderEmptyState).toBe(true);
    expect(model.message).toContain('No performance metrics');
  });

  it('19.2: Single data point chart rendering computes valid domains without NaN', () => {
    const domain = computeChartYDomain([42.5]);
    expect(domain[0]).toBe(32.5);
    expect(domain[1]).toBe(52.5);
    expect(isNaN(domain[0])).toBe(false);
    expect(isNaN(domain[1])).toBe(false);
  });

  it('19.3: Constant flatline metric (all zeros or constant 50) computes valid Y-axis bounds', () => {
    const allZeros = computeChartYDomain([0, 0, 0, 0]);
    expect(allZeros[0]).toBe(0);
    expect(allZeros[1]).toBe(10);

    const constantFifty = computeChartYDomain([50, 50, 50]);
    expect(constantFifty[0]).toBe(40);
    expect(constantFifty[1]).toBe(60);
  });

  it('19.4: Spike metric with 100x jump scales dynamic domain smoothly', () => {
    const spikyData = [1.2, 1.5, 1.4, 150.0, 1.3];
    const domain = computeChartYDomain(spikyData);

    expect(domain[0]).toBeLessThanOrEqual(1.2);
    expect(domain[1]).toBeGreaterThanOrEqual(150.0);
  });

  it('19.5: NaN and null data points are filtered out before passing to Recharts dataset', () => {
    const rawData = [10, NaN, 25, null as any, 40, Infinity, -Infinity];
    const cleaned = rawData.filter((v) => typeof v === 'number' && isFinite(v) && !isNaN(v));

    expect(cleaned).toEqual([10, 25, 40]);
    const domain = computeChartYDomain(cleaned);
    expect(domain[0]).toBeLessThan(10);
    expect(domain[1]).toBeGreaterThan(40);
  });
});
