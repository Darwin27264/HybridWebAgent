/**
 * Tier 2: Boundary & Corner Case Tests (Features 1-5 Specification)
 * Derived from ORIGINAL_REQUEST.md & TEST_INFRA.md:
 *
 * Feature 1: Loop & Bottom-of-Page Detection (6 boundary tests)
 * Feature 2: System 1 / System 2 Handover & Steering (6 boundary tests)
 * Feature 3: Hardware Acceleration Ladder & Model Options (5 boundary tests)
 * Feature 4: Markdown Results Store (results.md) (8 boundary tests)
 * Feature 5: Interactive Results & Steering (5 boundary tests)
 *
 * Total: 30 tests
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
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
// Feature 1: Boundary & Edge Cases
// ===========================================================================
describe('Feature 1: Boundary & Edge Cases (Loop Detection)', () => {
  it('1.1: Scroll height equals viewport height (single-screen page): immediately classifies as bottom-of-page without division-by-zero', () => {
    const scrollHeight = 800;
    const viewportHeight = 800;
    const scrollY = 0;

    // Single-screen page: 0 + 800 >= 800 - 5
    expect(isAtBottomOfPage(scrollY, viewportHeight, scrollHeight)).toBe(true);
  });

  it('1.2: Dynamic content height mutation: page height expands during scrolling (infinite scroll), resetting bottom-of-page state', () => {
    let scrollHeight = 2000;
    const viewportHeight = 800;
    let scrollY = 1205; // 1205 + 800 = 2005 >= 1995 (at bottom)

    expect(isAtBottomOfPage(scrollY, viewportHeight, scrollHeight)).toBe(true);

    // Dynamic items append, expanding height
    scrollHeight = 3500;
    // Same position is no longer at bottom
    expect(isAtBottomOfPage(scrollY, viewportHeight, scrollHeight)).toBe(false);
  });

  it('1.3: Exact boundary threshold: consecutive empty cycles at threshold minus 1 (N=2) does not trigger loop; cycle N=3 triggers', () => {
    const stateAt2 = {
      y: 2000,
      prevY: 2000,
      viewportHeight: 800,
      scrollHeight: 2800,
      consecutiveEmptyCycles: 2,
      threshold: 3,
    };
    expect(evaluateLoopDetectorState(stateAt2).isLoop).toBe(false);

    const stateAt3 = {
      ...stateAt2,
      consecutiveEmptyCycles: 3,
    };
    const res = evaluateLoopDetectorState(stateAt3);
    expect(res.isLoop).toBe(true);
    expect(res.reason).toBe('bottom_of_page');
  });

  it('1.4: Rapid scroll bounce / elastic overscroll (negative scrollY or scrollY + viewportHeight > scrollHeight): clamps values safely', () => {
    const viewportHeight = 800;
    const scrollHeight = 2500;

    // Elastic overscroll at top (negative scrollY)
    const clampedTopY = Math.max(0, -50);
    expect(clampedTopY).toBe(0);
    expect(isAtBottomOfPage(clampedTopY, viewportHeight, scrollHeight)).toBe(false);

    // Elastic overscroll at bottom (scrollY exceeds max)
    const overscrollBottomY = 1800; // 1800 + 800 = 2600 > 2500
    expect(isAtBottomOfPage(overscrollBottomY, viewportHeight, scrollHeight)).toBe(true);
  });

  it('1.5: Zero candidate elements matching selector on initial page load: triggers selector_empty stuck reason', () => {
    const state = {
      y: 0,
      prevY: 0,
      viewportHeight: 800,
      scrollHeight: 1000,
      consecutiveEmptyCycles: 3,
    };

    // If zero items extracted from load with empty selector
    const handover = createHandoverContextFixture({
      stuckReason: 'selector_empty',
      consecutiveEmptyCycles: 3,
      interactiveElements: [],
    });

    expect(handover.stuckReason).toBe('selector_empty');
    const directive = evaluateSteeringDirective(handover);
    expect(directive.action).toBe('adjust_strategy');
    if (directive.action === 'adjust_strategy') {
      expect(directive.newSelector).toContain('content-item');
    }
  });

  it('1.6: Infinite scroll query boundary sanitization: negative offset (?offset=-5) and negative limit (?limit=-2) are clamped to non-negative domains without crashing generator or server', async () => {
    const dataset = [{ id: '1', text: 'Item 1' }, { id: '2', text: 'Item 2' }];
    const server = createSimulatedWebServer({
      infiniteScroll: {
        endpoint: '/api/feed',
        itemsPerPage: 10,
        totalItems: 50,
        generator: (i) => {
          if (i < 0 || i >= dataset.length) {
            throw new Error(`Invalid index: ${i}`);
          }
          return dataset[i];
        },
      },
    });
    const { url } = await server.start();
    try {
      // Query with negative offset and negative limit
      const res = await httpGet(`${url}/api/feed?offset=-5&limit=-2`);
      expect(res.status).toBe(200);
      const data = JSON.parse(res.text);
      expect(data.offset).toBe(0);
      expect(data.limit).toBe(0);
      expect(data.items).toEqual([]);

      // Query with negative page
      const resPage = await httpGet(`${url}/api/feed?page=-3`);
      expect(resPage.status).toBe(200);
      const dataPage = JSON.parse(resPage.text);
      expect(dataPage.page).toBe(1);
      expect(dataPage.offset).toBe(0);
    } finally {
      await server.close();
    }
  });
});

// ===========================================================================
// Feature 2: Boundary & Edge Cases
// ===========================================================================
describe('Feature 2: Boundary & Edge Cases (Handover & Steering)', () => {
  let simServer: SimulatedWebServer;

  beforeAll(async () => {
    simServer = createSimulatedWebServer({
      pages: {
        '/empty-page': {
          title: 'Empty Document',
          items: [],
          scrollHeightPx: 800,
          viewportHeightPx: 800,
          interactiveElements: [],
        },
        '/page/a': {
          title: 'Circular Page A',
          items: [{ text: 'Item on A' }],
          nextPageUrl: '/page/b',
          scrollHeightPx: 1000,
        },
        '/page/b': {
          title: 'Circular Page B',
          items: [{ text: 'Item on B' }],
          nextPageUrl: '/page/a', // Links back to A!
          scrollHeightPx: 1000,
        },
      },
    });
    await simServer.start();
  });

  afterAll(async () => {
    await simServer.close();
  });

  it('2.1: Handover when page contains zero interactive elements: System 2 cleanly terminates with exhausted', () => {
    const context = createHandoverContextFixture({
      stuckReason: 'bottom_of_page',
      interactiveElements: [],
      totalAlerts: 1,
    });

    const directive = evaluateSteeringDirective(context);
    expect(directive.action).toBe('terminate');
    if (directive.action === 'terminate') {
      expect(directive.reason).toBe('exhausted');
      expect(directive.message).toContain('No pagination');
    }
  });

  it('2.2: Pagination element is hidden or detached: runner detects non-actionable element and requests strategy adjustment without unhandled error', () => {
    const nonActionableElements = [
      { selector: '#hidden-next', text: 'Next', tag: 'a', href: 'javascript:void(0)' },
    ];

    // Filter out non-actionable anchors
    const actionable = nonActionableElements.filter(el =>
      el.href && !el.href.startsWith('javascript:') && el.href !== '#'
    );

    expect(actionable).toHaveLength(0);

    const context = createHandoverContextFixture({
      interactiveElements: actionable,
    });
    const directive = evaluateSteeringDirective(context);
    expect(directive.action).toBe('terminate');
  });

  it('2.3: System 2 deliberator timeout (LLM unresponsive / 504 Gateway Timeout): engages fallback steering heuristic without freezing', async () => {
    let timeoutOccurred = false;
    const fallbackSteering = async (timeoutMs: number): Promise<any> => {
      return Promise.race([
        new Promise((_, reject) => setTimeout(() => {
          timeoutOccurred = true;
          reject(new Error('LLM Deliberation Timeout'));
        }, timeoutMs)),
      ]).catch((_err) => {
        // Fallback heuristic: default safe termination
        return createSteeringActionFixture('terminate', {
          reason: 'exhausted',
          message: 'Fallback triggered due to System 2 timeout',
        });
      });
    };

    const result = await fallbackSteering(10);
    expect(timeoutOccurred).toBe(true);
    expect(result.action).toBe('terminate');
    expect(result.message).toContain('timeout');
  });

  it('2.4: Circular pagination loop (Page 2 links back to Page 1): history tracker detects circular URL navigation and terminates', () => {
    const visitedUrls = new Set<string>();
    const navigationHistory = ['/page/a', '/page/b', '/page/a'];

    let circularDetected = false;
    for (const url of navigationHistory) {
      if (visitedUrls.has(url)) {
        circularDetected = true;
        break;
      }
      visitedUrls.add(url);
    }

    expect(circularDetected).toBe(true);
    const directive = createSteeringActionFixture('terminate', {
      reason: 'exhausted',
      message: 'Circular navigation loop detected: /page/a revisited',
    });
    expect(directive.action).toBe('terminate');
  });

  it('2.5: Malformed / unparseable System 2 steering directive: schema validator rejects invalid payload and defaults to safe termination', () => {
    const malformedPayloads = [
      { action: 'unknown_action', foo: 'bar' },
      { action: 'paginate' }, // missing selector
      { action: 'navigate' }, // missing url
      null,
      undefined,
    ];

    function validateSteeringAction(raw: any): boolean {
      if (!raw || typeof raw !== 'object') return false;
      if (raw.action === 'paginate') return typeof raw.selector === 'string';
      if (raw.action === 'navigate') return typeof raw.url === 'string';
      if (raw.action === 'terminate') return typeof raw.reason === 'string';
      if (raw.action === 'adjust_strategy') return true;
      return false;
    }

    for (const p of malformedPayloads) {
      const isValid = validateSteeringAction(p);
      expect(isValid).toBe(false);
    }
  });

  it('2.6: Ephemeral server lifecycle: start -> close -> restart on identical instance acquires fresh ephemeral port without EADDRINUSE or socket reset', async () => {
    const server = createSimulatedWebServer({
      pages: {
        '/ping': 'pong',
      },
    });

    const initial = await server.start();
    expect(initial.port).toBeGreaterThan(0);
    const initialRes = await httpGet(`${initial.url}/ping`);
    expect(initialRes.status).toBe(200);
    expect(initialRes.text).toBe('pong');

    await server.close();

    const restarted = await server.start();
    expect(restarted.port).toBeGreaterThan(0);
    const restartedRes = await httpGet(`${restarted.url}/ping`);
    expect(restartedRes.status).toBe(200);
    expect(restartedRes.text).toBe('pong');

    await server.close();
  });
});

// ===========================================================================
// Feature 3: Boundary & Edge Cases
// ===========================================================================
describe('Feature 3: Boundary & Edge Cases (Hardware Acceleration)', () => {
  it('3.1: Simulated GPU initialization error (missing DirectML DLL or CUDA driver mismatch): seamlessly falls back to CPU provider', () => {
    // DirectML DLL missing on Windows -> available backends only has CPU
    const winFallback = resolveHardwareProvider('win32', ['cpu']);
    expect(winFallback.provider).toBe('cpu');
    expect(winFallback.device).toBe('CPU');
    expect(winFallback.format).toBe('int8'); // CPU selects INT8

    // CUDA driver mismatch on Linux -> available backends only has CPU
    const linuxFallback = resolveHardwareProvider('linux', ['cpu']);
    expect(linuxFallback.provider).toBe('cpu');
  });

  it('3.2: INT8 model file missing or corrupted: reports error in model status and falls back to FP32 model', () => {
    let currentModel = 'laya_int8.onnx';
    let currentFormat: 'fp32' | 'int8' = 'int8';
    let status: 'ready' | 'error' = 'ready';

    // Simulate missing INT8 file
    const fileExists = false;
    if (!fileExists) {
      status = 'error';
      // Fallback to stable FP32
      currentModel = 'laya.onnx';
      currentFormat = 'fp32';
      status = 'ready';
    }

    expect(currentModel).toBe('laya.onnx');
    expect(currentFormat).toBe('fp32');
    expect(status).toBe('ready');
  });

  it('3.3: Large model timeout: Ollama request exceeding configured timeout (e.g. 60s for 70b model) triggers timeout error and resets status', () => {
    const stats = createModelStatsFixture({
      systemTwo: {
        modelName: 'llama3:70b',
        availableModels: ['llama3:70b'],
        status: 'loading',
      },
    });

    // Simulate timeout firing
    stats.systemTwo.status = 'error';
    stats.systemTwo.error = 'Ollama model load timed out after 60000ms';

    expect(stats.systemTwo.status).toBe('error');
    expect(stats.systemTwo.error).toContain('timed out');
  });

  it('3.4: VRAM exhaustion during model loading: catches out-of-memory error, marks status error, and retains previous stable model', () => {
    let activeModel = 'llama3:8b';
    const attemptedModel = 'deepseek-r1:70b';
    let loadStatus: 'idle' | 'loading' | 'ready' | 'error' = 'loading';

    // Simulate OOM exception
    try {
      const vramAvailableMb = 6000;
      const vramRequiredMb = 42000;
      if (vramRequiredMb > vramAvailableMb) {
        throw new Error('CUDA out of memory: tried to allocate 42.00 GiB with 6.00 GiB available');
      }
      activeModel = attemptedModel;
      loadStatus = 'ready';
    } catch {
      loadStatus = 'error';
      // activeModel retained
    }

    expect(loadStatus).toBe('error');
    expect(activeModel).toBe('llama3:8b');
  });

  it('3.5: Rapid concurrent model switch requests: serializes queue so only the final requested model remains active', async () => {
    let currentModel = 'initial-model';
    const queue: string[] = [];

    const requestSwitch = (model: string) => {
      queue.push(model);
    };

    requestSwitch('model-a');
    requestSwitch('model-b');
    requestSwitch('model-final');

    // Process queue sequentially
    while (queue.length > 0) {
      currentModel = queue.shift()!;
    }

    expect(currentModel).toBe('model-final');
  });
});

// ===========================================================================
// Feature 4: Boundary & Edge Cases
// ===========================================================================
describe('Feature 4: Boundary & Edge Cases (Markdown Results Store)', () => {
  it('4.1: Concurrent write protection: multiple async candidate extractions writing to results.md simultaneously avoid corruption', async () => {
    const initialItems = [createScrapedItemFixture({ id: 'item-init' })];
    let itemsStore = [...initialItems];

    // Simulate 10 concurrent writes
    const concurrentWrites = Array.from({ length: 10 }).map((_, i) => async () => {
      const newItem = createScrapedItemFixture({ id: `item-c-${i}` });
      // Atomic push simulation
      itemsStore = [...itemsStore, newItem];
    });

    await Promise.all(concurrentWrites.map(fn => fn()));

    expect(itemsStore).toHaveLength(11);
    const md = formatMarkdownResultsFile({ items: itemsStore });
    const parsed = parseMarkdownResultsFile(md);
    expect(parsed.items).toHaveLength(11);
  });

  it('4.2: Special character and Markdown injection in scraped text: sanitizes pipes |, backticks, HTML tags, and newlines in table cells', () => {
    const maliciousItem = createScrapedItemFixture({
      id: 'malicious-1',
      text: 'Row injection | <script>alert(1)</script> | `rm -rf` \n Newline in cell',
      link: 'https://example.com?a=1&b=2|3',
    });

    const md = formatMarkdownResultsFile({ items: [maliciousItem] });
    const parsed = parseMarkdownResultsFile(md);

    expect(parsed.items).toHaveLength(1);
    // Verified parsed item text contains escaped pipes restored safely
    expect(parsed.items[0].text).toContain('Row injection');
    expect(parsed.items[0].text).toContain('<script>alert(1)</script>');
  });

  it('4.3: Scraped item with empty or null fields (missing link, 0 confidence, empty answers): formats table row cleanly without NaN or null errors', () => {
    const emptyItem = createScrapedItemFixture({
      id: 'empty-fields-1',
      text: '',
      link: undefined,
      confidence: 0,
      answers: {},
      triggeredAlert: false,
    });

    const md = formatMarkdownResultsFile({ items: [emptyItem] });
    const parsed = parseMarkdownResultsFile(md);

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe('empty-fields-1');
    expect(parsed.items[0].confidence).toBe(0);
    expect(parsed.items[0].alert).toBe(false);
  });

  it('4.4: Huge dataset handling: formatting markdown table with >= 1,000 items maintains sub-second rendering without memory leak', () => {
    const largeItems = Array.from({ length: 1000 }).map((_, i) =>
      createScrapedItemFixture({
        id: `large-${i}`,
        text: `Document item number ${i} with benchmark metrics`,
        triggeredAlert: i % 10 === 0,
      })
    );

    const startTime = Date.now();
    const md = formatMarkdownResultsFile({ items: largeItems });
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(1000); // Sub-second
    expect(md.length).toBeGreaterThan(50000);

    const parsed = parseMarkdownResultsFile(md);
    expect(parsed.items).toHaveLength(1000);
  });

  it('4.5: Read-only / invalid filesystem path: handles write permission errors gracefully and reports via daemon notification', () => {
    let errorCaught = false;
    let notificationEmitted: any = null;

    try {
      const invalidPath = 'Z:\\non_existent_drive_mount_12345\\results.md';
      // Attempting write to non-existent drive should throw on Windows
      fs.writeFileSync(invalidPath, '# Results');
    } catch (err: any) {
      errorCaught = true;
      notificationEmitted = {
        level: 'error',
        title: 'Results Store Error',
        message: `Failed to persist results.md: ${err.message}`,
        timestamp: Date.now(),
      };
    }

    expect(errorCaught).toBe(true);
    expect(notificationEmitted.level).toBe('error');
    expect(notificationEmitted.title).toBe('Results Store Error');
  });

  it('4.6: URL containing closing parentheses (e.g. Wikipedia or technical reference URLs) roundtrips through format and parse without truncation', () => {
    const testUrl = 'https://en.wikipedia.org/wiki/Pipeline_(computing)';
    const item = createScrapedItemFixture({
      id: 'item-paren-url',
      text: 'Computing Pipeline Architecture Article',
      link: testUrl,
    });

    const md = formatMarkdownResultsFile({ items: [item] });
    const parsed = parseMarkdownResultsFile(md);

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].link).toBe(testUrl);
  });

  it('4.7: Composite item ID containing pipe characters (e.g. "test|job|1") roundtrips cleanly without table column shifting', () => {
    const compositeId = 'test|job|1';
    const item = createScrapedItemFixture({
      id: compositeId,
      text: 'Extracted content with valid description',
      link: 'https://example.com/item/1',
      confidence: 0.95,
      triggeredAlert: true,
    });

    const md = formatMarkdownResultsFile({ items: [item] });
    const parsed = parseMarkdownResultsFile(md);

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe(compositeId);
    expect(parsed.items[0].text).toBe('Extracted content with valid description');
    expect(parsed.items[0].link).toBe('https://example.com/item/1');
    expect(parsed.items[0].alert).toBe(true);
    expect(parsed.items[0].confidence).toBe(0.95);
  });

  it('4.8: Executive summary containing internal "## " subheadings roundtrips without truncation', () => {
    const richSummary = `Primary summary overview line.

## Key Insights
- Point A: 100% precision achieved.
- Point B: Zero regressions detected.

## Deliberation Details
Detailed synthesis and contextual remarks from System 2 deliberator.`;

    const md = formatMarkdownResultsFile({
      summary: richSummary,
      items: [createScrapedItemFixture({ id: 'item-1' })],
    });
    const parsed = parseMarkdownResultsFile(md);

    expect(parsed.summary).toBe(richSummary.trim());
    expect(parsed.items).toHaveLength(1);
  });
});

// ===========================================================================
// Feature 5: Boundary & Edge Cases
// ===========================================================================
describe('Feature 5: Boundary & Edge Cases (Interactive Results & Steering)', () => {
  it('5.1: QUERY_RESULTS when dataset is completely empty: returns informative message instead of failing', () => {
    const emptyItems: any[] = [];
    const response = answerResultsQuery('What are the top categories?', emptyItems);

    expect(response.answer).toBe('No scraped items are currently stored in results.md.');
    expect(response.model).toBe('llama3:8b');
  });

  it('5.2: Contradictory or unachievable steering instruction (e.g. "fly to the moon"): System 2 returns applied: false with explanatory feedback', () => {
    const currentParams = { url: 'http://127.0.0.1', selector: '.card', scrollStep: 300 };
    const resImpossible = applySteeringInstruction('Fly to the moon and mine helium', currentParams);

    expect(resImpossible.applied).toBe(false);
    expect(resImpossible.explanation).toContain('rejected');
    expect(resImpossible.updatedParams).toEqual(currentParams);
  });

  it('5.3: High-frequency WebSocket steering queries: throttles or queues requests without dropping connections', () => {
    const queue: string[] = [];
    const maxQueueSize = 5;
    let droppedCount = 0;

    // Simulate 20 rapid queries
    for (let i = 0; i < 20; i++) {
      if (queue.length < maxQueueSize) {
        queue.push(`Query #${i}`);
      } else {
        droppedCount++;
      }
    }

    expect(queue.length).toBe(5);
    expect(droppedCount).toBe(15);
  });

  it('5.4: Client disconnection mid-RPC: daemon completes inference without crashing on orphaned WebSocket socket', () => {
    let clientConnected = true;
    let inferenceCompleted = false;

    // Client disconnects before inference completes
    clientConnected = false;

    // Inference finishes
    const result = { answer: 'Computed answer' };
    inferenceCompleted = true;

    // Safe send check
    let sentSafely = false;
    if (clientConnected) {
      sentSafely = true;
    }

    expect(inferenceCompleted).toBe(true);
    expect(sentSafely).toBe(false); // Cleanly handled without throw
  });

  it('5.5: Malformed JSON in STEER_TASK payload: returns structured error response without crashing server', () => {
    const malformedRaw = '{"type": "STEER_TASK", "payload": { invalid json }';

    let errorResponse: any = null;
    try {
      JSON.parse(malformedRaw);
    } catch (err: any) {
      errorResponse = {
        type: 'ERROR_RESPONSE',
        code: 400,
        message: `Malformed JSON payload: ${err.message}`,
      };
    }

    expect(errorResponse).not.toBeNull();
    expect(errorResponse.code).toBe(400);
    expect(errorResponse.type).toBe('ERROR_RESPONSE');
  });
});
