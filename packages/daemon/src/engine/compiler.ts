import type {
  CompiledTaskSpec,
  LayaChoiceQuestion,
  LayaNoulQuestion,
  LayaScoreQuestion,
  LayaQuestionMap,
  AlertRule
} from '@ofln-scout/shared';
import { llamaEngine, GGUF_CATALOG } from './llamaEngine.js';

/**
 * Standard CSS selector presets for popular websites and generic web articles.
 */
export const SELECTOR_PRESETS = {
  hn: '.athing, tr.athing',
  reddit: 'shroot, [data-testid="post-container"], div.Post',
  github: 'article.Box-row, div.Box-row, li.repo-list-item',
  generic: 'article, div.post, div.card, li.item, [role="article"]'
} as const;

/**
 * Standard System 2 larger models supported by Ollama.
 */
export const SYSTEM_TWO_LARGER_MODELS = [
  'qwen2.5:14b',
  'qwen2.5:32b',
  'deepseek-r1:14b',
  'llama3.3:70b'
] as const;

/**
 * Standard default System 2 models provided by Ollama, including larger model options.
 */
export const DEFAULT_OLLAMA_MODELS = [
  'qwen2.5',
  'llama3.2',
  'deepseek-r1',
  'mistral',
  'qwen2.5:14b',
  'qwen2.5:32b',
  'deepseek-r1:14b',
  'llama3.3:70b'
];

/**
 * Default Ollama request timeout in milliseconds (60 seconds) to accommodate
 * cold-start weight loading for larger 14B, 32B, and 70B models.
 */
export const DEFAULT_OLLAMA_TIMEOUT_MS = 60000;

/**
 * Resolve effective Ollama timeout honoring custom parameter, environment variable, or default.
 */
export function resolveOllamaTimeout(customTimeoutMs?: number): number {
  if (typeof customTimeoutMs === 'number' && customTimeoutMs > 0 && Number.isFinite(customTimeoutMs)) {
    return customTimeoutMs;
  }
  if (process.env.OLLAMA_TIMEOUT_MS) {
    const parsed = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_OLLAMA_TIMEOUT_MS;
}

export interface OllamaRunningModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
  expiresAt?: string;
  sizeVram: number;
  vramUsageMb: number;
  gpuOffloaded: boolean;
}

export interface OllamaProcessStatus {
  online: boolean;
  models: OllamaRunningModel[];
  activeModelName?: string;
  totalVramUsageMb: number;
  gpuOffloaded: boolean;
}

/**
 * Query Ollama /api/ps endpoint to inspect active models in memory, VRAM footprint,
 * and GPU offload status. Returns 100% resilient defaults when Ollama is offline.
 */
