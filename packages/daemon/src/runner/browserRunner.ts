import * as crypto from 'node:crypto';
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import type { CompiledTaskSpec, AgentAction, BrowserSnapshot } from '@ofln-scout/shared';
import { sanitizeStateSnippet } from '../engine/layaEngine.js';

/**
 * Computes deterministic 40-character SHA-1 hex string for DOM snippet.
 */
export function sha1Hash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * In-memory LRU deduplication cache (default 2,000 entries).
 * Tracks evaluated DOM element hashes to prevent duplicate inference passes
 * across consecutive scroll ticks.
 */
export class LruDeduplicator {
  private cache = new Map<string, boolean>();
  public readonly maxSize: number;

  constructor(maxSize = 2000) {
    this.maxSize = maxSize;
  }

  has(hash: string): boolean {
    if (!this.cache.has(hash)) return false;
    // Refresh access order (move to most recent)
    this.cache.delete(hash);
    this.cache.set(hash, true);
    return true;
  }

  add(hash: string): void {
    if (this.cache.has(hash)) {
      this.cache.delete(hash);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first inserted in Map order)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(hash, true);
  }

  size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Abortable sleep that returns in < 1ms when AbortSignal triggers.
 * Ensures abort event listeners are cleanly deregistered in both timeout and abort paths.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
  });
}

export interface CandidateElement {
  text: string;
  link?: string;
}

export interface BrowserRunnerOptions {
  headless?: boolean;
  maxLruSize?: number;
}

export class BrowserRunner {
  public deduplicator: LruDeduplicator;
  private isHeadless: boolean;

  constructor(options: BrowserRunnerOptions = {}) {
    this.isHeadless = options.headless ?? true;
    this.deduplicator = new LruDeduplicator(options.maxLruSize ?? 2000);
  }

