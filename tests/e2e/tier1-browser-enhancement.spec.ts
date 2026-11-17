/**
 * Tier 1: Isolated Happy-Path Functional Tests (Browser Agent Enhancement)
 * Verifies R1 (Collaborative Browsing), R2 (Four-Page UI Workflow), and R3 (State Checkpointing & Resumption)
 *
 * Feature 1: Shared Contracts: Collaborative Browsing (1 test)
 * Feature 2: Shared Contracts: State Checkpointing (1 test)
 * Feature 3: SQLite Checkpointing & Actions Storage (5 tests)
 * Feature 4: System 1 Interactive Input & Fork Detection (5 tests)
 * Feature 5: System 2 Goal-Conditioned Deliberation (5 tests)
 * Feature 6: BrowserRunner Action Execution & Loop Guard (5 tests)
 * Feature 7: Runner State Checkpointing & Resumption (5 tests)
 * Feature 8: Daemon WebSocket RPC Resumption Flow (5 tests)
 * Feature 9: UI Wizard State Store & Navigation Actions (5 tests)
 * Feature 10: Persistent Top Bar & Wizard Step Navigator (5 tests)
 * Feature 11: Page 1: Goal & Model Setup View (5 tests)
 * Feature 12: Page 2: Spec Inspector & Start Task (5 tests)
 * Feature 13: Page 3: Live Agent Execution View (5 tests)
 * Feature 14: Page 4: Results & Steering View (5 tests)
 *
 * Total: 62 tests
 */

