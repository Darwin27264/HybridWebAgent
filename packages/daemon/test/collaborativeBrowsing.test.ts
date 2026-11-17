import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRunner } from '../src/runner/browserRunner.js';
import {
  evaluateStagnation,
  extractSearchQueryFromGoal,
  selectBestInputElement,
  selectBestNavigationChoice,
  findSubmitSelector
} from '../src/engine/systemTwoAssistant.js';
import type {
  CompiledTaskSpec,
  AgentAction,
  CandidateElement,
  HandoverContext,
  InteractiveInputElement,
  NavigationChoice
} from '@ofln-scout/shared';

describe('Milestone 2: System 1 & System 2 Collaborative Browsing Suite', () => {
  // --------------------------------------------------------------------------
  // Test 1: Interactive Form Input Detection & Handling
  // System 1 detects text input -> prompts System 2 -> fills query and submits -> navigates to mock results page
  // --------------------------------------------------------------------------
  it('Test 1: System 1 detects interactive text input -> prompts System 2 -> fills query and submits -> navigates to results page', async () => {
    const resultsHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Search Results</title></head>
        <body>
          <h1>Search Results for Mechanical Keyboards</h1>
          <div class="result-item">Custom Mechanical Keyboard with Gateron Switches</div>
          <div class="result-item">Keychron Q1 Pro Wireless Mechanical Keyboard</div>
        </body>
      </html>
    `;
    const resultsUri = `data:text/html;charset=utf-8,${encodeURIComponent(resultsHtml)}`;

    const searchHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Hardware Store</title></head>
        <body>
          <form id="search-form" action="${resultsUri}" method="GET">
            <input type="search" id="search-box" name="q" placeholder="Search products..." />
            <button type="submit" id="search-btn">Search</button>
          </form>
        </body>
      </html>
    `;
    const searchUri = `data:text/html;charset=utf-8,${encodeURIComponent(searchHtml)}`;

    const testSpec: CompiledTaskSpec = {
      id: 'collab-test-form-input',
      name: 'Search Form Test',
      userGoal: 'Search for "Mechanical Keyboards" in store',
      targetUrl: searchUri,
      domSelector: '.result-item',
      pollIntervalMs: 100,
      scrollStepPx: 200,
      questions: {
        is_keyboard: {
          type: 'noul',
          statement: 'Is this a mechanical keyboard?'
        }
      },
      alertRule: {
        questionKey: 'is_keyboard',
        operator: 'boolean_true',
        targetValue: true,
        minAnswerConfidence: 0.8
      },
      createdAt: Date.now()
    };

    const runner = new BrowserRunner({ headless: true });
    const emittedActions: AgentAction[] = [];
    const extractedCandidates: CandidateElement[] = [];
    const controller = new AbortController();

    const runPromise = runner.runTask(
      testSpec,
      async (candidate) => {
        extractedCandidates.push(candidate);
        if (extractedCandidates.length >= 2) {
          controller.abort();
        }
      },
      controller.signal,
      (action) => {
        emittedActions.push(action);
      }
    );

    // Safety timeout after 15 seconds
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      await runPromise;
    } finally {
      clearTimeout(timeout);
    }

    // 1. Verify System 2 handover was triggered for form input
    const handoverActions = emittedActions.filter((a) => a.type === 'system2_handover');
    assert.ok(handoverActions.length >= 2, 'Must emit at least pending and success handover actions');
    const inputHandover = handoverActions.find(
      (a) => a.details?.context?.triggerReason === 'form_input_required'
    );
    assert.ok(inputHandover, 'Must trigger handover with triggerReason "form_input_required"');

    // 2. Verify interaction action occurred with the query text from userGoal
    const interactionActions = emittedActions.filter((a) => a.type === 'interaction');
    assert.ok(interactionActions.length >= 1, 'Must emit interaction action for form input');
    const formFill = interactionActions[0];
    assert.equal(formFill.details?.selector, '#search-box');
    assert.equal(formFill.details?.text, 'Mechanical Keyboards');
    assert.equal(formFill.status, 'success');

    // 3. Verify candidates were extracted from the navigated results page
    assert.ok(extractedCandidates.length >= 1, 'Must extract candidates from results page');
    assert.ok(
      extractedCandidates.some((c) => c.text.includes('Custom Mechanical Keyboard with Gateron Switches')),
      'Must contain first search result'
    );
    assert.ok(
      extractedCandidates.some((c) => c.text.includes('Keychron Q1 Pro Wireless Mechanical Keyboard')),
      'Must contain second search result'
    );

    // 4. Verify handledInputs recorded the search input
    assert.ok(runner.getHandledInputs().some((inp) => inp.includes('#search-box')));
  });

  // --------------------------------------------------------------------------
  // Test 2: Navigation Fork Detection & Strategic Choice
  // System 1 detects navigation forks -> prompts System 2 -> selects and clicks target category link -> navigates
  // --------------------------------------------------------------------------
  it('Test 2: System 1 detects navigation forks -> prompts System 2 -> selects and clicks target category link -> navigates', async () => {
    const laptopsHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Laptops Department</title></head>
        <body>
          <h1>Laptops & Ultrabooks</h1>
          <div class="category-item">ThinkPad X1 Carbon Gen 12 Ultrabook</div>
          <div class="category-item">MacBook Pro M3 Max 16-inch</div>
        </body>
      </html>
    `;
    const laptopsUri = `data:text/html;charset=utf-8,${encodeURIComponent(laptopsHtml)}`;

    const booksHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Books Department</title></head>
        <body>
          <h1>Books & Literature</h1>
          <div class="category-item">Designing Data-Intensive Applications</div>
        </body>
      </html>
    `;
    const booksUri = `data:text/html;charset=utf-8,${encodeURIComponent(booksHtml)}`;

    const portalHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Megastore Portal</title></head>
        <body>
          <header>
            <nav class="categories">
              <a id="nav-books" href="${booksUri}">Books & Literature</a>
              <a id="nav-laptops" href="${laptopsUri}">Laptops & Ultrabooks</a>
              <a id="nav-clothing" href="#clothing">Clothing & Apparel</a>
            </nav>
          </header>
          <div class="intro">Welcome to Megastore! Select a department above to browse our catalog.</div>
        </body>
      </html>
    `;
    const portalUri = `data:text/html;charset=utf-8,${encodeURIComponent(portalHtml)}`;

    const testSpec: CompiledTaskSpec = {
      id: 'collab-test-nav-fork',
      name: 'Navigation Fork Test',
      userGoal: 'Find high-end laptops and ultrabooks',
      targetUrl: portalUri,
      domSelector: '.category-item',
      pollIntervalMs: 100,
      scrollStepPx: 200,
      questions: {
        is_laptop: {
          type: 'noul',
          statement: 'Is this an ultrabook or laptop?'
        }
      },
      alertRule: {
        questionKey: 'is_laptop',
        operator: 'boolean_true',
        targetValue: true,
        minAnswerConfidence: 0.8
      },
      createdAt: Date.now()
    };

    const runner = new BrowserRunner({ headless: true });
    const emittedActions: AgentAction[] = [];
    const extractedCandidates: CandidateElement[] = [];
    const controller = new AbortController();

    const runPromise = runner.runTask(
      testSpec,
      async (candidate) => {
        extractedCandidates.push(candidate);
        if (extractedCandidates.length >= 2) {
          controller.abort();
        }
      },
      controller.signal,
      (action) => {
        emittedActions.push(action);
      }
    );

    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      await runPromise;
    } finally {
      clearTimeout(timeout);
    }

    // 1. Verify navigation fork handover occurred
    const navForkHandover = emittedActions.find(
      (a) => a.type === 'system2_handover' && a.details?.context?.triggerReason === 'navigation_fork'
    );
    assert.ok(navForkHandover, 'Must trigger handover with triggerReason "navigation_fork"');

    // 2. Verify System 2 evaluated choices and picked Laptops (not Books or Clothing)
    const navDecision = emittedActions.find(
      (a) =>
        a.type === 'system2_handover' &&
        a.details?.decision?.action === 'choose_navigation' &&
        a.details?.decision?.selector === '#nav-laptops'
    );
    assert.ok(navDecision, 'System 2 must choose the #nav-laptops link matching the user goal');

    // 3. Verify navigation action was emitted
    const navActions = emittedActions.filter((a) => a.type === 'navigation');
    const branchNav = navActions.find((a) => a.message.includes('Laptops & Ultrabooks') || a.details?.selector === '#nav-laptops');
    assert.ok(branchNav, 'Runner must emit navigation action navigating to the selected choice');

    // 4. Verify candidates extracted from laptops page
    assert.ok(extractedCandidates.length >= 1, 'Must extract candidates from the laptops department page');
    assert.ok(
      extractedCandidates.some((c) => c.text.includes('ThinkPad X1 Carbon Gen 12 Ultrabook')),
      'Must contain ThinkPad ultrabook'
    );

    // 5. Verify visitedUrls contains laptopsUri and not booksUri
    const visited = runner.getVisitedUrls();
    assert.ok(visited.includes(laptopsUri), 'Visited URLs must contain laptopsUri');
    assert.ok(!visited.includes(booksUri), 'Visited URLs must NOT contain booksUri');
  });

  // --------------------------------------------------------------------------
  // Test 3: Stalled Progress Detection & Autonomous Recovery
  // System 1 detecting stalled progress -> prompts System 2 -> applies pagination or recovery action
  // --------------------------------------------------------------------------
  it('Test 3: System 1 detects stalled progress -> prompts System 2 -> applies pagination recovery', async () => {
    const page2Html = `
      <!DOCTYPE html>
      <html>
        <head><title>Articles Page 2</title></head>
        <body>
          <div class="article">Article 3: Deep Dive into ModernBERT Architecture</div>
          <div class="article">Article 4: Edge AI on Windows with DirectML</div>
        </body>
      </html>
    `;
    const page2Uri = `data:text/html;charset=utf-8,${encodeURIComponent(page2Html)}`;

    const page1Html = `
      <!DOCTYPE html>
      <html>
        <head><title>Articles Page 1</title></head>
        <body style="min-height: 2000px;">
          <div class="article">Article 1: Getting Started with ONNX Runtime</div>
          <div class="article">Article 2: Local AI Inference in 2026</div>
          <div style="margin-top: 1500px;" class="pagination">
            <a id="next-page" href="${page2Uri}">Next Page &gt;</a>
          </div>
        </body>
      </html>
    `;
    const page1Uri = `data:text/html;charset=utf-8,${encodeURIComponent(page1Html)}`;

    const testSpec: CompiledTaskSpec = {
      id: 'collab-test-stalled-progress',
      name: 'Stalled Progress Test',
      userGoal: 'Scout AI articles across pages',
      targetUrl: page1Uri,
      domSelector: '.article',
      pollIntervalMs: 50,
      scrollStepPx: 500,
      questions: {
        is_ai: {
          type: 'noul',
          statement: 'Is this an AI article?'
        }
      },
      alertRule: {
        questionKey: 'is_ai',
        operator: 'boolean_true',
        targetValue: true,
        minAnswerConfidence: 0.8
      },
      createdAt: Date.now()
    };

    const runner = new BrowserRunner({ headless: true });
    const emittedActions: AgentAction[] = [];
    const extractedCandidates: CandidateElement[] = [];
    const controller = new AbortController();

    const runPromise = runner.runTask(
      testSpec,
      async (candidate) => {
        extractedCandidates.push(candidate);
        // Once we extract an article from Page 2, we can abort
        if (candidate.text.includes('Article 3') || candidate.text.includes('Article 4')) {
          controller.abort();
        }
      },
      controller.signal,
      (action) => {
        emittedActions.push(action);
      }
    );

    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      await runPromise;
    } finally {
      clearTimeout(timeout);
    }

    // 1. Verify stagnation was detected
    const stagnationActions = emittedActions.filter((a) => a.type === 'stagnation_detected');
    assert.ok(stagnationActions.length >= 1, 'Must detect stagnation on page 1 boundary');

    // 2. Verify System 2 was invoked with triggerReason 'stalled_progress'
    const stalledHandover = emittedActions.find(
      (a) => a.type === 'system2_handover' && a.details?.context?.triggerReason === 'stalled_progress'
    );
    assert.ok(stalledHandover, 'Must invoke System 2 with triggerReason "stalled_progress"');

    // 3. Verify System 2 returned action 'paginate' with selector '#next-page'
    const paginateDecision = emittedActions.find(
      (a) => a.type === 'system2_handover' && a.details?.decision?.action === 'paginate'
    );
    assert.ok(paginateDecision, 'System 2 must return action "paginate"');

    // 4. Verify candidate from page 2 was extracted
    assert.ok(
      extractedCandidates.some((c) => c.text.includes('Article 3: Deep Dive into ModernBERT Architecture')),
      'Must successfully navigate and extract items from Page 2'
    );
  });

  // --------------------------------------------------------------------------
  // Test 4: Deterministic Offline Fallback under No-Model Conditions
  // Produces goal-conditioned inputs, choice scoring, and recovery actions
  // --------------------------------------------------------------------------
  describe('Test 4: Deterministic offline fallback under no-model conditions', () => {
    it('4.1 extractSearchQueryFromGoal extracts meaningful keywords and handles quotes/prefixes', () => {
      assert.equal(
        extractSearchQueryFromGoal('Search for "PlayStation 5 Pro" in store'),
        'PlayStation 5 Pro'
      );
      assert.equal(
        extractSearchQueryFromGoal("Find 'Local LLM Models' online"),
        'Local LLM Models'
      );
      assert.equal(
        extractSearchQueryFromGoal('Search for mechanical keyboards under $50'),
        'mechanical keyboards under $50'
      );
      assert.equal(
        extractSearchQueryFromGoal('Please find me cheap graphic cards on this website'),
        'cheap graphic cards'
      );
      assert.equal(
        extractSearchQueryFromGoal('Monitor local AI tools and ONNX runtime'),
        'local AI tools and ONNX runtime'
      );
      assert.equal(
        extractSearchQueryFromGoal('Query books about distributed databases'),
        'books about distributed databases'
      );
      assert.equal(
        extractSearchQueryFromGoal('search for "men\'s clothing" in store'),
        "men's clothing"
      );
      assert.equal(
        extractSearchQueryFromGoal("search for 'Levi\\'s 501 jeans' online"),
        "Levi's 501 jeans"
      );
      assert.equal(
        extractSearchQueryFromGoal('find "foo \\"bar\\" baz"'),
        'foo "bar" baz'
      );
      assert.equal(
        extractSearchQueryFromGoal('Search for "women\'s shoes" on this website'),
        "women's shoes"
      );
      assert.equal(extractSearchQueryFromGoal('Simple Goal'), 'Simple Goal');
      assert.equal(extractSearchQueryFromGoal(''), '');
    });

    it('4.2 selectBestInputElement prioritizes search inputs over generic inputs', () => {
      const candidates: InteractiveInputElement[] = [
        { selector: '#comment', tag: 'textarea', name: 'comment', placeholder: 'Leave a comment' },
        { selector: '#email', tag: 'input', type: 'email', name: 'email', placeholder: 'Your email' },
        { selector: '#search-box', tag: 'input', type: 'search', name: 'q', placeholder: 'Search products...' },
        { selector: '#username', tag: 'input', type: 'text', name: 'user' }
      ];

      const best = selectBestInputElement(candidates);
      assert.ok(best, 'Must select an input');
      assert.equal(best?.selector, '#search-box');

      // Check submit button extraction
      const submitSelector = findSubmitSelector([
        ...candidates,
        { selector: '#search-submit', tag: 'button', type: 'submit' }
      ]);
      assert.equal(submitSelector, '#search-submit');
    });

    it('4.3 selectBestNavigationChoice accurately scores token overlap with userGoal', () => {
      const choices: NavigationChoice[] = [
        { selector: '#nav-fashion', text: 'Fashion & Apparel', href: '/fashion', category: 'Clothing' },
        { selector: '#nav-electronics', text: 'Consumer Electronics', href: '/electronics', category: 'Electronics' },
        { selector: '#nav-ai', text: 'AI & Machine Learning Hardware', href: '/ai-hardware', category: 'Computing' }
      ];

      // Goal targeting AI hardware
      const bestAi = selectBestNavigationChoice(choices, 'Looking for AI machine learning hardware');
      assert.ok(bestAi);
      assert.equal(bestAi.choice.selector, '#nav-ai');
      assert.ok(bestAi.score > 20);

      // Goal targeting electronics
      const bestElectronics = selectBestNavigationChoice(choices, 'Find consumer electronics deals');
      assert.ok(bestElectronics);
      assert.equal(bestElectronics.choice.selector, '#nav-electronics');
    });

    it('4.4 evaluateStagnation offline fallback returns valid form_input and choose_navigation actions', async () => {
      const formHandover: HandoverContext = {
        taskId: 'offline-test-1',
        runId: 'run-off-1',
        userGoal: 'Search for "RTX 5090" GPUs',
        targetUrl: 'https://example.com/store',
        currentUrl: 'https://example.com/store',
        pageTitle: 'Example Store',
        triggerReason: 'form_input_required',
        scrollState: { y: 0, scrollHeight: 1000, viewportHeight: 600 },
        totalScanned: 0,
        totalAlerts: 0,
        consecutiveEmptyCycles: 0,
        formInputs: [
          { selector: '#store-search', tag: 'input', type: 'search', placeholder: 'Search catalog' }
        ]
      };

      const formDecision = await evaluateStagnation(formHandover);
      assert.equal(formDecision.action, 'form_input');
      if (formDecision.action === 'form_input') {
        assert.equal(formDecision.selector, '#store-search');
        assert.equal(formDecision.text, 'RTX 5090');
        assert.equal(formDecision.pressEnter, true);
        assert.ok(formDecision.reasoning?.includes('RTX 5090'));
      }

      const navHandover: HandoverContext = {
        taskId: 'offline-test-2',
        runId: 'run-off-2',
        userGoal: 'Find robotics and embedded systems',
        targetUrl: 'https://example.com/portal',
        currentUrl: 'https://example.com/portal',
        pageTitle: 'Example Portal',
        triggerReason: 'navigation_fork',
        scrollState: { y: 0, scrollHeight: 1000, viewportHeight: 600 },
        totalScanned: 0,
        totalAlerts: 0,
        consecutiveEmptyCycles: 0,
        navigationChoices: [
          { selector: '#nav-home', text: 'Home', href: '/home' },
          { selector: '#nav-robotics', text: 'Robotics & Automation', href: '/robotics' },
          { selector: '#nav-blog', text: 'Company Blog', href: '/blog' }
        ]
      };

      const navDecision = await evaluateStagnation(navHandover);
      assert.equal(navDecision.action, 'choose_navigation');
      if (navDecision.action === 'choose_navigation') {
        assert.equal(navDecision.selector, '#nav-robotics');
        assert.equal(navDecision.url, '/robotics');
        assert.equal(navDecision.text, 'Robotics & Automation');
      }
    });

    it('4.5 evaluateStagnation handles undefined or null scrollState without throwing', async () => {
      const handoverUndefinedScroll: HandoverContext = {
        taskId: 'offline-test-null-scroll',
        runId: 'run-off-3',
        userGoal: 'Search for "men\'s clothing"',
        targetUrl: 'https://example.com/store',
        currentUrl: 'https://example.com/store',
        pageTitle: 'Example Store',
        triggerReason: 'form_input_required',
        scrollState: undefined as any,
        totalScanned: 0,
        totalAlerts: 0,
        consecutiveEmptyCycles: 0,
        formInputs: [
          { selector: '#search-box', tag: 'input', type: 'search', placeholder: 'Search products' }
        ]
      };

      const decision1 = await evaluateStagnation(handoverUndefinedScroll);
      assert.equal(decision1.action, 'form_input');
      if (decision1.action === 'form_input') {
        assert.equal(decision1.selector, '#search-box');
        assert.equal(decision1.text, "men's clothing");
      }

      const handoverNullScroll: HandoverContext = {
        ...handoverUndefinedScroll,
        scrollState: null as any
      };
      const decision2 = await evaluateStagnation(handoverNullScroll);
      assert.equal(decision2.action, 'form_input');
    });
  });

  // --------------------------------------------------------------------------
  // Test 5: Circular Loop Prevention & Form Re-Submission Guard
  // Does not repeatedly submit the same form or loop indefinitely
  // --------------------------------------------------------------------------
  it('Test 5: Circular loop prevention: does not repeatedly submit the same form or loop indefinitely', async () => {
    // Single page with search input that appends mock results without navigating away
    const singlePageHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Single Page Search</title></head>
        <body style="min-height: 1000px;">
          <form id="search-form" onsubmit="event.preventDefault(); document.getElementById('results-container').innerHTML = '<div class=\\'scout-item\\'>Found Search Result 1</div>';">
            <input type="text" id="filter-input" name="filter" placeholder="Enter filter..." />
            <button type="submit" id="filter-btn">Filter</button>
          </form>
          <div id="results-container"></div>
        </body>
      </html>
    `;
    const singlePageUri = `data:text/html;charset=utf-8,${encodeURIComponent(singlePageHtml)}`;

    const testSpec: CompiledTaskSpec = {
      id: 'collab-test-loop-guard',
      name: 'Loop Guard Test',
      userGoal: 'Filter items',
      targetUrl: singlePageUri,
      domSelector: '.scout-item',
      pollIntervalMs: 50,
      scrollStepPx: 300,
      questions: {
        is_result: {
          type: 'noul',
          statement: 'Is this a search result?'
        }
      },
      alertRule: {
        questionKey: 'is_result',
        operator: 'boolean_true',
        targetValue: true,
        minAnswerConfidence: 0.8
      },
      createdAt: Date.now()
    };

    const runner = new BrowserRunner({ headless: true });
    const emittedActions: AgentAction[] = [];
    const extractedCandidates: CandidateElement[] = [];
    const controller = new AbortController();

    const runPromise = runner.runTask(
      testSpec,
      async (candidate) => {
        extractedCandidates.push(candidate);
      },
      controller.signal,
      (action) => {
        emittedActions.push(action);
      }
    );

    // Let it run for 3 seconds to complete the form input, extract candidates, and detect stagnation
    setTimeout(() => controller.abort(), 3500);

    await runPromise;

    // 1. Verify that form input interaction occurred exactly ONCE
    const interactionActions = emittedActions.filter((a) => a.type === 'interaction');
    assert.equal(
      interactionActions.length,
      1,
      `Form input must be submitted exactly once, got ${interactionActions.length}`
    );
    assert.equal(interactionActions[0].details?.selector, '#filter-input');

    // 2. Verify that the input selector was marked in handledInputs
    assert.ok(
      runner.getHandledInputs().some((inp) => inp.includes('#filter-input')),
      'Handled inputs set must contain #filter-input'
    );

    // 3. Verify candidate was extracted
    assert.ok(
      extractedCandidates.some((c) => c.text.includes('Found Search Result 1')),
      'Must extract candidate after single form submission'
    );

    // 4. Verify no second form input handover was triggered
    const formHandovers = emittedActions.filter(
      (a) => a.type === 'system2_handover' && a.details?.context?.triggerReason === 'form_input_required'
    );
    assert.equal(
      formHandovers.length,
      1,
      `Must only trigger form_input_required handover once, got ${formHandovers.length}`
    );
  });

  // --------------------------------------------------------------------------
  // Test 6: Self-Referential Links & Handled Choices Loop Prevention
  // Does not repeatedly trigger navigation_fork on javascript:void(0), #, or handled choices
  // --------------------------------------------------------------------------
  it('Test 6: Self-referential links (javascript:void(0), #) and handled choices do not cause infinite loops', async () => {
    const portalHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Self-Referential Links Portal</title></head>
        <body style="min-height: 800px;">
          <header>
            <nav class="categories">
              <a id="nav-js" href="javascript:void(0)">Keyboards Hub JS</a>
              <a id="nav-hash" href="#">Keyboards Hub Hash</a>
              <a id="nav-section" href="#section">Keyboards Section</a>
            </nav>
          </header>
          <div id="content">Welcome to the portal.</div>
        </body>
      </html>
    `;
    const portalUri = `data:text/html;charset=utf-8,${encodeURIComponent(portalHtml)}`;

    const testSpec: CompiledTaskSpec = {
      id: 'collab-test-self-ref-loop',
      name: 'Self-Referential Loop Guard Test',
      userGoal: 'Find Keyboards Hub',
      targetUrl: portalUri,
      domSelector: '.non-existent-item',
      pollIntervalMs: 50,
      scrollStepPx: 300,
      questions: {
        is_item: {
          type: 'noul',
          statement: 'Is this an item?'
        }
      },
      alertRule: {
        questionKey: 'is_item',
        operator: 'boolean_true',
        targetValue: true,
        minAnswerConfidence: 0.8
      },
      createdAt: Date.now()
    };

    const runner = new BrowserRunner({ headless: true });
    const emittedActions: AgentAction[] = [];
    const controller = new AbortController();

    const runPromise = runner.runTask(
      testSpec,
      async () => {},
      controller.signal,
      (action) => {
        emittedActions.push(action);
      }
    );

    // In vulnerable code, 28 navigation_fork handovers occurred within 3 seconds.
    // With fix, self-referential links are excluded and handled choices are tracked so at most 1 handover occurs.
    setTimeout(() => controller.abort(), 2500);

    await runPromise;

    // 1. Verify navigation_fork handover was triggered at most once
    const navForkHandovers = emittedActions.filter(
      (a) => a.type === 'system2_handover' && a.details?.context?.triggerReason === 'navigation_fork'
    );
    assert.ok(
      navForkHandovers.length <= 1,
      `Should not repeatedly trigger navigation_fork on self-referential links, got ${navForkHandovers.length}`
    );

    // 2. If a choice was handled, verify handledChoices tracked it
    if (navForkHandovers.length === 1) {
      assert.ok(
        runner.getHandledChoices().length >= 1,
        'Handled choices set must record the chosen navigation option'
      );
    }
  });
});
