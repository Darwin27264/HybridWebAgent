import assert from 'node:assert/strict';
import { useScoutStore, formatLatency } from './useScoutStore';
import type {
  CompiledTaskSpec,
  InferenceTelemetryItem,
  Job,
  AgentAction,
  BrowserSnapshot,
  SystemPerformanceMetrics,
} from '@ofln-scout/shared';

function runTests() {
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

  console.log('✅ All useScoutStore unit tests PASSED successfully!\n');
}

runTests();
