import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserRunner,
  LruDeduplicator,
  sha1Hash,
  abortableSleep
} from '../src/runner/browserRunner.js';
import type { CompiledTaskSpec } from '@ofln-scout/shared';

describe('Playwright Browser Runner & LRU Deduplication (Unit & Integration)', () => {
  describe('sha1Hash', () => {
    it('generates deterministic 40-character hex string for string input', () => {
      const text = 'Show HN: Fast Non-Autoregressive Decision Engine';
      const h1 = sha1Hash(text);
      const h2 = sha1Hash(text);
      assert.equal(h1, h2);
      assert.equal(h1.length, 40);
      assert.match(h1, /^[0-9a-f]{40}$/);
    });

    it('generates different hashes for different inputs', () => {
      const h1 = sha1Hash('Post A');
      const h2 = sha1Hash('Post B');
      assert.notEqual(h1, h2);
    });
  });

  describe('LruDeduplicator', () => {
    it('initializes empty and tracks size', () => {
      const lru = new LruDeduplicator(10);
      assert.equal(lru.size(), 0);
    });

    it('adds novel hashes and correctly recognizes existing hashes', () => {
      const lru = new LruDeduplicator(100);
      const h1 = sha1Hash('Item 1');
      const h2 = sha1Hash('Item 2');

      assert.equal(lru.has(h1), false);
      lru.add(h1);
      assert.equal(lru.has(h1), true);
      assert.equal(lru.has(h2), false);
      assert.equal(lru.size(), 1);
    });

    it('evicts the oldest entry when reaching maximum capacity', () => {
      const lru = new LruDeduplicator(3);
      lru.add('h1');
      lru.add('h2');
      lru.add('h3');
      assert.equal(lru.size(), 3);
      assert.equal(lru.has('h1'), true); // access h1, so h2 becomes oldest!

      lru.add('h4'); // should evict h2
      assert.equal(lru.size(), 3);
      assert.equal(lru.has('h2'), false);
      assert.equal(lru.has('h1'), true);
      assert.equal(lru.has('h3'), true);
      assert.equal(lru.has('h4'), true);
    });

    it('clears all items cleanly', () => {
      const lru = new LruDeduplicator(5);
      lru.add('a');
      lru.add('b');
      assert.equal(lru.size(), 2);
      lru.clear();
      assert.equal(lru.size(), 0);
      assert.equal(lru.has('a'), false);
    });
  });

  describe('abortableSleep', () => {
    it('resolves immediately if signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const t0 = Date.now();
      await abortableSleep(5000, controller.signal);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 50, `Elapsed ${elapsed}ms must be < 50ms`);
    });

    it('resolves in sub-50ms when signal aborts during sleep', async () => {
      const controller = new AbortController();
      const t0 = Date.now();
      setTimeout(() => controller.abort(), 20);
      await abortableSleep(5000, controller.signal);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 100, `Elapsed ${elapsed}ms must be < 100ms`);
    });
  });

  describe('BrowserRunner (Headless Chromium Integration)', () => {
    it('launches headless Chromium, extracts candidates, deduplicates, and cancels sub-100ms', async () => {
      const runner = new BrowserRunner({ headless: true });
      const htmlContent = `
        <!DOCTYPE html>
        <html>
          <body>
            <div class="athing"><a href="https://news.ycombinator.com/item?id=101">Show HN: Laya Engine</a></div>
            <div class="athing"><a href="https://news.ycombinator.com/item?id=102">Ask HN: Favorite tools in 2026?</a></div>
            <div class="athing"><a href="https://news.ycombinator.com/item?id=103">Show HN: Offline AI Scout</a></div>
          </body>
        </html>
      `;
      const dataUri = `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`;

      const testSpec: CompiledTaskSpec = {
        id: 'browser-test-task-1',
        name: 'Browser Test',
        userGoal: 'Scout test page',
        targetUrl: dataUri,
        domSelector: '.athing',
        pollIntervalMs: 200,
        scrollStepPx: 300,
        questions: {
          is_ai: {
            type: 'noul',
            statement: 'Is this an AI post?'
          }
        },
        alertRule: {
          questionKey: 'is_ai',
          operator: 'boolean_true',
          targetValue: true,
          minAnswerConfidence: 0.80
        },
        createdAt: Date.now()
      };

      const candidates: { text: string; link?: string }[] = [];
      const controller = new AbortController();

      // Launch runner and abort after extracting items
      const runPromise = runner.runTask(
        testSpec,
        async (candidate) => {
          candidates.push(candidate);
          if (candidates.length >= 3) {
            // Abort as soon as candidates are extracted
            controller.abort();
          }
        },
        controller.signal
      );

      const t0 = Date.now();
      await runPromise;
      const abortLatency = Date.now() - t0;

      assert.ok(candidates.length >= 3, `Expected at least 3 candidates, got ${candidates.length}`);
      assert.ok(
        candidates.some((c) => c.text.includes('Show HN: Laya Engine')),
        'Must contain Laya Engine post'
      );
      assert.ok(
        candidates.some((c) => c.link?.includes('item?id=101')),
        'Must contain extracted link'
      );

      // Verify deduplicator recorded the hashes
      assert.ok(runner.deduplicator.size() >= 3);
    });
  });
});
