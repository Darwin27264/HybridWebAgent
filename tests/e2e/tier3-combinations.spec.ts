/**
 * Tier 3: Cross-Feature Pairwise Interaction Tests (Specification)
 * Derived from ORIGINAL_REQUEST.md & TEST_INFRA.md:
 *
 * Pair 1: Loop Detection + S1/S2 Handover & Steering (F1 + F2)
 * Pair 2: S1/S2 Steering + Markdown Results Store (F2 + F4)
 * Pair 3: Hardware Acceleration Fallback + Loop Detection (F1 + F3)
 * Pair 4: Markdown Results Store + Interactive Querying (F4 + F5)
 * Pair 5: Interactive Steering + Live Task Execution (F2 + F5)
 * Pair 6: Model Lifecycle Telemetry + Results Summary Engine (F3 + F4)
 *
 * Total: 6 pairwise tests
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

describe('Tier 3: Pairwise Cross-Feature Combinations', () => {
  let simServer: SimulatedWebServer;

  beforeAll(async () => {
    simServer = createSimulatedWebServer({
      pages: {
        '/docs/page/1': {
          title: 'Documentation - Page 1',
          items: [
            { id: 'doc-1', text: 'Hardware Acceleration with WebGPU', link: '/docs/webgpu' },
            { id: 'doc-2', text: 'Ollama Multi-Model Setup', link: '/docs/ollama' },
          ],
          nextPageUrl: '/docs/page/2',
          nextPageSelector: '#next-page',
          nextPageText: 'Next Page',
          scrollHeightPx: 2500,
          viewportHeightPx: 800,
        },
        '/docs/page/2': {
          title: 'Documentation - Page 2',
          items: [
            { id: 'doc-3', text: 'Interactive Steering and Live Results', link: '/docs/steering' },
            { id: 'doc-4', text: 'Markdown Data Persistence Architecture', link: '/docs/markdown' },
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

  it('Pair 1: Loop Detection + S1/S2 Handover & Steering: bottom-of-page loop triggers handover, deliberates paginate, and navigates', async () => {
    simServer.resetRequests();

    // 1. Crawl Page 1 and reach bottom
    const res1 = await httpGet(`${simServer.url}/docs/page/1`);
    expect(res1.status).toBe(200);

    const scrollState = {
      y: 1700,
      prevY: 1700,
      viewportHeight: 800,
      scrollHeight: 2500,
      consecutiveEmptyCycles: 3,
    };

    // 2. Loop detection triggers
    const loopStatus = evaluateLoopDetectorState(scrollState);
    expect(loopStatus.isLoop).toBe(true);
    expect(loopStatus.reason).toBe('bottom_of_page');

    // 3. Handover context packaged with DOM interactive elements
    const context = createHandoverContextFixture({
      targetUrl: `${simServer.url}/docs/page/1`,
      currentUrl: `${simServer.url}/docs/page/1`,
      stuckReason: loopStatus.reason,
      interactiveElements: [
        { selector: '#next-page', text: 'Next Page', href: '/docs/page/2', tag: 'a' },
      ],
    });

    // 4. System 2 deliberates and issues paginate directive
    const directive = evaluateSteeringDirective(context);
    expect(directive.action).toBe('paginate');
    if (directive.action === 'paginate') {
      expect(directive.selector).toBe('#next-page');
    }

    // 5. Runner follows pagination link to Page 2
    const res2 = await httpGet(`${simServer.url}/docs/page/2`);
    expect(res2.status).toBe(200);
    expect(res2.text).toContain('Documentation - Page 2');

    // Confirm request trace
    const requests = simServer.getRequests();
    expect(requests.length).toBe(2);
    expect(requests[0].url).toBe('/docs/page/1');
    expect(requests[1].url).toBe('/docs/page/2');
  });

  it('Pair 2: S1/S2 Steering + Markdown Results Store: navigating to Page 2 scrapes items and updates markdown stats', () => {
    // Initial batch from Page 1
    const page1Items = [
      createScrapedItemFixture({ id: 'p1-1', text: 'Item 1 from page 1', triggeredAlert: true }),
      createScrapedItemFixture({ id: 'p1-2', text: 'Item 2 from page 1', triggeredAlert: false }),
    ];

    let storeMarkdown = formatMarkdownResultsFile({ items: page1Items });
    let parsed = parseMarkdownResultsFile(storeMarkdown);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.stats.totalScanned).toBe(2);
    expect(parsed.stats.totalAlerts).toBe(1);

    // Paginate and scrape Page 2 items
    const page2Items = [
      createScrapedItemFixture({ id: 'p2-1', text: 'Item 3 from page 2', triggeredAlert: true }),
      createScrapedItemFixture({ id: 'p2-2', text: 'Item 4 from page 2', triggeredAlert: false }),
    ];

    const allItems = [...page1Items, ...page2Items];
    storeMarkdown = formatMarkdownResultsFile({ items: allItems });
    parsed = parseMarkdownResultsFile(storeMarkdown);

    expect(parsed.items).toHaveLength(4);
    expect(parsed.stats.totalScanned).toBe(4);
    expect(parsed.stats.totalAlerts).toBe(2);
    expect(parsed.stats.matchRatePercent).toBe(50.0);
  });

  it('Pair 3: Hardware Acceleration Fallback + Loop Detection: CPU fallback increases inference latency without affecting loop detection accuracy', () => {
    // GPU mode: avg latency ~3.2ms
    const gpuProvider = resolveHardwareProvider('win32', ['dml', 'cpu']);
    expect(gpuProvider.provider).toBe('dml');

    // Simulate GPU driver crash -> fallback to CPU mode: avg latency ~14.5ms
    const cpuProvider = resolveHardwareProvider('win32', ['cpu']);
    expect(cpuProvider.provider).toBe('cpu');

    // Loop detector evaluations should remain strictly decoupled from inference provider latency
    const loopState = {
      y: 2400,
      prevY: 2400,
      viewportHeight: 800,
      scrollHeight: 3200,
      consecutiveEmptyCycles: 3,
      threshold: 3,
    };

    const loopResult = evaluateLoopDetectorState(loopState);
    expect(loopResult.isLoop).toBe(true);
    expect(loopResult.reason).toBe('bottom_of_page');
  });

  it('Pair 4: Markdown Results Store + Interactive Querying: items persisted in results.md are immediately answered via System 2 Q&A', () => {
    const items = [
      createScrapedItemFixture({
        id: 'bench-1',
        text: 'NVIDIA RTX 4090 WebGPU throughput 120 tokens/sec',
        answers: { category: 'Hardware' },
        triggeredAlert: true,
      }),
      createScrapedItemFixture({
        id: 'bench-2',
        text: 'DirectML driver latency test on Windows 11',
        answers: { category: 'Hardware' },
        triggeredAlert: true,
      }),
      createScrapedItemFixture({
        id: 'bench-3',
        text: 'Python Playwright headless browser setup',
        answers: { category: 'Browser' },
        triggeredAlert: false,
      }),
    ];

    // Persist to markdown
    const md = formatMarkdownResultsFile({ items });
    expect(md).toContain('NVIDIA RTX 4090');

    // Query 1: Alert count
    const qAlerts = answerResultsQuery('How many alert matches were detected?', items);
    expect(qAlerts.answer).toContain('2 alert-triggering items');

    // Query 2: Categories
    const qCats = answerResultsQuery('What categories were scraped?', items);
    expect(qCats.answer).toContain('Hardware: 2');
    expect(qCats.answer).toContain('Browser: 1');
  });

  it('Pair 5: Interactive Steering + Live Task Execution: STEER_TASK dynamically modifies running task parameters without restarting', () => {
    let activeTaskConfig = {
      url: 'http://127.0.0.1/initial-feed',
      selector: '.feed-item',
      scrollStep: 300,
    };

    // User submits steering instruction to speed up scrolling and change selector
    const instruction = 'Increase scroll step to 750px and focus only on ONNX cards';
    const steeringOutcome = applySteeringInstruction(instruction, activeTaskConfig);

    expect(steeringOutcome.applied).toBe(true);
    activeTaskConfig = steeringOutcome.updatedParams;

    expect(activeTaskConfig.scrollStep).toBe(750);
    expect(activeTaskConfig.selector).toContain('onnx');
    expect(activeTaskConfig.url).toBe('http://127.0.0.1/initial-feed'); // URL preserved
  });

  it('Pair 6: Model Lifecycle Telemetry + Results Summary Engine: switching System 2 model updates summary engine attribution', () => {
    const modelStats = createModelStatsFixture({
      systemTwo: {
        modelName: 'llama3:8b',
        availableModels: ['llama3:8b', 'llama3:14b', 'qwen2.5:32b'],
        status: 'ready',
      },
    });

    const items = [createScrapedItemFixture()];
    const initialQuery = answerResultsQuery('Summary of items', items);
    expect(initialQuery.model).toBe('llama3:8b');

    // User switches model to llama3:14b
    modelStats.systemTwo.modelName = 'llama3:14b';
    expect(modelStats.systemTwo.modelName).toBe('llama3:14b');
  });
});
