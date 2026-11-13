import assert from 'node:assert/strict';
import type {
  LayaPrimitiveType,
  LayaChoiceQuestion,
  LayaNoulQuestion,
  LayaScoreQuestion,
  LayaQuestionMap,
  AlertRule,
  CompiledTaskSpec,
  InferenceTelemetryItem,
  WsClientToServerMessage,
  WsServerToClientMessage,
  SystemTwoSteeringAction,
  HandoverContext,
  ModelLoadingStatus,
  ModelStats,
  ScrapedItem,
  ResultStats,
} from '../src/index.js';

console.log('Verifying @ofln-scout/shared type contracts...');

// Test 1: LayaPrimitiveType
const primChoice: LayaPrimitiveType = 'choice';
const primNoul: LayaPrimitiveType = 'noul';
const primScore: LayaPrimitiveType = 'score';
assert.equal(primChoice, 'choice');
assert.equal(primNoul, 'noul');
assert.equal(primScore, 'score');

// Test 2: LayaChoiceQuestion
const choiceQ: LayaChoiceQuestion = {
  type: 'choice',
  question: 'Is this post relevant to AI agents?',
  options: ['yes', 'no', 'uncertain'],
};
assert.equal(choiceQ.type, 'choice');
assert.equal(choiceQ.question, 'Is this post relevant to AI agents?');
assert.deepEqual(choiceQ.options, ['yes', 'no', 'uncertain']);

// Test 3: LayaNoulQuestion
const noulQ: LayaNoulQuestion = {
  type: 'noul',
  statement: 'The post announces a new open-source AI project.',
};
assert.equal(noulQ.type, 'noul');
assert.ok(noulQ.statement.includes('open-source'));

// Test 4: LayaScoreQuestion
const scoreQ: LayaScoreQuestion = {
  type: 'score',
  question: 'Rate the technical novelty of this submission from 1 to 5',
  rubric: {
    1: 'trivial or spam',
    2: 'minor incremental update',
    3: 'solid standard implementation',
    4: 'significant technical innovation',
    5: 'breakthrough methodology',
  },
};
assert.equal(scoreQ.type, 'score');
assert.equal(scoreQ.rubric[5], 'breakthrough methodology');

// Test 5: LayaQuestionMap
const questions: LayaQuestionMap = {
  is_relevant: choiceQ,
  is_novel: noulQ,
  novelty_score: scoreQ,
};
assert.equal(Object.keys(questions).length, 3);
assert.equal(questions.is_relevant.type, 'choice');

// Test 6: AlertRule
const alertRule: AlertRule = {
  questionKey: 'is_relevant',
  operator: 'equals',
  targetValue: 'yes',
  minAnswerConfidence: 0.85,
};
assert.equal(alertRule.questionKey, 'is_relevant');
assert.equal(alertRule.operator, 'equals');
assert.equal(alertRule.targetValue, 'yes');
assert.equal(alertRule.minAnswerConfidence, 0.85);

// Test 7: CompiledTaskSpec
const spec: CompiledTaskSpec = {
  id: 'task_hn_001',
  name: 'Hacker News AI Scout',
  userGoal: 'Scout top Show HN posts discussing local LLMs or offline AI',
  targetUrl: 'https://news.ycombinator.com/show',
  domSelector: '.athing',
  pollIntervalMs: 2500,
  scrollStepPx: 400,
  questions,
  alertRule,
  createdAt: Date.now(),
};
assert.equal(spec.id, 'task_hn_001');
assert.equal(spec.alertRule.minAnswerConfidence, 0.85);

// Test 8: InferenceTelemetryItem
const telemetry: InferenceTelemetryItem = {
  id: 'item_001',
  taskId: spec.id,
  timestamp: Date.now(),
  domSnippet: '<tr class="athing"><td>Show HN: Ofln-Scout local orchestrator</td></tr>',
  latencyMs: 38.5,
  rawAnswers: {
    is_relevant: {
      answer: 'yes',
      answer_confidence: 0.942,
      confidence: 0.88,
      distribution: { yes: 0.942, no: 0.058 },
    },
  },
  triggeredAlert: true,
};
assert.equal(telemetry.triggeredAlert, true);
assert.equal(telemetry.rawAnswers.is_relevant.answer_confidence, 0.942);

