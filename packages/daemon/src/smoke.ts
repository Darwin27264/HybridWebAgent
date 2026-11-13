/**
 * Daemon Smoke Verification Test Script
 * Verifies that @receptron/laya executes a single non-autoregressive forward pass
 * on native ONNX Runtime CPU and returns valid calibrated answer_confidence in [0, 1].
 */
import assert from 'node:assert/strict';
import { LayaEngine, sanitizeStateSnippet } from './engine/layaEngine.js';
import type { CompiledTaskSpec } from '@ofln-scout/shared';

async function runSmoke() {
  console.log('[Smoke Test] Initializing LayaEngine on ONNX Runtime CPU...');
  const engine = new LayaEngine();
  const ready = await engine.initialize();
  console.log(`[Smoke Test] Engine initialized: ready=${ready}`);

  const testSpec: CompiledTaskSpec = {
    id: 'smoke-test-task',
    name: 'Smoke Verification Task',
    userGoal: 'Verify single forward-pass System 1 inference',
    targetUrl: 'https://news.ycombinator.com',
    domSelector: '.athing',
    pollIntervalMs: 500,
    scrollStepPx: 300,
    questions: {
      topic: {
        type: 'choice',
        question: 'What is the topic of this post?',
        options: ['local_ai', 'web_dev', 'crypto', 'other']
      },
      is_ai: {
        type: 'noul',
        statement: 'This post announces or discusses AI, machine learning, or ONNX.'
      }
    },
    alertRule: {
      questionKey: 'topic',
      operator: 'equals',
      targetValue: 'local_ai',
      minAnswerConfidence: 0.80
    },
    createdAt: Date.now()
  };

  const sampleSnippet = sanitizeStateSnippet(
    'Show HN: Laya – Fast non-autoregressive decision model on ONNX Runtime CPU'
  );

  console.log('[Smoke Test] Evaluating candidate DOM snippet in single forward pass...');
  const telemetry = await engine.evaluateDomBatch(sampleSnippet, testSpec);

  console.log('[Smoke Test] Telemetry received:');
  console.log(JSON.stringify(telemetry, null, 2));

  assert.ok(telemetry.id, 'telemetry.id must be defined');
  assert.equal(telemetry.taskId, testSpec.id, 'telemetry.taskId must match spec.id');
  assert.ok(typeof telemetry.latencyMs === 'number', 'telemetry.latencyMs must be number');
  assert.ok(telemetry.latencyMs >= 0, 'latency must be non-negative');

  const topicAns = telemetry.rawAnswers['topic'];
  assert.ok(topicAns, 'topic answer must be present');
  assert.ok(
    topicAns.answer_confidence >= 0 && topicAns.answer_confidence <= 1,
    `topic answer_confidence must be in [0, 1], got ${topicAns.answer_confidence}`
  );

  const isAiAns = telemetry.rawAnswers['is_ai'];
  assert.ok(isAiAns, 'is_ai answer must be present');
  assert.ok(
    isAiAns.answer_confidence >= 0 && isAiAns.answer_confidence <= 1,
    `is_ai answer_confidence must be in [0, 1], got ${isAiAns.answer_confidence}`
  );

  assert.equal(typeof telemetry.triggeredAlert, 'boolean', 'triggeredAlert must be boolean');

  await engine.close();
  console.log('\n✔ Smoke verification passed: System 1 forward pass and answer_confidence verified!\n');
}

runSmoke().catch((err) => {
  console.error('[Smoke Test] FAILED:', err);
  process.exit(1);
});
