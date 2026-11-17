import type { CompiledTaskSpec } from '@ofln-scout/shared';

export interface PresetItem {
  id: string;
  name: string;
  badge: string;
  goal: string;
  spec: CompiledTaskSpec;
}

export const PRESETS: PresetItem[] = [
  {
    id: 'hn',
    name: 'Hacker News',
    badge: 'Show HN AI',
    goal: 'Monitor Hacker News for new local AI tools, ONNX libraries, and modernBERT decision engine releases',
    spec: {
      id: 'task-hn-ai-01',
      name: 'Hacker News Show HN AI Monitor',
      userGoal: 'Monitor Hacker News for new local AI tools and ONNX libraries',
      targetUrl: 'https://news.ycombinator.com',
      domSelector: '.athing',
      pollIntervalMs: 500,
      scrollStepPx: 300,
      questions: {
        topic: {
          type: 'choice',
          question: 'What is the main topic of this post?',
          options: ['local_ai', 'web_dev', 'crypto', 'other'],
        },
        is_relevant: {
          type: 'noul',
          statement: 'This post announces or discusses local AI, ONNX, or offline machine learning.',
        },
      },
      alertRule: {
        questionKey: 'topic',
        operator: 'equals',
        targetValue: 'local_ai',
        minAnswerConfidence: 0.80,
      },
      createdAt: Date.now(),
    },
  },
  {
    id: 'reddit',
    name: 'Reddit',
    badge: 'r/LocalLLaMA',
    goal: 'Scout r/LocalLLaMA for GGUF and INT8 quantization benchmarks',
    spec: {
      id: 'task-reddit-localllama-01',
      name: 'Reddit LocalLlama Quantization Monitor',
      userGoal: 'Scout r/LocalLLaMA for GGUF and INT8 quantization benchmarks',
      targetUrl: 'https://reddit.com/r/LocalLLaMA',
      domSelector: 'shreddit-post, .thing',
      pollIntervalMs: 800,
      scrollStepPx: 450,
      questions: {
        relevance: {
          type: 'choice',
          question: 'Is this post discussing model quantization or benchmarks?',
          options: ['quantization_or_benchmark', 'general_discussion', 'meme_or_fluff'],
        },
      },
      alertRule: {
        questionKey: 'relevance',
        operator: 'equals',
        targetValue: 'quantization_or_benchmark',
        minAnswerConfidence: 0.85,
      },
      createdAt: Date.now(),
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    badge: 'Trending AI',
    goal: 'Track trending repositories related to local offline LLMs and ONNX runtime tools',
    spec: {
      id: 'task-github-ai-01',
      name: 'GitHub Trending AI Scout',
      userGoal: 'Track trending repositories related to local offline LLMs and ONNX runtime tools',
      targetUrl: 'https://github.com/trending',
      domSelector: '.Box-row',
      pollIntervalMs: 1000,
      scrollStepPx: 400,
      questions: {
        category: {
          type: 'choice',
          question: 'What is the primary category of this project?',
          options: ['ai_ml_tools', 'developer_utilities', 'documentation', 'other'],
        },
        quality_score: {
          type: 'score',
          question: 'Rate repository stars/impact score',
          rubric: {
            1: 'under 100 stars',
            2: '100-500 stars',
            3: '500-2k stars',
            4: '2k-10k stars',
            5: '10k+ viral',
          },
        },
      },
      alertRule: {
        questionKey: 'category',
        operator: 'equals',
        targetValue: 'ai_ml_tools',
        minAnswerConfidence: 0.80,
      },
      createdAt: Date.now(),
    },
  },
  {
    id: 'generic',
    name: 'Generic Web',
    badge: 'Universal',
    goal: 'Scan page for announcements and technical breakthroughs',
    spec: {
      id: 'task-generic-01',
      name: 'Generic Web Page Scout',
      userGoal: 'Scan page for announcements and technical breakthroughs',
      targetUrl: 'https://example.com',
      domSelector: 'article, .post, .item',
      pollIntervalMs: 600,
      scrollStepPx: 350,
      questions: {
        is_announcement: {
          type: 'noul',
          statement: 'This content is a formal technical announcement or release.',
        },
      },
      alertRule: {
        questionKey: 'is_announcement',
        operator: 'boolean_true',
        targetValue: true,
        minAnswerConfidence: 0.80,
      },
      createdAt: Date.now(),
    },
  },
];
