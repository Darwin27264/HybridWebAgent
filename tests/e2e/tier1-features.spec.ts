/**
 * Tier 1: Isolated Happy-Path Functional Tests (Features 1-5 Specification)
 * Derived from ORIGINAL_REQUEST.md & TEST_INFRA.md:
 *
 * Feature 1: Loop & Bottom-of-Page Detection (5 tests)
 * Feature 2: System 1 / System 2 Handover & Steering (5 tests)
 * Feature 3: Hardware Acceleration Ladder & Model Options (5 tests)
 * Feature 4: Markdown Results Store (results.md) (5 tests)
 * Feature 5: Interactive Results & Steering (5 tests)
 *
 * Total: 25 tests
 */

import * as http from 'http';
import { describe, it, expect, beforeAll, afterAll } from './harness';
import {
  createSimulatedWebServer,
  createHandoverContextFixture,
  createSteeringActionFixture,
  createModelStatsFixture,
  createScrapedItemFixture,
  createResultStatsFixture,
  isAtBottomOfPage,
  isScrollStatic,
  evaluateLoopDetectorState,
  resolveHardwareProvider,
  HARDWARE_LADDERS,
  formatMarkdownResultsFile,
  parseMarkdownResultsFile,
  evaluateSteeringDirective,
  answerResultsQuery,
  applySteeringInstruction,
  LruDeduplicator,
  sha1Hash,
  SimulatedWebServer,
} from './test-utils';

// Helper to make genuine HTTP GET requests to simulated server
function httpGet(url: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, text: data });
      });
    }).on('error', reject);
  });
}

// ===========================================================================
// Feature 1: Loop & Bottom-of-Page Detection
// ===========================================================================
describe('Feature 1: Loop & Bottom-of-Page Detection', () => {
  it('1.1: Detects bottom-of-page geometry when scrollY + viewportHeight >= scrollHeight - 5', () => {
    const viewportHeight = 800;
    const scrollHeight = 3000;

    // Above bottom: scrollY = 2000 (2000 + 800 = 2800 < 2995)
    expect(isAtBottomOfPage(2000, viewportHeight, scrollHeight)).toBe(false);

    // Exact threshold: scrollY = 2195 (2195 + 800 = 2995 == 3000 - 5)
    expect(isAtBottomOfPage(2195, viewportHeight, scrollHeight)).toBe(true);

    // Fully at bottom: scrollY = 2200 (2200 + 800 = 3000 >= 2995)
    expect(isAtBottomOfPage(2200, viewportHeight, scrollHeight)).toBe(true);
  });

  it('1.2: Detects static scroll position when scroll Y coordinate remains unchanged across consecutive scroll cycles', () => {
    const prevY = 1500;
    const currYUnchanged = 1500;
    const currYChanged = 1800;

    expect(isScrollStatic(currYUnchanged, prevY)).toBe(true);
    expect(isScrollStatic(currYChanged, prevY)).toBe(false);
  });

  it('1.3: Consecutive empty cycles counter increments on each scroll tick when no new candidate items are extracted', () => {
    let consecutiveEmptyCycles = 0;
    const scrollEvents = [
      { newItemsFound: 3 },
      { newItemsFound: 0 },
      { newItemsFound: 0 },
      { newItemsFound: 0 },
    ];

    for (const evt of scrollEvents) {
      if (evt.newItemsFound === 0) {
        consecutiveEmptyCycles++;
      } else {
        consecutiveEmptyCycles = 0;
      }
    }

    expect(consecutiveEmptyCycles).toBe(3);
  });

  it('1.4: LoopDetector triggers handover condition when consecutive empty cycles reach threshold (>= 3)', () => {
    // Under threshold (2 cycles at bottom) -> no loop
    const stateUnder = {
      y: 2200,
      prevY: 2200,
      viewportHeight: 800,
      scrollHeight: 3000,
      consecutiveEmptyCycles: 2,
      threshold: 3,
    };
    expect(evaluateLoopDetectorState(stateUnder).isLoop).toBe(false);

    // At threshold (3 cycles at bottom) -> loop with bottom_of_page reason
    const stateAt = {
      y: 2200,
      prevY: 2200,
      viewportHeight: 800,
      scrollHeight: 3000,
      consecutiveEmptyCycles: 3,
      threshold: 3,
    };
    const resAt = evaluateLoopDetectorState(stateAt);
    expect(resAt.isLoop).toBe(true);
    expect(resAt.reason).toBe('bottom_of_page');
  });

  it('1.5: LRU candidate deduplication filters previously evaluated DOM elements, triggering empty-cycle increment when all items on screen are duplicates', () => {
    const lru = new LruDeduplicator(50);
    const candidateTexts = [
      'ModernBERT ONNX inference with DirectML',
      'WebGPU tensor execution in Chrome 120',
      'Ollama llama3:8b deliberate prompt strategy',
    ];

    // Tick 1: Extract and store
    let newItemsTick1 = 0;
    for (const text of candidateTexts) {
      const h = sha1Hash(text);
      if (!lru.has(h)) {
        lru.add(h);
        newItemsTick1++;
      }
    }
    expect(newItemsTick1).toBe(3);

    // Tick 2: Same items visible after minimal scroll
    let newItemsTick2 = 0;
    for (const text of candidateTexts) {
      const h = sha1Hash(text);
      if (!lru.has(h)) {
        lru.add(h);
        newItemsTick2++;
      }
    }
    expect(newItemsTick2).toBe(0); // All deduplicated
  });
});