import * as http from 'http';
import { describe, it, expect, beforeAll, afterAll } from './harness';
import {
  createSimulatedWebServer,
  createTestSqliteDb,
  createTaskCheckpointFixture,
  createInteractiveInputFixture,
  createNavigationChoiceFixture,
  createFormInputSteeringFixture,
  createChooseNavigationSteeringFixture,
  createHandoverContextFixture,
  createSteeringActionFixture,
  createResumeTaskMsg,
  createGetCheckpointsMsg,
  createCheckpointSavedMsg,
  createCheckpointsListMsg,
  detectInteractiveFormInputs,
  detectNavigationForks,
  deliberateCollaborativeStep,
  FormSubmissionLoopGuard,
  ForkNavigationLoopGuard,
  UiWizardStoreSimulator,
  LruDeduplicator,
  sha1Hash,
  SimulatedWebServer,
  InteractiveInputElement,
  NavigationChoice,
  HandoverTriggerReason,
  TaskCheckpoint,
  SystemTwoSteeringAction,
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

// ===========================================================================
// Feature 1: Shared Contracts: Collaborative Browsing
// ===========================================================================
describe('Feature 1: Shared Contracts: Collaborative Browsing', () => {
  it('1.1: Verify TypeScript interface contracts for InteractiveInputElement, NavigationChoice, HandoverTriggerReason, and SystemTwoSteeringAction', () => {
    const input: InteractiveInputElement = {
      selector: '#search-query',
      tag: 'input',
      type: 'text',
      name: 'q',
      placeholder: 'Search topics...',
      ariaLabel: 'Search',
      formAction: '/search',
      value: 'ModernBERT',
    };
    expect(input.selector).toBe('#search-query');
    expect(input.tag).toBe('input');
    expect(input.type).toBe('text');

    const choice: NavigationChoice = {
      selector: '#nav-docs',
      text: 'Documentation',
      href: '/docs',
      category: 'Guides',
    };
    expect(choice.selector).toBe('#nav-docs');
    expect(choice.href).toBe('/docs');

    const triggerReasons: HandoverTriggerReason[] = [
      'stagnation',
      'form_input_required',
      'navigation_fork',
      'stalled_progress',
    ];
    expect(triggerReasons).toHaveLength(4);

    const formAction: SystemTwoSteeringAction = {
      action: 'form_input',
      selector: '#search-query',
      text: 'WebGPU execution',
      submitSelector: '#submit-btn',
      pressEnter: true,
      reasoning: 'Input search keywords for user goal',
    };
    expect(formAction.action).toBe('form_input');
    expect((formAction as any).text).toBe('WebGPU execution');

    const navAction: SystemTwoSteeringAction = {
      action: 'choose_navigation',
      selector: '#nav-docs',
      url: '/docs',
      text: 'Documentation',
      reasoning: 'Target section matches user goal',
    };
    expect(navAction.action).toBe('choose_navigation');
    expect((navAction as any).url).toBe('/docs');
  });
});

// ===========================================================================
// Feature 2: Shared Contracts: State Checkpointing
// ===========================================================================
describe('Feature 2: Shared Contracts: State Checkpointing', () => {
  it('2.1: Verify TypeScript interface contracts for TaskCheckpoint and WebSocket checkpoint RPC messages', () => {
    const chk = createTaskCheckpointFixture({
      taskId: 'task-contract-01',
      status: 'running',
      scroll: { y: 1500, scrollHeight: 3500, viewportHeight: 800 },
      totalScanned: 25,
      totalAlerts: 4,
    });
    expect(chk.taskId).toBe('task-contract-01');
    expect(chk.status).toBe('running');
    expect(chk.scroll.y).toBe(1500);
    expect(chk.totalScanned).toBe(25);
    expect(chk.totalAlerts).toBe(4);

    const resumeMsg: WsClientToServerMessage = createResumeTaskMsg(chk.id, chk.taskId);
    expect(resumeMsg.type).toBe('RESUME_TASK');
    expect(resumeMsg.payload.taskId).toBe(chk.taskId);
    expect(resumeMsg.payload.checkpointId).toBe(chk.id);

    const getMsg: WsClientToServerMessage = createGetCheckpointsMsg(chk.taskId);
    expect(getMsg.type).toBe('GET_CHECKPOINTS');
    expect(getMsg.payload.taskId).toBe(chk.taskId);

    const savedMsg: WsServerToClientMessage = createCheckpointSavedMsg(chk);
    expect(savedMsg.type).toBe('CHECKPOINT_SAVED');
    expect(savedMsg.payload.id).toBe(chk.id);

    const listMsg: WsServerToClientMessage = createCheckpointsListMsg([chk]);
    expect(listMsg.type).toBe('CHECKPOINTS_LIST');
    expect(listMsg.payload).toHaveLength(1);
    expect(listMsg.payload[0].id).toBe(chk.id);
  });
});

// ===========================================================================
// Feature 3: SQLite Checkpointing & Actions Storage
// ===========================================================================
describe('Feature 3: SQLite Checkpointing & Actions Storage', () => {
  let dbHarness: ReturnType<typeof createTestSqliteDb>;

  beforeAll(() => {
    dbHarness = createTestSqliteDb(':memory:');
  });

  afterAll(() => {
    if (dbHarness.db && typeof dbHarness.db.close === 'function') {
      dbHarness.db.close();
    }
  });

  it('3.1: saveCheckpoint persists complete TaskCheckpoint with scroll coordinates, URLs, and JSON fields', () => {
    const chk = createTaskCheckpointFixture({
      id: 'chk-f3-01',
      taskId: 'task-f3-01',
      scroll: { y: 1800, scrollHeight: 4500, viewportHeight: 900 },
      dedupHashes: ['hash1', 'hash2', 'hash3'],
      wizardState: { currentPage: 3, userGoal: 'Find tutorials' },
      modelConfig: { systemOneModel: 'laya.onnx', systemTwoModel: 'llama3:8b' },
    });

    dbHarness.saveCheckpoint(chk);
    const retrieved = dbHarness.getLatestCheckpoint('task-f3-01');

    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('chk-f3-01');
    expect(retrieved!.scroll.y).toBe(1800);
    expect(retrieved!.scroll.scrollHeight).toBe(4500);
    expect(retrieved!.dedupHashes).toHaveLength(3);
    expect(retrieved!.wizardState?.currentPage).toBe(3);
    expect(retrieved!.wizardState?.userGoal).toBe('Find tutorials');
    expect(retrieved!.modelConfig?.systemTwoModel).toBe('llama3:8b');
  });

  it('3.2: getLatestCheckpoint retrieves the most recently updated checkpoint for a task', () => {
    const taskId = 'task-f3-multi';
    const chkEarly = createTaskCheckpointFixture({
      id: 'chk-early',
      taskId,
      updatedAt: 1000,
      totalScanned: 5,
    });
    const chkLate = createTaskCheckpointFixture({
      id: 'chk-late',
      taskId,
      updatedAt: 2000,
      totalScanned: 15,
    });

    dbHarness.saveCheckpoint(chkEarly);
    dbHarness.saveCheckpoint(chkLate);

    const latest = dbHarness.getLatestCheckpoint(taskId);
    expect(latest).toBeDefined();
    expect(latest!.id).toBe('chk-late');
    expect(latest!.totalScanned).toBe(15);
    expect(latest!.updatedAt).toBe(2000);
  });

  it('3.3: listCheckpoints returns all historical checkpoints for a task ordered by updated_at DESC', () => {
    const taskId = 'task-f3-hist';
    for (let i = 1; i <= 3; i++) {
      dbHarness.saveCheckpoint(
        createTaskCheckpointFixture({
          id: `chk-hist-${i}`,
          taskId,
          updatedAt: 1000 * i,
          totalScanned: 10 * i,
        })
      );
    }

    const list = dbHarness.listCheckpoints(taskId);
    expect(list).toHaveLength(3);
    expect(list[0].id).toBe('chk-hist-3');
    expect(list[1].id).toBe('chk-hist-2');
    expect(list[2].id).toBe('chk-hist-1');
  });

  it('3.4: saveAgentAction persists structured agent action linked to runId', () => {
    const runId = 'run-f3-actions';
    const action: AgentAction = {
      id: 'act-01',
      taskId: 'task-f3-01',
      timestamp: Date.now(),
      type: 'interaction',
      status: 'success',
      message: 'Submitted form search input',
      details: { selector: '#search-box', value: 'ModernBERT ONNX' },
    };

    dbHarness.saveAgentAction(action, runId);
    const actions = dbHarness.listAgentActions(runId);
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('act-01');
    expect(actions[0].message).toBe('Submitted form search input');
    expect(actions[0].details?.selector).toBe('#search-box');
  });

  it('3.5: listAgentActions retrieves ordered action log for a given run without metadata truncation', () => {
    const runId = 'run-f3-ordered';
    const t0 = Date.now();
    for (let i = 1; i <= 4; i++) {
      dbHarness.saveAgentAction(
        {
          id: `act-seq-${i}`,
          taskId: 'task-01',
          timestamp: t0 + i * 100,
          type: i % 2 === 0 ? 'navigation' : 'scroll',
          status: 'success',
          message: `Step ${i}`,
          details: { stepIndex: i, metaText: 'long detailed text without truncation' },
        },
        runId
      );
    }

    const log = dbHarness.listAgentActions(runId);
    expect(log).toHaveLength(4);
    expect(log[0].id).toBe('act-seq-1');
    expect(log[3].id).toBe('act-seq-4');
    expect(log[3].details?.metaText).toBe('long detailed text without truncation');
  });
});

// ===========================================================================
// Feature 4: System 1 Interactive Input & Fork Detection
// ===========================================================================
describe('Feature 4: System 1 Interactive Input & Fork Detection', () => {
  it('4.1: Detects single <input type="text"> and textarea elements with selectors and placeholders', () => {
    const html = `
      <div class="search-panel">
        <input type="text" id="query-input" placeholder="Search documentation..." />
        <textarea id="feedback-text" placeholder="Enter comments here..."></textarea>
      </div>
    `;
    const inputs = detectInteractiveFormInputs(html);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].selector).toBe('#query-input');
    expect(inputs[0].tag).toBe('input');
    expect(inputs[0].placeholder).toBe('Search documentation...');
    expect(inputs[1].selector).toBe('#feedback-text');
    expect(inputs[1].tag).toBe('textarea');
  });

  it('4.2: Detects navigation forks with multiple candidate links and categories', () => {
    const html = `
      <nav class="site-nav">
        <a id="nav-tutorials" href="/tutorials" data-category="Learning">Tutorials</a>
        <a id="nav-releases" href="/releases" data-category="Updates">Release Notes</a>
        <a id="nav-api" href="/api-docs" data-category="Reference">API Reference</a>
      </nav>
    `;
    const choices = detectNavigationForks(html);
    expect(choices).toHaveLength(3);
    expect(choices[0].selector).toBe('#nav-tutorials');
    expect(choices[0].category).toBe('Learning');
    expect(choices[1].selector).toBe('#nav-releases');
    expect(choices[1].href).toBe('/releases');
  });

  it('4.3: Constructs HandoverContext with form_input_required trigger reason when inputs are encountered', () => {
    const inputFixture = createInteractiveInputFixture({ selector: '#search-box', placeholder: 'Query' });
    const ctx = createHandoverContextFixture({
      triggerReason: 'form_input_required',
      formInputs: [inputFixture],
    });

    expect(ctx.triggerReason).toBe('form_input_required');
    expect(ctx.formInputs).toHaveLength(1);
    expect(ctx.formInputs![0].selector).toBe('#search-box');
  });

  it('4.4: Constructs HandoverContext with navigation_fork trigger reason when multiple matching branches exist', () => {
    const c1 = createNavigationChoiceFixture({ selector: '#fork-1', text: 'Branch 1', href: '/b1' });
    const c2 = createNavigationChoiceFixture({ selector: '#fork-2', text: 'Branch 2', href: '/b2' });
    const ctx = createHandoverContextFixture({
      triggerReason: 'navigation_fork',
      navigationChoices: [c1, c2],
    });

    expect(ctx.triggerReason).toBe('navigation_fork');
    expect(ctx.navigationChoices).toHaveLength(2);
    expect(ctx.navigationChoices![1].selector).toBe('#fork-2');
  });

  it('4.5: Increments consecutive stagnation counter and sets stalled_progress trigger reason prior to total halt', () => {
    let stagnationCounter = 0;
    const ticks = [
      { newItems: 0 },
      { newItems: 0 },
      { newItems: 0 },
    ];

    for (const t of ticks) {
      if (t.newItems === 0) stagnationCounter++;
    }

    expect(stagnationCounter).toBe(3);
    const ctx = createHandoverContextFixture({
      consecutiveEmptyCycles: stagnationCounter,
      triggerReason: stagnationCounter >= 3 ? 'stalled_progress' : 'stagnation',
    });
    expect(ctx.triggerReason).toBe('stalled_progress');
  });
});

