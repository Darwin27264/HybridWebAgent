import assert from 'node:assert/strict';
import { useScoutStore, formatLatency } from './useScoutStore';
import { formatItemAsCsvRow, formatResultsAsCsv } from '../components/ResultsPanel';
import { wsClient } from '../lib/wsClient';
import type {
  CompiledTaskSpec,
  InferenceTelemetryItem,
  Job,
  AgentAction,
  BrowserSnapshot,
  SystemPerformanceMetrics,
  ScrapedItem,
  ResultStats,
  ModelStats,
  TaskCheckpoint,
} from '@ofln-scout/shared';

async function runTests() {
  console.log('▶ Starting useScoutStore unit tests...');

  // Reset store before starting
  useScoutStore.getState().reset();

  // Test 1: Initial state
  {
    const state = useScoutStore.getState();
    assert.equal(state.wsConnected, false, 'Expected wsConnected false initially');
    assert.equal(state.daemonStatus.isRunning, false, 'Expected isRunning false initially');
    assert.equal(state.daemonStatus.layaReady, false, 'Expected layaReady false initially');
    assert.equal(state.daemonStatus.activeTaskId, null, 'Expected activeTaskId null initially');
    assert.equal(state.isLaunching, false, 'Expected isLaunching false initially');
    assert.equal(state.isStopping, false, 'Expected isStopping false initially');
    assert.equal(state.compilationStatus, 'idle', 'Expected compilationStatus idle initially');
    assert.equal(state.activeTab, 'workbench', 'Expected activeTab workbench initially');
    assert.equal(state.inferenceFeed.length, 0, 'Expected inferenceFeed to be empty initially');
    assert.equal(state.alerts.length, 0, 'Expected alerts to be empty initially');
    assert.equal(state.agentActions.length, 0, 'Expected agentActions to be empty initially');
    assert.equal(state.jobs.length, 0, 'Expected jobs to be empty initially');
    assert.equal(state.latestSnapshot, null, 'Expected latestSnapshot null initially');
    assert.equal(state.metrics, null, 'Expected metrics null initially');
    assert.equal(state.telemetryStats.totalScanned, 0, 'Expected totalScanned 0 initially');
    assert.equal(state.telemetryStats.avgLatencyMs, 0, 'Expected avgLatencyMs 0 initially');
    assert.equal(state.resultsMarkdown, '', 'Expected resultsMarkdown empty initially');
    assert.equal(state.resultsSummary, '', 'Expected resultsSummary empty initially');
    assert.equal(state.resultsStats, null, 'Expected resultsStats null initially');
    assert.equal(state.resultsItems.length, 0, 'Expected resultsItems empty initially');
    assert.equal(state.resultsLastUpdated, null, 'Expected resultsLastUpdated null initially');
    assert.equal(state.chatMessages.length, 0, 'Expected chatMessages empty initially');
    assert.equal(state.isChatLoading, false, 'Expected isChatLoading false initially');
    assert.equal(state.modelStats, null, 'Expected modelStats null initially');
    console.log('  ✔ Test 1: Initial store state verified');
  }

  // Test 2: Connection state transitions and Boundary 8.5 (reset latency on disconnect)
  {
    useScoutStore.getState().setConnected(true);
    assert.equal(useScoutStore.getState().wsConnected, true, 'Expected wsConnected true');

    // Simulate some latency
    useScoutStore.getState().addInference({
      id: 'inf-test-lat',
      taskId: 't-1',
      timestamp: Date.now(),
      domSnippet: 'test snippet',
      latencyMs: 35.5,
      rawAnswers: {},
      triggeredAlert: false,
    });
    assert.equal(useScoutStore.getState().telemetryStats.avgLatencyMs > 0, true);

    // Disconnect event must reset active latency display to 0 per Boundary 8.5
    useScoutStore.getState().setConnected(false);
    assert.equal(useScoutStore.getState().wsConnected, false);
    assert.equal(
      useScoutStore.getState().telemetryStats.avgLatencyMs,
      0,
      'Expected avgLatencyMs reset to 0 on disconnect'
    );
    console.log('  ✔ Test 2: Connection state transitions and Boundary 8.5 verified');
  }

  // Test 3: Status state transitions
  {
    useScoutStore.getState().setStatus({
      isRunning: true,
      layaReady: true,
      activeTaskId: 'task-active-123',
    });
    const status = useScoutStore.getState().daemonStatus;
    assert.equal(status.isRunning, true);
    assert.equal(status.layaReady, true);
    assert.equal(status.activeTaskId, 'task-active-123');
    console.log('  ✔ Test 3: Daemon status updates verified');
  }

  // Test 4: Compilation transitions and spec updates
  {
    const sampleSpec: CompiledTaskSpec = {
      id: 'task-test-01',
      name: 'Test Task',
      userGoal: 'Test Goal',
      targetUrl: 'https://example.com',
      domSelector: '.test',
      pollIntervalMs: 500,
      scrollStepPx: 300,
      questions: {
        is_tool: {
          type: 'noul',
          statement: 'Is this an AI tool?',
        },
      },
      alertRule: {
        questionKey: 'is_tool',
        operator: 'boolean_true',
        targetValue: true,
        minAnswerConfidence: 0.85,
      },
      createdAt: Date.now(),
    };

    useScoutStore.getState().setCompilation('compiling', 'Compiling via Ollama...');
    assert.equal(useScoutStore.getState().compilationStatus, 'compiling');
    assert.equal(useScoutStore.getState().compilationMessage, 'Compiling via Ollama...');

    useScoutStore.getState().setCompilation('ready', 'Task spec compiled', sampleSpec);
    assert.equal(useScoutStore.getState().compilationStatus, 'ready');
    assert.equal(useScoutStore.getState().compilationMessage, 'Task spec compiled');
    assert.equal(useScoutStore.getState().currentSpec?.id, 'task-test-01');
    console.log('  ✔ Test 4: Compilation transitions and spec updates verified');
  }

  // Test 5: Feed buffer capping at 100 items (Boundary 8.1)
  {
    useScoutStore.getState().reset();
    const burstCount = 150;
    for (let i = 0; i < burstCount; i++) {
      const item: InferenceTelemetryItem = {
        id: `inf-${i}`,
        taskId: 't-1',
        timestamp: Date.now() + i,
        domSnippet: `DOM snippet ${i}`,
        latencyMs: 20 + (i % 5),
        rawAnswers: {},
        triggeredAlert: i % 10 === 0,
      };
      useScoutStore.getState().addInference(item);
    }

    const feed = useScoutStore.getState().inferenceFeed;
    assert.equal(feed.length, 100, `Expected feed capped at 100, got ${feed.length}`);
    assert.equal(feed[0].id, `inf-${burstCount - 1}`);
    assert.equal(feed[feed.length - 1].id, `inf-${burstCount - 100}`);

    const stats = useScoutStore.getState().telemetryStats;
    assert.equal(stats.totalScanned, 150, 'Expected totalScanned to record all 150 items');
    assert.equal(stats.totalAlerts, 15, 'Expected totalAlerts to record 15 alerts');
    assert.equal(stats.latencyHistory.length, 30, 'Expected latency history capped at 30 items');
    console.log('  ✔ Test 5: Feed buffer capping at 100 items verified');
  }

  // Test 6: Latency formatting and NaN / Infinity resilience (Boundary 8.3)
  {
    assert.equal(formatLatency(18.4), '18.4 ms');
    assert.equal(formatLatency(0), '0.0 ms');
    assert.equal(formatLatency(NaN), '0.0 ms');
    assert.equal(formatLatency(Infinity), '0.0 ms');
    assert.equal(formatLatency(-15.4), '0.0 ms');

    useScoutStore.getState().addInference({
      id: 'inf-nan',
      taskId: 't-1',
      timestamp: Date.now(),
      domSnippet: 'snippet with NaN latency',
      latencyMs: NaN,
      rawAnswers: {},
      triggeredAlert: false,
    });

    const currentAvg = useScoutStore.getState().telemetryStats.avgLatencyMs;
    assert.equal(isFinite(currentAvg) && !isNaN(currentAvg), true, 'Store avg latency must remain valid finite number');
    console.log('  ✔ Test 6: Latency boundary formatting verified');
  }

  // Test 7: Alert management and deduplication
  {
    const alertItem1: InferenceTelemetryItem = {
      id: 'alert-01',
      taskId: 't-1',
      timestamp: 1000,
      domSnippet: 'Alert snippet 1',
      latencyMs: 15.0,
      rawAnswers: {},
      triggeredAlert: true,
    };
    const alertItem2: InferenceTelemetryItem = {
      id: 'alert-02',
      taskId: 't-1',
      timestamp: 2000,
      domSnippet: 'Alert snippet 2',
      latencyMs: 16.0,
      rawAnswers: {},
      triggeredAlert: true,
    };

    useScoutStore.getState().addAlert(alertItem1);
    assert.equal(useScoutStore.getState().alerts.length, 1);

    // Duplicate alert ID should not be re-added
    useScoutStore.getState().addAlert(alertItem1);
    assert.equal(useScoutStore.getState().alerts.length, 1);

    useScoutStore.getState().addAlert(alertItem2);
    assert.equal(useScoutStore.getState().alerts.length, 2);

    useScoutStore.getState().clearAlerts();
    assert.equal(useScoutStore.getState().alerts.length, 0);
    assert.equal(useScoutStore.getState().telemetryStats.totalAlerts, 0);
    console.log('  ✔ Test 7: Alert management and deduplication verified');
  }

  // Test 8: Fresh run execution reset (R1)
  {
    // Populate state with run data
    useScoutStore.getState().addInference({
      id: 'inf-run-1',
      taskId: 't-run',
      timestamp: Date.now(),
      domSnippet: 'snippet',
      latencyMs: 12.0,
      rawAnswers: {},
      triggeredAlert: true,
    });
    useScoutStore.getState().addAlert({
      id: 'alert-run-1',
      taskId: 't-run',
      timestamp: Date.now(),
      domSnippet: 'snippet',
      latencyMs: 12.0,
      rawAnswers: {},
      triggeredAlert: true,
    });
    useScoutStore.getState().addAction({
      id: 'act-1',
      taskId: 't-run',
      timestamp: Date.now(),
      type: 'navigation',
      status: 'success',
      message: 'Navigated to page',
    });
    useScoutStore.getState().setLatestSnapshot({
      taskId: 't-run',
      timestamp: Date.now(),
      url: 'https://example.com',
      title: 'Example',
      screenshot: 'data:image/jpeg;base64,123',
      scroll: { x: 0, y: 100, scrollHeight: 1000, viewportHeight: 600 },
    });
    useScoutStore.getState().setIsLaunching(true);

    assert.equal(useScoutStore.getState().inferenceFeed.length > 0, true);
    assert.equal(useScoutStore.getState().alerts.length > 0, true);
    assert.equal(useScoutStore.getState().agentActions.length > 0, true);
    assert.notEqual(useScoutStore.getState().latestSnapshot, null);

    // Trigger startFreshRun
    useScoutStore.getState().startFreshRun();

    const freshState = useScoutStore.getState();
    assert.equal(freshState.inferenceFeed.length, 0, 'Inference feed must be reset on fresh run');
    assert.equal(freshState.alerts.length, 0, 'Alerts must be reset on fresh run');
    assert.equal(freshState.agentActions.length, 0, 'Agent actions must be reset on fresh run');
    assert.equal(freshState.latestSnapshot, null, 'Snapshot must be reset on fresh run');
    assert.equal(freshState.telemetryStats.totalScanned, 0, 'Total scanned must be reset');
    assert.equal(freshState.telemetryStats.totalAlerts, 0, 'Total alerts must be reset');
    assert.equal(freshState.telemetryStats.avgLatencyMs, 0, 'Avg latency must be reset');
    assert.equal(freshState.isLaunching, false, 'isLaunching reset');
    assert.equal(freshState.isStopping, false, 'isStopping reset');
    console.log('  ✔ Test 8: Fresh run execution reset verified');
  }

  // Test 9: System 2 Model selection and Ollama discovery (R3)
  {
    useScoutStore.getState().setSelectedModel('llama3.2:3b');
    assert.equal(useScoutStore.getState().selectedModel, 'llama3.2:3b');

    // Adding custom model adds to availableModels
    useScoutStore.getState().setSelectedModel('deepseek-r1:14b');
    assert.equal(useScoutStore.getState().selectedModel, 'deepseek-r1:14b');
    assert.equal(useScoutStore.getState().availableModels.includes('deepseek-r1:14b'), true);

    // Setting models list from daemon
    useScoutStore.getState().setModelsList(
      ['qwen2.5:7b-instruct-q4_K_M', 'llama3.2:3b', 'mistral:7b'],
      'mistral:7b',
      true
    );
    assert.equal(useScoutStore.getState().selectedModel, 'mistral:7b');
    assert.equal(useScoutStore.getState().ollamaOnline, true);
    assert.deepEqual(useScoutStore.getState().availableModels, [
      'qwen2.5:7b-instruct-q4_K_M',
      'llama3.2:3b',
      'mistral:7b',
    ]);
    console.log('  ✔ Test 9: System 2 Model selection and Ollama discovery verified');
  }

  // Test 10: Browser snapshot updates (R2)
  {
    const snapshot: BrowserSnapshot = {
      taskId: 'task-live-1',
      timestamp: Date.now(),
      url: 'https://news.ycombinator.com',
      title: 'Hacker News',
      screenshot: 'base64encodedjpegdata...',
      scroll: { x: 0, y: 250, scrollHeight: 2000, viewportHeight: 800 },
    };

    useScoutStore.getState().setLatestSnapshot(snapshot);
    const storedSnapshot = useScoutStore.getState().latestSnapshot;
    assert.notEqual(storedSnapshot, null);
    assert.equal(storedSnapshot?.url, 'https://news.ycombinator.com');
    assert.equal(storedSnapshot?.scroll.y, 250);

    useScoutStore.getState().setLatestSnapshot(null);
    assert.equal(useScoutStore.getState().latestSnapshot, null);
    console.log('  ✔ Test 10: Browser snapshot updates verified');
  }

  // Test 11: Agent actions timeline appending & capping (R2)
  {
    useScoutStore.getState().clearActions();
    assert.equal(useScoutStore.getState().agentActions.length, 0);

    for (let i = 0; i < 250; i++) {
      const action: AgentAction = {
        id: `act-${i}`,
        taskId: 't-agent',
        timestamp: Date.now() + i,
        type: i % 2 === 0 ? 'navigation' : 'extraction',
        status: 'success',
        message: `Action ${i} executed`,
      };
      useScoutStore.getState().addAction(action);
    }

    const actions = useScoutStore.getState().agentActions;
    assert.equal(actions.length, 200, 'Expected actions capped at MAX_ACTION_ITEMS (200)');
    assert.equal(actions[0].id, 'act-249', 'Expected newest action at index 0');

    useScoutStore.getState().clearActions();
    assert.equal(useScoutStore.getState().agentActions.length, 0);
    console.log('  ✔ Test 11: Agent actions timeline appending & capping verified');
  }

  // Test 12: Multi-job state management (R5)
  {
    const sampleJobs: Job[] = [
      {
        id: 'job-1',
        name: 'Hacker News Scout',
        spec: {
          id: 'spec-1',
          name: 'HN Spec',
          userGoal: 'Scout HN',
          targetUrl: 'https://news.ycombinator.com',
          domSelector: '.athing',
          pollIntervalMs: 500,
          scrollStepPx: 300,
          questions: {},
          alertRule: {
            questionKey: 'q',
            operator: 'boolean_true',
            targetValue: true,
            minAnswerConfidence: 0.8,
          },
          createdAt: Date.now(),
        },
        cronSchedule: '*/5 * * * *',
        isScheduled: true,
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'job-2',
        name: 'Reddit LocalLlama Scout',
        spec: {
          id: 'spec-2',
          name: 'Reddit Spec',
          userGoal: 'Scout Reddit',
          targetUrl: 'https://reddit.com/r/LocalLLaMA',
          domSelector: 'shreddit-post',
          pollIntervalMs: 800,
          scrollStepPx: 450,
          questions: {},
          alertRule: {
            questionKey: 'q',
            operator: 'boolean_true',
            targetValue: true,
            minAnswerConfidence: 0.8,
          },
          createdAt: Date.now(),
        },
        cronSchedule: '@hourly',
        isScheduled: false,
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    useScoutStore.getState().setJobs(sampleJobs);
    assert.equal(useScoutStore.getState().jobs.length, 2);

    // Update job status
    useScoutStore.getState().updateJobStatus('job-1', 'running', 'run-test-123');
    const updatedJob = useScoutStore.getState().jobs.find((j) => j.id === 'job-1');
    assert.equal(updatedJob?.status, 'running');
    assert.notEqual(updatedJob?.lastRunAt, undefined);

    // Switch active job
    useScoutStore.getState().setActiveJobId('job-2');
    assert.equal(useScoutStore.getState().activeJobId, 'job-2');

    // Switch active tab
    useScoutStore.getState().setActiveTab('jobs');
    assert.equal(useScoutStore.getState().activeTab, 'jobs');
    console.log('  ✔ Test 12: Multi-job state management verified');
  }

  // Test 13: System performance metrics & history (R6)
  {
    const metrics: SystemPerformanceMetrics = {
      timestamp: Date.now(),
      cpu: { processPercent: 4.5, systemPercent: 12.3 },
      memory: {
        rssBytes: 85 * 1024 * 1024,
        heapUsedBytes: 42 * 1024 * 1024,
        heapTotalBytes: 60 * 1024 * 1024,
        externalBytes: 8 * 1024 * 1024,
        systemFreeBytes: 4000 * 1024 * 1024,
        systemTotalBytes: 16000 * 1024 * 1024,
      },
      eventLoop: { lagMs: 0.85, p99LagMs: 2.1 },
      services: {
        websocket: { name: 'WebSocket', status: 'healthy' },
        database: { name: 'SQLite', status: 'healthy' },
        layaEngine: { name: 'Laya', status: 'healthy' },
        browser: { name: 'Browser', status: 'idle' },
        ollama: { name: 'Ollama', status: 'healthy' },
      },
      activeJobsCount: 1,
    };

    useScoutStore.getState().setMetrics(metrics);
    assert.equal(useScoutStore.getState().metrics?.cpu.processPercent, 4.5);
    assert.equal(useScoutStore.getState().metricsHistory.length, 1);
    console.log('  ✔ Test 13: System performance metrics & history verified');
  }

  // Test 14: Button loading state transitions (R1)
  {
    useScoutStore.getState().setIsLaunching(true);
    assert.equal(useScoutStore.getState().isLaunching, true);

    // When status changes to running, launching state resets
    useScoutStore.getState().setStatus({
      isRunning: true,
      layaReady: true,
      activeTaskId: 'task-test',
    });
    assert.equal(useScoutStore.getState().isLaunching, false);

    // Stopping state
    useScoutStore.getState().setIsStopping(true);
    assert.equal(useScoutStore.getState().isStopping, true);

    // When status changes to stopped, stopping state resets
    useScoutStore.getState().setStatus({
      isRunning: false,
      layaReady: true,
      activeTaskId: null,
    });
    assert.equal(useScoutStore.getState().isStopping, false);
    console.log('  ✔ Test 14: Button loading state transitions verified');
  }

  // Test 15: Full store reset restores all defaults
  {
    useScoutStore.getState().reset();
    const finalState = useScoutStore.getState();
    assert.equal(finalState.activeTab, 'workbench');
    assert.equal(finalState.inferenceFeed.length, 0);
    assert.equal(finalState.alerts.length, 0);
    assert.equal(finalState.agentActions.length, 0);
    assert.equal(finalState.jobs.length, 0);
    assert.equal(finalState.latestSnapshot, null);
    assert.equal(finalState.metrics, null);
    assert.equal(finalState.metricsHistory.length, 0);
    assert.equal(finalState.currentSpec, null);
    assert.equal(finalState.telemetryStats.totalScanned, 0);
    assert.equal(finalState.telemetryStats.avgLatencyMs, 0);
    assert.equal(finalState.isLaunching, false);
    assert.equal(finalState.isStopping, false);
    assert.equal(finalState.resultsMarkdown, '');
    assert.equal(finalState.resultsSummary, '');
    assert.equal(finalState.resultsStats, null);
    assert.equal(finalState.resultsItems.length, 0);
    assert.equal(finalState.resultsLastUpdated, null);
    assert.equal(finalState.chatMessages.length, 0);
    assert.equal(finalState.isChatLoading, false);
    assert.equal(finalState.modelStats, null);
    console.log('  ✔ Test 15: Full store reset verified');
  }

  // Test 16: Defect remediations (null latency handling, job fallback, model sanitization)
  {
    useScoutStore.getState().reset();

    // 1. formatLatency(null as any) returns '0.0 ms' without throwing
    assert.equal(formatLatency(null as any), '0.0 ms');
    assert.equal(formatLatency(undefined as any), '0.0 ms');

    // 2. addInference with latencyMs: null records numeric 0 in latencyHistory
    useScoutStore.getState().addInference({
      id: 'inf-null-test',
      taskId: 't-null',
      timestamp: Date.now(),
      domSnippet: 'null latency snippet',
      latencyMs: null as any,
      rawAnswers: {},
      triggeredAlert: false,
    });
    const history = useScoutStore.getState().telemetryStats.latencyHistory;
    assert.equal(history.length, 1);
    assert.strictEqual(history[0].latencyMs, 0, 'Expected numeric 0 in latencyHistory for null latencyMs');

    // 3. setJobs with an updated list omitting the active job ID causes activeJobId to fall back
    const jobA: Job = {
      id: 'job-a',
      name: 'Job A',
      spec: {
        id: 's-a',
        name: 'Spec A',
        userGoal: 'Goal A',
        targetUrl: 'https://a.com',
        domSelector: 'div',
        pollIntervalMs: 500,
        scrollStepPx: 100,
        questions: {},
        alertRule: { questionKey: 'q', operator: 'boolean_true', targetValue: true, minAnswerConfidence: 0.8 },
        createdAt: Date.now(),
      },
      cronSchedule: '* * * * *',
      isScheduled: false,
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const jobB: Job = {
      id: 'job-b',
      name: 'Job B',
      spec: {
        id: 's-b',
        name: 'Spec B',
        userGoal: 'Goal B',
        targetUrl: 'https://b.com',
        domSelector: 'div',
        pollIntervalMs: 500,
        scrollStepPx: 100,
        questions: {},
        alertRule: { questionKey: 'q', operator: 'boolean_true', targetValue: true, minAnswerConfidence: 0.8 },
        createdAt: Date.now(),
      },
      cronSchedule: '* * * * *',
      isScheduled: false,
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    useScoutStore.getState().setJobs([jobA, jobB]);
    useScoutStore.getState().setActiveJobId('job-b');
    assert.equal(useScoutStore.getState().activeJobId, 'job-b');

    // Remove job-b from list, activeJobId should fall back to job-a (jobs[0]?.id)
    useScoutStore.getState().setJobs([jobA]);
    assert.equal(useScoutStore.getState().activeJobId, 'job-a', 'Expected activeJobId to fall back to jobs[0].id');

    // Clear all jobs, activeJobId should fall back to null
    useScoutStore.getState().setJobs([]);
    assert.equal(useScoutStore.getState().activeJobId, null, 'Expected activeJobId to fall back to null when jobs empty');

    // 4. setSelectedModel('') and setSelectedModel('   ') do not add blank strings to availableModels
    const prevCount = useScoutStore.getState().availableModels.length;
    useScoutStore.getState().setSelectedModel('');
    assert.equal(useScoutStore.getState().availableModels.length, prevCount);
    assert.equal(useScoutStore.getState().availableModels.includes(''), false);

    useScoutStore.getState().setSelectedModel('   ');
    assert.equal(useScoutStore.getState().availableModels.length, prevCount);
    assert.equal(useScoutStore.getState().availableModels.some((m) => m.trim() === ''), false);

    console.log('  ✔ Test 16: Defect remediations (null latency, activeJobId fallback, model sanitization) verified');
  }

  // Test 17: Results state updates and stats aggregation
  {
    useScoutStore.getState().reset();

    const sampleItems: ScrapedItem[] = [
      {
        id: 'item-1',
        timestamp: new Date().toISOString(),
        text: 'Show HN: Local ONNX Classifier',
        link: 'https://news.ycombinator.com/item?id=1',
        answers: { topic: 'local_ai' },
        confidence: 0.95,
        triggeredAlert: true,
      },
      {
        id: 'item-2',
        timestamp: new Date().toISOString(),
        text: 'Ask HN: Favorite Web Dev Stack in 2026',
        link: 'https://news.ycombinator.com/item?id=2',
        answers: { topic: 'web_dev' },
        confidence: 0.88,
        triggeredAlert: false,
      },
    ];

    const sampleStats: ResultStats = {
      totalScanned: 25,
      totalAlerts: 4,
      matchRatePercent: 16.0,
      avgLatencyMs: 42.5,
      topCategories: { local_ai: 4, web_dev: 12, other: 9 },
    };

    useScoutStore.getState().setResults({
      markdown: '# Test Report\n\n- Finding 1\n- Finding 2',
      summary: 'System 2 identified 4 local AI releases.',
      stats: sampleStats,
      items: sampleItems,
      timestamp: '2026-11-14T00:30:00.000Z',
    });

    const state = useScoutStore.getState();
    assert.equal(state.resultsMarkdown, '# Test Report\n\n- Finding 1\n- Finding 2');
    assert.equal(state.resultsSummary, 'System 2 identified 4 local AI releases.');
    assert.equal(state.resultsStats?.totalScanned, 25);
    assert.equal(state.resultsStats?.totalAlerts, 4);
    assert.equal(state.resultsStats?.matchRatePercent, 16.0);
    assert.equal(state.resultsStats?.topCategories.local_ai, 4);
    assert.equal(state.resultsItems.length, 2);
    assert.equal(state.resultsItems[0].id, 'item-1');
    assert.equal(state.resultsLastUpdated, new Date('2026-11-14T00:30:00.000Z').getTime());

    // Partial update: updating only markdown preserves summary, stats, and items
    useScoutStore.getState().setResults({ markdown: '# Updated Report' });
    const updatedState = useScoutStore.getState();
    assert.equal(updatedState.resultsMarkdown, '# Updated Report');
    assert.equal(updatedState.resultsSummary, 'System 2 identified 4 local AI releases.');
    assert.equal(updatedState.resultsStats?.totalScanned, 25);
    assert.equal(updatedState.resultsItems.length, 2);

    console.log('  ✔ Test 17: Results state updates and partial updates verified');
  }

  // Test 18: Chat message appending, loading flag toggle, and clear action
  {
    useScoutStore.getState().reset();
    assert.equal(useScoutStore.getState().chatMessages.length, 0);
    assert.equal(useScoutStore.getState().isChatLoading, false);

    // Add User Query
    useScoutStore.getState().addChatMessage({
      id: 'msg-u1',
      role: 'user',
      type: 'query',
      content: 'Summarize top findings',
      timestamp: Date.now(),
    });
    useScoutStore.getState().setChatLoading(true);

    let state = useScoutStore.getState();
    assert.equal(state.chatMessages.length, 1);
    assert.equal(state.chatMessages[0].role, 'user');
    assert.equal(state.chatMessages[0].type, 'query');
    assert.equal(state.chatMessages[0].content, 'Summarize top findings');
    assert.equal(state.isChatLoading, true);

    // Add Assistant Response
    useScoutStore.getState().addChatMessage({
      id: 'msg-a1',
      role: 'assistant',
      type: 'query',
      content: 'Here are the top findings: ...',
      timestamp: Date.now(),
      meta: { model: 'qwen2.5:7b-instruct-q4_K_M' },
    });
    useScoutStore.getState().setChatLoading(false);

    state = useScoutStore.getState();
    assert.equal(state.chatMessages.length, 2);
    assert.equal(state.chatMessages[1].role, 'assistant');
    assert.equal(state.chatMessages[1].meta?.model, 'qwen2.5:7b-instruct-q4_K_M');
    assert.equal(state.isChatLoading, false);

    // Add Steering Directive
    useScoutStore.getState().addChatMessage({
      id: 'msg-u2',
      role: 'user',
      type: 'steer',
      content: 'Scroll faster (+200px)',
      timestamp: Date.now(),
    });
    useScoutStore.getState().addChatMessage({
      id: 'msg-a2',
      role: 'assistant',
      type: 'steer',
      content: 'Increased scroll step to 500px.',
      timestamp: Date.now(),
      meta: { applied: true, explanation: 'Updated scrollStepPx to 500' },
    });

    state = useScoutStore.getState();
    assert.equal(state.chatMessages.length, 4);
    assert.equal(state.chatMessages[3].meta?.applied, true);

    // Clear messages
    useScoutStore.getState().clearChatMessages();
    assert.equal(useScoutStore.getState().chatMessages.length, 0);

    console.log('  ✔ Test 18: Chat message stream, steering meta, and clearing verified');
  }

  // Test 19: Model stats lifecycle state updates
  {
    useScoutStore.getState().reset();
    assert.equal(useScoutStore.getState().modelStats, null);

    const sampleModelStats: ModelStats = {
      systemOne: {
        modelName: 'modernbert-onnx-int8',
        format: 'int8',
        provider: 'dml',
        device: 'DirectML (Intel Iris Xe)',
        status: 'ready',
        avgLatencyMs: 14.8,
      },
      systemTwo: {
        modelName: 'qwen2.5:7b-instruct-q4_K_M',
        availableModels: ['qwen2.5:7b-instruct-q4_K_M', 'llama3.2:3b'],
        status: 'ready',
        vramUsageMb: 4250,
        gpuOffloaded: true,
      },
    };

    useScoutStore.getState().setModelStats(sampleModelStats);
    const state = useScoutStore.getState();
    assert.notEqual(state.modelStats, null);
    assert.equal(state.modelStats?.systemOne.modelName, 'modernbert-onnx-int8');
    assert.equal(state.modelStats?.systemOne.format, 'int8');
    assert.equal(state.modelStats?.systemOne.provider, 'dml');
    assert.equal(state.modelStats?.systemOne.status, 'ready');
    assert.equal(state.modelStats?.systemOne.avgLatencyMs, 14.8);
    assert.equal(state.modelStats?.systemTwo.modelName, 'qwen2.5:7b-instruct-q4_K_M');
    assert.equal(state.modelStats?.systemTwo.status, 'ready');
    assert.equal(state.modelStats?.systemTwo.vramUsageMb, 4250);
    assert.equal(state.modelStats?.systemTwo.gpuOffloaded, true);

    // Update with loading / error status
    useScoutStore.getState().setModelStats({
      ...sampleModelStats,
      systemTwo: {
        ...sampleModelStats.systemTwo,
        status: 'loading',
      },
    });
    assert.equal(useScoutStore.getState().modelStats?.systemTwo.status, 'loading');

    console.log('  ✔ Test 19: Dual-brain model stats and lifecycle transitions verified');
  }

  // Test 20: Tab navigation to results tab
  {
    useScoutStore.getState().reset();
    assert.equal(useScoutStore.getState().activeTab, 'workbench');

    useScoutStore.getState().setActiveTab('results');
    assert.equal(useScoutStore.getState().activeTab, 'results');

    useScoutStore.getState().setActiveTab('jobs');
    assert.equal(useScoutStore.getState().activeTab, 'jobs');

    useScoutStore.getState().setActiveTab('status');
    assert.equal(useScoutStore.getState().activeTab, 'status');

    useScoutStore.getState().setActiveTab('workbench');
    assert.equal(useScoutStore.getState().activeTab, 'workbench');

    console.log('  ✔ Test 20: Tab navigation to results and other tabs verified');
  }

  // Test 21: Fresh run execution reset and store reset verification
  {
    useScoutStore.getState().reset();

    // Populate transient data across feeds, actions, results, and chat
    useScoutStore.getState().addInference({
      id: 'inf-fresh-1',
      taskId: 't-1',
      timestamp: Date.now(),
      domSnippet: 'sample',
      latencyMs: 20,
      rawAnswers: {},
      triggeredAlert: true,
    });
    useScoutStore.getState().addAction({
      id: 'act-fresh-1',
      taskId: 't-1',
      timestamp: Date.now(),
      type: 'stagnation_detected',
      status: 'warning',
      message: 'Browser crawler stagnant at bottom of page',
      details: { stuckReason: 'page_bottom', consecutiveEmptyCycles: 3 },
    });
    useScoutStore.getState().setResults({
      markdown: '# Run 1 Results',
      summary: 'Run 1 summary',
      items: [{ id: 'i-1', text: 't1', answers: {}, confidence: 0.9, triggeredAlert: false, timestamp: '' }],
    });
    useScoutStore.getState().addChatMessage({
      id: 'c-1',
      role: 'user',
      type: 'query',
      content: 'hello',
      timestamp: Date.now(),
    });

    assert.equal(useScoutStore.getState().inferenceFeed.length, 1);
    assert.equal(useScoutStore.getState().agentActions.length, 1);
    assert.equal(useScoutStore.getState().resultsItems.length, 1);
    assert.equal(useScoutStore.getState().chatMessages.length, 1);

    // Call startFreshRun()
    useScoutStore.getState().startFreshRun();
    const freshState = useScoutStore.getState();
    assert.equal(freshState.inferenceFeed.length, 0);
    assert.equal(freshState.alerts.length, 0);
    assert.equal(freshState.agentActions.length, 0);
    assert.equal(freshState.resultsMarkdown, '');
    assert.equal(freshState.resultsSummary, '');
    assert.equal(freshState.resultsStats, null);
    assert.equal(freshState.resultsItems.length, 0);
    assert.equal(freshState.resultsLastUpdated, null);
    assert.equal(freshState.chatMessages.length, 0);
    assert.equal(freshState.isChatLoading, false);

    console.log('  ✔ Test 21: Fresh run execution reset clears results and chat state verified');
  }

  // Test 22: Remediation - RFC 4180 CSV export escaping & chatLoading reset on disconnect/send failure
  {
    useScoutStore.getState().reset();

    // 1. CSV export escaping for items containing URLs with commas and quotes (RFC 4180)
    const complexItems: ScrapedItem[] = [
      {
        id: 'item-1',
        timestamp: '2026-11-14T00:00:00.000Z',
        triggeredAlert: false,
        confidence: 0.9,
        answers: { tag: 'ai,ml', rank: 1 },
        link: 'https://example.com/search?q=ai,ml&sort=date,desc',
        text: 'Valid snippet text with simple words',
      },
      {
        id: 'item-"2",with,commas',
        timestamp: '2026-11-14T00:01:00.000Z',
        triggeredAlert: true,
        confidence: 0.9876,
        answers: { quote: 'He said "Hello, World!"', nested: { a: 'b,c' } },
        link: 'https://maps.google.com/?ll=40.7128,-74.0060&query="New+York,NY"',
        text: 'Snippet\nwith newline and "embedded quotes" and, commas, everywhere',
      },
      {
        id: 'item-3-minimal',
        timestamp: '2026-11-14T00:02:00.000Z',
        triggeredAlert: false,
        confidence: undefined as unknown as number,
        answers: undefined as any,
        link: undefined,
        text: undefined as unknown as string,
      },
    ];

    // Helper RFC 4180 CSV parser
    const parseCsvRow = (row: string): string[] => {
      const fields: string[] = [];
      let current = '';
      let inQuotes = false;
      let i = 0;
      while (i < row.length) {
        const char = row[i];
        if (inQuotes) {
          if (char === '"') {
            if (i + 1 < row.length && row[i + 1] === '"') {
              current += '"';
              i += 2;
              continue;
            } else {
              inQuotes = false;
              i++;
              continue;
            }
          } else {
            current += char;
            i++;
            continue;
          }
        } else {
          if (char === '"') {
            inQuotes = true;
            i++;
            continue;
          } else if (char === ',') {
            fields.push(current);
            current = '';
            i++;
            continue;
          } else {
            current += char;
            i++;
            continue;
          }
        }
      }
      fields.push(current);
      return fields;
    };

    const fullCsv = formatResultsAsCsv(complexItems);
    const csvLines = fullCsv.split('\n');
    assert.equal(csvLines.length, 4, 'Expected header + 3 data rows in CSV');

    const headerCols = parseCsvRow(csvLines[0]);
    assert.equal(headerCols.length, 7, 'Expected 7 header columns');
    assert.deepEqual(headerCols, ['ID', 'Timestamp', 'TriggeredAlert', 'Confidence', 'Answers', 'Link', 'Snippet']);

    for (let idx = 0; idx < complexItems.length; idx++) {
      const item = complexItems[idx];
      const rowStr = csvLines[idx + 1];
      const rowFromFn = formatItemAsCsvRow(item);
      assert.equal(rowStr, rowFromFn, 'formatResultsAsCsv row must match formatItemAsCsvRow');

      // Assert strict 7-column parsing
      const parsedFields = parseCsvRow(rowStr);
      assert.equal(
        parsedFields.length,
        7,
        `Expected exactly 7 columns in row ${idx + 1}, got ${parsedFields.length}. Row: ${rowStr}`
      );

      // Verify each column matches RFC 4180 unescaped values
      assert.equal(parsedFields[0], item.id || '', 'ID column mismatch');
      assert.equal(parsedFields[1], item.timestamp, 'Timestamp column mismatch');
      assert.equal(parsedFields[2], item.triggeredAlert ? 'YES' : 'NO', 'TriggeredAlert column mismatch');
      assert.equal(parsedFields[3], (item.confidence ?? 0).toFixed(2), 'Confidence column mismatch');
      assert.deepEqual(JSON.parse(parsedFields[4]), item.answers || {}, 'Answers JSON mismatch');
      assert.equal(parsedFields[5], item.link || '', 'Link column mismatch (commas or quotes corrupted)');
      assert.equal(parsedFields[6], (item.text || '').replace(/\r?\n/g, ' '), 'Snippet column mismatch');

      // Also verify regex-based comma splitting respecting quotes produces 7 columns
      const regexSplit = rowStr.split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/);
      assert.equal(regexSplit.length, 7, `Regex split on row ${idx + 1} did not yield 7 columns`);
    }

    // 2. Disconnect (`setConnected(false)`) resets `isChatLoading: false`
    useScoutStore.getState().setConnected(true);
    useScoutStore.getState().setChatLoading(true);
    assert.equal(useScoutStore.getState().isChatLoading, true);

    useScoutStore.getState().setConnected(false);
    assert.equal(
      useScoutStore.getState().isChatLoading,
      false,
      'Expected isChatLoading reset to false on disconnect'
    );
    assert.equal(useScoutStore.getState().wsConnected, false);

    // 3. wsClient.send failure resets isChatLoading immediately
    assert.equal(wsClient.isConnected(), false, 'Expected wsClient disconnected in test environment');

    // queryResults while disconnected
    const querySent = wsClient.queryResults('What is the summary of recent scans?');
    assert.equal(querySent, false, 'Expected queryResults to return false when disconnected');
    assert.equal(
      useScoutStore.getState().isChatLoading,
      false,
      'Expected isChatLoading reset to false when queryResults send fails'
    );

    // steerTask while disconnected
    const steerSent = wsClient.steerTask('Scroll 300px down');
    assert.equal(steerSent, false, 'Expected steerTask to return false when disconnected');
    assert.equal(
      useScoutStore.getState().isChatLoading,
      false,
      'Expected isChatLoading reset to false when steerTask send fails'
    );

    console.log('  ✔ Test 22: RFC 4180 CSV export escaping and isChatLoading disconnect/failure reset verified');
  }

  // Test 23: Wizard navigation setPage sets page and clamps to [1, 4]
  {
    useScoutStore.getState().reset();
    assert.equal(useScoutStore.getState().currentPage, 1, 'Initial page should be 1');

    useScoutStore.getState().setPage(2);
    assert.equal(useScoutStore.getState().currentPage, 2, 'Should advance to page 2');

    useScoutStore.getState().setPage(3);
    assert.equal(useScoutStore.getState().currentPage, 3, 'Should advance to page 3');

    useScoutStore.getState().setPage(4);
    assert.equal(useScoutStore.getState().currentPage, 4, 'Should advance to page 4');

    // Clamping lower bound
    useScoutStore.getState().setPage(0);
    assert.equal(useScoutStore.getState().currentPage, 1, 'setPage(0) should clamp to 1');

    useScoutStore.getState().setPage(-10);
    assert.equal(useScoutStore.getState().currentPage, 1, 'setPage(-10) should clamp to 1');

    // Clamping upper bound
    useScoutStore.getState().setPage(5);
    assert.equal(useScoutStore.getState().currentPage, 4, 'setPage(5) should clamp to 4');

    useScoutStore.getState().setPage(99);
    assert.equal(useScoutStore.getState().currentPage, 4, 'setPage(99) should clamp to 4');

    console.log('  ✔ Test 23: Wizard navigation setPage and clamping to [1, 4] verified');
  }

  // Test 24: Wizard navigation nextPage increments up to 4
  {
    useScoutStore.getState().reset();
    assert.equal(useScoutStore.getState().currentPage, 1);

    useScoutStore.getState().nextPage();
    assert.equal(useScoutStore.getState().currentPage, 2, 'nextPage() from 1 should yield 2');

    useScoutStore.getState().nextPage();
    assert.equal(useScoutStore.getState().currentPage, 3, 'nextPage() from 2 should yield 3');

    useScoutStore.getState().nextPage();
    assert.equal(useScoutStore.getState().currentPage, 4, 'nextPage() from 3 should yield 4');

    // Clamped at 4
    useScoutStore.getState().nextPage();
    assert.equal(useScoutStore.getState().currentPage, 4, 'nextPage() from 4 should stay 4');

    console.log('  ✔ Test 24: Wizard navigation nextPage up to 4 verified');
  }

  // Test 25: Wizard navigation prevPage decrements down to 1
  {
    useScoutStore.getState().reset();
    useScoutStore.getState().setPage(4);
    assert.equal(useScoutStore.getState().currentPage, 4);

    useScoutStore.getState().prevPage();
    assert.equal(useScoutStore.getState().currentPage, 3, 'prevPage() from 4 should yield 3');

    useScoutStore.getState().prevPage();
    assert.equal(useScoutStore.getState().currentPage, 2, 'prevPage() from 3 should yield 2');

    useScoutStore.getState().prevPage();
    assert.equal(useScoutStore.getState().currentPage, 1, 'prevPage() from 2 should yield 1');

    // Clamped at 1
    useScoutStore.getState().prevPage();
    assert.equal(useScoutStore.getState().currentPage, 1, 'prevPage() from 1 should stay 1');

    console.log('  ✔ Test 25: Wizard navigation prevPage down to 1 verified');
  }

  // Test 26: reset() resets currentPage to 1
  {
    useScoutStore.getState().reset();
    useScoutStore.getState().setPage(3);
    assert.equal(useScoutStore.getState().currentPage, 3);

    useScoutStore.getState().reset();
    assert.equal(useScoutStore.getState().currentPage, 1, 'reset() must reset currentPage to 1');
    assert.equal(useScoutStore.getState().canResume, false, 'reset() must reset canResume to false');
    assert.equal(useScoutStore.getState().lastCheckpoint, undefined, 'reset() must reset lastCheckpoint to undefined');

    console.log('  ✔ Test 26: reset() resets currentPage to 1 verified');
  }

  // Test 27: lastCheckpoint and canResume state handling and resumeTask() transitions to Page 3
  {
    useScoutStore.getState().reset();
    assert.equal(useScoutStore.getState().canResume, false);
    assert.equal(useScoutStore.getState().lastCheckpoint, undefined);

    const sampleCheckpoint: TaskCheckpoint = {
      id: 'chk-test-001',
      taskId: 'task-test-resume',
      runId: 'run-resume-1',
      createdAt: Date.now() - 5000,
      updatedAt: Date.now(),
      status: 'paused',
      targetUrl: 'https://news.ycombinator.com',
      currentUrl: 'https://news.ycombinator.com',
      pageTitle: 'Hacker News',
      scroll: { y: 300, scrollHeight: 2000, viewportHeight: 800 },
      totalScanned: 15,
      totalAlerts: 2,
      activeStepCount: 5,
      dedupHashes: ['h1', 'h2'],
      wizardState: { currentPage: 3, userGoal: 'Monitor AI stories' },
    };

    // When status receives lastCheckpoint and isRunning is false -> canResume: true
    useScoutStore.getState().setStatus({
      isRunning: false,
      layaReady: true,
      activeTaskId: 'task-test-resume',
      lastCheckpoint: sampleCheckpoint,
    });
    assert.equal(useScoutStore.getState().canResume, true, 'canResume should be true when lastCheckpoint present and idle');
    assert.deepEqual(useScoutStore.getState().lastCheckpoint, sampleCheckpoint);

    // When task starts running -> canResume: false
    useScoutStore.getState().setStatus({
      isRunning: true,
      layaReady: true,
      activeTaskId: 'task-test-resume',
    });
    assert.equal(useScoutStore.getState().canResume, false, 'canResume should be false while isRunning');

    // When task stops again -> canResume: true
    useScoutStore.getState().setStatus({
      isRunning: false,
      layaReady: true,
      activeTaskId: null,
    });
    assert.equal(useScoutStore.getState().canResume, true, 'canResume should be true after stopping');

    // Test resumeTask() transitions to Page 3
    useScoutStore.getState().setPage(1);
    assert.equal(useScoutStore.getState().currentPage, 1);

    await useScoutStore.getState().resumeTask('task-test-resume', 'chk-test-001');
    assert.equal(useScoutStore.getState().currentPage, 3, 'resumeTask() should set currentPage to 3');

    console.log('  ✔ Test 27: lastCheckpoint and canResume handling and resumeTask() transitions to Page 3 verified');
  }

  console.log('✅ All useScoutStore unit tests PASSED successfully!\n');
}

runTests().catch((err) => {
  console.error('Fatal error in tests:', err);
  process.exit(1);
});