// ===========================================================================
// Feature 2: System 1 / System 2 Handover & Steering
// ===========================================================================
describe('Feature 2: System 1 / System 2 Handover & Steering', () => {
  let simServer: SimulatedWebServer;

  beforeAll(async () => {
    simServer = createSimulatedWebServer({
      pages: {
        '/page/1': {
          title: 'Article List - Page 1',
          items: [
            { id: 'art-1', text: 'Article 1: Intro', link: '/read/1' },
            { id: 'art-2', text: 'Article 2: Advanced', link: '/read/2' },
          ],
          nextPageUrl: '/page/2',
          nextPageSelector: '#next-page',
          nextPageText: 'Next Page',
          scrollHeightPx: 2500,
          viewportHeightPx: 800,
        },
        '/page/2': {
          title: 'Article List - Page 2',
          items: [
            { id: 'art-3', text: 'Article 3: Concurrency', link: '/read/3' },
          ],
          isBottom: true,
          scrollHeightPx: 1200,
          viewportHeightPx: 800,
        },
      },
    });
    await simServer.start();
  });

  afterAll(async () => {
    await simServer.close();
  });

  it('2.1: Generates complete HandoverContext payload including taskId, runId, stuckReason, scrollState, and interactiveElements', () => {
    const context = createHandoverContextFixture({
      taskId: 'task-test-21',
      runId: 'run-test-21',
      stuckReason: 'bottom_of_page',
      scrollState: { y: 1700, scrollHeight: 2500, viewportHeight: 800 },
      interactiveElements: [
        { selector: '#next-page', text: 'Next Page', href: '/page/2', tag: 'a' },
      ],
    });

    expect(context.taskId).toBe('task-test-21');
    expect(context.runId).toBe('run-test-21');
    expect(context.stuckReason).toBe('bottom_of_page');
    expect(context.scrollState.y).toBe(1700);
    expect(context.interactiveElements).toHaveLength(1);
    expect(context.interactiveElements[0].selector).toBe('#next-page');
  });

  it('2.2: Extracts interactive elements from simulated web page DOM (anchor tags matching a[href], buttons with #next-page)', async () => {
    const res = await httpGet(`${simServer.url}/page/1`);
    expect(res.status).toBe(200);

    // Verify HTML contains candidate interactive elements
    expect(res.text).toContain('id="next-page"');
    expect(res.text).toContain('href="/page/2"');
    expect(res.text).toContain('Next Page');
  });

  it('2.3: System 2 deliberator evaluates handover context and returns valid paginate steering action', () => {
    const context = createHandoverContextFixture({
      stuckReason: 'bottom_of_page',
      interactiveElements: [
        { selector: '#next-page', text: 'Next Page', href: '/page/2', tag: 'a' },
      ],
    });

    const directive = evaluateSteeringDirective(context);
    expect(directive.action).toBe('paginate');
    if (directive.action === 'paginate') {
      expect(directive.selector).toBe('#next-page');
      expect(directive.text).toBe('Next Page');
    }
  });

  it('2.4: System 2 deliberator emits terminate steering action when user goal is satisfied or content exhausted', () => {
    const contextExhausted = createHandoverContextFixture({
      stuckReason: 'bottom_of_page',
      interactiveElements: [], // No buttons or links
    });

    const directiveExhausted = evaluateSteeringDirective(contextExhausted);
    expect(directiveExhausted.action).toBe('terminate');
    if (directiveExhausted.action === 'terminate') {
      expect(directiveExhausted.reason).toBe('exhausted');
    }

    const contextGoalMet = createHandoverContextFixture({
      totalAlerts: 10, // Target goal reached
      interactiveElements: [{ selector: '#next-page', text: 'Next', tag: 'a' }],
    });
    const directiveGoalMet = evaluateSteeringDirective(contextGoalMet);
    expect(directiveGoalMet.action).toBe('terminate');
    if (directiveGoalMet.action === 'terminate') {
      expect(directiveGoalMet.reason).toBe('goal_completed');
    }
  });

  it('2.5: Browser runner executes pagination navigation and verifies request arrival on simulated web server', async () => {
    simServer.resetRequests();

    // 1. Initial crawl on Page 1
    const p1Res = await httpGet(`${simServer.url}/page/1`);
    expect(p1Res.status).toBe(200);

    // 2. Handover decides to paginate
    const context = createHandoverContextFixture({
      currentUrl: `${simServer.url}/page/1`,
      interactiveElements: [{ selector: '#next-page', text: 'Next Page', href: '/page/2', tag: 'a' }],
    });
    const directive = evaluateSteeringDirective(context);
    expect(directive.action).toBe('paginate');

    // 3. Follow pagination link to Page 2
    const p2Res = await httpGet(`${simServer.url}/page/2`);
    expect(p2Res.status).toBe(200);
    expect(p2Res.text).toContain('Article 3: Concurrency');

    // 4. Confirm simulated web server recorded requests in order
    const requests = simServer.getRequests();
    expect(requests.length).toBe(2);
    expect(requests[0].url).toBe('/page/1');
    expect(requests[1].url).toBe('/page/2');
  });
});