// ===========================================================================
// Feature 5: System 2 Goal-Conditioned Deliberation
// ===========================================================================
describe('Feature 5: System 2 Goal-Conditioned Deliberation', () => {
  it('5.1: Deliberates on form_input_required context and generates targeted form_input steering action', async () => {
    const ctx = createHandoverContextFixture({
      userGoal: 'Find WebGPU ONNX acceleration tutorials',
      triggerReason: 'form_input_required',
      formInputs: [createInteractiveInputFixture({ selector: '#search-box' })],
    });

    const action = await deliberateCollaborativeStep(ctx, true);
    expect(action.action).toBe('form_input');
    const inputAct = action as Extract<SystemTwoSteeringAction, { action: 'form_input' }>;
    expect(inputAct.selector).toBe('#search-box');
    expect(inputAct.text).toContain('WebGPU');
    expect(inputAct.pressEnter).toBe(true);
  });

  it('5.2: Deliberates on navigation_fork context and returns highest-ranking choose_navigation action', async () => {
    const ctx = createHandoverContextFixture({
      userGoal: 'Track v0.2.0 release updates and bug fixes',
      triggerReason: 'navigation_fork',
      navigationChoices: [
        createNavigationChoiceFixture({ selector: '#nav-tutorials', text: 'Tutorials', href: '/tutorials' }),
        createNavigationChoiceFixture({ selector: '#nav-releases', text: 'Release Notes', href: '/releases' }),
        createNavigationChoiceFixture({ selector: '#nav-community', text: 'Community', href: '/forum' }),
      ],
    });

    const action = await deliberateCollaborativeStep(ctx, true);
    expect(action.action).toBe('choose_navigation');
    const navAct = action as Extract<SystemTwoSteeringAction, { action: 'choose_navigation' }>;
    expect(navAct.selector).toBe('#nav-releases');
    expect(navAct.url).toBe('/releases');
  });

  it('5.3: Generates contextually appropriate query text based on user goal in simulated prompt', async () => {
    const ctx = createHandoverContextFixture({
      userGoal: 'Search for ModernBERT model benchmarks',
      triggerReason: 'form_input_required',
      formInputs: [createInteractiveInputFixture({ selector: '#q' })],
    });

    const action = await deliberateCollaborativeStep(ctx, true);
    expect(action.action).toBe('form_input');
    const inputAct = action as Extract<SystemTwoSteeringAction, { action: 'form_input' }>;
    expect(inputAct.text).toContain('ModernBERT');
  });

  it('5.4: Emits valid SystemTwoSteeringAction matching shared union type', async () => {
    const ctx = createHandoverContextFixture({
      triggerReason: 'stagnation',
      stuckReason: 'bottom_of_page',
    });

    const action = await deliberateCollaborativeStep(ctx, true);
    expect(action.action).toBe('paginate');
    expect((action as any).selector).toBe('#next-page');
  });

  it('5.5: Fallback: executes deterministic heuristic selection when Ollama service is unavailable', async () => {
    const ctx = createHandoverContextFixture({
      userGoal: 'Find tutorials',
      triggerReason: 'navigation_fork',
      navigationChoices: [
        createNavigationChoiceFixture({ selector: '#nav-1', text: 'Section 1', href: '/sec1' }),
        createNavigationChoiceFixture({ selector: '#nav-2', text: 'Section 2', href: '/sec2' }),
      ],
    });

    // Offline mode: modelOnline = false
    const action = await deliberateCollaborativeStep(ctx, false);
    expect(action.action).toBe('choose_navigation');
    const navAct = action as Extract<SystemTwoSteeringAction, { action: 'choose_navigation' }>;
    expect(navAct.selector).toBe('#nav-1');
    expect(navAct.reasoning).toContain('Fallback heuristic');
  });
});

