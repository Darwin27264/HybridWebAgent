import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  LayaEngine,
  sanitizeStateSnippet,
  mapQuestionsToLaya,
  evaluateAlertRule,
  HARDWARE_LADDERS,
  getProviderLadder,
  getDeviceNameForProvider
} from '../src/engine/layaEngine.js';
import type { CompiledTaskSpec, AlertRule } from '@ofln-scout/shared';

describe('System 1 Decision Engine (Unit & Integration)', () => {
  let engine: LayaEngine;

  const testSpec: CompiledTaskSpec = {
    id: 'test-laya-task-1',
    name: 'HN Test Task',
    userGoal: 'Identify local AI and ONNX posts',
    targetUrl: 'https://news.ycombinator.com',
    domSelector: '.athing',
    pollIntervalMs: 800,
    scrollStepPx: 400,
    questions: {
      topic: {
        type: 'choice',
        question: 'What is the topic of this post?',
        options: ['local_ai', 'web_dev', 'crypto', 'other']
      },
      is_ai_post: {
        type: 'noul',
        statement: 'This post announces or discusses AI, machine learning, or ONNX.'
      },
      quality_score: {
        type: 'score',
        question: 'Rate the technical depth of this project',
        rubric: { 1: 'trivial', 2: 'basic', 3: 'detailed', 4: 'production-grade' }
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

  before(async () => {
    engine = new LayaEngine();
    await engine.initialize();
  });

  after(async () => {
    if (engine) {
      await engine.close();
    }
  });

  describe('sanitizeStateSnippet', () => {
    it('collapses multiple whitespace characters and newlines', () => {
      const raw = '  Show   HN:  \n\t Local   ONNX   Engine   ';
      const clean = sanitizeStateSnippet(raw);
      assert.equal(clean, 'Show HN: Local ONNX Engine');
    });

    it('strictly truncates snippet to <= 460 characters', () => {
      const longRaw = 'word '.repeat(150);
      const clean = sanitizeStateSnippet(longRaw);
      assert.ok(clean.length <= 460, `Length ${clean.length} must be <= 460`);
    });

    it('handles empty or non-string inputs safely', () => {
      assert.equal(sanitizeStateSnippet(''), '');
      assert.equal(sanitizeStateSnippet(null as any), '');
      assert.equal(sanitizeStateSnippet(undefined as any), '');
    });
  });

  describe('mapQuestionsToLaya', () => {
    it('maps choice, noul, and score questions to @receptron/laya format', () => {
      const mapped = mapQuestionsToLaya(testSpec.questions);

      assert.equal(mapped.topic.type, 'choice');
      assert.equal(mapped.topic.instructions, testSpec.questions.topic.question);
      assert.deepEqual(mapped.topic.criteria, (testSpec.questions.topic as any).options);

      assert.equal(mapped.is_ai_post.type, 'noul');
      assert.equal(mapped.is_ai_post.instructions, (testSpec.questions.is_ai_post as any).statement);
      assert.equal(mapped.is_ai_post.criteria, undefined);

      assert.equal(mapped.quality_score.type, 'score');
      assert.equal(mapped.quality_score.instructions, testSpec.questions.quality_score.question);
      assert.deepEqual(mapped.quality_score.criteria, [
        'trivial',
        'basic',
        'detailed',
        'production-grade'
      ]);
    });
  });

  describe('evaluateAlertRule', () => {
    const baseRule: AlertRule = {
      questionKey: 'topic',
      operator: 'equals',
      targetValue: 'local_ai',
      minAnswerConfidence: 0.85
    };

    it('strictly gates on answer_confidence (max(p)), ignoring high normalized entropy confidence', () => {
      // Entropy confidence is 0.95, but answer_confidence is 0.82 (< 0.85 threshold)
      const belowAnswer = {
        answer: 'local_ai',
        answer_confidence: 0.82,
        confidence: 0.95
      };
      assert.equal(evaluateAlertRule(baseRule, belowAnswer), false);

      // Calibrated answer_confidence meets threshold (0.87 >= 0.85)
      const aboveAnswer = {
        answer: 'local_ai',
        answer_confidence: 0.87,
        confidence: 0.60
      };
      assert.equal(evaluateAlertRule(baseRule, aboveAnswer), true);
    });

    it('evaluates operator "equals" correctly', () => {
      const rule: AlertRule = {
        questionKey: 'topic',
        operator: 'equals',
        targetValue: 'local_ai',
        minAnswerConfidence: 0.80
      };
      assert.equal(
        evaluateAlertRule(rule, { answer: 'local_ai', answer_confidence: 0.90 }),
        true
      );
      assert.equal(
        evaluateAlertRule(rule, { answer: 'crypto', answer_confidence: 0.90 }),
        false
      );
    });

    it('evaluates operator "gte" for numerical score questions', () => {
      const rule: AlertRule = {
        questionKey: 'score',
        operator: 'gte',
        targetValue: 3,
        minAnswerConfidence: 0.75
      };
      assert.equal(evaluateAlertRule(rule, { answer: 4, answer_confidence: 0.80 }), true);
      assert.equal(evaluateAlertRule(rule, { answer: 3, answer_confidence: 0.80 }), true);
      assert.equal(evaluateAlertRule(rule, { answer: 2, answer_confidence: 0.99 }), false);
    });

    it('evaluates operator "boolean_true" for noul questions', () => {
      const rule: AlertRule = {
        questionKey: 'is_ai',
        operator: 'boolean_true',
        targetValue: true,
        minAnswerConfidence: 0.80
      };
      assert.equal(evaluateAlertRule(rule, { answer: true, answer_confidence: 0.88 }), true);
      assert.equal(evaluateAlertRule(rule, { answer: 'true', answer_confidence: 0.88 }), true);
      assert.equal(evaluateAlertRule(rule, { answer: false, answer_confidence: 0.95 }), false);
    });
  });

  describe('LayaEngine ONNX Forward Pass', () => {
    it('initializes and reports isReady', () => {
      assert.equal(engine.isReady, true);
    });

    it('evaluates DOM snippet across multi-questions in a single forward pass', async () => {
      const snippet = 'Show HN: Ofln-Scout – Fast non-autoregressive decision model on ONNX Runtime CPU';
      const telemetry = await engine.evaluateDomBatch(snippet, testSpec);

      assert.ok(telemetry.id);
      assert.equal(telemetry.taskId, testSpec.id);
      assert.ok(typeof telemetry.latencyMs === 'number');
      assert.ok(telemetry.latencyMs >= 0);
      assert.equal(typeof telemetry.triggeredAlert, 'boolean');

      // Check all questions were answered in single forward pass
      assert.ok(telemetry.rawAnswers['topic']);
      assert.ok(telemetry.rawAnswers['is_ai_post']);
      assert.ok(telemetry.rawAnswers['quality_score']);

      for (const [key, ans] of Object.entries(telemetry.rawAnswers)) {
        assert.ok(
          ans.answer_confidence >= 0 && ans.answer_confidence <= 1,
          `Answer confidence for ${key} must be in [0, 1]`
        );
      }
    });
  });

  describe('Milestone 2: Hardware Acceleration & Model Options', () => {
    it('defines hardware acceleration ladders for win32, linux, and darwin', () => {
      assert.deepEqual(HARDWARE_LADDERS.win32, ['webgpu', 'dml', 'cpu']);
      assert.deepEqual(HARDWARE_LADDERS.linux, ['cuda', 'rocm', 'openvino', 'webgpu', 'cpu']);
      assert.deepEqual(HARDWARE_LADDERS.darwin, ['webgpu', 'cpu']);

      assert.deepEqual(getProviderLadder('win32'), ['webgpu', 'dml', 'cpu']);
      assert.deepEqual(getProviderLadder('linux'), ['cuda', 'rocm', 'openvino', 'webgpu', 'cpu']);
      assert.deepEqual(getProviderLadder('darwin'), ['webgpu', 'cpu']);
      assert.deepEqual(getProviderLadder('unknown_os' as any), ['cuda', 'rocm', 'openvino', 'webgpu', 'cpu']);
    });

    it('maps execution providers to human-readable device strings', () => {
      assert.equal(getDeviceNameForProvider('webgpu'), 'GPU (WebGPU Adapter)');
      assert.equal(getDeviceNameForProvider('dml'), 'DirectML (DirectX 12 GPU)');
      assert.equal(getDeviceNameForProvider('cuda'), 'NVIDIA GPU (CUDA)');
      assert.equal(getDeviceNameForProvider('tensorrt'), 'NVIDIA TensorRT GPU');
      assert.equal(getDeviceNameForProvider('rocm'), 'AMD GPU (ROCm)');
      assert.equal(getDeviceNameForProvider('openvino'), 'Intel NPU/GPU (OpenVINO)');
      assert.equal(getDeviceNameForProvider('cpu'), 'CPU');
      assert.equal(getDeviceNameForProvider('other'), 'CPU');
    });

    it('exposes accurate ModelStats conforming to the shared contract', () => {
      const stats = engine.getModelStats();
      assert.ok(stats.modelName.includes('laya'));
      assert.ok(stats.format === 'fp32' || stats.format === 'int8');
      assert.ok(typeof stats.provider === 'string');
      assert.ok(typeof stats.device === 'string');
      assert.ok(stats.status === 'ready' || stats.status === 'idle');
      assert.ok(typeof stats.avgLatencyMs === 'number');
      assert.ok(stats.avgLatencyMs >= 0);
    });

    it('falls back cleanly to FP32 when INT8 model file is missing', async () => {
      const tempEngine = new LayaEngine();
      const ok = await tempEngine.initialize({ format: 'int8', forceOffline: false });
      if (ok) {
        assert.equal(tempEngine.format, 'fp32');
        assert.equal(tempEngine.modelName, 'laya.onnx');
        assert.equal(tempEngine.status, 'ready');
      }
      await tempEngine.close();
    });

    it('falls back to CPU or available provider when preferred provider fails probe pass', async () => {
      const tempEngine = new LayaEngine();
      const ok = await tempEngine.initialize({ preferredProvider: 'non_existent_gpu_provider' });
      if (ok) {
        assert.equal(tempEngine.status, 'ready');
        assert.ok(['webgpu', 'dml', 'cpu'].includes(tempEngine.provider));
      }
      await tempEngine.close();
    });
  });
});