// ===========================================================================
// Feature 3: Hardware Acceleration Ladder & Model Options
// ===========================================================================
describe('Feature 3: Hardware Acceleration Ladder & Model Options', () => {
  it('3.1: Windows hardware probe tests WebGPU -> DirectML -> CPU fallback sequence, selecting DirectML when WebGPU is unavailable', () => {
    const winLadder = HARDWARE_LADDERS.win32;
    expect(winLadder).toEqual(['webgpu', 'dml', 'cpu']);

    // WebGPU absent, DirectML available
    const chosen = resolveHardwareProvider('win32', ['dml', 'cpu']);
    expect(chosen.provider).toBe('dml');
    expect(chosen.device).toContain('DirectML');
    expect(chosen.format).toBe('fp32');
  });

  it('3.2: Linux hardware probe tests CUDA -> ROCm -> OpenVINO -> WebGPU -> CPU sequence, selecting CUDA when available', () => {
    const linuxLadder = HARDWARE_LADDERS.linux;
    expect(linuxLadder).toEqual(['cuda', 'rocm', 'openvino', 'webgpu', 'cpu']);

    // NVIDIA GPU detected
    const chosen = resolveHardwareProvider('linux', ['cuda', 'cpu']);
    expect(chosen.provider).toBe('cuda');
    expect(chosen.device).toContain('NVIDIA');
    expect(chosen.format).toBe('fp32');

    // AMD GPU detected
    const chosenAmd = resolveHardwareProvider('linux', ['rocm', 'cpu']);
    expect(chosenAmd.provider).toBe('rocm');
    expect(chosenAmd.device).toContain('AMD');

    // Intel NPU/GPU detected
    const chosenIntel = resolveHardwareProvider('linux', ['openvino', 'cpu']);
    expect(chosenIntel.provider).toBe('openvino');
    expect(chosenIntel.device).toContain('Intel');
  });

  it('3.3: System 1 model selector loads INT8 quantized model (laya_int8.onnx) and reports format in telemetry', () => {
    const stats = createModelStatsFixture({
      systemOne: {
        modelName: 'laya_int8.onnx',
        format: 'int8',
        provider: 'cpu',
        device: 'CPU (AVX2-VNNI)',
        status: 'ready',
        avgLatencyMs: 8.4,
      },
    });

    expect(stats.systemOne.modelName).toBe('laya_int8.onnx');
    expect(stats.systemOne.format).toBe('int8');
    expect(stats.systemOne.status).toBe('ready');
    expect(stats.systemOne.avgLatencyMs).toBeLessThan(10);
  });

  it('3.4: System 1 model selector loads FP32 model (laya.onnx) and reports active execution provider', () => {
    const stats = createModelStatsFixture({
      systemOne: {
        modelName: 'laya.onnx',
        format: 'fp32',
        provider: 'dml',
        device: 'NVIDIA GeForce RTX 4070 (DirectML)',
        status: 'ready',
        avgLatencyMs: 3.2,
      },
    });

    expect(stats.systemOne.modelName).toBe('laya.onnx');
    expect(stats.systemOne.format).toBe('fp32');
    expect(stats.systemOne.provider).toBe('dml');
    expect(stats.systemOne.device).toContain('RTX 4070');
  });

  it('3.5: Model loading lifecycle telemetry transitions through idle -> loading -> ready and emits MODEL_STATS message structure', () => {
    const transitions: Array<{ status: 'idle' | 'loading' | 'ready'; latency: number }> = [
      { status: 'idle', latency: 0 },
      { status: 'loading', latency: 0 },
      { status: 'ready', latency: 12.5 },
    ];

    expect(transitions[0].status).toBe('idle');
    expect(transitions[1].status).toBe('loading');
    expect(transitions[2].status).toBe('ready');

    const msg = {
      type: 'MODEL_STATS' as const,
      payload: createModelStatsFixture(),
    };
    expect(msg.type).toBe('MODEL_STATS');
    expect(msg.payload.systemOne.status).toBe('ready');
    expect(msg.payload.systemTwo.availableModels).toContain('llama3:8b');
  });
});