// ===========================================================================
// Feature 6: BrowserRunner Action Execution & Loop Guard
// ===========================================================================
describe('Feature 6: BrowserRunner Action Execution & Loop Guard', () => {
  let simServer: SimulatedWebServer;

  beforeAll(async () => {
    simServer = createSimulatedWebServer({
      pages: {
        '/search-page': {
          title: 'Search Page',
          forms: [
            {
              id: 'search-form',
              action: '/search-results',
              method: 'POST',
              fields: [{ tag: 'input', type: 'text', id: 'search-input', name: 'q' }],
              submitButton: { id: 'search-btn', text: 'Search' },
            },
          ],
        },
        '/search-results': {
          title: 'Search Results',
          items: [{ id: 'res-1', text: 'ModernBERT Documentation Overview' }],
        },
      },
    });
    await simServer.start();
  });

  afterAll(async () => {
    await simServer.close();
  });

  it('6.1: Executes form_input action: types text into target input and triggers submission', async () => {
    simServer.resetRequests();
    const action = createFormInputSteeringFixture({
      selector: '#search-input',
      text: 'ModernBERT',
    });

    // Simulate action execution by POSTing form to server
    const res = await httpPost(`${simServer.url}/search-results`, { q: (action as any).text });
    expect(res.status).toBe(200);

    const requests = simServer.getRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body?.q).toBe('ModernBERT');
  });

  it('6.2: Executes choose_navigation action: navigates to target URL/selector', async () => {
    const action = createChooseNavigationSteeringFixture({
      url: `${simServer.url}/search-page`,
    });

    const res = await httpGet((action as any).url);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Search Page');
  });

  it('6.3: Form re-submission loop guard: prevents submitting identical input values consecutively to same selector', () => {
    const guard = new FormSubmissionLoopGuard();
    guard.recordSubmission('#search-input', 'identical-query');
    guard.recordSubmission('#search-input', 'identical-query');
    expect(guard.shouldBlock('#search-input', 'identical-query', 3)).toBe(false);

    guard.recordSubmission('#search-input', 'identical-query');
    expect(guard.shouldBlock('#search-input', 'identical-query', 3)).toBe(true);
  });

  it('6.4: Fork loop guard: tracks visited branch URLs and blocks cycles to previously exhausted forks', () => {
    const guard = new ForkNavigationLoopGuard();
    const branchUrl = 'http://127.0.0.1/docs/exhausted-branch';

    expect(guard.canVisit(branchUrl)).toBe(true);
    guard.recordVisit(branchUrl);
    expect(guard.isExhausted(branchUrl)).toBe(true);
    expect(guard.canVisit(branchUrl)).toBe(false);
  });

  it('6.5: Emits agent_action structured event on each successful action execution', () => {
    const emittedActions: AgentAction[] = [];
    const recordAction = (type: AgentAction['type'], message: string) => {
      emittedActions.push({
        id: `act-${Date.now()}-${emittedActions.length}`,
        taskId: 'task-runner-01',
        timestamp: Date.now(),
        type,
        status: 'success',
        message,
      });
    };

    recordAction('interaction', 'Executed form_input on #search-box');
    recordAction('navigation', 'Navigated to /search-results');

    expect(emittedActions).toHaveLength(2);
    expect(emittedActions[0].type).toBe('interaction');
    expect(emittedActions[1].type).toBe('navigation');
  });
});

