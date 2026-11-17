import * as crypto from 'node:crypto';
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import type {
  CompiledTaskSpec,
  AgentAction,
  BrowserSnapshot,
  HandoverContext,
  InteractiveInputElement,
  NavigationChoice,
  TaskCheckpoint
} from '@ofln-scout/shared';
import { sanitizeStateSnippet } from '../engine/layaEngine.js';
import { LoopDetector, type CycleTelemetry } from './loopDetector.js';
import { evaluateStagnation } from '../engine/systemTwoAssistant.js';

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

  getHashes(): string[] {
    return Array.from(this.cache.keys());
  }

  loadHashes(hashes: string[]): void {
    if (!hashes || !Array.isArray(hashes)) return;
    for (const h of hashes) {
      if (typeof h === 'string' && h.length > 0) {
        this.add(h);
      }
    }
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
  public loopDetector: LoopDetector;
  public totalAlerts = 0;
  public totalScanned = 0;
  public activeStepCount = 0;
  public lastScroll = { y: 0, scrollHeight: 0, viewportHeight: 0 };
  public lastUrl = '';
  public lastPageTitle = '';
  private isHeadless: boolean;
  private activeSpec: CompiledTaskSpec | null = null;
  private currentTargetUrl?: string;
  private dynamicSelector?: string;
  private dynamicScrollStepPx?: number;
  private dynamicPollIntervalMs?: number;
  private pendingNavigationUrl?: string;
  private visitedUrls = new Set<string>();
  private handledInputs = new Set<string>();
  private handledChoices = new Set<string>();
  private recentActions: string[] = [];
  private activePage: Page | null = null;

  constructor(options: BrowserRunnerOptions = {}) {
    this.isHeadless = options.headless ?? true;
    this.deduplicator = new LruDeduplicator(options.maxLruSize ?? 2000);
    this.loopDetector = new LoopDetector();
  }

  public getDeduplicationHashes(): string[] {
    return this.deduplicator.getHashes();
  }

  public loadDeduplicationHashes(hashes: string[]): void {
    this.deduplicator.loadHashes(hashes);
  }

  public async getCurrentState(): Promise<{
    currentUrl: string;
    targetUrl: string;
    pageTitle?: string;
    scroll: { y: number; scrollHeight: number; viewportHeight: number };
    totalScanned: number;
    totalAlerts: number;
    activeStepCount: number;
    dedupHashes: string[];
  }> {
    let scroll = { ...this.lastScroll };
    let currentUrl = this.currentTargetUrl || this.activeSpec?.targetUrl || '';
    let pageTitle = this.lastPageTitle;

    if (this.activePage && !this.activePage.isClosed()) {
      try {
        currentUrl = this.activePage.url() || currentUrl;
        pageTitle = (await this.activePage.title().catch(() => pageTitle)) || pageTitle;
        const metrics = await this.activePage
          .evaluate(() => ({
            y: window.scrollY || window.pageYOffset || 0,
            scrollHeight: document.documentElement.scrollHeight || document.body.scrollHeight || 0,
            viewportHeight: window.innerHeight || 0
          }))
          .catch(() => null);
        if (metrics) {
          scroll = metrics;
          this.lastScroll = metrics;
        }
      } catch {
        // Use last known metrics
      }
    }

    return {
      currentUrl,
      targetUrl: this.activeSpec?.targetUrl || currentUrl,
      pageTitle: pageTitle || undefined,
      scroll,
      totalScanned: this.totalScanned,
      totalAlerts: this.totalAlerts,
      activeStepCount: this.activeStepCount,
      dedupHashes: this.deduplicator.getHashes()
    };
  }

  public getVisitedUrls(): string[] {
    return Array.from(this.visitedUrls);
  }

  public getHandledInputs(): string[] {
    return Array.from(this.handledInputs);
  }

  public getHandledChoices(): string[] {
    return Array.from(this.handledChoices);
  }

  public getRecentActions(): string[] {
    return [...this.recentActions];
  }

  /**
   * Dynamically applies task steering updates to the active running session.
   */
  public applySteering(updatedSpec: CompiledTaskSpec): void {
    this.activeSpec = updatedSpec;
    if (updatedSpec.domSelector) {
      this.dynamicSelector = updatedSpec.domSelector;
    }
    if (updatedSpec.scrollStepPx !== undefined) {
      this.dynamicScrollStepPx = updatedSpec.scrollStepPx;
    }
    if (updatedSpec.pollIntervalMs !== undefined) {
      this.dynamicPollIntervalMs = updatedSpec.pollIntervalMs;
    }
    if (
      updatedSpec.targetUrl &&
      this.currentTargetUrl &&
      updatedSpec.targetUrl !== this.currentTargetUrl
    ) {
      this.currentTargetUrl = updatedSpec.targetUrl;
      this.pendingNavigationUrl = updatedSpec.targetUrl;
    }
  }

  /**
   * Run the headless browser scraping and scrolling loop until cancelled by signal.
   */
  public async runTask(
    spec: CompiledTaskSpec,
    onCandidate: (candidate: CandidateElement) => Promise<void>,
    signal: AbortSignal,
    onAction?: (action: AgentAction) => Promise<void> | void,
    onSnapshot?: (snapshot: BrowserSnapshot) => Promise<void> | void,
    getAlertCount?: () => number,
    resumeCheckpoint?: TaskCheckpoint,
    onCheckpoint?: (checkpoint: Partial<TaskCheckpoint>) => Promise<void> | void
  ): Promise<void> {
    // 1. Reset LRU deduplication cache, loop detector, and state on task start
    this.resetCache();
    this.loopDetector.reset();
    this.visitedUrls.clear();
    this.handledInputs.clear();
    this.handledChoices.clear();
    this.recentActions = [];

    if (resumeCheckpoint?.dedupHashes && Array.isArray(resumeCheckpoint.dedupHashes)) {
      this.deduplicator.loadHashes(resumeCheckpoint.dedupHashes);
    }

    const initialNavUrl = resumeCheckpoint?.currentUrl || spec.targetUrl;
    if (spec.targetUrl) {
      this.visitedUrls.add(spec.targetUrl);
    }
    if (resumeCheckpoint?.currentUrl) {
      this.visitedUrls.add(resumeCheckpoint.currentUrl);
    }
    this.currentTargetUrl = initialNavUrl;
    this.lastUrl = initialNavUrl;
    this.activeSpec = spec;
    this.dynamicSelector = spec.domSelector;
    this.dynamicScrollStepPx = spec.scrollStepPx;
    this.dynamicPollIntervalMs = spec.pollIntervalMs;
    this.pendingNavigationUrl = undefined;

    this.totalAlerts = resumeCheckpoint?.totalAlerts || 0;
    let totalScanned = resumeCheckpoint?.totalScanned || 0;
    let activeStepCount = resumeCheckpoint?.activeStepCount || 0;
    this.totalScanned = totalScanned;
    this.activeStepCount = activeStepCount;
    if (resumeCheckpoint?.scroll) {
      this.lastScroll = { ...resumeCheckpoint.scroll };
    } else {
      this.lastScroll = { y: 0, scrollHeight: 0, viewportHeight: 0 };
    }

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
      this.activePage = page;
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

    const triggerCheckpoint = async () => {
      if (!onCheckpoint) return;
      try {
        const scroll =
          (await page
            ?.evaluate(() => ({
              y: window.scrollY || window.pageYOffset || 0,
              scrollHeight: document.documentElement.scrollHeight || document.body.scrollHeight || 0,
              viewportHeight: window.innerHeight || 0
            }))
            .catch(() => this.lastScroll)) || this.lastScroll;
        this.lastScroll = scroll;
        const currentUrl = page?.url() || this.currentTargetUrl || spec.targetUrl;
        const pageTitle = (await page?.title().catch(() => '')) || '';
        this.lastUrl = currentUrl;
        this.lastPageTitle = pageTitle;

        await onCheckpoint({
          taskId: this.activeSpec?.id || spec.id,
          targetUrl: this.activeSpec?.targetUrl || spec.targetUrl,
          currentUrl,
          pageTitle,
          scroll,
          totalScanned,
          totalAlerts: getAlertCount ? getAlertCount() : this.totalAlerts,
          activeStepCount,
          dedupHashes: this.deduplicator.getHashes()
        });
      } catch {
        // Suppress checkpoint callback error
      }
    };

    try {
      if (signal.aborted || !page) return;

      // Navigate to target/resumed URL
      await emitAction('navigation', 'pending', `Navigating to ${initialNavUrl}`);
      try {
        await page.goto(initialNavUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        this.lastUrl = page.url();
        await emitAction('navigation', 'success', `Successfully navigated to ${initialNavUrl}`);
      } catch (err: any) {
        if (signal.aborted) return;
        await emitAction('navigation', 'warning', `Navigation warning: ${err.message}`);
        console.warn(`[BrowserRunner] Navigation warning for ${initialNavUrl}: ${err.message}`);
      }

      // After page load/initial stabilization, restore scroll offset
      if (resumeCheckpoint?.scroll?.y) {
        await page
          .evaluate((y) => {
            window.scrollTo(0, y);
          }, resumeCheckpoint.scroll.y)
          .catch(() => {});
        await page.waitForTimeout(50).catch(() => {});
      }

      if (resumeCheckpoint) {
        await emitAction(
          'system',
          'success',
          `Resumed task execution from checkpoint at step ${resumeCheckpoint.activeStepCount ?? 0} on ${resumeCheckpoint.currentUrl || spec.targetUrl}`,
          {
            checkpointId: resumeCheckpoint.id,
            activeStepCount: resumeCheckpoint.activeStepCount,
            scroll: resumeCheckpoint.scroll,
            totalScanned,
            totalAlerts: this.totalAlerts
          }
        );
      }

      // Initial visual snapshot after page load
      await captureSnapshot(true);
      await triggerCheckpoint();

      // Scrolling and extraction loop
      while (!signal.aborted && page && !page.isClosed()) {
        // Handle pending live steering navigation
        if (this.pendingNavigationUrl) {
          const navUrl = this.pendingNavigationUrl;
          this.pendingNavigationUrl = undefined;
          await emitAction('navigation', 'pending', `Steering navigation to ${navUrl}`);
          try {
            await page.goto(navUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 30000
            });
            await emitAction('navigation', 'success', `Steered navigation to ${navUrl}`);
          } catch (err: any) {
            await emitAction('navigation', 'warning', `Steering navigation warning: ${err.message}`);
          }
          this.resetCache();
          this.loopDetector.reset();
          await captureSnapshot(true);
          await triggerCheckpoint();
        }

        // Step A: Detect visible interactive form inputs
        const currentUrl = page.url() || (this.activeSpec?.targetUrl || spec.targetUrl);
        const formInputs: InteractiveInputElement[] = await page
          .evaluate(() => {
            const inputs = Array.from(
              document.querySelectorAll(
                'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select'
              )
            );
            return inputs
              .filter((el) => {
                const htmlEl = el as HTMLElement;
                const style = window.getComputedStyle(htmlEl);
                return style.display !== 'none' && style.visibility !== 'hidden' && !htmlEl.hasAttribute('disabled');
              })
              .map((el) => {
                const input = el as HTMLInputElement;
                const tag = el.tagName.toLowerCase();
                const type = (input.type || 'text').toLowerCase();
                const name = input.name || '';
                const placeholder = input.placeholder || '';
                const ariaLabel = input.getAttribute('aria-label') || '';
                let selector = '';
                if (input.id) {
                  selector = `#${input.id}`;
                } else if (input.name) {
                  selector = `${tag}[name="${input.name}"]`;
                } else if (input.className && typeof input.className === 'string') {
                  const firstClass = input.className.split(/\s+/).filter(Boolean)[0];
                  selector = firstClass ? `${tag}.${firstClass}` : tag;
                } else {
                  selector = tag;
                }
                return {
                  selector,
                  tag,
                  type,
                  name,
                  placeholder,
                  ariaLabel,
                  value: input.value || ''
                };
              });
          })
          .catch(() => []);

        const unhandledInputs = formInputs.filter(
          (inp) => !this.handledInputs.has(inp.selector) && !this.handledInputs.has(`${currentUrl}::${inp.selector}`)
        );

        const shouldTriggerInput =
          unhandledInputs.length > 0 &&
          (totalScanned === 0 ||
            unhandledInputs.some(
              (inp) =>
                inp.type === 'search' ||
                /search|query|find|filter|keyword|q\b/i.test(inp.name || '') ||
                /search|query|find|filter/i.test(inp.placeholder || '') ||
                /search|query|find|filter/i.test(inp.ariaLabel || '') ||
                inp.selector.includes('search') ||
                inp.selector.includes('query')
            ) ||
            /search|find|query|look|monitor|track|get|browse|filter/i.test(this.activeSpec?.userGoal || spec.userGoal));

        if (shouldTriggerInput) {
          const interactiveElements = await page
            .evaluate(() => {
              const elements = Array.from(
                document.querySelectorAll(
                  'a[href], button, [role="button"], input[type="submit"], .next, a.morelink, [class*="pagination"]'
                )
              );
              return elements.slice(0, 20).map((el) => {
                const tag = el.tagName.toLowerCase();
                const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
                const href = (el as HTMLAnchorElement).href || undefined;
                let selector = '';
                if (el.id) {
                  selector = `#${el.id}`;
                } else if (el.className && typeof el.className === 'string') {
                  const firstClass = el.className.split(/\s+/).filter(Boolean)[0];
                  selector = firstClass ? `${tag}.${firstClass}` : tag;
                } else {
                  selector = tag;
                }
                return { selector, text, href, tag };
              });
            })
            .catch(() => []);

          const pageTitle = await page.title().catch(() => '');

          const handoverContext: HandoverContext = {
            taskId: this.activeSpec?.id || spec.id,
            runId: `run-${Date.now()}`,
            userGoal: this.activeSpec?.userGoal || spec.userGoal,
            targetUrl: this.activeSpec?.targetUrl || spec.targetUrl,
            currentUrl,
            pageTitle,
            triggerReason: 'form_input_required',
            scrollState: { y: 0, scrollHeight: 0, viewportHeight: 0 },
            totalScanned,
            totalAlerts: getAlertCount ? getAlertCount() : this.totalAlerts,
            consecutiveEmptyCycles: 0,
            interactiveElements,
            formInputs: unhandledInputs,
            recentActions: [...this.recentActions]
          };

          await emitAction(
            'system2_handover',
            'pending',
            `Initiating System 2 deliberation for "form_input_required"`,
            { context: handoverContext }
          );

          const decision = await evaluateStagnation(handoverContext);

          if (signal.aborted) break;

          await emitAction(
            'system2_handover',
            'success',
            `System 2 decision: ${decision.action}`,
            { decision }
          );

          // Mark unhandled inputs as handled so we avoid duplicate prompts
          for (const inp of unhandledInputs) {
            this.handledInputs.add(inp.selector);
            this.handledInputs.add(`${currentUrl}::${inp.selector}`);
          }

          if (decision.action === 'form_input') {
            const inputSelector = decision.selector;
            const textToFill = decision.text || '';
            let filled = false;
            try {
              const inputEl = page.locator(inputSelector).first();
              if ((await inputEl.count()) > 0) {
                await inputEl.click({ timeout: 5000 }).catch(() => {});
                await inputEl.fill(textToFill, { timeout: 5000 });
                filled = true;
                this.handledInputs.add(inputSelector);
                this.handledInputs.add(`${currentUrl}::${inputSelector}`);

                // Check if the form has an action attribute
                const formAction = await inputEl.evaluate((el) => {
                  const form = (el as HTMLInputElement).form;
                  return form?.getAttribute('action') || null;
                }).catch(() => null);

                if (decision.submitSelector) {
                  const submitBtn = page.locator(decision.submitSelector).first();
                  if ((await submitBtn.count()) > 0) {
                    await submitBtn.click({ timeout: 5000 }).catch(() => {});
                  } else if (decision.pressEnter !== false) {
                    await inputEl.press('Enter', { timeout: 5000 }).catch(() => {});
                  }
                } else if (decision.pressEnter !== false) {
                  await inputEl.press('Enter', { timeout: 5000 }).catch(() => {});
                }

                if (formAction && formAction.startsWith('data:')) {
                  await page.goto(formAction, { waitUntil: 'domcontentloaded', timeout: 30000 });
                } else {
                  await page.waitForTimeout(100);
                  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                }
                this.visitedUrls.add(page.url());
              }
            } catch (err: any) {
              console.warn(`[BrowserRunner] Form input failed for ${inputSelector}: ${err.message}`);
            }

            await emitAction('interaction', filled ? 'success' : 'warning', `Filled "${textToFill}" into ${inputSelector}`, {
              selector: inputSelector,
              text: textToFill,
              submitSelector: decision.submitSelector,
              pressEnter: decision.pressEnter,
              reasoning: decision.reasoning
            });

            this.recentActions.push(`form_input: ${inputSelector} = "${textToFill}"`);
            this.resetCache();
            this.loopDetector.reset();
            await captureSnapshot(true);
            await triggerCheckpoint();
            continue;
          } else if (decision.action === 'complete' || decision.action === 'terminate') {
            await emitAction(
              'system',
              'success',
              `Run finished by System 2: ${(decision as any).message || (decision as any).reason}`
            );
            break;
          } else if (decision.action === 'navigate') {
            try {
              await page.goto(decision.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
              this.visitedUrls.add(decision.url);
              this.visitedUrls.add(page.url());
            } catch {}
            this.resetCache();
            this.loopDetector.reset();
            await captureSnapshot(true);
            await triggerCheckpoint();
            continue;
          }
        }

        // 1. Batch DOM query for candidate elements matching active DOM selector
        const activeSelector = this.dynamicSelector || spec.domSelector;
        let rawCandidates: { text: string; link: string }[] = [];
        try {
          rawCandidates = await page.$$eval(activeSelector, (elements) => {
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
          await emitAction('extraction', 'success', `Extracted ${rawCandidates.length} candidate elements matching "${activeSelector}"`, {
            count: rawCandidates.length
          });
        }

        // 2. Deduplicate candidates using SHA-1 LRU cache and emit
        let novelCount = 0;
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
          novelCount++;
          totalScanned++;
          this.totalScanned = totalScanned;
          await emitAction('inference', 'pending', `Evaluating candidate: "${cleanText.slice(0, 60)}${cleanText.length > 60 ? '...' : ''}"`, {
            link: raw.link
          });
          await onCandidate({ text: cleanText, link: raw.link });
        }

        if (signal.aborted) break;

        // 3. Query scroll state
        const scrollMetrics = await page
          .evaluate(() => ({
            y: window.scrollY || window.pageYOffset || 0,
            scrollHeight: document.documentElement.scrollHeight || document.body.scrollHeight || 0,
            viewportHeight: window.innerHeight || 0
          }))
          .catch(() => ({ y: 0, scrollHeight: 0, viewportHeight: 0 }));
        this.lastScroll = scrollMetrics;
        if (getAlertCount) {
          this.totalAlerts = getAlertCount();
        }

        // 4. Record cycle in loop detector
        const loopResult = this.loopDetector.recordCycle({
          y: scrollMetrics.y,
          viewportHeight: scrollMetrics.viewportHeight,
          scrollHeight: scrollMetrics.scrollHeight,
          candidateCount: rawCandidates.length,
          novelCount
        });

        // Step B: Detect navigation forks / choices
        const navigationChoices: NavigationChoice[] = await page
          .evaluate(() => {
            const selectors = 'nav a, header a, .categories a, .category a, .menu a, .tabs a, [role="navigation"] a';
            const links = Array.from(document.querySelectorAll(selectors));
            return links
              .map((el) => {
                const a = el as HTMLAnchorElement;
                const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
                const href = a.href || '';
                const rawHref = (a.getAttribute('href') || '').trim();
                let selector = '';
                if (a.id) {
                  selector = `#${a.id}`;
                } else if (a.getAttribute('href')) {
                  selector = `a[href="${a.getAttribute('href')}"]`;
                } else if (a.className && typeof a.className === 'string') {
                  const firstClass = a.className.split(/\s+/).filter(Boolean)[0];
                  selector = firstClass ? `a.${firstClass}` : 'a';
                } else {
                  selector = 'a';
                }
                const category =
                  a.closest('[data-category]')?.getAttribute('data-category') ||
                  a.getAttribute('data-category') ||
                  a.closest('nav, .categories, .menu, .tabs')?.getAttribute('aria-label') ||
                  undefined;
                return { selector, text, href, rawHref, category };
              })
              .filter(
                (c) =>
                  c.text.length > 0 &&
                  c.href.length > 0 &&
                  !c.href.startsWith('javascript:') &&
                  c.href !== '#' &&
                  c.href !== '' &&
                  c.rawHref !== '#' &&
                  !c.rawHref.startsWith('javascript:')
              )
              .map(({ rawHref, ...rest }) => rest);
          })
          .catch(() => []);

        const unvisitedChoices = navigationChoices.filter((c) => {
          if (!c.href) return false;
          const cleanHref = c.href.replace(/\/$/, '');
          return (
            !this.handledChoices.has(c.selector) &&
            !this.handledChoices.has(c.href) &&
            !this.visitedUrls.has(c.href) &&
            !this.visitedUrls.has(cleanHref)
          );
        });

        const isProgressEmpty = totalScanned === 0 && rawCandidates.length === 0;
        const isStagnantWithChoices =
          unvisitedChoices.length > 0 &&
          (isProgressEmpty || (novelCount === 0 && loopResult.consecutiveEmptyCycles >= 1 && !loopResult.isStagnant));

        if (isStagnantWithChoices) {
          const pageTitle = await page.title().catch(() => '');
          const handoverContext: HandoverContext = {
            taskId: this.activeSpec?.id || spec.id,
            runId: `run-${Date.now()}`,
            userGoal: this.activeSpec?.userGoal || spec.userGoal,
            targetUrl: this.activeSpec?.targetUrl || spec.targetUrl,
            currentUrl: page.url() || (this.activeSpec?.targetUrl || spec.targetUrl),
            pageTitle,
            triggerReason: 'navigation_fork',
            scrollState: scrollMetrics,
            totalScanned,
            totalAlerts: getAlertCount ? getAlertCount() : this.totalAlerts,
            consecutiveEmptyCycles: loopResult.consecutiveEmptyCycles,
            navigationChoices: unvisitedChoices,
            recentActions: [...this.recentActions]
          };

          await emitAction(
            'system2_handover',
            'pending',
            `Initiating System 2 deliberation for "navigation_fork"`,
            { context: handoverContext }
          );

          const decision = await evaluateStagnation(handoverContext);

          if (signal.aborted) break;

          await emitAction(
            'system2_handover',
            'success',
            `System 2 decision: ${decision.action}`,
            { decision }
          );

          if (decision.action === 'choose_navigation') {
            this.handledChoices.add(decision.selector);
            if (decision.url) {
              this.handledChoices.add(decision.url);
            }
            let navigated = false;
            const targetUrl = decision.url;
            const targetSelector = decision.selector;
            try {
              if (targetSelector) {
                const linkEl = page.locator(targetSelector).first();
                if ((await linkEl.count()) > 0) {
                  const href = await linkEl.getAttribute('href').catch(() => null);
                  if (href && (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('data:'))) {
                    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    navigated = true;
                    this.visitedUrls.add(href);
                    this.handledChoices.add(href);
                  } else {
                    await linkEl.click({ timeout: 5000 });
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                    navigated = true;
                    this.visitedUrls.add(page.url());
                  }
                }
              }
              if (!navigated && targetUrl) {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                navigated = true;
                this.visitedUrls.add(targetUrl);
                this.handledChoices.add(targetUrl);
              }
            } catch (err: any) {
              console.warn(`[BrowserRunner] Navigation failed: ${err.message}`);
            }

            this.visitedUrls.add(page.url());
            await emitAction(
              'navigation',
              navigated ? 'success' : 'warning',
              `Navigated via choice "${decision.text || targetSelector}" to ${page.url()}`,
              {
                selector: targetSelector,
                url: targetUrl || page.url(),
                text: decision.text,
                reasoning: decision.reasoning
              }
            );

            this.recentActions.push(`choose_navigation: ${decision.text || targetSelector} -> ${page.url()}`);
            this.resetCache();
            this.loopDetector.reset();
            await captureSnapshot(true);
            await triggerCheckpoint();
            continue;
          } else if (decision.action === 'complete' || decision.action === 'terminate') {
            await emitAction(
              'system',
              'success',
              `Run finished by System 2: ${(decision as any).message || (decision as any).reason}`
            );
            break;
          }
        }

        // Step C: Stalled progress detection via LoopDetector
        if (loopResult.isStagnant && loopResult.stuckReason) {
          await emitAction('stagnation_detected', 'warning', `Stagnation detected: ${loopResult.stuckReason}`, {
            stuckReason: loopResult.stuckReason,
            consecutiveEmptyCycles: loopResult.consecutiveEmptyCycles,
            scrollState: scrollMetrics
          });

          // Extract interactive elements safely from page (cap at 20)
          const interactiveElements = await page
            .evaluate(() => {
              const elements = Array.from(
                document.querySelectorAll(
                  'a[href], button, [role="button"], input[type="submit"], .next, a.morelink, [class*="pagination"]'
                )
              );
              return elements.slice(0, 20).map((el) => {
                const tag = el.tagName.toLowerCase();
                const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
                const href = (el as HTMLAnchorElement).href || undefined;
                let selector = '';
                if (el.id) {
                  selector = `#${el.id}`;
                } else if (el.className && typeof el.className === 'string') {
                  const firstClass = el.className.split(/\s+/).filter(Boolean)[0];
                  selector = firstClass ? `${tag}.${firstClass}` : tag;
                } else {
                  selector = tag;
                }
                return { selector, text, href, tag };
              });
            })
            .catch(() => []);

          const currentUrl = page.url() || (this.activeSpec?.targetUrl || spec.targetUrl);
          const pageTitle = await page.title().catch(() => '');

          const handoverContext: HandoverContext = {
            taskId: this.activeSpec?.id || spec.id,
            runId: `run-${Date.now()}`,
            userGoal: this.activeSpec?.userGoal || spec.userGoal,
            targetUrl: this.activeSpec?.targetUrl || spec.targetUrl,
            currentUrl,
            pageTitle,
            triggerReason: 'stalled_progress',
            stuckReason: loopResult.stuckReason,
            scrollState: scrollMetrics,
            totalScanned,
            totalAlerts: getAlertCount ? getAlertCount() : this.totalAlerts,
            consecutiveEmptyCycles: loopResult.consecutiveEmptyCycles,
            interactiveElements,
            navigationChoices: unvisitedChoices,
            recentActions: [...this.recentActions]
          };

          await emitAction(
            'system2_handover',
            'pending',
            `Initiating System 2 deliberation for "${loopResult.stuckReason}"`,
            { context: handoverContext }
          );

          const decision = await evaluateStagnation(handoverContext);

          if (signal.aborted) {
            break;
          }

          await emitAction(
            'system2_handover',
            'success',
            `System 2 decision: ${decision.action}`,
            { decision }
          );

          // Execute System 2 decision
          if (decision.action === 'paginate') {
            let paginated = false;
            if (decision.selector) {
              try {
                let el = page.locator(decision.selector).first();
                if ((await el.count()) > 0) {
                  // If selector resolved to a container element without an href, check for child anchor
                  const aInside = el.locator('a[href]').first();
                  if ((await aInside.count()) > 0) {
                    el = aInside;
                  }
                  const href = await el.getAttribute('href').catch(() => null);
                  if (href && (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('data:'))) {
                    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    paginated = true;
                    this.visitedUrls.add(href);
                  } else {
                    await el.click({ timeout: 5000 }).catch(() => {});
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                    paginated = true;
                    this.visitedUrls.add(page.url());
                  }
                }
              } catch {
                paginated = false;
              }
            }
            if (!paginated) {
              const matched = interactiveElements.find(
                (item) =>
                  (decision.text && item.text.toLowerCase().includes(decision.text.toLowerCase())) ||
                  (decision.selector && item.selector === decision.selector)
              );
              if (matched?.href) {
                try {
                  await page.goto(matched.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
                  paginated = true;
                  this.visitedUrls.add(matched.href);
                } catch {}
              }
            }
            this.visitedUrls.add(page.url());
            this.resetCache();
            this.loopDetector.reset();
            await captureSnapshot(true);
            await triggerCheckpoint();
            continue;
          } else if (decision.action === 'choose_navigation') {
            let navigated = false;
            const targetUrl = decision.url;
            const targetSelector = decision.selector;
            try {
              if (targetSelector) {
                const linkEl = page.locator(targetSelector).first();
                if ((await linkEl.count()) > 0) {
                  const href = await linkEl.getAttribute('href').catch(() => null);
                  if (href && (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('data:'))) {
                    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    navigated = true;
                    this.visitedUrls.add(href);
                  } else {
                    await linkEl.click({ timeout: 5000 });
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                    navigated = true;
                    this.visitedUrls.add(page.url());
                  }
                }
              }
              if (!navigated && targetUrl) {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                navigated = true;
                this.visitedUrls.add(targetUrl);
              }
            } catch (err: any) {
              console.warn(`[BrowserRunner] Navigation failed: ${err.message}`);
            }

            this.visitedUrls.add(page.url());
            await emitAction(
              'navigation',
              navigated ? 'success' : 'warning',
              `Navigated via choice "${decision.text || targetSelector}" to ${page.url()}`,
              {
                selector: targetSelector,
                url: targetUrl || page.url(),
                text: decision.text,
                reasoning: decision.reasoning
              }
            );

            this.recentActions.push(`choose_navigation: ${decision.text || targetSelector} -> ${page.url()}`);
            this.resetCache();
            this.loopDetector.reset();
            await captureSnapshot(true);
            await triggerCheckpoint();
            continue;
          } else if (decision.action === 'form_input') {
            const inputSelector = decision.selector;
            const textToFill = decision.text || '';
            let filled = false;
            try {
              const inputEl = page.locator(inputSelector).first();
              if ((await inputEl.count()) > 0) {
                await inputEl.click({ timeout: 5000 }).catch(() => {});
                await inputEl.fill(textToFill, { timeout: 5000 });
                filled = true;
                this.handledInputs.add(inputSelector);
                this.handledInputs.add(`${currentUrl}::${inputSelector}`);

                // Check if the form has an action attribute
                const formAction = await inputEl.evaluate((el) => {
                  const form = (el as HTMLInputElement).form;
                  return form?.getAttribute('action') || null;
                }).catch(() => null);

                if (decision.submitSelector) {
                  const submitBtn = page.locator(decision.submitSelector).first();
                  if ((await submitBtn.count()) > 0) {
                    await submitBtn.click({ timeout: 5000 }).catch(() => {});
                  } else if (decision.pressEnter !== false) {
                    await inputEl.press('Enter', { timeout: 5000 }).catch(() => {});
                  }
                } else if (decision.pressEnter !== false) {
                  await inputEl.press('Enter', { timeout: 5000 }).catch(() => {});
                }

                if (formAction && formAction.startsWith('data:')) {
                  await page.goto(formAction, { waitUntil: 'domcontentloaded', timeout: 30000 });
                } else {
                  await page.waitForTimeout(100);
                  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                }
                this.visitedUrls.add(page.url());
              }
            } catch (err: any) {
              console.warn(`[BrowserRunner] Form input failed for ${inputSelector}: ${err.message}`);
            }

            await emitAction('interaction', filled ? 'success' : 'warning', `Filled "${textToFill}" into ${inputSelector}`, {
              selector: inputSelector,
              text: textToFill,
              submitSelector: decision.submitSelector,
              pressEnter: decision.pressEnter,
              reasoning: decision.reasoning
            });

            this.recentActions.push(`form_input: ${inputSelector} = "${textToFill}"`);
            this.resetCache();
            this.loopDetector.reset();
            await captureSnapshot(true);
            await triggerCheckpoint();
            continue;
          } else if (decision.action === 'adjust_strategy' || decision.action === 'adjust_selector') {
            const newSel = (decision as any).newSelector || (decision as any).selector;
            if (newSel) {
              this.dynamicSelector = newSel;
            }
            if ((decision as any).scrollStepPx !== undefined) {
              this.dynamicScrollStepPx = (decision as any).scrollStepPx;
            }
            this.loopDetector.reset();
            continue;
          } else if (decision.action === 'retry_with_scroll') {
            const stepPx = (decision as any).scrollStepPx || Math.max(scrollMetrics.viewportHeight, 600);
            try {
              await page.mouse.wheel(0, stepPx);
            } catch {}
            this.loopDetector.reset();
            continue;
          } else if (decision.action === 'navigate') {
            try {
              await page.goto(decision.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
              this.visitedUrls.add(decision.url);
              this.visitedUrls.add(page.url());
            } catch {}
            this.resetCache();
            this.loopDetector.reset();
            await captureSnapshot(true);
            await triggerCheckpoint();
            continue;
          } else if (decision.action === 'switch_tab') {
            if (context) {
              const pages = context.pages();
              const targetIdx = decision.tabIndex ?? 0;
              if (pages[targetIdx] && pages[targetIdx] !== page) {
                page = pages[targetIdx];
                await page.bringToFront().catch(() => {});
              }
            }
            this.loopDetector.reset();
            continue;
          } else if (decision.action === 'complete' || decision.action === 'terminate') {
            await emitAction(
              'system',
              'success',
              `Run finished by System 2: ${(decision as any).message || (decision as any).reason}`
            );
            break;
          }
        }

        // 6. Smooth viewport scrolling
        const step = Math.max(50, this.dynamicScrollStepPx || spec.scrollStepPx || 400);
        try {
          await page.mouse.wheel(0, step);
          await emitAction('scroll', 'success', `Scrolled viewport by ${step}px`);
        } catch {
          if (signal.aborted) break;
        }

        activeStepCount++;
        this.activeStepCount = activeStepCount;

        await triggerCheckpoint();

        // Periodic snapshot capture throttled to <= once per 1000ms
        await captureSnapshot(false);

        // 7. Sleep pollIntervalMs (cancellable via AbortSignal)
        const pollMs = Math.max(50, this.dynamicPollIntervalMs || spec.pollIntervalMs || 800);
        await abortableSleep(pollMs, signal);
      }
    } finally {
      this.activePage = null;
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