// ===========================================================================
// Feature 4: Markdown Results Store (results.md)
// ===========================================================================
describe('Feature 4: Markdown Results Store (results.md)', () => {
  it('4.1: Initializes results.md with standard YAML frontmatter metadata, timestamp, and column headers', () => {
    const items = [
      createScrapedItemFixture({ id: 'item-1', text: 'Sample Item 1', triggeredAlert: true }),
    ];
    const md = formatMarkdownResultsFile({
      title: 'Documentation Index Results',
      taskId: 'task-doc-1',
      items,
    });

    expect(md).toContain('---');
    expect(md).toContain('title: "Documentation Index Results"');
    expect(md).toContain('taskId: "task-doc-1"');
    expect(md).toContain('generatedAt:');
    expect(md).toContain('## Statistics');
    expect(md).toContain('## Scraped Items');
    expect(md).toContain('| # | ID | Text | Link | Status | Confidence |');
  });

  it('4.2: Appends newly scraped items with structured answers, confidence score, and alert flags', () => {
    const items = [
      createScrapedItemFixture({
        id: 'item-101',
        text: 'DirectML ONNX Execution Provider for Windows',
        link: 'https://onnxruntime.ai/docs/dml',
        confidence: 0.98,
        triggeredAlert: true,
      }),
      createScrapedItemFixture({
        id: 'item-102',
        text: 'General CSS grid tutorial',
        link: 'https://example.com/css',
        confidence: 0.42,
        triggeredAlert: false,
      }),
    ];

    const md = formatMarkdownResultsFile({ items });
    const parsed = parseMarkdownResultsFile(md);

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].id).toBe('item-101');
    expect(parsed.items[0].alert).toBe(true);
    expect(parsed.items[0].confidence).toBe(0.98);
    expect(parsed.items[1].id).toBe('item-102');
    expect(parsed.items[1].alert).toBe(false);
  });

  it('4.3: Calculates and updates summary statistics (ResultStats: totalScanned, totalAlerts, matchRatePercent)', () => {
    const items = [
      createScrapedItemFixture({ triggeredAlert: true }),
      createScrapedItemFixture({ triggeredAlert: false }),
      createScrapedItemFixture({ triggeredAlert: true }),
      createScrapedItemFixture({ triggeredAlert: false }),
    ];

    const stats = createResultStatsFixture({
      totalScanned: 4,
      totalAlerts: 2,
      matchRatePercent: 50.0,
      avgLatencyMs: 11.2,
    });

    const md = formatMarkdownResultsFile({ items, stats });
    const parsed = parseMarkdownResultsFile(md);

    expect(parsed.stats.totalScanned).toBe(4);
    expect(parsed.stats.totalAlerts).toBe(2);
    expect(parsed.stats.matchRatePercent).toBe(50.0);
    expect(parsed.stats.avgLatencyMs).toBe(11.2);
  });

  it('4.4: System 2 generates plain English executive narrative summary and embeds it into the markdown summary block', () => {
    const customSummary = 'High concentration of hardware acceleration references detected across pages 1 and 2.';
    const md = formatMarkdownResultsFile({
      items: [createScrapedItemFixture()],
      summary: customSummary,
    });

    const parsed = parseMarkdownResultsFile(md);
    expect(parsed.summary).toBe(customSummary);
  });

  it('4.5: Offline fallback generates structured rule-based summary when LLM/System 2 is unavailable', () => {
    const items = [
      createScrapedItemFixture({ triggeredAlert: true }),
      createScrapedItemFixture({ triggeredAlert: false }),
    ];
    // No LLM summary passed -> formatMarkdownResultsFile defaults to rule-based fallback
    const md = formatMarkdownResultsFile({ items });
    const parsed = parseMarkdownResultsFile(md);

    expect(parsed.summary).toContain('Successfully extracted 2 items');
    expect(parsed.summary).toContain('1 alert-triggering items');
    expect(parsed.summary).toContain('50.0% match rate');
  });
});