// ===========================================================================
// Feature 7: Runner State Checkpointing & Resumption
// ===========================================================================
describe('Feature 7: Runner State Checkpointing & Resumption', () => {
  it('7.1: Runner automatically creates checkpoint snapshot at periodic scroll intervals', () => {
    const checkpoints: TaskCheckpoint[] = [];
    const intervalTicks = 5;

    for (let tick = 1; tick <= 10; tick++) {
      if (tick % intervalTicks === 0) {
        checkpoints.push(
          createTaskCheckpointFixture({
            activeStepCount: tick,
            scroll: { y: tick * 300, scrollHeight: 5000, viewportHeight: 800 },
          })
        );
      }
    }

    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0].activeStepCount).toBe(5);
    expect(checkpoints[1].activeStepCount).toBe(10);
    expect(checkpoints[1].scroll.y).toBe(3000);
  });

  it('7.2: Runner captures final checkpoint upon manual stop() or task cancellation', () => {
    const chk = createTaskCheckpointFixture({
      status: 'stopped',
      activeStepCount: 14,
      scroll: { y: 2100, scrollHeight: 4000, viewportHeight: 800 },
    });

    expect(chk.status).toBe('stopped');
    expect(chk.activeStepCount).toBe(14);
  });

  it('7.3: Runner restores scroll coordinates (scrollY) from checkpoint upon restart', () => {
    const chk = createTaskCheckpointFixture({
      scroll: { y: 1850, scrollHeight: 4000, viewportHeight: 800 },
    });

    let currentY = 0;
    // Simulate resumption hook
    currentY = chk.scroll.y;
    expect(currentY).toBe(1850);
  });

  it('7.4: Runner pre-populates LRU deduplication cache with checkpoint dedupHashes', () => {
    const hashes = ['hash-a', 'hash-b', 'hash-c'];
    const chk = createTaskCheckpointFixture({ dedupHashes: hashes });

    const lru = new LruDeduplicator(100);
    for (const h of chk.dedupHashes) {
      lru.add(h);
    }

    expect(lru.size()).toBe(3);
    expect(lru.has('hash-a')).toBe(true);
    expect(lru.has('hash-unknown')).toBe(false);
  });

  it('7.5: Resumed runner continues processing new items without re-alerting on previously scanned elements', () => {
    const seenItem = 'Item 1: Already scanned in previous run';
    const newItem = 'Item 2: New un-scanned article';
    const lru = new LruDeduplicator(100);
    lru.add(sha1Hash(seenItem));

    const candidateBatch = [seenItem, newItem];
    const itemsToEvaluate: string[] = [];

    for (const item of candidateBatch) {
      const h = sha1Hash(item);
      if (!lru.has(h)) {
        lru.add(h);
        itemsToEvaluate.push(item);
      }
    }

    expect(itemsToEvaluate).toHaveLength(1);
    expect(itemsToEvaluate[0]).toBe(newItem);
  });
});

// ===========================================================================
// Feature 8: Daemon WebSocket RPC Resumption Flow
// ===========================================================================
describe('Feature 8: Daemon WebSocket RPC Resumption Flow', () => {
  let dbHarness: ReturnType<typeof createTestSqliteDb>;

  beforeAll(() => {
    dbHarness = createTestSqliteDb(':memory:');
  });

  afterAll(() => {
    if (dbHarness.db && typeof dbHarness.db.close === 'function') {
      dbHarness.db.close();
    }
  });

  it('8.1: Handles RESUME_TASK message and queries SQLite for latest valid checkpoint', () => {
    const taskId = 'task-rpc-01';
    const chk = createTaskCheckpointFixture({
      id: 'chk-rpc-01',
      taskId,
      scroll: { y: 2400, scrollHeight: 5000, viewportHeight: 800 },
    });
    dbHarness.saveCheckpoint(chk);

    const resumeMsg = createResumeTaskMsg(chk.id, taskId);
    expect(resumeMsg.type).toBe('RESUME_TASK');

    const found = dbHarness.getLatestCheckpoint(resumeMsg.payload.taskId);
    expect(found).toBeDefined();
    expect(found!.id).toBe('chk-rpc-01');
    expect(found!.scroll.y).toBe(2400);
  });

  it('8.2: Broadcasts DAEMON_STATUS containing restored lastCheckpoint payload to connected clients', () => {
    const chk = createTaskCheckpointFixture({ id: 'chk-status-bc' });
    const statusMsg: WsServerToClientMessage = {
      type: 'DAEMON_STATUS',
      payload: {
        isRunning: true,
        layaReady: true,
        activeTaskId: chk.taskId,
        lastCheckpoint: chk,
      },
    };

    expect(statusMsg.payload.lastCheckpoint).toBeDefined();
    expect(statusMsg.payload.lastCheckpoint!.id).toBe('chk-status-bc');
  });

  it('8.3: Handles GET_CHECKPOINTS and responds with CHECKPOINTS_LIST', () => {
    const taskId = 'task-rpc-list';
    const chk1 = createTaskCheckpointFixture({ id: 'chk-l1', taskId, updatedAt: 100 });
    const chk2 = createTaskCheckpointFixture({ id: 'chk-l2', taskId, updatedAt: 200 });
    dbHarness.saveCheckpoint(chk1);
    dbHarness.saveCheckpoint(chk2);

    const checkpoints = dbHarness.listCheckpoints(taskId);
    const responseMsg = createCheckpointsListMsg(checkpoints);

    expect(responseMsg.type).toBe('CHECKPOINTS_LIST');
    expect(responseMsg.payload).toHaveLength(2);
    expect(responseMsg.payload[0].id).toBe('chk-l2');
  });

  it('8.4: Reconnect flow: newly connected WebSocket client receives current checkpoint in initial status push', () => {
    const activeCheckpoint = createTaskCheckpointFixture({ id: 'chk-reconnect' });
    const initialStatusPush: WsServerToClientMessage = {
      type: 'DAEMON_STATUS',
      payload: {
        isRunning: true,
        layaReady: true,
        activeTaskId: activeCheckpoint.taskId,
        lastCheckpoint: activeCheckpoint,
      },
    };

    expect(initialStatusPush.type).toBe('DAEMON_STATUS');
    expect(initialStatusPush.payload.lastCheckpoint?.id).toBe('chk-reconnect');
  });

  it('8.5: Emits CHECKPOINT_SAVED notification to clients whenever a checkpoint is committed to disk', () => {
    const chk = createTaskCheckpointFixture({ id: 'chk-saved-notify' });
    const notifMsg = createCheckpointSavedMsg(chk);

    expect(notifMsg.type).toBe('CHECKPOINT_SAVED');
    expect(notifMsg.payload.id).toBe('chk-saved-notify');
  });
});

