import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeResultStats,
  generateResultsSummary,
  queryResults,
  steerTask,
} from '../src/engine/systemTwoAssistant.js';
import type { CompiledTaskSpec, ScrapedItem } from '@ofln-scout/shared';

describe('SystemTwoAssistant Engine Suite', () => {
  const mockItems: ScrapedItem[] = [
    {
      id: 'item-001',
      timestamp: '2026-11-12T15:00:00.000Z',
      text: 'Show HN: Local ONNX runner for modern browser agents',
      link: 'https://news.ycombinator.com/item?id=1001',
      answers: { category: 'agent', framework: 'onnx' },
      confidence: 0.94,
      triggeredAlert: true,
    },
    {
      id: 'item-002',
      timestamp: '2026-11-12T15:01:00.000Z',
      text: 'Ask HN: Best WebGPU tutorials in 2026',
      link: 'https://news.ycombinator.com/item?id=1002',
      answers: { category: 'graphics' },
      confidence: 0.82,
      triggeredAlert: false,
    },
    {
      id: 'item-003',
      timestamp: '2026-11-12T15:02:00.000Z',
      text: 'Show HN: Autonomous web crawler using Ollama and ModernBERT',
      link: 'https://news.ycombinator.com/item?id=1003',
      answers: { category: 'agent', framework: 'ollama' },
      confidence: 0.98,
      triggeredAlert: true,
    },
  ];

  const baseSpec: CompiledTaskSpec = {
    id: 'task-test-base',
    name: 'HN Test Task',
    userGoal: 'Scout AI web agents',
    targetUrl: 'https://news.ycombinator.com/show',
    domSelector: '.athing',
    pollIntervalMs: 800,
    scrollStepPx: 400,
    questions: {
      is_agent: {
        type: 'noul',
        statement: 'This post is about autonomous web agents',
      },
    },
    alertRule: {
      questionKey: 'is_agent',
      operator: 'equals',
      targetValue: 'true',
      minAnswerConfidence: 0.8,
    },
    createdAt: 1700000000000,
  };

  it('1. computeResultStats: calculates counts, percentages, and categories correctly', () => {
    const stats = computeResultStats(mockItems, 5, 22.5);
    assert.equal(stats.totalScanned, 5);
    assert.equal(stats.totalAlerts, 2);
    assert.equal(stats.matchRatePercent, 40.0);
    assert.equal(stats.avgLatencyMs, 22.5);
    assert.equal(stats.topCategories['agent'], 2);
    assert.equal(stats.topCategories['onnx'], 1);
    assert.equal(stats.topCategories['graphics'], 1);
  });

  it('2. computeResultStats: handles empty dataset gracefully', () => {
    const stats = computeResultStats([], 0, 0);
    assert.equal(stats.totalScanned, 0);
    assert.equal(stats.totalAlerts, 0);
    assert.equal(stats.matchRatePercent, 0);
    assert.deepEqual(stats.topCategories, {});
  });

  it('3. generateResultsSummary: produces structured markdown summary in offline mode', async () => {
    const stats = computeResultStats(mockItems, 3, 18.0);
    const summary = await generateResultsSummary(mockItems, stats, 'Scout AI web agents');

    assert.ok(summary.includes('### Executive Summary'));
    assert.ok(summary.includes('Scout monitored web content for the goal'));
    assert.ok(summary.includes('### Key Metrics'));
    assert.ok(summary.includes('- **Total Scanned**: 3'));
    assert.ok(summary.includes('- **Total Matches**: 2'));
    assert.ok(summary.includes('### Notable Matches'));
    assert.ok(summary.includes('Show HN: Autonomous web crawler'));
    assert.ok(summary.includes('https://news.ycombinator.com/item?id=1003'));
    assert.ok(summary.includes('### Assessment'));
  });

  it('4. queryResults: answers aggregate queries in offline mode', async () => {
    const res = await queryResults('How many items were found and what is the count?', mockItems);
    assert.ok(res.answer.includes('3 total scraped item(s)'));
    assert.ok(res.answer.includes('2 matching alert(s)'));
    assert.equal(res.model, 'offline-heuristic');
  });

  it('5. queryResults: answers keyword queries matching item text or answers', async () => {
    const res = await queryResults('Tell me about ModernBERT and Ollama crawler', mockItems);
    assert.ok(res.answer.includes('Found'));
    assert.ok(res.answer.includes('Autonomous web crawler using Ollama and ModernBERT'));
    assert.ok(res.answer.includes('https://news.ycombinator.com/item?id=1003'));
    assert.equal(res.model, 'offline-heuristic');
  });

  it('6. queryResults: returns no-match message for unrelated queries', async () => {
    const res = await queryResults('Find articles about baking sourdough pizza dough', mockItems);
    assert.ok(res.answer.includes('No items in the scraped results matched'));
    assert.equal(res.model, 'offline-heuristic');
  });

  it('7. steerTask: parses target URL update', async () => {
    const res = await steerTask('Change url to https://reddit.com/r/localllama', baseSpec);
    assert.equal(res.applied, true);
    assert.equal(res.updatedSpec.targetUrl, 'https://reddit.com/r/localllama');
    assert.ok(res.explanation.includes('Updated target URL'));
  });

  it('8. steerTask: parses scroll step adjustments (absolute and relative)', async () => {
    const abs = await steerTask('Set scroll step to 650', baseSpec);
    assert.equal(abs.applied, true);
    assert.equal(abs.updatedSpec.scrollStepPx, 650);

    const faster = await steerTask('Please scroll faster', baseSpec);
    assert.equal(faster.applied, true);
    assert.equal(faster.updatedSpec.scrollStepPx, 600);

    const slower = await steerTask('Please scroll slower', baseSpec);
    assert.equal(slower.applied, true);
    assert.equal(slower.updatedSpec.scrollStepPx, 250);
  });

  it('9. steerTask: parses poll interval adjustments (absolute and relative)', async () => {
    const abs = await steerTask('Set poll interval to 1500', baseSpec);
    assert.equal(abs.applied, true);
    assert.equal(abs.updatedSpec.pollIntervalMs, 1500);

    const faster = await steerTask('poll faster', baseSpec);
    assert.equal(faster.applied, true);
    assert.equal(faster.updatedSpec.pollIntervalMs, 400);

    const slower = await steerTask('poll slower', baseSpec);
    assert.equal(slower.applied, true);
    assert.equal(slower.updatedSpec.pollIntervalMs, 1300);
  });

  it('10. steerTask: parses confidence threshold adjustments', async () => {
    const abs = await steerTask('set confidence to 0.90', baseSpec);
    assert.equal(abs.applied, true);
    assert.equal(abs.updatedSpec.alertRule.minAnswerConfidence, 0.90);

    const lower = await steerTask('lower confidence threshold', baseSpec);
    assert.equal(lower.applied, true);
    assert.equal(lower.updatedSpec.alertRule.minAnswerConfidence, 0.70);

    const higher = await steerTask('raise confidence threshold', baseSpec);
    assert.equal(higher.applied, true);
    assert.equal(higher.updatedSpec.alertRule.minAnswerConfidence, 0.90);
  });

  it('11. steerTask: parses DOM selector and user goal updates', async () => {
    const sel = await steerTask('change selector to .post-card', baseSpec);
    assert.equal(sel.applied, true);
    assert.equal(sel.updatedSpec.domSelector, '.post-card');

    const goal = await steerTask('look for "cutting edge local AI developments"', baseSpec);
    assert.equal(goal.applied, true);
    assert.equal(goal.updatedSpec.userGoal, 'cutting edge local AI developments');
  });

  it('12. steerTask: returns applied false for unparseable instructions', async () => {
    const res = await steerTask('xyz 123 completely unrelated nonsense gibberish', baseSpec);
    assert.equal(res.applied, false);
    assert.equal(res.updatedSpec, baseSpec);
    assert.ok(res.explanation.includes('Unable to parse steering instruction'));
  });

  it('13. computeResultStats: prototype property collision immunity', () => {
    const protoItems: ScrapedItem[] = [
      {
        id: 'proto-1',
        timestamp: '',
        text: 'Item with prototype identifier answers',
        answers: { a: 'toString', b: 'valueOf' },
        confidence: 0.9,
        triggeredAlert: true,
      },
      {
        id: 'proto-2',
        timestamp: '',
        text: 'Item with constructor answer',
        answers: { a: 'constructor', b: 'toString' },
        confidence: 0.8,
        triggeredAlert: false,
      },
    ];

    const stats = computeResultStats(protoItems, 2, 10);
    assert.equal(typeof stats.topCategories['toString'], 'number');
    assert.equal(stats.topCategories['toString'], 2);
    assert.equal(typeof stats.topCategories['valueOf'], 'number');
    assert.equal(stats.topCategories['valueOf'], 1);
    assert.equal(typeof stats.topCategories['constructor'], 'number');
    assert.equal(stats.topCategories['constructor'], 1);
  });

  it('14. queryResults: safely handles items with null or undefined answers without throwing', async () => {
    const itemsWithNullAnswers: ScrapedItem[] = [
      {
        id: 'null-ans-1',
        timestamp: '',
        text: 'Local ONNX browser agent runner',
        answers: undefined as any,
        confidence: 0.9,
        triggeredAlert: true,
      },
      {
        id: 'null-ans-2',
        timestamp: '',
        text: 'Sample WebGPU tutorial',
        answers: null as any,
        confidence: 0.7,
        triggeredAlert: false,
      },
    ];

    // Should not throw 'Cannot convert undefined or null to object'
    const res = await queryResults('browser agent', itemsWithNullAnswers);
    assert.ok(res.answer.includes('Found 1 relevant item(s)'));
    assert.ok(res.answer.includes('Local ONNX browser agent runner'));
  });

  it('15. steerTask: strips trailing punctuation from target URL', async () => {
    // Trailing comma
    const resComma = await steerTask(
      'Change url to https://news.ycombinator.com/show, scroll step 600',
      baseSpec
    );
    assert.equal(resComma.applied, true);
    assert.equal(resComma.updatedSpec.targetUrl, 'https://news.ycombinator.com/show');

    // Trailing period
    const resPeriod = await steerTask(
      'Navigate to https://example.com/test.',
      baseSpec
    );
    assert.equal(resPeriod.applied, true);
    assert.equal(resPeriod.updatedSpec.targetUrl, 'https://example.com/test');

    // Trailing colon, semicolon, quote, exclamation
    const resPunct = await steerTask(
      'Set target to "https://news.ycombinator.com/newest"; please update!',
      baseSpec
    );
    assert.equal(resPunct.applied, true);
    assert.equal(resPunct.updatedSpec.targetUrl, 'https://news.ycombinator.com/newest');
  });

  it('16. generateResultsSummary & queryResults: safely handles items with undefined or null text without throwing', async () => {
    const itemsWithoutText: ScrapedItem[] = [
      {
        id: 'undef-text-1',
        timestamp: '2026-11-12T16:00:00.000Z',
        text: undefined as any,
        answers: { category: 'database', framework: 'sqlite' },
        confidence: 0.95,
        triggeredAlert: true,
      },
      {
        id: 'null-text-2',
        timestamp: '2026-11-12T16:01:00.000Z',
        text: null as any,
        answers: { category: 'database' },
        confidence: 0.85,
        triggeredAlert: true,
      },
    ];

    const stats = computeResultStats(itemsWithoutText, 2, 15);

    // generateResultsSummary must not throw with undefined or null text
    let summary = '';
    await assert.doesNotReject(async () => {
      summary = await generateResultsSummary(itemsWithoutText, stats, 'Monitor database announcements');
    }, 'generateResultsSummary must not reject when item.text is null or undefined');

    assert.ok(summary.includes('### Executive Summary'));
    assert.ok(summary.includes('### Notable Matches'));

    // queryResults must not throw with undefined or null text
    let queryRes: { answer: string; model: string } | undefined;
    await assert.doesNotReject(async () => {
      queryRes = await queryResults('database', itemsWithoutText);
    }, 'queryResults must not reject when item.text is null or undefined');

    assert.ok(queryRes);
    assert.ok(queryRes.answer.includes('Found 2 relevant item(s)'));
  });

  it('17. computeResultStats: retains __proto__ numeric count in topCategories and renders in summary', async () => {
    const protoItems: ScrapedItem[] = [
      {
        id: 'p-1',
        timestamp: '2026-11-12T16:00:00.000Z',
        text: 'Proto test item',
        answers: { category: '__proto__' },
        confidence: 0.9,
        triggeredAlert: true,
      },
    ];

    const stats = computeResultStats(protoItems, 1, 10);
    assert.equal(typeof stats.topCategories['__proto__'], 'number');
    assert.equal(stats.topCategories['__proto__'], 1);
    assert.notDeepEqual(stats.topCategories['__proto__'], {});

    const summary = await generateResultsSummary(protoItems, stats, 'Proto test goal');
    assert.ok(summary.includes('- **__proto__**: 1'));
  });
});