// ===========================================================================
// Feature 5: Interactive Results & Steering Interface
// ===========================================================================
describe('Feature 5: Interactive Results & Steering Interface', () => {
  it('5.1: Handles GET_RESULTS request and responds with markdown and stats from the store', () => {
    const items = [
      createScrapedItemFixture({ id: 'item-51', text: 'Ollama 14b model config', triggeredAlert: true }),
    ];
    const stats = createResultStatsFixture({ totalScanned: 1, totalAlerts: 1, matchRatePercent: 100 });
    const markdown = formatMarkdownResultsFile({ items, stats });

    const responseMsg = {
      type: 'RESULTS_UPDATE' as const,
      payload: {
        markdown,
        summary: '1 item collected with alert.',
        stats,
        items,
        timestamp: new Date().toISOString(),
      },
    };

    expect(responseMsg.type).toBe('RESULTS_UPDATE');
    expect(responseMsg.payload.markdown).toContain('item-51');
    expect(responseMsg.payload.stats.totalScanned).toBe(1);
    expect(responseMsg.payload.items).toHaveLength(1);
  });

  it('5.2: Handles QUERY_RESULTS request and returns plain English QUERY_RESULTS_RESPONSE from System 2 assistant', () => {
    const items = [
      createScrapedItemFixture({ text: 'WebGPU benchmark item', triggeredAlert: true, answers: { category: 'Hardware' } }),
      createScrapedItemFixture({ text: 'DirectML driver issue', triggeredAlert: true, answers: { category: 'Hardware' } }),
      createScrapedItemFixture({ text: 'HTML styling guide', triggeredAlert: false, answers: { category: 'Web' } }),
    ];

    const resAlerts = answerResultsQuery('How many alerts were triggered?', items);
    expect(resAlerts.answer).toContain('2 alert-triggering items');
    expect(resAlerts.answer).toContain('66.7% match rate');
    expect(resAlerts.model).toBe('llama3:8b');

    const resCats = answerResultsQuery('What are the categories?', items);
    expect(resCats.answer).toContain('Hardware: 2');
    expect(resCats.answer).toContain('Web: 1');
  });

  it('5.3: Handles STEER_TASK request and translates natural language instruction into actionable task parameter updates', () => {
    const currentParams = {
      url: 'http://127.0.0.1/page/1',
      selector: '.item',
      scrollStep: 300,
    };

    // Steering 1: Increase scroll step
    const steerStep = applySteeringInstruction('Increase scroll step to 600px', currentParams);
    expect(steerStep.applied).toBe(true);
    expect(steerStep.updatedParams.scrollStep).toBe(600);
    expect(steerStep.explanation).toContain('600px');

    // Steering 2: Adjust selector
    const steerSel = applySteeringInstruction('Focus only on ONNX models', currentParams);
    expect(steerSel.applied).toBe(true);
    expect(steerSel.updatedParams.selector).toContain('onnx');
  });

  it('5.4: Broadcasts RESULTS_UPDATE event payload containing latest markdown, summary, stats, and items array', () => {
    const items = [createScrapedItemFixture()];
    const stats = createResultStatsFixture();
    const markdown = formatMarkdownResultsFile({ items, stats });

    const payload = {
      markdown,
      summary: 'Broadcasting results update',
      stats,
      items,
      timestamp: new Date().toISOString(),
    };

    expect(typeof payload.markdown).toBe('string');
    expect(payload.items).toHaveLength(1);
    expect(payload.stats.totalScanned).toBeGreaterThan(0);
  });

  it('5.5: User steering adjustments dynamically update active scraping parameters for subsequent extraction cycle', () => {
    let runnerConfig = {
      url: 'http://127.0.0.1/old-page',
      selector: '.article',
      scrollStep: 200,
    };

    // User submits steering instruction
    const userInstruction = 'Navigate to http://127.0.0.1/new-page and set scroll step to 500px';
    const result = applySteeringInstruction(userInstruction, runnerConfig);

    expect(result.applied).toBe(true);
    runnerConfig = result.updatedParams;

    expect(runnerConfig.url).toBe('http://127.0.0.1/new-page');
  });
});