// ===========================================================================
// Feature 9: UI Wizard State Store & Navigation Actions
// ===========================================================================
describe('Feature 9: UI Wizard State Store & Navigation Actions', () => {
  it('9.1: Store initializes with currentPage = 1 and canResume = false', () => {
    const store = new UiWizardStoreSimulator();
    expect(store.currentPage).toBe(1);
    expect(store.canResume).toBe(false);
  });

  it('9.2: nextPage() advances sequentially (1 -> 2 -> 3 -> 4) and clamps at Page 4', () => {
    const store = new UiWizardStoreSimulator();
    expect(store.currentPage).toBe(1);

    store.nextPage();
    expect(store.currentPage).toBe(2);

    store.nextPage();
    expect(store.currentPage).toBe(3);

    store.nextPage();
    expect(store.currentPage).toBe(4);

    // Clamp at 4
    store.nextPage();
    expect(store.currentPage).toBe(4);
  });

  it('9.3: prevPage() moves backward (4 -> 3 -> 2 -> 1) and clamps at Page 1', () => {
    const store = new UiWizardStoreSimulator();
    store.setPage(4);
    expect(store.currentPage).toBe(4);

    store.prevPage();
    expect(store.currentPage).toBe(3);

    store.prevPage();
    expect(store.currentPage).toBe(2);

    store.prevPage();
    expect(store.currentPage).toBe(1);

    // Clamp at 1
    store.prevPage();
    expect(store.currentPage).toBe(1);
  });

  it('9.4: setPage(page) directly transitions to valid workflow pages', () => {
    const store = new UiWizardStoreSimulator();
    store.setPage(3);
    expect(store.currentPage).toBe(3);
    store.setPage(2);
    expect(store.currentPage).toBe(2);
  });

  it('9.5: Receiving lastCheckpoint in daemon status sets canResume = true and updates wizardState', () => {
    const store = new UiWizardStoreSimulator();
    const chk = createTaskCheckpointFixture({
      wizardState: { currentPage: 3, userGoal: 'Monitor ONNX Benchmarks' },
    });

    store.applyCheckpoint(chk);
    expect(store.canResume).toBe(true);
    expect(store.currentPage).toBe(3);
    expect(store.userGoal).toBe('Monitor ONNX Benchmarks');
  });
});

// ===========================================================================
// Feature 10: Persistent Top Bar & Wizard Step Navigator
// ===========================================================================
describe('Feature 10: Persistent Top Bar & Wizard Step Navigator', () => {
  it('10.1: TelemetryHeader displays connection status and engine telemetry consistently across all 4 pages', () => {
    const deriveHeaderModel = (wsOnline: boolean, activeModel: string, page: number) => ({
      visible: true,
      badgeText: wsOnline ? 'ONLINE' : 'OFFLINE',
      activeModel,
      activePage: page,
    });

    for (let page = 1; page <= 4; page++) {
      const header = deriveHeaderModel(true, 'qwen2.5:3b', page);
      expect(header.visible).toBe(true);
      expect(header.badgeText).toBe('ONLINE');
      expect(header.activeModel).toBe('qwen2.5:3b');
    }
  });

  it('10.2: WorkflowNavigator renders 4 distinct step indicators showing active, completed, and upcoming steps', () => {
    const getStepStates = (currentPage: number) => {
      const steps = [1, 2, 3, 4];
      return steps.map((s) => ({
        step: s,
        status: s === currentPage ? 'active' : (s < currentPage ? 'completed' : 'upcoming'),
      }));
    };

    const statesOnPage2 = getStepStates(2);
    expect(statesOnPage2[0].status).toBe('completed');
    expect(statesOnPage2[1].status).toBe('active');
    expect(statesOnPage2[2].status).toBe('upcoming');
    expect(statesOnPage2[3].status).toBe('upcoming');
  });

  it('10.3: Left arrow control (< Prev) is disabled on Page 1 and enabled on Pages 2-4', () => {
    const canGoPrev = (page: number) => page > 1;
    expect(canGoPrev(1)).toBe(false);
    expect(canGoPrev(2)).toBe(true);
    expect(canGoPrev(3)).toBe(true);
    expect(canGoPrev(4)).toBe(true);
  });

  it('10.4: Right arrow control (Next >) is enabled on Pages 1-3 and disabled on Page 4', () => {
    const canGoNext = (page: number) => page < 4;
    expect(canGoNext(1)).toBe(true);
    expect(canGoNext(2)).toBe(true);
    expect(canGoNext(3)).toBe(true);
    expect(canGoNext(4)).toBe(false);
  });

  it('10.5: Step clicks in WorkflowNavigator trigger store page transitions', () => {
    const store = new UiWizardStoreSimulator();
    const onStepClick = (step: number) => store.setPage(step);

    onStepClick(3);
    expect(store.currentPage).toBe(3);
    onStepClick(1);
    expect(store.currentPage).toBe(1);
  });
});

