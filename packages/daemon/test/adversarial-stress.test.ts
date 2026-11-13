import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeCompiledSpec,
  compileTask,
  getPresetTaskSpec,
  estimateTokens
} from '../src/engine/compiler.js';

describe('Adversarial Stress Suite for System 2 Compiler', () => {
  const baseSpec = {
    id: 'adversarial-spec',
    name: 'Adversarial Test',
    userGoal: 'Scout test',
    targetUrl: 'https://example.com',
    domSelector: 'article',
    pollIntervalMs: 800,
    scrollStepPx: 400,
    questions: {
      topic: {
        type: 'choice' as const,
        question: 'What is the topic?',
        options: ['ai', 'crypto']
      }
    },
    alertRule: {
      questionKey: 'topic',
      operator: 'equals' as const,
      targetValue: 'ai',
      minAnswerConfidence: 0.80
    },
    createdAt: Date.now()
  };

  describe('1. Cardinality Sanitization Probes', () => {
    it('[Cardinality] 50 options sanitized to <= 20 options with valid: true', () => {
      const spec50 = {
        ...baseSpec,
        questions: {
          topic: {
            type: 'choice' as const,
            question: 'Pick one',
            options: Array.from({ length: 50 }, (_, i) => `opt_${i}`)
          }
        }
      };
      const res = sanitizeCompiledSpec(spec50);
      assert.equal(res.valid, true);
      assert.ok(res.sanitizedSpec);
      const opts = (res.sanitizedSpec.questions.topic as any).options;
      assert.ok(opts.length <= 20);
      assert.equal(opts.length, 20);
    });

    it('[Cardinality] Boundary 20 options passes validation without changes', () => {
      const spec20 = {
        ...baseSpec,
        questions: {
          topic: {
            type: 'choice' as const,
            question: 'Pick one',
            options: Array.from({ length: 20 }, (_, i) => `opt_${i}`)
          }
        }
      };
      const res = sanitizeCompiledSpec(spec20);
      assert.equal(res.valid, true);
      assert.ok(res.sanitizedSpec);
      const opts = (res.sanitizedSpec.questions.topic as any).options;
      assert.equal(opts.length, 20);
    });

    it('[Cardinality] Boundary 21 options sanitized to <= 20 options with valid: true', () => {
      const spec21 = {
        ...baseSpec,
        questions: {
          topic: {
            type: 'choice' as const,
            question: 'Pick one',
            options: Array.from({ length: 21 }, (_, i) => `opt_${i}`)
          }
        }
      };
      const res = sanitizeCompiledSpec(spec21);
      assert.equal(res.valid, true);
      assert.ok(res.sanitizedSpec);
      const opts = (res.sanitizedSpec.questions.topic as any).options;
      assert.equal(opts.length, 20);
    });

    it('[Cardinality] Choice question with 0 options detected as invalid', () => {
      const spec0 = {
        ...baseSpec,
        questions: {
          topic: {
            type: 'choice' as const,
            question: 'Pick one',
            options: []
          }
        }
      };
      const res = sanitizeCompiledSpec(spec0);
      assert.equal(res.valid, false);
      assert.equal(res.sanitizedSpec, undefined);
      assert.ok(res.errors.some((e) => e.includes('requires at least one option')));
    });
  });

  describe('2. Label Uniqueness Probes', () => {
    it('[Label Uniqueness] Duplicate labels ["crypto", "ai", "crypto", "web3"] deduplicated', () => {
      const specDup = {
        ...baseSpec,
        questions: {
          topic: {
            type: 'choice' as const,
            question: 'Pick one',
            options: ['crypto', 'ai', 'crypto', 'web3']
          }
        }
      };
      const res = sanitizeCompiledSpec(specDup);
      assert.equal(res.valid, true);
      assert.ok(res.sanitizedSpec);
      const opts = (res.sanitizedSpec.questions.topic as any).options;
      assert.deepEqual(opts, ['crypto', 'ai', 'web3']);
    });

    it('[Label Uniqueness] All identical options ["ai", "ai", "ai"] handled to 1 option', () => {
      const specIdentical = {
        ...baseSpec,
        questions: {
          topic: {
            type: 'choice' as const,
            question: 'Pick one',
            options: ['ai', 'ai', 'ai']
          }
        }
      };
      const res = sanitizeCompiledSpec(specIdentical);
      assert.equal(res.valid, true);
      assert.ok(res.sanitizedSpec);
      const opts = (res.sanitizedSpec.questions.topic as any).options;
      assert.deepEqual(opts, ['ai']);
    });
  });

  describe('3. Token Boundary Guard Probes', () => {
    it('[Token Guard] Long question (>1000 chars, ~325 tokens) truncated to < 160 tokens', () => {
      const longText = 'word '.repeat(250);
      const specLong = {
        ...baseSpec,
        questions: {
          topic: {
            type: 'choice' as const,
            question: longText,
            options: ['ai', 'other']
          }
        }
      };
      const res = sanitizeCompiledSpec(specLong);
      assert.equal(res.valid, true);
      assert.ok(res.sanitizedSpec);
      const q = res.sanitizedSpec.questions.topic as any;
      const totalTokens = estimateTokens(q.question + ' ' + q.options.join(' '));
      assert.ok(totalTokens < 160, `Tokens (${totalTokens}) must be < 160`);
    });

    it('[Token Guard] Sub-160 token question (156 tokens) passes without rejection', () => {
      // 120 words * 1.3 = 156 tokens
      const sub160Text = 'word '.repeat(118).trim();
      const specSub160 = {
        ...baseSpec,
        questions: {
          topic: {
            type: 'choice' as const,
            question: sub160Text,
            options: ['ai', 'other'] // 118 + 2 = 120 words -> 156 tokens
          }
        }
      };
      const res = sanitizeCompiledSpec(specSub160);
      assert.equal(res.valid, true);
      assert.ok(res.sanitizedSpec);
      const q = res.sanitizedSpec.questions.topic as any;
      const totalTokens = estimateTokens(q.question + ' ' + q.options.join(' '));
      assert.ok(totalTokens < 160);
    });

    it('[Token Guard] Noul question (>1000 chars) truncated to < 160 tokens', () => {
      const longStmt = 'statement '.repeat(250);
      const specNoul = {
        ...baseSpec,
        questions: {
          is_rel: {
            type: 'noul' as const,
            statement: longStmt
          }
        }
      };
      const res = sanitizeCompiledSpec(specNoul);
      assert.equal(res.valid, true);
      assert.ok(res.sanitizedSpec);
      const q = res.sanitizedSpec.questions.is_rel as any;
      const totalTokens = estimateTokens(q.statement);
      assert.ok(totalTokens < 160, `Tokens (${totalTokens}) must be < 160`);
    });
  });

  describe('4. Confidence Bounding Probes', () => {
    it('clamps 0.1 to 0.50', () => {
      const res = sanitizeCompiledSpec({
        ...baseSpec,
        alertRule: { ...baseSpec.alertRule, minAnswerConfidence: 0.1 }
      });
      assert.equal(res.sanitizedSpec?.alertRule.minAnswerConfidence, 0.50);
    });

    it('clamps 0.49 to 0.50', () => {
      const res = sanitizeCompiledSpec({
        ...baseSpec,
        alertRule: { ...baseSpec.alertRule, minAnswerConfidence: 0.49 }
      });
      assert.equal(res.sanitizedSpec?.alertRule.minAnswerConfidence, 0.50);
    });

    it('clamps 1.05 to 0.99', () => {
      const res = sanitizeCompiledSpec({
        ...baseSpec,
        alertRule: { ...baseSpec.alertRule, minAnswerConfidence: 1.05 }
      });
      assert.equal(res.sanitizedSpec?.alertRule.minAnswerConfidence, 0.99);
    });

    it('defaults NaN to 0.80', () => {
      const res = sanitizeCompiledSpec({
        ...baseSpec,
        alertRule: { ...baseSpec.alertRule, minAnswerConfidence: NaN as any }
      });
      assert.equal(res.sanitizedSpec?.alertRule.minAnswerConfidence, 0.80);
    });

    it('defaults undefined to 0.80', () => {
      const res = sanitizeCompiledSpec({
        ...baseSpec,
        alertRule: { ...baseSpec.alertRule, minAnswerConfidence: undefined as any }
      });
      assert.equal(res.sanitizedSpec?.alertRule.minAnswerConfidence, 0.80);
    });

    it('clamps -0.5 to 0.50', () => {
      const res = sanitizeCompiledSpec({
        ...baseSpec,
        alertRule: { ...baseSpec.alertRule, minAnswerConfidence: -0.5 }
      });
      assert.equal(res.sanitizedSpec?.alertRule.minAnswerConfidence, 0.50);
    });

    it('clamps 0.0 to 0.50', () => {
      const res = sanitizeCompiledSpec({
        ...baseSpec,
        alertRule: { ...baseSpec.alertRule, minAnswerConfidence: 0.0 }
      });
      assert.equal(res.sanitizedSpec?.alertRule.minAnswerConfidence, 0.50);
    });
  });

  describe('5. Offline Fallback & Resiliency Probes', () => {
    it('returns deterministic preset within timeout when Ollama is offline', async () => {
      const start = Date.now();
      const spec = await compileTask('Monitor Hacker News for local AI');
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2000, `Took ${elapsed}ms`);
      assert.ok(spec.id);
      assert.equal(spec.targetUrl, 'https://news.ycombinator.com');
    });
  });

  describe('6. Edge Cases & Potential Crash Probes', () => {
    it('null input does not crash sanitizeCompiledSpec', () => {
      const res = sanitizeCompiledSpec(null);
      assert.equal(res.valid, false);
      assert.equal(res.sanitizedSpec, undefined);
    });

    it('empty object input does not crash sanitizeCompiledSpec', () => {
      const res = sanitizeCompiledSpec({});
      assert.equal(res.valid, false);
      assert.equal(res.sanitizedSpec, undefined);
    });

    it('unknown preset defaults to generic Web Content Scout', () => {
      const spec = getPresetTaskSpec('unknown_site_xyz');
      assert.ok(spec.id);
      assert.equal(spec.name, 'Web Content Scout');
    });

    it('generic preset correctly extracts URL from userGoal', () => {
      const spec = getPresetTaskSpec('generic', 'Scout posts from https://myblog.com/feed');
      assert.equal(spec.targetUrl, 'https://myblog.com/feed');
    });
  });
});