// Test 9: WsClientToServerMessage
const clientMessages: WsClientToServerMessage[] = [
  { type: 'COMPILE_TASK', payload: { userGoal: 'Find offline LLM posts' } },
  { type: 'START_TASK', payload: { spec } },
  { type: 'STOP_TASK' },
  { type: 'CLEAR_ALERTS' },
];
assert.equal(clientMessages.length, 4);
assert.equal(clientMessages[0].type, 'COMPILE_TASK');
assert.equal(clientMessages[2].type, 'STOP_TASK');

// Test 10: WsServerToClientMessage
const serverMessages: WsServerToClientMessage[] = [
  { type: 'DAEMON_STATUS', payload: { isRunning: true, layaReady: true, activeTaskId: spec.id } },
  { type: 'COMPILATION_PROGRESS', payload: { status: 'ready', message: 'Spec compiled successfully', spec } },
  { type: 'INFERENCE_EVENT', payload: telemetry },
  { type: 'ALERT_MATCH', payload: telemetry },
];
assert.equal(serverMessages.length, 4);
assert.equal(serverMessages[0].type, 'DAEMON_STATUS');
assert.equal(serverMessages[3].type, 'ALERT_MATCH');

// Test 11: SystemTwoSteeringAction
const steeringActions: SystemTwoSteeringAction[] = [
  { action: 'paginate', selector: 'button.next-page', text: 'Next' },
  { action: 'navigate', url: 'https://news.ycombinator.com/news?p=2' },
  { action: 'switch_tab', tabIndex: 1, url: 'https://news.ycombinator.com' },
  { action: 'adjust_strategy', newSelector: 'tr.athing', scrollStepPx: 500 },
  { action: 'terminate', reason: 'goal_completed', message: 'All target items gathered' },
];
assert.equal(steeringActions.length, 5);
assert.equal(steeringActions[0].action, 'paginate');
assert.equal(steeringActions[4].action, 'terminate');
if (steeringActions[4].action === 'terminate') {
  assert.equal(steeringActions[4].reason, 'goal_completed');
}

// Test 12: HandoverContext
const handoverCtx: HandoverContext = {
  taskId: 'task-test-01',
  runId: 'run-test-01',
  userGoal: 'Find all AI posts',
  targetUrl: 'https://news.ycombinator.com',
  currentUrl: 'https://news.ycombinator.com/news?p=3',
  pageTitle: 'Hacker News',
  stuckReason: 'bottom_of_page',
  scrollState: {
    y: 2400,
    scrollHeight: 2400,
    viewportHeight: 800,
  },
  totalScanned: 60,
  totalAlerts: 5,
  consecutiveEmptyCycles: 3,
  interactiveElements: [
    { selector: 'a.morelink', text: 'More', href: 'https://news.ycombinator.com/news?p=4', tag: 'a' },
  ],
};
assert.equal(handoverCtx.taskId, 'task-test-01');
assert.equal(handoverCtx.stuckReason, 'bottom_of_page');
assert.equal(handoverCtx.interactiveElements.length, 1);
assert.equal(handoverCtx.interactiveElements[0].tag, 'a');

// Test 13: ModelLoadingStatus
const statuses: ModelLoadingStatus[] = ['idle', 'loading', 'ready', 'error'];
assert.equal(statuses.length, 4);
assert.deepEqual(statuses, ['idle', 'loading', 'ready', 'error']);

