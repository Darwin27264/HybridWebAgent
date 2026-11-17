/**
 * Tier 4: Realistic End-to-End Application Scenarios (Browser Agent Enhancement)
 * Verifies full multi-step journeys combining R1, R2, and R3 in realistic workflows.
 *
 * Scenario 1: Full Interactive Form Crawling & Steering Journey (R1)
 * Scenario 2: Multi-Branch Navigation Fork Deliberation & Deep Exploration (R1)
 * Scenario 3: Mid-Task Interruption, State Checkpointing, and Graceful Resumption (R3)
 * Scenario 4: Complete Four-Page Desktop UI Workflow Journey (R2)
 * Scenario 5: Fault-Tolerant Multi-Cycle Browsing with Stagnation, Form Recovery, and Checkpointing (R1 + R2 + R3)
 *
 * Total: 5 scenarios
 */

import * as http from 'http';
import { describe, it, expect, beforeAll, afterAll } from './harness';
import {
  createSimulatedWebServer,
  createTestSqliteDb,
  createTaskCheckpointFixture,
  createInteractiveInputFixture,
  createNavigationChoiceFixture,
  createHandoverContextFixture,
  detectInteractiveFormInputs,
  detectNavigationForks,
  deliberateCollaborativeStep,
  FormSubmissionLoopGuard,
  UiWizardStoreSimulator,
  LruDeduplicator,
  sha1Hash,
  SimulatedWebServer,
  TaskCheckpoint,
  SystemTwoSteeringAction,
  formatMarkdownResultsFile,
  parseMarkdownResultsFile,
  answerResultsQuery,
} from './test-utils';
import type { AgentAction, WsClientToServerMessage, WsServerToClientMessage, ScrapedItem, ResultStats } from '../../packages/shared/src/types';

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

function httpPost(url: string, body: any): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, text: data });
        });
      }
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

