import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileTask,
  sanitizeCompiledSpec,
  getPresetTaskSpec,
  SELECTOR_PRESETS,
  estimateTokens
} from '../src/engine/compiler.js';
import type { CompiledTaskSpec } from '@ofln-scout/shared';

describe('System 2 Task Compiler (Unit & Integration)', () => {
  const validSpec: CompiledTaskSpec = {
    id: 'test-spec-1',
    name: 'HN AI Monitor',
    userGoal: 'Scout Hacker News for AI engines',
    targetUrl: 'https://news.ycombinator.com',
    domSelector: '.athing, tr.athing',
    pollIntervalMs: 800,
    scrollStepPx: 400,
    questions: {
      topic: {
        type: 'choice',
        question: 'What is the topic?',
        options: ['local_ai', 'web_dev', 'crypto', 'other']
      },
      is_ai: {
        type: 'noul',
        statement: 'This post discusses AI or ONNX.'
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

  describe('estimateTokens', () => {
    it('returns 0 for empty or whitespace string', () => {
      assert.equal(estimateTokens(''), 0);
      assert.equal(estimateTokens('   \n\t  '), 0);
    });

    it('estimates tokens based on word count with 1.3 multiplier', () => {
      const text = 'one two three four five'; // 5 words * 1.3 = 6.5 -> 7
      assert.equal(estimateTokens(text), 7);
    });
  });

  describe('sanitizeCompiledSpec', () => {
    it('validates a compliant task specification', () => {
      const res = sanitizeCompiledSpec(validSpec);
      assert.equal(res.valid, true);
      assert.equal(res.errors.length, 0);
      assert.ok(res.sanitizedSpec);
      assert.equal(res.sanitizedSpec?.alertRule.minAnswerConfidence, 0.80);
    });

    it('rejects non-object rawSpec input', () => {
      const resNull = sanitizeCompiledSpec(null);
      assert.equal(resNull.valid, false);
      assert.ok(resNull.errors.some((e) => e.includes('non-null object')));

      const resString = sanitizeCompiledSpec('invalid');
      assert.equal(resString.valid, false);
    });

    it('validates and clamps minAnswerConfidence to [0.50, 0.99] defaulting to 0.80', () => {
      // Missing minAnswerConfidence
      const missingConf = {
        ...validSpec,
        alertRule: {
          questionKey: 'topic',
          operator: 'equals' as const,
          targetValue: 'local_ai'
        }
      };
      const resMissing = sanitizeCompiledSpec(missingConf);
      assert.equal(resMissing.valid, true);
      assert.equal(resMissing.sanitizedSpec?.alertRule.minAnswerConfidence, 0.80);

      // Low confidence (< 0.50)
      const lowConf = {
        ...validSpec,
        alertRule: { ...validSpec.alertRule, minAnswerConfidence: 0.10 }
      };
      const resLow = sanitizeCompiledSpec(lowConf);
      assert.equal(resLow.valid, true);
      assert.equal(resLow.sanitizedSpec?.alertRule.minAnswerConfidence, 0.50);

      // High confidence (> 0.99)
      const highConf = {
        ...validSpec,
        alertRule: { ...validSpec.alertRule, minAnswerConfidence: 1.50 }
      };
      const resHigh = sanitizeCompiledSpec(highConf);
      assert.equal(resHigh.valid, true);
      assert.equal(resHigh.sanitizedSpec?.alertRule.minAnswerConfidence, 0.99);
    });

    it('actively sanitizes choice questions exceeding 20 options to <= 20 options', () => {
      const longChoice = {
        ...validSpec,
        questions: {
          category: {
            type: 'choice' as const,
            question: 'Pick one',
            options: Array.from({ length: 50 }, (_, i) => `opt_${i}`)
          }
        }
      };
      const res = sanitizeCompiledSpec(longChoice);
      assert.equal(res.valid, true);
      assert.ok(res.sanitizedSpec);
      const cat = res.sanitizedSpec.questions.category as any;
      assert.equal(cat.options.length, 20);
      assert.deepEqual(cat.options, Array.from({ length: 20 }, (_, i) => `opt_${i}`));
    });

    it('actively deduplicates choice questions with duplicate option labels', () => {
      const dupChoice = {
        ...validSpec,
        questions: {
          category: {
            type: 'choice' as const,
            question: 'Pick one',
            options: ['ai', 'crypto', 'ai', 'web3']
          }
        }
      };
      const res = sanitizeCompiledSpec(dupChoice);
      assert.equal(res.valid, true);
      assert.ok(res.sanitizedSpec);
      const cat = res.sanitizedSpec.questions.category as any;
      assert.deepEqual(cat.options, ['ai', 'crypto', 'web3']);
    });

    it('detects choice questions with 0 options as invalid', () => {
      const emptyChoice = {
        ...validSpec,
        questions: {
          category: {
            type: 'choice' as const,
            question: 'Pick one',
            options: []
          }
        }
      };
      const res = sanitizeCompiledSpec(emptyChoice);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('requires at least one option')));
    });

    it('actively truncates questions exceeding 160 tokens token boundary to < 160 tokens', () => {
      const longText = 'word '.repeat(200);
      const overflowSpec = {
        ...validSpec,
        questions: {
          verboseChoice: {
            type: 'choice' as const,
            question: longText,
            options: ['yes', 'no']
          },
          verboseNoul: {
            type: 'noul' as const,
            statement: longText
          }
        }
      };
      const res = sanitizeCompiledSpec(overflowSpec);
      assert.equal(res.valid, true);
      assert.ok(res.sanitizedSpec);
      const choiceQ = res.sanitizedSpec.questions.verboseChoice as any;
      const noulQ = res.sanitizedSpec.questions.verboseNoul as any;
      assert.ok(estimateTokens(choiceQ.question + ' ' + choiceQ.options.join(' ')) < 160);
      assert.ok(estimateTokens(noulQ.statement) < 160);
    });

    it('validates score questions with rubric object or array', () => {
      const scoreSpec = {
        ...validSpec,
        questions: {
          rating: {
            type: 'score' as const,
            question: 'Rate relevance',
            rubric: { 1: 'poor', 2: 'fair', 3: 'good', 4: 'excellent' }
          }
        },
        alertRule: {
          questionKey: 'rating',
          operator: 'gte' as const,
          targetValue: 3,
          minAnswerConfidence: 0.80
        }
      };
      const res = sanitizeCompiledSpec(scoreSpec);
      assert.equal(res.valid, true);
      assert.equal(res.errors.length, 0);
    });
  });

  describe('getPresetTaskSpec & SELECTOR_PRESETS', () => {
    it('defines standard selector presets', () => {
      assert.equal(SELECTOR_PRESETS.hn, '.athing, tr.athing');
      assert.equal(
        SELECTOR_PRESETS.reddit,
        'shroot, [data-testid="post-container"], div.Post'
      );
      assert.equal(
        SELECTOR_PRESETS.github,
        'article.Box-row, div.Box-row, li.repo-list-item'
      );
      assert.equal(
        SELECTOR_PRESETS.generic,
        'article, div.post, div.card, li.item, [role="article"]'
      );
    });

    it('generates valid preset task specs for all preset types', () => {
      const presets = ['hn', 'reddit', 'github', 'generic'];
      for (const preset of presets) {
        const spec = getPresetTaskSpec(preset);
        assert.ok(spec.id);
        assert.ok(spec.name);
        assert.ok(spec.targetUrl);
        assert.ok(spec.domSelector);
        assert.ok(spec.questions);
        assert.ok(spec.alertRule);

        const sanitized = sanitizeCompiledSpec(spec);
        assert.equal(sanitized.valid, true, `Preset ${preset} must be valid`);
      }
    });

    it('extracts URL in generic preset when provided in userGoal', () => {
      const customUrl = 'https://news.example.com/feed';
      const spec = getPresetTaskSpec('generic', `Scout articles from ${customUrl}`);
      assert.equal(spec.targetUrl, customUrl);
    });
  });

  describe('compileTask (Offline Resilient System 2)', () => {
    it('falls back seamlessly to deterministic preset generation when Ollama is offline', async () => {
      const specHn = await compileTask('Monitor Hacker News for local AI and ONNX');
      assert.ok(specHn.id);
      assert.equal(specHn.targetUrl, 'https://news.ycombinator.com');
      assert.equal(specHn.domSelector, SELECTOR_PRESETS.hn);
      assert.ok(specHn.questions['topic']);

      const specReddit = await compileTask('Scout r/LocalLLaMA for INT8 benchmarks');
      assert.equal(specReddit.targetUrl, 'https://reddit.com/r/LocalLLaMA');
      assert.equal(specReddit.domSelector, SELECTOR_PRESETS.reddit);

      const specGithub = await compileTask('Scout trending GitHub repositories for machine learning');
      assert.equal(specGithub.targetUrl, 'https://github.com/trending');
      assert.equal(specGithub.domSelector, SELECTOR_PRESETS.github);

      const specGeneric = await compileTask('Find new articles on https://techcrunch.com');
      assert.equal(specGeneric.targetUrl, 'https://techcrunch.com');
      assert.equal(specGeneric.domSelector, SELECTOR_PRESETS.generic);
    });
  });
});