export async function fetchOllamaPs(
  baseUrl?: string,
  timeoutMs = 3000
): Promise<OllamaProcessStatus> {
  const ollamaBaseUrl = baseUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${ollamaBaseUrl}/api/ps`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    if (response.ok) {
      const data = (await response.json()) as {
        models?: Array<{
          name?: string;
          model?: string;
          size?: number;
          digest?: string;
          details?: any;
          expires_at?: string;
          size_vram?: number;
        }>;
      };

      if (Array.isArray(data.models)) {
        const runningModels: OllamaRunningModel[] = data.models.map((m) => {
          const sizeVram = m.size_vram || 0;
          const vramUsageMb = Math.round(sizeVram / (1024 * 1024));
          return {
            name: m.name || m.model || '',
            model: m.model || m.name || '',
            size: m.size || 0,
            digest: m.digest || '',
            details: m.details,
            expiresAt: m.expires_at,
            sizeVram,
            vramUsageMb,
            gpuOffloaded: sizeVram > 0
          };
        });

        const totalVramUsageMb = runningModels.reduce((acc, m) => acc + m.vramUsageMb, 0);
        const hasGpuOffload = runningModels.some((m) => m.gpuOffloaded);
        const activeModelName = runningModels.length > 0 ? runningModels[0].name : undefined;

        return {
          online: true,
          models: runningModels,
          activeModelName,
          totalVramUsageMb,
          gpuOffloaded: hasGpuOffload
        };
      }
      return { online: true, models: [], totalVramUsageMb: 0, gpuOffloaded: false };
    }
  } catch {
    // Offline, timeout, or 404
  } finally {
    clearTimeout(timeoutId);
  }

  return { online: false, models: [], totalVramUsageMb: 0, gpuOffloaded: false };
}

/**
 * Get comprehensive System 2 model status for telemetry and UI badges,
 * combining /api/tags discovery with /api/ps process telemetry.
 */
export async function getSystemTwoModelStats(
  selectedModel = 'qwen2.5',
  baseUrl?: string
): Promise<{
  modelName: string;
  availableModels: string[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  vramUsageMb?: number;
  gpuOffloaded?: boolean;
  error?: string;
}> {
  // 1. If baseUrl is explicitly specified (e.g. in test harness or remote Ollama), check that endpoint directly
  if (baseUrl) {
    const [tagsRes, psRes] = await Promise.all([
      fetchOllamaModels(baseUrl),
      fetchOllamaPs(baseUrl)
    ]);

    const isOnline = tagsRes.online || psRes.online;
    const availableModels = tagsRes.models.length > 0 ? tagsRes.models : [...DEFAULT_OLLAMA_MODELS];

    if (!isOnline) {
      return {
        modelName: selectedModel,
        availableModels,
        status: 'idle',
        vramUsageMb: 0,
        gpuOffloaded: false,
        error: 'Ollama daemon offline (offline template fallback active)'
      };
    }

    const active = psRes.models.find(
      (m) => m.name === selectedModel || m.model === selectedModel || m.name.startsWith(selectedModel)
    ) || psRes.models[0];

    return {
      modelName: active ? active.name : selectedModel,
      availableModels,
      status: 'ready',
      vramUsageMb: active ? active.vramUsageMb : psRes.totalVramUsageMb,
      gpuOffloaded: active ? active.gpuOffloaded : psRes.gpuOffloaded
    };
  }

  // 2. Check embedded llamaEngine (hardware-accelerated via Vulkan/CUDA/DirectML)
  try {
    const telemetry = await llamaEngine.getTelemetry();
    const ggufList = llamaEngine.getModelsList();
    const availableModels = ggufList.map((m) => m.id);

    if (llamaEngine.isReady()) {
      return {
        modelName: llamaEngine.getActiveModelId() || selectedModel,
        availableModels,
        status: 'ready',
        vramUsageMb: telemetry.vramUsageMb,
        gpuOffloaded: telemetry.gpuOffloaded
      };
    }

    const downloaded = ggufList.filter((m) => m.downloaded);
    if (downloaded.length > 0) {
      return {
        modelName: downloaded[0].id,
        availableModels,
        status: 'idle',
        vramUsageMb: telemetry.vramUsageMb,
        gpuOffloaded: telemetry.gpuOffloaded,
        error: `Downloaded models available on disk: ${downloaded.map((m) => m.name).join(', ')} (activate to load onto ${telemetry.gpuName})`
      };
    }

    return {
      modelName: selectedModel,
      availableModels: availableModels.length > 0 ? availableModels : GGUF_CATALOG.map((m) => m.id),
      status: 'idle',
      vramUsageMb: telemetry.vramUsageMb,
      gpuOffloaded: telemetry.gpuOffloaded,
      error: `Embedded llama.cpp active on ${telemetry.gpuName} (${telemetry.gpuBackend}). Download a model below to run on GPU.`
    };
  } catch {
    // Fallback if llamaEngine cannot initialize
    return {
      modelName: selectedModel,
      availableModels: GGUF_CATALOG.map((m) => m.id),
      status: 'idle',
      vramUsageMb: 0,
      gpuOffloaded: false,
      error: 'Offline template fallback active'
    };
  }
}

/**
 * Discover locally available Ollama models via GET /api/tags.
 * Returns online status and array of installed model tags, falling back gracefully
 * to standard model definitions if Ollama daemon is offline.
 */
export async function fetchOllamaModels(
  baseUrl?: string
): Promise<{ online: boolean; models: string[] }> {
  const ollamaBaseUrl = baseUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(`${ollamaBaseUrl}/api/tags`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    if (response.ok) {
      const data = (await response.json()) as {
        models?: Array<{ name?: string; model?: string }>;
      };
      if (Array.isArray(data.models) && data.models.length > 0) {
        const names = data.models
          .map((m) => m.name || m.model || '')
          .filter(Boolean);
        return {
          online: true,
          models: names.length > 0 ? names : DEFAULT_OLLAMA_MODELS
        };
      }
      return { online: true, models: DEFAULT_OLLAMA_MODELS };
    }
  } catch {
    // Connection refused, timeout, or network offline
  } finally {
    clearTimeout(timeoutId);
  }

  return { online: false, models: DEFAULT_OLLAMA_MODELS };
}

/**
 * Estimate token count using standard whitespace/word heuristic (word count * 1.3).
 */
export function estimateTokens(text: string): number {
  if (!text || typeof text !== 'string') return 0;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  return Math.ceil(words.length * 1.3);
}

export interface SanitizerResult {
  valid: boolean;
  errors: string[];
  sanitizedSpec?: CompiledTaskSpec;
}

/**
 * Post-compilation sanitizer:
 * - Choice question options auto-deduplicated and clamped to <= 20 distinct entries.
 * - Choice question requires at least one option.
 * - Question instructions + criteria auto-truncated to < 160 estimated tokens (below 192 limit).
 * - Default minAnswerConfidence to 0.80 clamped in [0.50, 0.99].
 */
export function sanitizeCompiledSpec(rawSpec: any): SanitizerResult {
  const errors: string[] = [];

  if (!rawSpec || typeof rawSpec !== 'object') {
    return { valid: false, errors: ['Spec must be a non-null object'] };
  }

  // Clone spec to avoid mutating original
  const spec = JSON.parse(JSON.stringify(rawSpec));

  // 1. Validate and sanitize alertRule
  if (!spec.alertRule || typeof spec.alertRule !== 'object') {
    errors.push('Missing alertRule');
  } else {
    if (typeof spec.alertRule.minAnswerConfidence !== 'number') {
      spec.alertRule.minAnswerConfidence = 0.80;
    } else {
      spec.alertRule.minAnswerConfidence = Math.max(
        0.50,
        Math.min(0.99, spec.alertRule.minAnswerConfidence)
      );
    }
    if (!spec.alertRule.operator) {
      spec.alertRule.operator = 'equals';
    }
  }

  // 2. Validate and sanitize questions map
  if (!spec.questions || typeof spec.questions !== 'object') {
    errors.push('Missing or invalid questions map');
  } else {
    const questionEntries = Object.entries(spec.questions);
    if (questionEntries.length === 0) {
      errors.push('Questions map must contain at least one question');
    }

    for (const [key, q] of questionEntries as [string, any][]) {
      if (!q || typeof q !== 'object') {
        errors.push(`Question "${key}" is not an object`);
        continue;
      }

      if (q.type === 'choice') {
        let opts: string[] = [];
        if (Array.isArray(q.options)) {
          opts = q.options;
        } else if (typeof q.options === 'object' && q.options !== null) {
          opts = Object.values(q.options);
        } else {
          errors.push(`Choice question "${key}" requires at least one option`);
          continue;
        }

        // Auto-deduplicate duplicate option labels while preserving order
        opts = Array.from(new Set(opts.map((o: any) => String(o))));

        // Cardinality Auto-Sanitization: require at least 1 option
        if (opts.length === 0) {
          errors.push(`Choice question "${key}" requires at least one option`);
          continue;
        }

        // Auto-slice to max 20 options
        if (opts.length > 20) {
          opts = opts.slice(0, 20);
        }
        q.options = opts;

        // Token Boundary Auto-Sanitization (< 160 tokens)
        let textLen = (q.question || '') + ' ' + opts.join(' ');
        if (estimateTokens(textLen) >= 160) {
          const words = (q.question || '').trim().split(/\s+/).filter(Boolean);
          while (words.length > 1 && estimateTokens(words.join(' ') + ' ' + opts.join(' ')) >= 160) {
            words.pop();
          }
          q.question = words.join(' ');

          // If still >= 160 tokens due to option criteria, truncate options
          if (estimateTokens((q.question || '') + ' ' + opts.join(' ')) >= 160) {
            for (let i = opts.length - 1; i >= 0; i--) {
              const optWords = opts[i].trim().split(/\s+/).filter(Boolean);
              while (optWords.length > 1 && estimateTokens((q.question || '') + ' ' + opts.join(' ')) >= 160) {
                optWords.pop();
                opts[i] = optWords.join(' ');
              }
            }
            while (opts.length > 1 && estimateTokens((q.question || '') + ' ' + opts.join(' ')) >= 160) {
              opts.pop();
            }
            q.options = opts;
          }
        }
      } else if (q.type === 'noul') {
        // Token Boundary Auto-Sanitization for noul question (< 160 tokens)
        let stmt = typeof q.statement === 'string' ? q.statement : '';
        if (estimateTokens(stmt) >= 160) {
          const words = stmt.trim().split(/\s+/).filter(Boolean);
          while (words.length > 1 && estimateTokens(words.join(' ')) >= 160) {
            words.pop();
          }
          stmt = words.join(' ');
          q.statement = stmt;
        }
      } else if (q.type === 'score') {
        let rubricVals: string[] = [];
        if (q.rubric) {
          if (Array.isArray(q.rubric)) {
            rubricVals = q.rubric.map((r: any) => String(r));
          } else if (typeof q.rubric === 'object') {
            rubricVals = Object.keys(q.rubric)
              .sort((a, b) => Number(a) - Number(b))
              .map((k) => String((q.rubric as any)[k]));
          }
        }

        // Token Boundary Auto-Sanitization for score question (< 160 tokens)
        let textLen = (q.question || '') + ' ' + rubricVals.join(' ');
        if (estimateTokens(textLen) >= 160) {
          const words = (q.question || '').trim().split(/\s+/).filter(Boolean);
          while (words.length > 1 && estimateTokens(words.join(' ') + ' ' + rubricVals.join(' ')) >= 160) {
            words.pop();
          }
          q.question = words.join(' ');

          // If still >= 160 tokens, truncate rubric criteria
          if (estimateTokens((q.question || '') + ' ' + rubricVals.join(' ')) >= 160) {
            for (let i = rubricVals.length - 1; i >= 0; i--) {
              const rWords = rubricVals[i].trim().split(/\s+/).filter(Boolean);
              while (rWords.length > 1 && estimateTokens((q.question || '') + ' ' + rubricVals.join(' ')) >= 160) {
                rWords.pop();
                rubricVals[i] = rWords.join(' ');
              }
            }
            if (Array.isArray(q.rubric)) {
              q.rubric = rubricVals;
            } else if (typeof q.rubric === 'object' && q.rubric !== null) {
              const keys = Object.keys(q.rubric).sort((a, b) => Number(a) - Number(b));
              keys.forEach((k, idx) => {
                if (rubricVals[idx] !== undefined) {
                  q.rubric[k] = rubricVals[idx];
                }
              });
            }
          }
        }
      } else {
        errors.push(`Unknown question type "${q.type}" in question "${key}"`);
      }
    }
  }

  // Ensure default metadata
  if (!spec.id) {
    spec.id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }
  if (!spec.name) {
    spec.name = 'Scout Task';
  }
  if (!spec.targetUrl) {
    spec.targetUrl = 'https://news.ycombinator.com';
  }
  if (!spec.domSelector) {
    spec.domSelector = SELECTOR_PRESETS.generic;
  }
  if (typeof spec.pollIntervalMs !== 'number' || spec.pollIntervalMs <= 0) {
    spec.pollIntervalMs = 800;
  }
  if (typeof spec.scrollStepPx !== 'number' || spec.scrollStepPx <= 0) {
    spec.scrollStepPx = 400;
  }
  if (!spec.createdAt) {
    spec.createdAt = Date.now();
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedSpec: errors.length === 0 ? (spec as CompiledTaskSpec) : undefined
  };
}

/**
 * Deterministic task specification generator for built-in presets.
 */
export function getPresetTaskSpec(
  presetKey: 'hn' | 'reddit' | 'github' | 'generic' | string,
  userGoal?: string
): CompiledTaskSpec {
  const now = Date.now();
  const normalizedKey = presetKey.toLowerCase();

  if (normalizedKey.includes('hn') || normalizedKey.includes('hacker') || normalizedKey.includes('ycombinator')) {
    return {
      id: `task-hn-${now}`,
      name: 'Hacker News Show HN AI Monitor',
      userGoal: userGoal || 'Monitor Hacker News for new local AI tools and ONNX libraries',
      targetUrl: 'https://news.ycombinator.com',
      domSelector: SELECTOR_PRESETS.hn,
      pollIntervalMs: 800,
      scrollStepPx: 400,
      questions: {
        topic: {
          type: 'choice',
          question: 'What is the main topic of this post?',
          options: ['local_ai', 'web_dev', 'crypto', 'other']
        },
        is_relevant: {
          type: 'noul',
          statement: 'This post announces or discusses local AI, ONNX, or offline machine learning.'
        }
      },
      alertRule: {
        questionKey: 'topic',
        operator: 'equals',
        targetValue: 'local_ai',
        minAnswerConfidence: 0.80
      },
      createdAt: now
    };
  }

  if (normalizedKey.includes('reddit') || normalizedKey.includes('localllama')) {
    return {
      id: `task-reddit-${now}`,
      name: 'Reddit LocalLlama Quantization Monitor',
      userGoal: userGoal || 'Scout r/LocalLLaMA for GGUF and INT8 quantization benchmarks',
      targetUrl: 'https://reddit.com/r/LocalLLaMA',
      domSelector: SELECTOR_PRESETS.reddit,
      pollIntervalMs: 1000,
      scrollStepPx: 450,
      questions: {
        relevance: {
          type: 'choice',
          question: 'Is this post discussing model quantization or benchmarks?',
          options: ['quantization_or_benchmark', 'general_discussion', 'meme_or_fluff']
        },
        quality: {
          type: 'score',
          question: 'Rate the technical depth and benchmark quality of this post',
          rubric: {
            1: 'superficial or fluff',
            2: 'basic overview without benchmarks',
            3: 'detailed benchmarks with setup details',
            4: 'rigorous reproducible benchmark suite'
          }
        }
      },
      alertRule: {
        questionKey: 'relevance',
        operator: 'equals',
        targetValue: 'quantization_or_benchmark',
        minAnswerConfidence: 0.85
      },
      createdAt: now
    };
  }

  if (normalizedKey.includes('github') || normalizedKey.includes('repo') || normalizedKey.includes('trending')) {
    return {
      id: `task-github-${now}`,
      name: 'GitHub Trending Scout',
      userGoal: userGoal || 'Scout GitHub Trending for machine learning and AI devtools',
      targetUrl: 'https://github.com/trending',
      domSelector: SELECTOR_PRESETS.github,
      pollIntervalMs: 1200,
      scrollStepPx: 400,
      questions: {
        category: {
          type: 'choice',
          question: 'What is the primary category of this project?',
          options: ['ai_ml', 'devtools', 'web', 'other']
        },
        is_trending_ai: {
          type: 'noul',
          statement: 'This repository is a notable local AI tool or machine learning library.'
        }
      },
      alertRule: {
        questionKey: 'category',
        operator: 'equals',
        targetValue: 'ai_ml',
        minAnswerConfidence: 0.80
      },
      createdAt: now
    };
  }

  // Generic fallback preset
  // Extract URL from user goal if present
  let targetUrl = 'https://news.ycombinator.com';
  const urlMatch = userGoal?.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    targetUrl = urlMatch[0];
  }

  return {
    id: `task-scout-${now}`,
    name: 'Web Content Scout',
    userGoal: userGoal || 'Monitor webpage for relevant content',
    targetUrl,
    domSelector: SELECTOR_PRESETS.generic,
    pollIntervalMs: 1000,
    scrollStepPx: 400,
    questions: {
      is_relevant: {
        type: 'noul',
        statement: userGoal
          ? `This item matches the criteria: ${userGoal.slice(0, 100)}`
          : 'This item matches the search goal.'
      }
    },
    alertRule: {
      questionKey: 'is_relevant',
      operator: 'boolean_true',
      targetValue: true,
      minAnswerConfidence: 0.80
    },
    createdAt: now
  };
}

/**
 * System 2 Natural-Language Task Compiler.
 * Queries local Ollama (POST /api/generate with format: "json") using primary
 * model `qwen2.5:7b-instruct-q4_K_M` (fallback `llama3.2`).
 * If a custom model is requested via `model`, routes to that model first.
 * If Ollama is offline or times out (default 60000ms), seamlessly falls back to
 * deterministic task generation with preset templates.
 */
export async function compileTask(
  userGoal: string,
  model?: string,
  timeoutMs?: number
): Promise<CompiledTaskSpec> {
  const ollamaBaseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const defaultPrimary = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct-q4_K_M';
  const primaryModel = model || defaultPrimary;
  const fallbackModel = 'llama3.2';
  const effectiveTimeout = resolveOllamaTimeout(timeoutMs);

  const modelsToTry: string[] = [];
  if (primaryModel) modelsToTry.push(primaryModel);
  if (!modelsToTry.includes(defaultPrimary)) modelsToTry.push(defaultPrimary);
  if (!modelsToTry.includes(fallbackModel)) modelsToTry.push(fallbackModel);

  const systemPrompt = `You are a System 2 AI Task Compiler for Ofln-Scout, an offline browser automation tool.
Given a user goal, output a valid JSON object matching the CompiledTaskSpec interface:
{
  "name": "Short Descriptive Title",
  "userGoal": "User goal prompt",
  "targetUrl": "https://news.ycombinator.com",
  "domSelector": ".athing, tr.athing",
  "pollIntervalMs": 800,
  "scrollStepPx": 400,
  "questions": {
    "topic": {
      "type": "choice",
      "question": "What is the topic?",
      "options": ["ai", "crypto", "web", "other"]
    },
    "is_relevant": {
      "type": "noul",
      "statement": "This post announces or discusses AI."
    }
  },
  "alertRule": {
    "questionKey": "topic",
    "operator": "equals",
    "targetValue": "ai",
    "minAnswerConfidence": 0.80
  }
}
Rules:
1. "questions" must contain 1-3 questions of types: "choice" (options <= 20 distinct entries), "noul" (statement), or "score" (question and rubric).
2. "alertRule.minAnswerConfidence" must be between 0.50 and 0.99 (default 0.80).
3. "alertRule.operator" must be "equals", "gte", or "boolean_true".
4. All text instructions must be concise (< 160 tokens).
Return ONLY the JSON object.`;

  // 1. Try embedded llama.cpp engine if loaded on GPU
  if (llamaEngine.isReady()) {
    try {
      const responseText = await llamaEngine.generateText(
        `User Goal: "${userGoal}"\n\nReturn ONLY the valid JSON specification matching the schema:`,
        { systemPrompt }
      );
      if (responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          parsed.userGoal = userGoal;
          const sanitized = sanitizeCompiledSpec(parsed);
          if (sanitized.valid && sanitized.sanitizedSpec) {
            return sanitized.sanitizedSpec;
          }
        }
      }
    } catch {
      // continue to Ollama / offline template fallback
    }
  }

  // 2. Query Ollama if available
  for (const currentModel of modelsToTry) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: currentModel,
          prompt: `${systemPrompt}\n\nUser Goal: ${userGoal}`,
          stream: false,
          format: 'json'
        }),
        signal: controller.signal
      });

      if (response.ok) {
        const body = (await response.json()) as { response?: string };
        if (body.response) {
          const parsed = JSON.parse(body.response);
          parsed.userGoal = userGoal;
          const sanitized = sanitizeCompiledSpec(parsed);
          if (sanitized.valid && sanitized.sanitizedSpec) {
            return sanitized.sanitizedSpec;
          }
        }
      }
    } catch {
      // Ollama offline, connection refused, or timed out - continue to fallback
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Resilient offline fallback: Deterministic preset generation
  return getPresetTaskSpec(userGoal, userGoal);
}