// Test 14: ModelStats
const modelStats: ModelStats = {
  systemOne: {
    modelName: 'Laya ModernBERT',
    format: 'fp32',
    provider: 'webgpu',
    device: 'NVIDIA GeForce RTX 4090',
    status: 'ready',
    avgLatencyMs: 12.4,
  },
  systemTwo: {
    modelName: 'qwen2.5',
    availableModels: ['qwen2.5', 'llama3.2'],
    status: 'ready',
    vramUsageMb: 4200,
    gpuOffloaded: true,
  },
};
assert.equal(modelStats.systemOne.status, 'ready');
assert.equal(modelStats.systemOne.provider, 'webgpu');
assert.equal(modelStats.systemTwo.gpuOffloaded, true);

// Test 15: ScrapedItem
const scrapedItem: ScrapedItem = {
  id: 'scrape-001',
  timestamp: '2026-11-12T15:00:00.000Z',
  text: 'Show HN: Local offline scout agent',
  link: 'https://news.ycombinator.com/item?id=123',
  answers: { is_relevant: 'yes', topic: 'ai' },
  confidence: 0.95,
  triggeredAlert: true,
};
assert.equal(scrapedItem.id, 'scrape-001');
assert.equal(scrapedItem.confidence, 0.95);
assert.equal(scrapedItem.triggeredAlert, true);
assert.equal(scrapedItem.link, 'https://news.ycombinator.com/item?id=123');

// Test 16: ResultStats
const resultStats: ResultStats = {
  totalScanned: 50,
  totalAlerts: 10,
  matchRatePercent: 20.0,
  avgLatencyMs: 14.2,
  topCategories: { ai: 8, tools: 2 },
};
assert.equal(resultStats.totalScanned, 50);
assert.equal(resultStats.totalAlerts, 10);
assert.equal(resultStats.matchRatePercent, 20.0);
assert.equal(resultStats.topCategories.ai, 8);

// Test 17: WsClientToServerMessage results and steering extensions
const extendedClientMsgs: WsClientToServerMessage[] = [
  { type: 'QUERY_RESULTS', payload: { query: 'How many AI articles found?', taskId: 'task-test-01' } },
  { type: 'STEER_TASK', payload: { instruction: 'Increase scroll speed to 600px', taskId: 'task-test-01' } },
  { type: 'GET_RESULTS', payload: { taskId: 'task-test-01' } },
];
assert.equal(extendedClientMsgs.length, 3);
assert.equal(extendedClientMsgs[0].type, 'QUERY_RESULTS');
assert.equal(extendedClientMsgs[1].type, 'STEER_TASK');
assert.equal(extendedClientMsgs[2].type, 'GET_RESULTS');

// Test 18: WsServerToClientMessage results and steering extensions
const extendedServerMsgs: WsServerToClientMessage[] = [
  {
    type: 'QUERY_RESULTS_RESPONSE',
    payload: {
      query: 'How many AI articles found?',
      answer: 'Found 10 matching articles.',
      timestamp: '2026-11-12T15:01:00.000Z',
      model: 'qwen2.5',
    },
  },
  {
    type: 'STEER_TASK_RESPONSE',
    payload: {
      instruction: 'Increase scroll speed to 600px',
      explanation: 'Updated scroll step to 600px.',
      applied: true,
      timestamp: '2026-11-12T15:01:05.000Z',
    },
  },
  {
    type: 'RESULTS_UPDATE',
    payload: {
      markdown: '# Results\n\n- Scanned 50 items',
      summary: 'Executive summary text',
      stats: resultStats,
      items: [scrapedItem],
      timestamp: '2026-11-12T15:01:10.000Z',
    },
  },
  {
    type: 'MODEL_STATS',
    payload: modelStats,
  },
];
assert.equal(extendedServerMsgs.length, 4);
assert.equal(extendedServerMsgs[0].type, 'QUERY_RESULTS_RESPONSE');
assert.equal(extendedServerMsgs[1].type, 'STEER_TASK_RESPONSE');
assert.equal(extendedServerMsgs[2].type, 'RESULTS_UPDATE');
assert.equal(extendedServerMsgs[3].type, 'MODEL_STATS');

console.log('✓ All @ofln-scout/shared type contracts verified successfully.');