describe('Tier 4: Realistic E2E Browser Enhancement Scenarios', () => {
  let simServer: SimulatedWebServer;
  let dbHarness: ReturnType<typeof createTestSqliteDb>;

  beforeAll(async () => {
    dbHarness = createTestSqliteDb(':memory:');
    simServer = createSimulatedWebServer({
      pages: {
        '/docs': {
          title: 'Documentation Portal',
          items: [
            { id: 'p1-1', text: 'Introduction to Offline AI Agents', link: '/docs/intro' },
            { id: 'p1-2', text: 'Getting Started with Local Inference', link: '/docs/start' },
          ],
          formInputs: [
            createInteractiveInputFixture({ selector: '#search-box', name: 'q', placeholder: 'Search documentation...' }),
          ],
          navigationChoices: [
            createNavigationChoiceFixture({ selector: '#nav-tutorials', text: 'Tutorials', href: '/docs/tutorials', category: 'Learning' }),
            createNavigationChoiceFixture({ selector: '#nav-releases', text: 'Release Notes', href: '/docs/releases', category: 'Releases' }),
            createNavigationChoiceFixture({ selector: '#nav-community', text: 'Community Forum', href: '/community', category: 'Forum' }),
          ],
        },
        '/docs/tutorials': {
          title: 'Tutorials Directory',
          items: [
            { id: 'tut-1', text: 'WebGPU ONNX Acceleration with ModernBERT', link: '/docs/webgpu-modernbert' },
            { id: 'tut-2', text: 'Llama.cpp Embedding Pipeline Setup', link: '/docs/llama-embedding' },
          ],
        },
        '/docs/releases': {
          title: 'Release Notes',
          items: [
            { id: 'rel-1', text: 'v0.2.0: Added Dual-Brain S1/S2 Collaborative Browsing', link: '/releases/v0.2.0' },
            { id: 'rel-2', text: 'v0.1.9: Fixed SQLite WAL Checkpoint Locking', link: '/releases/v0.1.9' },
          ],
        },
        '/docs/search-results': {
          title: 'Filtered Tutorials Search Results',
          items: [
            { id: 'sr-1', text: 'Tutorial: WebGPU ONNX Acceleration in Chromium', link: '/docs/webgpu-onnx-tutorial' },
            { id: 'sr-2', text: 'Benchmark: DirectML vs WebGPU on Windows 11', link: '/docs/benchmarks-dml-webgpu' },
          ],
        },
      },
    });
    await simServer.start();
  });

  afterAll(async () => {
    await simServer.close();
    if (dbHarness.db && typeof dbHarness.db.close === 'function') {
      dbHarness.db.close();
    }
  });

  it('Scenario 1: Full Interactive Form Crawling & Steering Journey (R1)', async () => {
    const userGoal = 'Find WebGPU ONNX acceleration tutorials';
    const actionTimeline: AgentAction[] = [];
    const loopGuard = new FormSubmissionLoopGuard();

    // 1. Initial Landing on /docs
    const landingRes = await httpGet(`${simServer.url}/docs`);
    expect(landingRes.status).toBe(200);
    expect(landingRes.text).toContain('Documentation Portal');

    actionTimeline.push({
      id: 'act-s1-1',
      taskId: 'task-s1',
      timestamp: Date.now(),
      type: 'navigation',
      status: 'success',
      message: 'Landed on /docs index',
    });

    // 2. System 1 encounters search input
    const inputs = detectInteractiveFormInputs(landingRes.text);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].selector).toBe('#search-box');

    // 3. System 1 invokes System 2 with form_input_required
    const handoverCtx = createHandoverContextFixture({
      userGoal,
      triggerReason: 'form_input_required',
      formInputs: inputs,
    });

    const action = await deliberateCollaborativeStep(handoverCtx, true);
    expect(action.action).toBe('form_input');
    const formAct = action as Extract<SystemTwoSteeringAction, { action: 'form_input' }>;
    expect(formAct.selector).toBe('#search-box');
    expect(formAct.text.toLowerCase()).toContain('webgpu');

    actionTimeline.push({
      id: 'act-s1-2',
      taskId: 'task-s1',
      timestamp: Date.now(),
      type: 'interaction',
      status: 'success',
      message: `System 2 deliberated query: "${formAct.text}" into ${formAct.selector}`,
    });

    // 4. BrowserRunner executes form submission
    loopGuard.recordSubmission(formAct.selector, formAct.text);
    expect(loopGuard.shouldBlock(formAct.selector, formAct.text, 3)).toBe(false);

    const searchRes = await httpPost(`${simServer.url}/docs/search-results`, { q: formAct.text });
    expect(searchRes.status).toBe(200);
    expect(searchRes.text).toContain('Tutorial: WebGPU ONNX Acceleration in Chromium');

    actionTimeline.push({
      id: 'act-s1-3',
      taskId: 'task-s1',
      timestamp: Date.now(),
      type: 'extraction',
      status: 'success',
      message: 'Extracted 2 matching tutorials from search results',
    });

    expect(actionTimeline).toHaveLength(3);
    expect(actionTimeline[2].type).toBe('extraction');
  });

  it('Scenario 2: Multi-Branch Navigation Fork Deliberation & Deep Exploration (R1)', async () => {
    const userGoal = 'Track v0.2.0 release updates and bug fixes';
    const actionTimeline: AgentAction[] = [];

    // 1. Land on /docs
    const landingRes = await httpGet(`${simServer.url}/docs`);
    const forks = detectNavigationForks(landingRes.text);
    expect(forks.length).toBeGreaterThanOrEqual(3);

    // 2. System 1 packages handover context with navigation_fork
    const handoverCtx = createHandoverContextFixture({
      userGoal,
      triggerReason: 'navigation_fork',
      navigationChoices: forks,
    });

    // 3. System 2 inspects goal and ranks Release Notes link highest
    const action = await deliberateCollaborativeStep(handoverCtx, true);
    expect(action.action).toBe('choose_navigation');
    const navAct = action as Extract<SystemTwoSteeringAction, { action: 'choose_navigation' }>;
    expect(navAct.selector).toBe('#nav-releases');
    expect(navAct.url).toBe('/docs/releases');

    // 4. Runner executes branch navigation
    const releasesRes = await httpGet(`${simServer.url}${navAct.url}`);
    expect(releasesRes.status).toBe(200);
    expect(releasesRes.text).toContain('v0.2.0: Added Dual-Brain S1/S2 Collaborative Browsing');

    actionTimeline.push({
      id: 'act-s2-1',
      taskId: 'task-s2',
      timestamp: Date.now(),
      type: 'navigation',
      status: 'success',
      message: `Navigated to ${navAct.url}`,
    });

    expect(actionTimeline[0].message).toContain('/docs/releases');
  });

  it('Scenario 3: Mid-Task Interruption, State Checkpointing, and Graceful Resumption (R3)', () => {
    const taskId = 'task-s3-resumption';
    const totalItemsToScan = 40;
    const interruptionIndex = 12;

    const initialLru = new LruDeduplicator(100);
    const scannedItems: string[] = [];
    const alertsEmitted: string[] = [];

    // 1. Initial run processes 12 items
    for (let i = 1; i <= interruptionIndex; i++) {
      const itemText = `Infinite Feed Item #${i} on ONNX runtime optimizations`;
      const h = sha1Hash(itemText);
      initialLru.add(h);
      scannedItems.push(itemText);
      if (i % 4 === 0) {
        alertsEmitted.push(`Alert for Item #${i}`);
      }
    }

    expect(scannedItems).toHaveLength(12);
    expect(alertsEmitted).toHaveLength(3);

    // 2. Interruption occurs -> Runner saves checkpoint to SQLite
    const savedCheckpoint: TaskCheckpoint = {
      id: 'chk-s3-interrupted',
      taskId,
      runId: 'run-s3-01',
      createdAt: Date.now() - 10000,
      updatedAt: Date.now(),
      status: 'interrupted',
      targetUrl: 'http://127.0.0.1:8080/feed',
      currentUrl: 'http://127.0.0.1:8080/feed?page=3',
      scroll: { y: 1800, scrollHeight: 6000, viewportHeight: 800 },
      totalScanned: 12,
      totalAlerts: 3,
      activeStepCount: 12,
      dedupHashes: Array.from({ length: 12 }, (_, idx) => sha1Hash(`Infinite Feed Item #${idx + 1} on ONNX runtime optimizations`)),
    };

    dbHarness.saveCheckpoint(savedCheckpoint);

    // 3. Client issues RESUME_TASK
    const retrievedChk = dbHarness.getLatestCheckpoint(taskId);
    expect(retrievedChk).toBeDefined();
    expect(retrievedChk!.status).toBe('interrupted');
    expect(retrievedChk!.scroll.y).toBe(1800);
    expect(retrievedChk!.totalScanned).toBe(12);

    // 4. Runner restores scroll and pre-warms LRU deduplication cache
    const resumedLru = new LruDeduplicator(100);
    for (const h of retrievedChk!.dedupHashes) {
      resumedLru.add(h);
    }
    expect(resumedLru.size()).toBe(12);

    // 5. Runner continues scanning from item 13 to item 40
    let duplicateAlertsCount = 0;
    let newlyScannedCount = 0;

    for (let i = 1; i <= totalItemsToScan; i++) {
      const itemText = `Infinite Feed Item #${i} on ONNX runtime optimizations`;
      const h = sha1Hash(itemText);
      if (!resumedLru.has(h)) {
        resumedLru.add(h);
        newlyScannedCount++;
        scannedItems.push(itemText);
        if (i % 4 === 0) {
          alertsEmitted.push(`Alert for Item #${i}`);
        }
      } else {
        // Skipped duplicate item!
        if (i <= interruptionIndex) {
          // Expected: items 1..12 are recognized as duplicates
        } else {
          duplicateAlertsCount++;
        }
      }
    }

    // Exactly 28 remaining items processed
    expect(newlyScannedCount).toBe(28);
    expect(scannedItems).toHaveLength(40);
    expect(alertsEmitted).toHaveLength(10); // 3 from initial + 7 from remaining
    expect(duplicateAlertsCount).toBe(0);
  });

  it('Scenario 4: Complete Four-Page Desktop UI Workflow Journey (R2)', () => {
    const store = new UiWizardStoreSimulator();

    // --- Page 1: Goal & Model Setup ---
    expect(store.currentPage).toBe(1);
    store.setUserGoal('Monitor AI model performance metrics');
    store.selectedModel = 'qwen2.5:3b';
    expect(store.canAdvanceFromPage1()).toBe(true);

    // Navigate to Page 2
    store.nextPage();
    expect(store.currentPage).toBe(2);

    // --- Page 2: Spec Inspector & Start Task ---
    const spec = store.compileSpec();
    store.setThreshold(0.85);
    expect(spec.userGoal).toBe('Monitor AI model performance metrics');
    expect(store.alertConfidenceThreshold).toBe(0.85);

    // Click "Start Task"
    store.startTask();
    expect(store.isTaskRunning).toBe(true);
    expect(store.currentPage).toBe(3);

    // --- Page 3: Live Agent Execution View ---
    store.snapshot = {
      taskId: spec.id,
      timestamp: Date.now(),
      url: spec.targetUrl,
      title: 'Active Agent Execution View',
      screenshot: 'data:image/jpeg;base64,sample',
      scroll: { x: 0, y: 800, scrollHeight: 3000, viewportHeight: 800 },
    };
    store.actionTimeline.push({
      id: 'a1',
      taskId: spec.id,
      timestamp: Date.now(),
      type: 'navigation',
      status: 'success',
      message: 'Navigated to target portal',
    });
    expect(store.snapshot).toBeDefined();
    expect(store.actionTimeline).toHaveLength(1);

    // Task finishes or user stops it
    store.stopTask();
    expect(store.isTaskRunning).toBe(false);

    // Navigate to Page 4
    store.nextPage();
    expect(store.currentPage).toBe(4);

    // --- Page 4: Results & Steering ---
    const scrapedResults: ScrapedItem[] = [
      {
        id: 'r1',
        timestamp: new Date().toISOString(),
        text: 'Benchmark: ModernBERT on WebGPU reaches 12ms latency',
        link: 'https://example.com/modernbert',
        answers: { isRelevant: true },
        confidence: 0.94,
        triggeredAlert: true,
      },
    ];
    store.results = scrapedResults;
    expect(store.results).toHaveLength(1);

    // Question System 2
    store.chatMessages.push({
      role: 'user',
      text: 'What was the fastest benchmark observed?',
      timestamp: Date.now(),
    });
    const answer = answerResultsQuery('What was the fastest benchmark observed?', scrapedResults, 1, 1);
    store.chatMessages.push({
      role: 'assistant',
      text: answer.answer,
      timestamp: Date.now() + 500,
    });
    expect(store.chatMessages[1].text).toContain('ModernBERT');

    // Steering re-run: navigate back to Page 2
    store.prevPage();
    store.prevPage();
    expect(store.currentPage).toBe(2);
  });

  it('Scenario 5: Fault-Tolerant Multi-Cycle Browsing with Stagnation, Form Recovery, and Checkpointing (R1 + R2 + R3)', async () => {
    const store = new UiWizardStoreSimulator();
    const taskId = 'task-s5-composite';

    // 1. Page 1 Setup & Page 2 Launch
    store.setUserGoal('Find documentation and bypass filter modal');
    store.startTask();
    expect(store.currentPage).toBe(3);

    // 2. Crawl hits bottom of page (Stagnation)
    const stagnationCtx = createHandoverContextFixture({
      taskId,
      userGoal: store.userGoal,
      triggerReason: 'stagnation',
      stuckReason: 'bottom_of_page',
    });

    const pagAction = await deliberateCollaborativeStep(stagnationCtx, true);
    expect(pagAction.action).toBe('paginate');

    // 3. On new page, encounters a filter modal input
    const filterInput = createInteractiveInputFixture({ selector: '#modal-filter-input', placeholder: 'Filter category' });
    const inputCtx = createHandoverContextFixture({
      taskId,
      userGoal: store.userGoal,
      triggerReason: 'form_input_required',
      formInputs: [filterInput],
    });

    const inputAction = await deliberateCollaborativeStep(inputCtx, true);
    expect(inputAction.action).toBe('form_input');

    // 4. Checkpoint state at Page 2
    const chk = createTaskCheckpointFixture({
      id: 'chk-s5-cycle',
      taskId,
      status: 'paused',
      scroll: { y: 2200, scrollHeight: 4500, viewportHeight: 800 },
      wizardState: { currentPage: 3, userGoal: store.userGoal },
    });
    dbHarness.saveCheckpoint(chk);

    // 5. Resumed via WebSocket
    const resumed = dbHarness.getLatestCheckpoint(taskId);
    expect(resumed).toBeDefined();
    expect(resumed!.scroll.y).toBe(2200);

    // 6. Complete task and export Markdown report on Page 4
    store.setPage(4);
    const finalItems: ScrapedItem[] = [
      {
        id: 'fi-1',
        timestamp: new Date().toISOString(),
        text: 'Composite Flow Execution Summary',
        link: 'http://127.0.0.1/summary',
        answers: { status: 'passed' },
        confidence: 0.98,
        triggeredAlert: true,
      },
    ];
    const stats: ResultStats = {
      totalScanned: 15,
      totalAlerts: 4,
      matchRatePercent: 26.6,
      avgLatencyMs: 11.4,
      topCategories: { Documentation: 10, Releases: 5 },
    };

    const mdReport = formatMarkdownResultsFile({
      items: finalItems,
      stats,
      summary: 'Summary of multi-cycle run',
    });
    expect(mdReport).toContain('Scout Scraping Results');
    expect(mdReport).toContain('Composite Flow Execution Summary');

    const parsed = parseMarkdownResultsFile(mdReport);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.stats.totalScanned).toBe(15);
  });
});
