/**
 * Tier 4: Realistic End-to-End Application Scenarios (Specification)
 * Derived from ORIGINAL_REQUEST.md & TEST_INFRA.md:
 *
 * Scenario 1: Multi-Page Documentation Crawl with Bottom-of-Page Pagination
 * Scenario 2: Infinite Scroll Scraping with Strategy Adjustment Steering
 * Scenario 3: Interactive Results Analysis & Follow-Up Steering Journey
 * Scenario 4: Hardware Degradation & Recovery during High-Volume Scraping
 * Scenario 5: Complete Task Lifecycle (Compilation -> Multi-Page Loop -> Steering -> Summary -> Markdown)
 *
 * Total: 5 scenarios
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

describe('Tier 4: Realistic E2E Application Scenarios', () => {
  let simServer: SimulatedWebServer;

  beforeAll(async () => {
    simServer = createSimulatedWebServer({
      pages: {
        '/crawl/p1': {
          title: 'Docs Crawl - Page 1',
          items: [
            { id: 'c1-1', text: 'Overview of Architecture', link: '/docs/1' },
            { id: 'c1-2', text: 'System 1 Laya Engine', link: '/docs/2' },
          ],
          nextPageUrl: '/crawl/p2',
          nextPageSelector: '#next-page',
          nextPageText: 'Page 2',
          scrollHeightPx: 2000,
          viewportHeightPx: 800,
        },
        '/crawl/p2': {
          title: 'Docs Crawl - Page 2',
          items: [
            { id: 'c2-1', text: 'System 2 Ollama Assistant', link: '/docs/3' },
            { id: 'c2-2', text: 'Hardware Acceleration Providers', link: '/docs/4' },
          ],
          nextPageUrl: '/crawl/p3',
          nextPageSelector: '#next-page',
          nextPageText: 'Page 3',
          scrollHeightPx: 2000,
          viewportHeightPx: 800,
        },
        '/crawl/p3': {
          title: 'Docs Crawl - Page 3',
          items: [
            { id: 'c3-1', text: 'Markdown Results Persistence', link: '/docs/5' },
          ],
          isBottom: true,
          scrollHeightPx: 1000,
          viewportHeightPx: 800,
        },
      },
      infiniteScroll: {
        endpoint: '/api/infinite-feed',
        itemsPerPage: 5,
        totalItems: 15,
        generator: (idx) => ({
          id: `feed-item-${idx + 1}`,
          text: `Realtime Feed Post #${idx + 1} regarding ONNX DirectML optimization`,
          link: `/posts/${idx + 1}`,
          category: idx % 2 === 0 ? 'Hardware' : 'Software',
        }),
      },
    });
    await simServer.start();
  });

  afterAll(async () => {
    await simServer.close();
  });

  it('Scenario 1: Multi-Page Documentation Crawl with Bottom-of-Page Pagination end-to-end journey', async () => {
    simServer.resetRequests();
    const collectedItems: any[] = [];
    let currentUrl = `${simServer.url}/crawl/p1`;
    let crawlFinished = false;
    let pageCount = 0;

    while (!crawlFinished && pageCount < 5) {
      pageCount++;
      // 1. Fetch current page
      const res = await httpGet(currentUrl);
      expect(res.status).toBe(200);

      // 2. Extract items on page
      if (currentUrl.includes('/p1')) {
        collectedItems.push(
          createScrapedItemFixture({ id: 'c1-1', text: 'Overview of Architecture', triggeredAlert: false }),
          createScrapedItemFixture({ id: 'c1-2', text: 'System 1 Laya Engine', triggeredAlert: true })
        );
      } else if (currentUrl.includes('/p2')) {
        collectedItems.push(
          createScrapedItemFixture({ id: 'c2-1', text: 'System 2 Ollama Assistant', triggeredAlert: true }),
          createScrapedItemFixture({ id: 'c2-2', text: 'Hardware Acceleration Providers', triggeredAlert: true })
        );
      } else if (currentUrl.includes('/p3')) {
        collectedItems.push(
          createScrapedItemFixture({ id: 'c3-1', text: 'Markdown Results Persistence', triggeredAlert: false })
        );
      }

      // 3. Scroll to bottom and evaluate loop detector
      const isBottom = isAtBottomOfPage(1200, 800, currentUrl.includes('/p3') ? 1000 : 2000);
      expect(isBottom).toBe(true);

      const loopState = evaluateLoopDetectorState({
        y: 1200,
        prevY: 1200,
        viewportHeight: 800,
        scrollHeight: currentUrl.includes('/p3') ? 1000 : 2000,
        consecutiveEmptyCycles: 3,
      });
      expect(loopState.isLoop).toBe(true);

      // 4. Extract interactive pagination elements
      const hasNextLink = res.text.includes('id="next-page"');
      const interactiveElements = hasNextLink
        ? [{ selector: '#next-page', text: 'Next Page', href: currentUrl.includes('/p1') ? '/crawl/p2' : '/crawl/p3', tag: 'a' }]
        : [];

      // 5. Handover to System 2 Deliberator
      const context = createHandoverContextFixture({
        currentUrl,
        stuckReason: loopState.reason,
        interactiveElements,
      });
      const directive = evaluateSteeringDirective(context);

      if (directive.action === 'paginate') {
        const nextTarget = interactiveElements[0].href;
        currentUrl = `${simServer.url}${nextTarget}`;
      } else if (directive.action === 'terminate') {
        expect(directive.reason).toBe('exhausted');
        crawlFinished = true;
      }
    }

    // Verify all 3 pages visited
    expect(pageCount).toBe(3);
    expect(collectedItems).toHaveLength(5);

    // Verify persistence in results.md
    const md = formatMarkdownResultsFile({ items: collectedItems, taskId: 'crawl-task-1' });
    const parsed = parseMarkdownResultsFile(md);
    expect(parsed.items).toHaveLength(5);
    expect(parsed.stats.totalAlerts).toBe(3);
    expect(parsed.stats.totalScanned).toBe(5);

    const requests = simServer.getRequests();
    expect(requests.length).toBe(3);
    expect(requests[0].url).toBe('/crawl/p1');
    expect(requests[1].url).toBe('/crawl/p2');
    expect(requests[2].url).toBe('/crawl/p3');
  });

  it('Scenario 2: Infinite Scroll Scraping with Strategy Adjustment Steering end-to-end journey', async () => {
    // 1. Initial batch request to infinite scroll endpoint
    const feedRes1 = await httpGet(`${simServer.url}/api/infinite-feed?page=1`);
    expect(feedRes1.status).toBe(200);
    const feedData1 = JSON.parse(feedRes1.text);
    expect(feedData1.items).toHaveLength(5);
    expect(feedData1.hasMore).toBe(true);

    // 2. Feed simulation pauses / rate-limits (no new items on page 1 retry)
    const consecutiveEmpty = 3;
    const loopStatus = evaluateLoopDetectorState({
      y: 1000,
      prevY: 1000,
      viewportHeight: 800,
      scrollHeight: 1000,
      consecutiveEmptyCycles: consecutiveEmpty,
    });
    expect(loopStatus.isLoop).toBe(true);

    // 3. User submits steering instruction via STEER_TASK
    let taskParams = { scrollStep: 300, selector: '.item' };
    const steerResult = applySteeringInstruction(
      'Increase scroll step to 600px and focus only on ONNX cards',
      taskParams
    );
    expect(steerResult.applied).toBe(true);
    taskParams = steerResult.updatedParams;
    expect(taskParams.scrollStep).toBe(600);
    expect(taskParams.selector).toContain('onnx');

    // 4. Runner resumes with updated strategy, requesting page 2
    const feedRes2 = await httpGet(`${simServer.url}/api/infinite-feed?page=2`);
    expect(feedRes2.status).toBe(200);
    const feedData2 = JSON.parse(feedRes2.text);
    expect(feedData2.items).toHaveLength(5);
    expect(feedData2.items[0].id).toBe('feed-item-6');
  });

  it('Scenario 3: Interactive Results Analysis & Follow-Up Steering Journey end-to-end journey', () => {
    // 1. Task scrapes items into store
    const items = [
      createScrapedItemFixture({ id: 's3-1', text: 'WebGPU compute shaders for ModernBERT', answers: { category: 'Hardware' }, triggeredAlert: true }),
      createScrapedItemFixture({ id: 's3-2', text: 'CUDA vs ROCm performance breakdown', answers: { category: 'Hardware' }, triggeredAlert: true }),
      createScrapedItemFixture({ id: 's3-3', text: 'Ollama local LLM API integration', answers: { category: 'Software' }, triggeredAlert: false }),
    ];
    const md = formatMarkdownResultsFile({ items });
    expect(md).toContain('WebGPU');

    // 2. User queries results via QUERY_RESULTS
    const q1 = answerResultsQuery('How many items triggered alerts?', items);
    expect(q1.answer).toContain('2 alert-triggering items');
    expect(q1.answer).toContain('66.7% match rate');

    const q2 = answerResultsQuery('Show me category statistics', items);
    expect(q2.answer).toContain('Hardware: 2');
    expect(q2.answer).toContain('Software: 1');

    // 3. User steers follow-up task to focus on ONNX
    let runnerConfig = { selector: '.card', scrollStep: 200 };
    const steerRes = applySteeringInstruction('Focus only on ONNX models and set scroll step to 450px', runnerConfig);
    expect(steerRes.applied).toBe(true);
    runnerConfig = steerRes.updatedParams;
    expect(runnerConfig.selector).toContain('onnx');
    expect(runnerConfig.scrollStep).toBe(450);
  });

  it('Scenario 4: Hardware Degradation & Recovery during High-Volume Scraping end-to-end journey', () => {
    // 1. Scraper starts on DirectML GPU provider
    let activeHardware = resolveHardwareProvider('win32', ['dml', 'cpu']);
    expect(activeHardware.provider).toBe('dml');
    expect(activeHardware.format).toBe('fp32');

    const modelStats = createModelStatsFixture({
      systemOne: {
        modelName: 'laya.onnx',
        format: 'fp32',
        provider: 'dml',
        device: 'NVIDIA RTX 4070 (DirectML)',
        status: 'ready',
        avgLatencyMs: 4.1,
      },
    });
    expect(modelStats.systemOne.status).toBe('ready');

    // 2. High volume scraping triggers simulated GPU out-of-memory
    const vramExhausted = true;
    if (vramExhausted) {
      // Graceful fallback to CPU provider
      activeHardware = resolveHardwareProvider('win32', ['cpu']);
      modelStats.systemOne.provider = activeHardware.provider;
      modelStats.systemOne.device = activeHardware.device;
      modelStats.systemOne.format = activeHardware.format;
      modelStats.systemOne.avgLatencyMs = 15.8;
      modelStats.systemOne.status = 'ready';
    }

    // 3. Verify CPU fallback properties
    expect(activeHardware.provider).toBe('cpu');
    expect(activeHardware.format).toBe('int8');
    expect(modelStats.systemOne.provider).toBe('cpu');
    expect(modelStats.systemOne.status).toBe('ready');

    // 4. Verify scraper continues and writes results
    const items = [
      createScrapedItemFixture({ text: 'Scraped successfully post-fallback', triggeredAlert: true }),
    ];
    const md = formatMarkdownResultsFile({ items, stats: createResultStatsFixture({ avgLatencyMs: 15.8 }) });
    expect(md).toContain('15.8ms');
  });

  it('Scenario 5: Complete Task Lifecycle: Compilation -> Multi-Page Loop Detection -> Steering -> Summary Generation -> Persistence end-to-end journey', async () => {
    // 1. Goal Compilation
    const userGoal = 'Monitor documentation for new GPU acceleration features';
    const compiledSpec = {
      id: 'task-lifecycle-1',
      userGoal,
      targetUrl: `${simServer.url}/crawl/p1`,
      selector: '.item',
      scrollStep: 400,
    };
    expect(compiledSpec.targetUrl).toContain('/crawl/p1');

    // 2. Load Page 1
    const resP1 = await httpGet(compiledSpec.targetUrl);
    expect(resP1.status).toBe(200);

    // 3. Loop detection on Page 1
    const loopP1 = evaluateLoopDetectorState({
      y: 1200,
      prevY: 1200,
      viewportHeight: 800,
      scrollHeight: 2000,
      consecutiveEmptyCycles: 3,
    });
    expect(loopP1.isLoop).toBe(true);

    // 4. Deliberation -> Paginate to Page 2
    const contextP1 = createHandoverContextFixture({
      targetUrl: compiledSpec.targetUrl,
      currentUrl: compiledSpec.targetUrl,
      stuckReason: loopP1.reason,
      interactiveElements: [{ selector: '#next-page', text: 'Page 2', href: '/crawl/p2', tag: 'a' }],
    });
    const directiveP1 = evaluateSteeringDirective(contextP1);
    expect(directiveP1.action).toBe('paginate');

    // 5. Scrape Page 2 & terminate
    const items = [
      createScrapedItemFixture({ id: 'item-p1', text: 'Hardware Acceleration Providers', triggeredAlert: true }),
      createScrapedItemFixture({ id: 'item-p2', text: 'Interactive Steering and Live Results', triggeredAlert: true }),
    ];
    const stats = createResultStatsFixture({
      totalScanned: 2,
      totalAlerts: 2,
      matchRatePercent: 100.0,
      avgLatencyMs: 12.0,
    });

    // 6. Summary generation
    const executiveSummary = 'Executive Summary: Successfully monitored documentation and found 2 relevant GPU acceleration features.';
    const md = formatMarkdownResultsFile({
      title: 'GPU Feature Monitor Results',
      taskId: compiledSpec.id,
      items,
      stats,
      summary: executiveSummary,
    });

    // 7. Verify disk markdown format & Q&A query
    const parsed = parseMarkdownResultsFile(md);
    expect(parsed.metadata.taskId).toBe('task-lifecycle-1');
    expect(parsed.summary).toContain('Executive Summary');
    expect(parsed.items).toHaveLength(2);
    expect(parsed.stats.matchRatePercent).toBe(100.0);

    const queryResponse = answerResultsQuery('How many alerts were found?', items);
    expect(queryResponse.answer).toContain('2 alert-triggering items');
  });
});
