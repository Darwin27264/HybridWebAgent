import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LoopDetector,
  isAtBottomOfPage,
  isScrollStatic,
  type CycleTelemetry
} from '../src/runner/loopDetector.js';
import { evaluateStagnation } from '../src/engine/systemTwoAssistant.js';
import { BrowserRunner } from '../src/runner/browserRunner.js';
import type { CompiledTaskSpec, HandoverContext, AgentAction } from '@ofln-scout/shared';

describe('Milestone 3: LoopDetector & System 2 Handover Suite', () => {
  describe('LoopDetector Unit Logic', () => {
    it('1. Threshold bounding and reset behavior', () => {
      const detector = new LoopDetector({ threshold: 3, tolerance: 5 });
      assert.equal(detector.consecutiveEmptyCycles, 0);

      // Cycle 1: zero novelty
      const r1 = detector.recordCycle({
        y: 100,
        viewportHeight: 800,
        scrollHeight: 3000,
        candidateCount: 5,
        novelCount: 0
      });
      assert.equal(r1.isStagnant, false);
      assert.equal(r1.stuckReason, undefined);
      assert.equal(detector.consecutiveEmptyCycles, 1);

      // Cycle 2: zero novelty
      const r2 = detector.recordCycle({
        y: 200,
        viewportHeight: 800,
        scrollHeight: 3000,
        candidateCount: 5,
        novelCount: 0
      });
      assert.equal(r2.isStagnant, false);
      assert.equal(detector.consecutiveEmptyCycles, 2);

      // Cycle 3: novel items discovered -> counter resets
      const r3 = detector.recordCycle({
        y: 300,
        viewportHeight: 800,
        scrollHeight: 3000,
        candidateCount: 5,
        novelCount: 2
      });
      assert.equal(r3.isStagnant, false);
      assert.equal(detector.consecutiveEmptyCycles, 0);

      // Cycle 4, 5: empty cycles
      detector.recordCycle({
        y: 400,
        viewportHeight: 800,
        scrollHeight: 3000,
        candidateCount: 5,
        novelCount: 0
      });
      detector.recordCycle({
        y: 500,
        viewportHeight: 800,
        scrollHeight: 3000,
        candidateCount: 5,
        novelCount: 0
      });
      assert.equal(detector.consecutiveEmptyCycles, 2);

      // Cycle 6: 3rd consecutive empty cycle -> triggers stagnation
      const r6 = detector.recordCycle({
        y: 600,
        viewportHeight: 800,
        scrollHeight: 3000,
        candidateCount: 5,
        novelCount: 0
      });
      assert.equal(r6.isStagnant, true);
      assert.equal(r6.consecutiveEmptyCycles, 3);
      assert.equal(r6.stuckReason, 'no_new_items');

      // Manual reset clears consecutive empty cycles
      detector.reset();
      assert.equal(detector.consecutiveEmptyCycles, 0);
    });

    it('2. Bottom of page detection', () => {
      const detector = new LoopDetector({ threshold: 3, tolerance: 5 });

      // Helper function validation
      assert.equal(isAtBottomOfPage(1200, 800, 2000, 5), true);
      assert.equal(isAtBottomOfPage(1195, 800, 2000, 5), true); // within tolerance
      assert.equal(isAtBottomOfPage(1190, 800, 2000, 5), false); // outside tolerance
      assert.equal(isAtBottomOfPage(0, 0, 0, 5), false); // uninitialized / invalid

      // 3 cycles at the bottom of the page
      detector.recordCycle({
        y: 1200,
        viewportHeight: 800,
        scrollHeight: 2000,
        candidateCount: 5,
        novelCount: 0
      });
      detector.recordCycle({
        y: 1200,
        viewportHeight: 800,
        scrollHeight: 2000,
        candidateCount: 5,
        novelCount: 0
      });
      const res = detector.recordCycle({
        y: 1200,
        viewportHeight: 800,
        scrollHeight: 2000,
        candidateCount: 5,
        novelCount: 0
      });

      assert.equal(res.isStagnant, true);
      assert.equal(res.stuckReason, 'bottom_of_page');
    });

    it('3. Static scroll detection (repeated_actions)', () => {
      const detector = new LoopDetector({ threshold: 3, tolerance: 5 });

      // Helper function validation
      assert.equal(isScrollStatic(400, 400, 5), true);
      assert.equal(isScrollStatic(404, 400, 5), true); // within tolerance
      assert.equal(isScrollStatic(410, 400, 5), false);

      // Not at bottom of page (scrollHeight is 5000), but y stays at 400
      detector.recordCycle({
        y: 400,
        viewportHeight: 800,
        scrollHeight: 5000,
        candidateCount: 5,
        novelCount: 0
      });
      detector.recordCycle({
        y: 400,
        viewportHeight: 800,
        scrollHeight: 5000,
        candidateCount: 5,
        novelCount: 0
      });
      const res = detector.recordCycle({
        y: 400,
        viewportHeight: 800,
        scrollHeight: 5000,
        candidateCount: 5,
        novelCount: 0
      });

      assert.equal(res.isStagnant, true);
      assert.equal(res.stuckReason, 'repeated_actions');
    });

    it('4. Zero novelty detection (no_new_items)', () => {
      const detector = new LoopDetector({ threshold: 3 });

      // Viewport moves progressively down, not at bottom, items found, but 0 are novel
      detector.recordCycle({
        y: 100,
        viewportHeight: 800,
        scrollHeight: 5000,
        candidateCount: 4,
        novelCount: 0
      });
      detector.recordCycle({
        y: 300,
        viewportHeight: 800,
        scrollHeight: 5000,
        candidateCount: 4,
        novelCount: 0
      });
      const res = detector.recordCycle({
        y: 500,
        viewportHeight: 800,
        scrollHeight: 5000,
        candidateCount: 4,
        novelCount: 0
      });

      assert.equal(res.isStagnant, true);
      assert.equal(res.stuckReason, 'no_new_items');
    });

    it('5. Empty selector detection (selector_empty)', () => {
      const detector = new LoopDetector({ threshold: 3 });

      // Candidate count is 0 on all cycles, not at bottom
      detector.recordCycle({
        y: 0,
        viewportHeight: 800,
        scrollHeight: 3000,
        candidateCount: 0,
        novelCount: 0
      });
      detector.recordCycle({
        y: 100,
        viewportHeight: 800,
        scrollHeight: 3000,
        candidateCount: 0,
        novelCount: 0
      });
      const res = detector.recordCycle({
        y: 200,
        viewportHeight: 800,
        scrollHeight: 3000,
        candidateCount: 0,
        novelCount: 0
      });

      assert.equal(res.isStagnant, true);
      assert.equal(res.stuckReason, 'selector_empty');
    });
  });

  describe('evaluateStagnation Offline Heuristic Decisions', () => {
    const baseContext: HandoverContext = {
      taskId: 'test-task-m3',
      runId: 'run-test-m3',
      userGoal: 'Collect local AI tools',
      targetUrl: 'https://news.ycombinator.com',
      currentUrl: 'https://news.ycombinator.com',
      pageTitle: 'Hacker News',
      stuckReason: 'bottom_of_page',
      scrollState: { y: 2200, scrollHeight: 3000, viewportHeight: 800 },
      totalScanned: 25,
      totalAlerts: 2,
      consecutiveEmptyCycles: 3,
      interactiveElements: []
    };

    it('terminates with goal_completed when totalAlerts >= 10', async () => {
      const ctx: HandoverContext = {
        ...baseContext,
        totalAlerts: 10,
        stuckReason: 'bottom_of_page',
        interactiveElements: [{ selector: '#next-page', text: 'Next Page', tag: 'a' }]
      };
      const action = await evaluateStagnation(ctx);
      assert.equal(action.action, 'terminate');
      if (action.action === 'terminate') {
        assert.equal(action.reason, 'goal_completed');
        assert.match(action.message, /target alerts acquired/i);
      }
    });

    it('returns paginate action when bottom_of_page or no_new_items with pagination elements', async () => {
      const ctx1: HandoverContext = {
        ...baseContext,
        stuckReason: 'bottom_of_page',
        interactiveElements: [
          { selector: 'button.search', text: 'Search', tag: 'button' },
          { selector: '#next-page', text: 'Next Page', tag: 'a', href: '/page/2' }
        ]
      };
      const act1 = await evaluateStagnation(ctx1);
      assert.equal(act1.action, 'paginate');
      if (act1.action === 'paginate') {
        assert.equal(act1.selector, '#next-page');
        assert.equal(act1.text, 'Next Page');
      }

      const ctx2: HandoverContext = {
        ...baseContext,
        stuckReason: 'no_new_items',
        interactiveElements: [
          { selector: 'a.morelink', text: 'More', tag: 'a', href: '/news?p=2' }
        ]
      };
      const act2 = await evaluateStagnation(ctx2);
      assert.equal(act2.action, 'paginate');
      if (act2.action === 'paginate') {
        assert.equal(act2.selector, 'a.morelink');
      }
    });

    it('terminates with exhausted when bottom_of_page has no pagination matches', async () => {
      const ctx: HandoverContext = {
        ...baseContext,
        stuckReason: 'bottom_of_page',
        interactiveElements: [
          { selector: 'a.privacy', text: 'Privacy Policy', tag: 'a' },
          { selector: 'a.terms', text: 'Terms of Service', tag: 'a' }
        ]
      };
      const act = await evaluateStagnation(ctx);
      assert.equal(act.action, 'terminate');
      if (act.action === 'terminate') {
        assert.equal(act.reason, 'exhausted');
        assert.match(act.message, /page boundary reached/i);
      }
    });

    it('returns adjust_strategy with broader selector when selector_empty', async () => {
      const ctx: HandoverContext = {
        ...baseContext,
        stuckReason: 'selector_empty'
      };
      const act = await evaluateStagnation(ctx);
      assert.equal(act.action, 'adjust_strategy');
      if (act.action === 'adjust_strategy') {
        assert.ok(act.newSelector);
        assert.match(act.newSelector, /article|\.post|\.item/);
        assert.equal(act.scrollStepPx, 400);
      }
    });

    it('returns retry_with_scroll with increased scroll step when repeated_actions', async () => {
      const ctx: HandoverContext = {
        ...baseContext,
        stuckReason: 'repeated_actions',
        scrollState: { y: 500, scrollHeight: 3000, viewportHeight: 900 }
      };
      const act = await evaluateStagnation(ctx);
      assert.equal(act.action, 'retry_with_scroll');
      if (act.action === 'retry_with_scroll') {
        assert.equal(act.scrollStepPx, 900); // Math.max(viewportHeight, 600)
      }
    });
  });

  describe('BrowserRunner Integration (Playwright Headless Chromium)', () => {
    it('executes pagination crawl across multiple pages with System 2 handover', async () => {
      const runner = new BrowserRunner({ headless: true });

      // Page 2 data URI
      const page2Html = `
        <!DOCTYPE html>
        <html>
          <head><style>body { min-height: 800px; margin: 0; padding: 20px; }</style></head>
          <body>
            <h2>Page 2 Results</h2>
            <div class="result-item"><a href="https://example.com/p2-1">Page 2 Item 1: ONNX Runtime Web</a></div>
            <div class="result-item"><a href="https://example.com/p2-2">Page 2 Item 2: Laya ModernBERT INT8</a></div>
            <div id="end-marker" style="margin-top: 600px;">End of items</div>
          </body>
        </html>
      `;
      const page2Uri = `data:text/html;charset=utf-8,${encodeURIComponent(page2Html)}`;

      // Page 1 data URI linking to Page 2
      const page1Html = `
        <!DOCTYPE html>
        <html>
          <head><style>body { min-height: 800px; margin: 0; padding: 20px; }</style></head>
          <body>
            <h2>Page 1 Results</h2>
            <div class="result-item"><a href="https://example.com/p1-1">Page 1 Item 1: Scout Architecture</a></div>
            <div class="result-item"><a href="https://example.com/p1-2">Page 1 Item 2: Playwright Web Scraping</a></div>
            <div style="margin-top: 600px;">
              <a id="next-page" href="${page2Uri}">Next Page</a>
            </div>
          </body>
        </html>
      `;
      const page1Uri = `data:text/html;charset=utf-8,${encodeURIComponent(page1Html)}`;

      const spec: CompiledTaskSpec = {
        id: 'pagination-task-01',
        name: 'Pagination Crawl Task',
        userGoal: 'Scrape articles across paginated feed',
        targetUrl: page1Uri,
        domSelector: '.result-item',
        pollIntervalMs: 50,
        scrollStepPx: 400,
        questions: {
          relevant: {
            type: 'noul',
            statement: 'Is this relevant?'
          }
        },
        alertRule: {
          questionKey: 'relevant',
          operator: 'boolean_true',
          targetValue: true,
          minAnswerConfidence: 0.8
        },
        createdAt: Date.now()
      };

      const extractedCandidates: { text: string; link?: string }[] = [];
      const recordedActions: AgentAction[] = [];
      const controller = new AbortController();

      // Configure timeout guard to prevent test hanging
      const timeoutTimer = setTimeout(() => controller.abort(), 15000);

      try {
        await runner.runTask(
          spec,
          async (candidate) => {
            extractedCandidates.push(candidate);
          },
          controller.signal,
          (action) => {
            recordedActions.push(action);
          }
        );
      } finally {
        clearTimeout(timeoutTimer);
      }

      // 1. Verify candidate extraction across both pages
      assert.ok(
        extractedCandidates.length >= 4,
        `Expected at least 4 items across pages, got ${extractedCandidates.length}`
      );
      assert.ok(
        extractedCandidates.some((c) => c.text.includes('Page 1 Item 1')),
        'Must contain Page 1 Item 1'
      );
      assert.ok(
        extractedCandidates.some((c) => c.text.includes('Page 2 Item 1')),
        'Must contain Page 2 Item 1 from paginated load'
      );

      // 2. Verify stagnation detection and System 2 handover actions
      const stagnationActions = recordedActions.filter((a) => a.type === 'stagnation_detected');
      const handoverActions = recordedActions.filter((a) => a.type === 'system2_handover');

      assert.ok(
        stagnationActions.length >= 1,
        'Expected at least one stagnation_detected action'
      );
      assert.ok(
        handoverActions.length >= 2, // pending + success
        'Expected system2_handover actions emitted'
      );

      const paginateHandover = handoverActions.find(
        (a) => a.status === 'success' && a.details?.decision?.action === 'paginate'
      );
      assert.ok(paginateHandover, 'Must have a successful paginate decision recorded');
    });

    it('dynamically adapts extraction via applySteering during active crawling', async () => {
      const runner = new BrowserRunner({ headless: true });

      const htmlContent = `
        <!DOCTYPE html>
        <html>
          <head><style>body { min-height: 2500px; margin: 0; padding: 20px; }</style></head>
          <body>
            <h2>Dual Tag Document</h2>
            <div class="tech-item"><a href="https://example.com/t1">Tech: Fast ONNX</a></div>
            <div class="tech-item"><a href="https://example.com/t2">Tech: WebGPU Pipeline</a></div>
            <div class="finance-item" style="margin-top: 100px;"><a href="https://example.com/f1">Finance: Q3 Earnings</a></div>
            <div class="finance-item"><a href="https://example.com/f2">Finance: Fed Interest Rates</a></div>
          </body>
        </html>
      `;
      const dataUri = `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`;

      const initialSpec: CompiledTaskSpec = {
        id: 'dynamic-steer-task-01',
        name: 'Dynamic Steer Task',
        userGoal: 'Scrape tech items then steer to finance',
        targetUrl: dataUri,
        domSelector: '.tech-item',
        pollIntervalMs: 60,
        scrollStepPx: 200,
        questions: {
          q1: { type: 'noul', statement: 'Check item' }
        },
        alertRule: {
          questionKey: 'q1',
          operator: 'boolean_true',
          targetValue: true,
          minAnswerConfidence: 0.8
        },
        createdAt: Date.now()
      };

      const extractedCandidates: { text: string; link?: string }[] = [];
      const controller = new AbortController();
      let steered = false;

      const runPromise = runner.runTask(
        initialSpec,
        async (candidate) => {
          extractedCandidates.push(candidate);

          // Once tech items are extracted, dynamically apply steering to switch selector to .finance-item
          if (!steered && extractedCandidates.length >= 2) {
            steered = true;
            const updatedSpec: CompiledTaskSpec = {
              ...initialSpec,
              domSelector: '.finance-item'
            };
            runner.applySteering(updatedSpec);
          }

          // Once finance items are also extracted, finish test
          if (extractedCandidates.some((c) => c.text.includes('Finance: Fed Interest Rates'))) {
            controller.abort();
          }
        },
        controller.signal
      );

      const timeoutTimer = setTimeout(() => controller.abort(), 10000);
      try {
        await runPromise;
      } finally {
        clearTimeout(timeoutTimer);
      }

      assert.ok(steered, 'applySteering must have been invoked');
      assert.ok(
        extractedCandidates.some((c) => c.text.includes('Tech: Fast ONNX')),
        'Must contain initial tech item'
      );
      assert.ok(
        extractedCandidates.some((c) => c.text.includes('Finance: Q3 Earnings') || c.text.includes('Finance: Fed Interest Rates')),
        'Must contain steered finance item extracted without restarting runner'
      );
    });
  });
});