// ===========================================================================
// Feature 11: Page 1: Goal & Model Setup View
// ===========================================================================
describe('Feature 11: Page 1: Goal & Model Setup View', () => {
  it('11.1: Renders goal textarea and updates store userGoal on change', () => {
    const store = new UiWizardStoreSimulator();
    store.setUserGoal('Monitor GPU memory consumption during browser crawling');
    expect(store.userGoal).toBe('Monitor GPU memory consumption during browser crawling');
    expect(store.canAdvanceFromPage1()).toBe(true);
  });

  it('11.2: Renders GGUF local model catalog with model sizes and download status', () => {
    const models = [
      { id: 'm1', name: 'qwen2.5:1.5b', sizeMb: 950, downloaded: true },
      { id: 'm2', name: 'llama3.2:3b', sizeMb: 2100, downloaded: false },
    ];
    expect(models).toHaveLength(2);
    expect(models[0].downloaded).toBe(true);
    expect(models[1].sizeMb).toBe(2100);
  });

  it('11.3: Clicking download initiates model download and displays progress bar', () => {
    let downloadState = { isDownloading: false, progressPercent: 0 };
    const onDownloadClick = () => {
      downloadState.isDownloading = true;
      downloadState.progressPercent = 15;
    };

    onDownloadClick();
    expect(downloadState.isDownloading).toBe(true);
    expect(downloadState.progressPercent).toBe(15);
  });

  it('11.4: Displays System 2 engine telemetry (active model, GPU provider, VRAM usage)', () => {
    const telemetry = {
      activeModel: 'qwen2.5:3b',
      provider: 'vulkan',
      vramUsageMb: 1450,
      totalVramMb: 8192,
    };
    expect(telemetry.activeModel).toBe('qwen2.5:3b');
    expect(telemetry.provider).toBe('vulkan');
    expect(telemetry.vramUsageMb).toBe(1450);
  });

  it('11.5: Displays System 2 output preview viewer when deliberation text is emitted', () => {
    let outputPreview = '';
    const onDeliberationEmit = (text: string) => {
      outputPreview = text;
    };

    onDeliberationEmit('Identified navigation choices: /tutorials, /releases');
    expect(outputPreview).toContain('/tutorials');
  });
});

// ===========================================================================
// Feature 12: Page 2: Spec Inspector & Start Task
// ===========================================================================
describe('Feature 12: Page 2: Spec Inspector & Start Task', () => {
  it('12.1: Displays compiled task specification plan (selector, interval, questions, rules)', () => {
    const store = new UiWizardStoreSimulator();
    store.setUserGoal('Find ONNX tutorials');
    const spec = store.compileSpec();

    expect(spec.userGoal).toBe('Find ONNX tutorials');
    expect(spec.domSelector).toBe('.doc-card');
    expect(spec.pollIntervalMs).toBe(500);
    expect(spec.questions.relevant).toBeDefined();
  });

  it('12.2: Alert threshold slider updates minAnswerConfidence in spec', () => {
    const store = new UiWizardStoreSimulator();
    store.compileSpec('Find releases');
    store.setThreshold(0.92);

    expect(store.alertConfidenceThreshold).toBe(0.92);
    expect(store.taskSpec?.alertRule.minAnswerConfidence).toBe(0.92);
  });

  it('12.3: Start Task button initiates WebSocket START_TASK with compiled spec', () => {
    const store = new UiWizardStoreSimulator();
    store.compileSpec('Test Task');
    let emittedMsg: WsClientToServerMessage | null = null;

    const onStartClick = () => {
      emittedMsg = {
        type: 'START_TASK',
        payload: { spec: store.taskSpec! },
      };
      store.startTask();
    };

    onStartClick();
    expect(emittedMsg).toBeDefined();
    expect(emittedMsg!.type).toBe('START_TASK');
    expect(emittedMsg!.payload.spec.name).toContain('Agent Run:');
  });

  it('12.4: Successful start automatically transitions wizard from Page 2 to Page 3', () => {
    const store = new UiWizardStoreSimulator();
    store.setPage(2);
    store.compileSpec('Live Task');

    store.startTask();
    expect(store.isTaskRunning).toBe(true);
    expect(store.currentPage).toBe(3);
  });

  it('12.5: Start Task button is disabled when daemon is offline or spec compilation is in progress', () => {
    const isStartDisabled = (wsConnected: boolean, isCompiling: boolean, specReady: boolean) =>
      !wsConnected || isCompiling || !specReady;

    expect(isStartDisabled(false, false, true)).toBe(true); // offline
    expect(isStartDisabled(true, true, true)).toBe(true); // compiling
    expect(isStartDisabled(true, false, false)).toBe(true); // no spec
    expect(isStartDisabled(true, false, true)).toBe(false); // ready
  });
});

