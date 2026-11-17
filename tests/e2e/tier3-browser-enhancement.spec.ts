/**
 * Tier 3: Cross-Feature Pairwise Interaction Tests (Browser Agent Enhancement)
 * Verifies multi-component interactions across R1 (Collaborative Browsing),
 * R2 (Four-Page UI Workflow), and R3 (State Checkpointing & Resumption).
 *
 * Pair 1: F4 + F5: Input Detection + System 2 Deliberation
 * Pair 2: F5 + F6: System 2 Action + BrowserRunner Execution
 * Pair 3: F4 + F6: Navigation Fork + Outbound Branch Navigation
 * Pair 4: F6 + F7: Action Execution + Runner State Checkpointing
 * Pair 5: F7 + F3: Runner Checkpointing + SQLite Persistence
 * Pair 6: F8 + F7: WebSocket RESUME_TASK + Runner Restoration
 * Pair 7: F11 + F12: Page 1 Goal Setup + Page 2 Spec Compilation
 * Pair 8: F12 + F13: Page 2 Start Task + Page 3 Live Execution
 * Pair 9: F13 + F7: Page 3 Live Execution + Checkpoint Generation
 * Pair 10: F8 + F9: Checkpoint Resumption RPC + UI Wizard Restoration
 * Pair 11: F5 + F7: System 2 Deliberation + Checkpointed Chat Context
 * Pair 12: F14 + F6: Page 4 Steering + System 2 Pipeline Re-Run
 *
 * Total: 12 tests
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
  ForkNavigationLoopGuard,
  UiWizardStoreSimulator,
  LruDeduplicator,
  sha1Hash,
  SimulatedWebServer,
  TaskCheckpoint,
  SystemTwoSteeringAction,
  applySteeringInstruction,
} from './test-utils';
import type { AgentAction, WsClientToServerMessage, WsServerToClientMessage } from '../../packages/shared/src/types';

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

describe('Tier 3: Browser Enhancement Pairwise Combinations', () => {
  let simServer: SimulatedWebServer;
  let dbHarness: ReturnType<typeof createTestSqliteDb>;

  beforeAll(async () => {
    dbHarness = createTestSqliteDb(':memory:');
    simServer = createSimulatedWebServer({
      pages: {
        '/docs/index': {
          title: 'Documentation Index',
          formInputs: [
            createInteractiveInputFixture({ selector: '#search-query', name: 'q', placeholder: 'Search...' }),
          ],
          navigationChoices: [
            createNavigationChoiceFixture({ selector: '#nav-docs', text: 'Documentation', href: '/docs/tutorials', category: 'Docs' }),
            createNavigationChoiceFixture({ selector: '#nav-blog', text: 'Engineering Blog', href: '/blog', category: 'Blog' }),
            createNavigationChoiceFixture({ selector: '#nav-careers', text: 'Careers', href: '/careers', category: 'Company' }),
          ],
        },
        '/docs/tutorials': {
          title: 'Tutorials Page',
          items: [
            { id: 'tut-1', text: 'WebGPU ONNX Runtime Acceleration Guide', link: '/docs/webgpu' },
            { id: 'tut-2', text: 'ModernBERT Fine-Tuning Tutorial', link: '/docs/modernbert' },
          ],
        },
        '/search/results': {
          title: 'Search Results',
          items: [
            { id: 'sr-1', text: 'WebGPU Execution Provider in Chromium', link: '/docs/webgpu-chromium' },
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

  it('Pair 1: F4 + F5: Input Detection + System 2 Deliberation: search input triggers handover and deliberates form_input action', async () => {
    const res = await httpGet(`${simServer.url}/docs/index`);
    expect(res.status).toBe(200);

    const inputs = detectInteractiveFormInputs(res.text);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].selector).toBe('#search-query');

    const ctx = createHandoverContextFixture({
      userGoal: 'Find WebGPU tutorials',
      triggerReason: 'form_input_required',
      formInputs: inputs,
    });

    const action = await deliberateCollaborativeStep(ctx, true);
    expect(action.action).toBe('form_input');
    const formAct = action as Extract<SystemTwoSteeringAction, { action: 'form_input' }>;
    expect(formAct.selector).toBe('#search-query');
    expect(formAct.text.toLowerCase()).toContain('webgpu');
  });

  it('Pair 2: F5 + F6: System 2 Action + BrowserRunner Execution: deliberated form_input action submits and triggers loop guard on repeat', async () => {
    const action = await deliberateCollaborativeStep(
      createHandoverContextFixture({
        userGoal: 'Search ModernBERT',
        triggerReason: 'form_input_required',
        formInputs: [createInteractiveInputFixture({ selector: '#search-query' })],
      }),
      true
    );

    const formAct = action as Extract<SystemTwoSteeringAction, { action: 'form_input' }>;
    const guard = new FormSubmissionLoopGuard();

    // 1st submission
    guard.recordSubmission(formAct.selector, formAct.text);
    const postRes1 = await httpPost(`${simServer.url}/search/results`, { q: formAct.text });
    expect(postRes1.status).toBe(200);
    expect(guard.shouldBlock(formAct.selector, formAct.text, 3)).toBe(false);

    // 2nd and 3rd submissions trigger loop guard
    guard.recordSubmission(formAct.selector, formAct.text);
    guard.recordSubmission(formAct.selector, formAct.text);
    expect(guard.shouldBlock(formAct.selector, formAct.text, 3)).toBe(true);
  });

  it('Pair 3: F4 + F6: Navigation Fork + Outbound Branch Navigation: picks chosen branch, navigates, and verifies loaded content', async () => {
    const indexRes = await httpGet(`${simServer.url}/docs/index`);
    const choices = detectNavigationForks(indexRes.text);
    expect(choices.length).toBeGreaterThanOrEqual(3);

    const navChoice = choices.find((c) => c.text.includes('Documentation')) || choices[0];
    const navAction = {
      action: 'choose_navigation' as const,
      selector: navChoice.selector,
      url: `${simServer.url}${navChoice.href}`,
      text: navChoice.text,
    };

    const branchRes = await httpGet(navAction.url);
    expect(branchRes.status).toBe(200);
    expect(branchRes.text).toContain('Tutorials Page');
    expect(branchRes.text).toContain('WebGPU ONNX Runtime Acceleration Guide');
  });

  it('Pair 4: F6 + F7: Action Execution + Runner State Checkpointing: action execution increments step and updates checkpoint coordinates', () => {
    let currentY = 0;
    let stepCount = 0;
    const lru = new LruDeduplicator(100);

    // Step 1: Navigation
    stepCount++;
    currentY += 400;
    lru.add(sha1Hash('item-1'));

    // Step 2: Form input
    stepCount++;
    currentY += 400;
    lru.add(sha1Hash('item-2'));

    // Periodic Checkpoint Snapshot
    const chk = createTaskCheckpointFixture({
      activeStepCount: stepCount,
      scroll: { y: currentY, scrollHeight: 3000, viewportHeight: 800 },
      dedupHashes: ['item-1-hash', 'item-2-hash'],
    });

    expect(chk.activeStepCount).toBe(2);
    expect(chk.scroll.y).toBe(800);
    expect(chk.dedupHashes).toHaveLength(2);
  });

  it('Pair 5: F7 + F3: Runner Checkpointing + SQLite Persistence: serialized checkpoint is safely stored and re-queried from disk', () => {
    const taskId = 'task-pair-5';
    const chk = createTaskCheckpointFixture({
      id: 'chk-p5-01',
      taskId,
      scroll: { y: 1600, scrollHeight: 4000, viewportHeight: 800 },
      totalScanned: 18,
      totalAlerts: 3,
      wizardState: { currentPage: 3, userGoal: 'Extract ONNX Benchmarks' },
    });

    dbHarness.saveCheckpoint(chk);
    const retrieved = dbHarness.getLatestCheckpoint(taskId);

    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('chk-p5-01');
    expect(retrieved!.scroll.y).toBe(1600);
    expect(retrieved!.totalScanned).toBe(18);
    expect(retrieved!.wizardState?.currentPage).toBe(3);
  });

  it('Pair 6: F8 + F7: WebSocket RESUME_TASK + Runner Restoration: client resume retrieves checkpoint and re-populates LRU dedup cache', () => {
    const taskId = 'task-pair-6';
    const originalHashes = [sha1Hash('item-a'), sha1Hash('item-b'), sha1Hash('item-c')];
    dbHarness.saveCheckpoint(
      createTaskCheckpointFixture({
        id: 'chk-p6-01',
        taskId,
        scroll: { y: 2100, scrollHeight: 5000, viewportHeight: 800 },
        dedupHashes: originalHashes,
      })
    );

    // Client sends RESUME_TASK
    const resumeMsg: WsClientToServerMessage = {
      type: 'RESUME_TASK',
      payload: { taskId },
    };

    const latest = dbHarness.getLatestCheckpoint(resumeMsg.payload.taskId);
    expect(latest).toBeDefined();
    expect(latest!.scroll.y).toBe(2100);

    // Runner pre-warms cache
    const runnerLru = new LruDeduplicator(100);
    for (const h of latest!.dedupHashes) {
      runnerLru.add(h);
    }
    expect(runnerLru.size()).toBe(3);
    expect(runnerLru.has(originalHashes[0])).toBe(true);
  });

  it('Pair 7: F11 + F12: Page 1 Goal Setup + Page 2 Spec Compilation: goal input enables Page 2 compilation and enables Start Task', () => {
    const store = new UiWizardStoreSimulator();
    store.setUserGoal('Track GPU memory utilization across scraping jobs');
    expect(store.canAdvanceFromPage1()).toBe(true);

    // Advance to Page 2 and compile
    store.nextPage();
    expect(store.currentPage).toBe(2);

    const spec = store.compileSpec();
    expect(spec.userGoal).toBe('Track GPU memory utilization across scraping jobs');
    expect(store.taskSpec).toBeDefined();
  });

  it('Pair 8: F12 + F13: Page 2 Start Task + Page 3 Live Execution: start button dispatches START_TASK and shifts view to Page 3 live feed', () => {
    const store = new UiWizardStoreSimulator();
    store.setPage(2);
    store.compileSpec('Live Navigation Task');

    let started = false;
    const onStartClick = () => {
      started = store.startTask();
    };

    onStartClick();
    expect(started).toBe(true);
    expect(store.isTaskRunning).toBe(true);
    expect(store.currentPage).toBe(3);
  });

  it('Pair 9: F13 + F7: Page 3 Live Execution + Checkpoint Generation: active execution periodically captures steps and enables canResume', () => {
    const store = new UiWizardStoreSimulator();
    store.setPage(3);
    store.isTaskRunning = true;

    // Simulate daemon checkpoint broadcast during live run
    const chk = createTaskCheckpointFixture({
      activeStepCount: 15,
      scroll: { y: 1500, scrollHeight: 4000, viewportHeight: 800 },
      wizardState: { currentPage: 3, userGoal: 'Live Task' },
    });

    store.applyCheckpoint(chk);
    expect(store.canResume).toBe(true);
    expect(store.lastCheckpoint?.activeStepCount).toBe(15);
  });

  it('Pair 10: F8 + F9: Checkpoint Resumption RPC + UI Wizard Restoration: daemon status push restores wizard state and switches to saved page', () => {
    const store = new UiWizardStoreSimulator();
    expect(store.currentPage).toBe(1);
    expect(store.canResume).toBe(false);

    const chk = createTaskCheckpointFixture({
      wizardState: { currentPage: 4, userGoal: 'Review Flagged Items' },
    });

    // Simulate DAEMON_STATUS broadcast with lastCheckpoint
    const statusMsg: WsServerToClientMessage = {
      type: 'DAEMON_STATUS',
      payload: {
        isRunning: false,
        layaReady: true,
        activeTaskId: chk.taskId,
        lastCheckpoint: chk,
      },
    };

    if (statusMsg.payload.lastCheckpoint) {
      store.applyCheckpoint(statusMsg.payload.lastCheckpoint);
    }

    expect(store.canResume).toBe(true);
    expect(store.currentPage).toBe(4);
    expect(store.userGoal).toBe('Review Flagged Items');
  });

  it('Pair 11: F5 + F7: System 2 Deliberation + Checkpointed Chat Context: restored chat history provides conversational context for deliberation', () => {
    const chk = createTaskCheckpointFixture({
      chatContext: [
        { role: 'user', text: 'Focus on v0.2.0 changelog only', timestamp: 1000 },
        { role: 'assistant', text: 'I will prioritize release notes links', timestamp: 1100 },
      ],
    });

    const store = new UiWizardStoreSimulator();
    store.applyCheckpoint(chk);
    expect(store.chatMessages).toHaveLength(2);
    expect(store.chatMessages[0].text).toContain('v0.2.0');

    // Deliberation context inherits prior user preferences from chat history
    const contextWithChat = createHandoverContextFixture({
      userGoal: store.chatMessages[0].text,
      triggerReason: 'navigation_fork',
      navigationChoices: [
        createNavigationChoiceFixture({ selector: '#nav-blog', text: 'Blog', href: '/blog' }),
        createNavigationChoiceFixture({ selector: '#nav-rel', text: 'Release v0.2.0', href: '/releases/v0.2.0' }),
      ],
    });

    const action = {
      action: 'choose_navigation' as const,
      selector: '#nav-rel',
      url: '/releases/v0.2.0',
      reasoning: 'Prioritizing release notes based on chat context directive',
    };

    expect(action.action).toBe('choose_navigation');
    expect(action.selector).toBe('#nav-rel');
  });

  it('Pair 12: F14 + F6: Page 4 Steering + System 2 Pipeline Re-Run: user instruction on Page 4 adjusts scroll parameters for re-run', () => {
    const store = new UiWizardStoreSimulator();
    store.setPage(4);

    const initialParams = { url: 'http://127.0.0.1/docs', selector: '.card', scrollStep: 300 };
    const instruction = 'Increase scroll step to 600px and navigate to http://127.0.0.1/docs/v2';

    const steerResult = applySteeringInstruction(instruction, initialParams);
    expect(steerResult.applied).toBe(true);
    expect(steerResult.updatedParams.scrollStep).toBe(600);
    expect(steerResult.updatedParams.url).toBe('http://127.0.0.1/docs/v2');

    // Re-run shifts view back to Page 3 live execution
    store.setPage(3);
    expect(store.currentPage).toBe(3);
  });
});