  /**
   * Run the headless browser scraping and scrolling loop until cancelled by signal.
   */
  public async runTask(
    spec: CompiledTaskSpec,
    onCandidate: (candidate: CandidateElement) => Promise<void>,
    signal: AbortSignal,
    onAction?: (action: AgentAction) => Promise<void> | void,
    onSnapshot?: (snapshot: BrowserSnapshot) => Promise<void> | void
  ): Promise<void> {
    // 1. Reset LRU deduplication cache on task start to ensure second runs evaluate candidates
    this.resetCache();

    if (signal.aborted) {
      return;
    }

    const emitAction = async (
      type: AgentAction['type'],
      status: AgentAction['status'],
      message: string,
      details?: Record<string, any>
    ) => {
      if (!onAction) return;
      try {
        await onAction({
          id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          taskId: spec.id,
          timestamp: Date.now(),
          type,
          status,
          message,
          details
        });
      } catch {
        // Do not fail runner loop on action telemetry callback errors
      }
    };

    await emitAction('system', 'pending', 'Launching browser automation...');

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      browser = await chromium.launch({
        headless: this.isHeadless,
        args: [
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox'
        ]
      });
      context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 sysOne/1.0'
      });
      page = await context.newPage();
    } catch (err: any) {
      if (context) {
        try {
          await context.close();
        } catch {}
        context = null;
      }
      if (browser) {
        try {
          await browser.close();
        } catch {}
        browser = null;
      }
      await emitAction('system', 'error', `Browser launch failed: ${err.message}`);
      console.warn(
        `[BrowserRunner] Playwright Chromium launch failed: ${err.message}. Ensure browsers are installed via 'pnpm exec playwright install chromium'.`
      );
      throw new Error(`Playwright Chromium launch failed: ${err.message}`);
    }

    await emitAction('system', 'success', 'Browser launched successfully');

    const onAbort = () => {
      if (page && !page.isClosed()) {
        page.close().catch(() => {});
      }
      if (context) {
        context.close().catch(() => {});
      }
      if (browser) {
        browser.close().catch(() => {});
        browser = null;
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });

    let lastSnapshotTime = 0;
    const captureSnapshot = async (force = false) => {
      if (!onSnapshot || !page || page.isClosed()) return;
      const now = Date.now();
      if (!force && now - lastSnapshotTime < 1000) return;
      lastSnapshotTime = now;

      try {
        const scroll = await page
          .evaluate(() => ({
            x: window.scrollX || window.pageXOffset || 0,
            y: window.scrollY || window.pageYOffset || 0,
            scrollHeight: document.documentElement.scrollHeight || document.body.scrollHeight || 0,
            viewportHeight: window.innerHeight || 0
          }))
          .catch(() => ({ x: 0, y: 0, scrollHeight: 0, viewportHeight: 0 }));

        const screenshotBuffer = await page
          .screenshot({
            type: 'jpeg',
            quality: 50
          })
          .catch(() => null);

        const screenshot = screenshotBuffer
          ? `data:image/jpeg;base64,${screenshotBuffer.toString('base64')}`
          : undefined;

        const currentUrl = page.url() || spec.targetUrl;
        const pageTitle = await page.title().catch(() => '');

        await onSnapshot({
          taskId: spec.id,
          timestamp: now,
          url: currentUrl,
          title: pageTitle,
          screenshot,
          scroll
        });
      } catch {
        // Suppress snapshot evaluation errors during teardown
      }
    };

    try {
      if (signal.aborted || !page) return;

      // Navigate to target URL
      await emitAction('navigation', 'pending', `Navigating to ${spec.targetUrl}`);
      try {
        await page.goto(spec.targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        await emitAction('navigation', 'success', `Successfully navigated to ${spec.targetUrl}`);
      } catch (err: any) {
        if (signal.aborted) return;
        await emitAction('navigation', 'warning', `Navigation warning: ${err.message}`);
        console.warn(`[BrowserRunner] Navigation warning for ${spec.targetUrl}: ${err.message}`);
      }

      // Initial visual snapshot after page load
      await captureSnapshot(true);

      // Scrolling and extraction loop
      while (!signal.aborted && page && !page.isClosed()) {
        // 1. Batch DOM query for candidate elements matching spec.domSelector
        let rawCandidates: { text: string; link: string }[] = [];
        try {
          rawCandidates = await page.$$eval(spec.domSelector, (elements) => {
            return elements
              .map((el) => {
                const text = (el.textContent || '').trim();
                const a =
                  (el.tagName.toLowerCase() === 'a' ? el : null) ||
                  el.querySelector('a') ||
                  el.closest('a');
                const link = a ? (a as HTMLAnchorElement).href : '';
                return { text, link };
              })
              .filter((c) => c.text.length > 0);
          });
        } catch {
          // Page closed or navigated during eval
          if (signal.aborted) break;
        }

        if (rawCandidates.length > 0) {
          await emitAction('extraction', 'success', `Extracted ${rawCandidates.length} candidate elements matching "${spec.domSelector}"`, {
            count: rawCandidates.length
          });
        }

        // 2. Deduplicate candidates using SHA-1 LRU cache and emit
        for (const raw of rawCandidates) {
          if (signal.aborted) break;

          const cleanText = sanitizeStateSnippet(raw.text);
          if (!cleanText) continue;

          const compactPayload = JSON.stringify({
            text: cleanText,
            link: raw.link || ''
          });
          const hash = sha1Hash(compactPayload);

          if (this.deduplicator.has(hash)) {
            continue; // Skip already-processed DOM node
          }

          this.deduplicator.add(hash);
          await emitAction('inference', 'pending', `Evaluating candidate: "${cleanText.slice(0, 60)}${cleanText.length > 60 ? '...' : ''}"`, {
            link: raw.link
          });
          await onCandidate({ text: cleanText, link: raw.link });
        }

        if (signal.aborted) break;

        // 3. Smooth viewport scrolling
        const step = Math.max(50, spec.scrollStepPx || 400);
        try {
          await page.mouse.wheel(0, step);
          await emitAction('scroll', 'success', `Scrolled viewport by ${step}px`);
        } catch {
          if (signal.aborted) break;
        }

        // Periodic snapshot capture throttled to <= once per 1000ms
        await captureSnapshot(false);

        // 4. Sleep pollIntervalMs (cancellable via AbortSignal)
        const pollMs = Math.max(50, spec.pollIntervalMs || 800);
        await abortableSleep(pollMs, signal);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);

      if (page && !page.isClosed()) {
        try {
          await page.close();
        } catch {}
      }
      if (context) {
        try {
          await context.close();
        } catch {}
      }
      if (browser) {
        try {
          await browser.close();
        } catch {}
        browser = null;
      }
    }
  }

  /**
   * Reset deduplication cache.
   */
  public resetCache(): void {
    this.deduplicator.clear();
  }
}