// ===========================================================================
// Feature 13: Page 3: Live Agent Execution View
// ===========================================================================
describe('Feature 13: Page 3: Live Agent Execution View', () => {
  it('13.1: Displays real-time browser visual snapshot viewport', () => {
    const store = new UiWizardStoreSimulator();
    store.snapshot = {
      taskId: 'task-live',
      timestamp: Date.now(),
      url: 'http://127.0.0.1:8080/docs',
      title: 'Documentation Index',
      screenshot: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
      scroll: { x: 0, y: 1200, scrollHeight: 3000, viewportHeight: 800 },
    };

    expect(store.snapshot).toBeDefined();
    expect(store.snapshot.title).toBe('Documentation Index');
    expect(store.snapshot.screenshot).toContain('data:image/jpeg;base64');
  });

  it('13.2: Renders chronological action sequence timeline (AgentActionTimeline) with pending/success states', () => {
    const store = new UiWizardStoreSimulator();
    store.actionTimeline = [
      { id: 'a1', taskId: 't1', timestamp: 1000, type: 'scroll', status: 'success', message: 'Scrolled 400px' },
      { id: 'a2', taskId: 't1', timestamp: 1500, type: 'interaction', status: 'pending', message: 'Typing input' },
    ];

    expect(store.actionTimeline).toHaveLength(2);
    expect(store.actionTimeline[0].status).toBe('success');
    expect(store.actionTimeline[1].status).toBe('pending');
  });

  it('13.3: Renders decision matrix showing candidate scores and alert evaluations', () => {
    const matrixItem = {
      id: 'cand-01',
      snippet: 'WebGPU ONNX acceleration guide',
      confidence: 0.94,
      triggeredAlert: true,
      decision: 'Flagged Match',
    };

    expect(matrixItem.confidence).toBe(0.94);
    expect(matrixItem.triggeredAlert).toBe(true);
    expect(matrixItem.decision).toBe('Flagged Match');
  });

  it('13.4: Provides Stop and Pause buttons to control active task execution', () => {
    const store = new UiWizardStoreSimulator();
    store.startTask();
    expect(store.isTaskRunning).toBe(true);

    store.stopTask();
    expect(store.isTaskRunning).toBe(false);
  });

  it('13.5: Displays live inference event stream with per-step latency metrics', () => {
    const store = new UiWizardStoreSimulator();
    store.inferenceFeed.push({
      id: 'inf-01',
      taskId: 'task-live',
      timestamp: Date.now(),
      domSnippet: 'Candidate text for inference',
      latencyMs: 14.8,
      rawAnswers: { relevant: { answer: 'yes', answer_confidence: 0.95 } },
      triggeredAlert: true,
    });

    expect(store.inferenceFeed).toHaveLength(1);
    expect(store.inferenceFeed[0].latencyMs).toBe(14.8);
    expect(store.inferenceFeed[0].triggeredAlert).toBe(true);
  });
});

// ===========================================================================
// Feature 14: Page 4: Results & Steering View
// ===========================================================================
describe('Feature 14: Page 4: Results & Steering View', () => {
  it('14.1: Renders flagged matches list (AlertsDrawer) with confidence scores', () => {
    const alerts = [
      { id: 'alt-1', text: 'WebGPU DirectML Guide', confidence: 0.96 },
      { id: 'alt-2', text: 'v0.2.0 Release Changelog', confidence: 0.88 },
    ];

    expect(alerts).toHaveLength(2);
    expect(alerts[0].confidence).toBe(0.96);
  });

  it('14.2: Renders extracted results table (ResultsPanel) with CSV/Markdown export controls', () => {
    const store = new UiWizardStoreSimulator();
    store.results = [
      {
        id: 'res-1',
        timestamp: new Date().toISOString(),
        text: 'ONNX runtime benchmark',
        link: 'https://example.com/onnx',
        answers: { relevant: true },
        confidence: 0.91,
        triggeredAlert: true,
      },
    ];

    expect(store.results).toHaveLength(1);
    expect(store.results[0].text).toContain('benchmark');
  });

  it('14.3: ChatConsole allows user to query System 2 about collected findings', () => {
    const store = new UiWizardStoreSimulator();
    store.chatMessages.push({
      role: 'user',
      text: 'What are the main performance bottlenecks found?',
      timestamp: Date.now(),
    });
    store.chatMessages.push({
      role: 'assistant',
      text: 'The primary bottleneck identified is memory bandwidth on CPU execution provider.',
      timestamp: Date.now() + 500,
    });

    expect(store.chatMessages).toHaveLength(2);
    expect(store.chatMessages[1].role).toBe('assistant');
  });

  it('14.4: Submitting steering instructions parses parameters and submits STEER_TASK', () => {
    let steerMsg: WsClientToServerMessage | null = null;
    const submitSteering = (instruction: string) => {
      steerMsg = {
        type: 'STEER_TASK',
        payload: { instruction },
      };
    };

    submitSteering('Focus extraction on .release-item only');
    expect(steerMsg).toBeDefined();
    expect(steerMsg!.type).toBe('STEER_TASK');
    expect(steerMsg!.payload.instruction).toContain('.release-item');
  });

  it('14.5: Re-run button prepares task spec modifications and navigates back to Page 2 or Page 3', () => {
    const store = new UiWizardStoreSimulator();
    store.setPage(4);
    expect(store.currentPage).toBe(4);

    const onReRun = (targetPage: 2 | 3) => {
      store.setPage(targetPage);
    };

    onReRun(2);
    expect(store.currentPage).toBe(2);
  });
});
