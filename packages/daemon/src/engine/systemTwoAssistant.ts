import type { CompiledTaskSpec, ScrapedItem, ResultStats } from '@ofln-scout/shared';
import { sanitizeCompiledSpec, resolveOllamaTimeout } from './compiler.js';

export function computeResultStats(
  items: ScrapedItem[],
  totalScanned?: number,
  avgLatencyMs = 0
): ResultStats {
  const scanned = totalScanned !== undefined ? Math.max(totalScanned, items.length) : items.length;
  const alerts = items.filter((i) => i.triggeredAlert).length;
  const matchRate = scanned > 0 ? Math.round((alerts / scanned) * 1000) / 10 : 0;

  const topCategories: Record<string, number> = Object.create(null);
  for (const item of items) {
    if (!item.answers) continue;
    for (const val of Object.values(item.answers)) {
      if (typeof val === 'string' && val.trim().length > 0 && val !== 'true' && val !== 'false') {
        const cat = val.trim();
        topCategories[cat] = (topCategories[cat] || 0) + 1;
      } else if (typeof val === 'object' && val !== null && typeof (val as any).answer === 'string') {
        const cat = (val as any).answer.trim();
        if (cat.length > 0 && cat !== 'true' && cat !== 'false') {
          topCategories[cat] = (topCategories[cat] || 0) + 1;
        }
      }
    }
  }

  const sortedEntries = Object.entries(topCategories).sort(([, a], [, b]) => b - a);
  const cleanCategories = Object.fromEntries(sortedEntries);

  return {
    totalScanned: scanned,
    totalAlerts: alerts,
    matchRatePercent: matchRate,
    avgLatencyMs,
    topCategories: cleanCategories,
  };
}

export async function generateResultsSummary(
  items: ScrapedItem[],
  stats: ResultStats,
  userGoal: string,
  model?: string
): Promise<string> {
  const ollamaBaseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const defaultModel = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct-q4_K_M';
  const primaryModel = model || defaultModel;
  const modelsToTry = Array.from(new Set([primaryModel, defaultModel, 'qwen2.5', 'llama3.2']));

  const sampleItems = items
    .slice(0, 5)
    .map(
      (item, idx) =>
        `${idx + 1}. [${(item.text || '').slice(0, 80)}](${item.link || 'N/A'}) - Confidence: ${(item.confidence * 100).toFixed(0)}%`
    )
    .join('\n');

  const prompt = `You are a System 2 AI Assistant for Scout, an offline browser agent.
User Goal: "${userGoal}"

Statistics:
- Total Scanned: ${stats.totalScanned}
- Total Alerts: ${stats.totalAlerts}
- Match Rate: ${stats.matchRatePercent}%
- Average Latency: ${stats.avgLatencyMs}ms
- Top Categories: ${JSON.stringify(stats.topCategories)}

Discovered Samples:
${sampleItems || 'No items extracted yet.'}

Provide a concise, professional executive summary in Markdown format.
Include an overview of findings, key metrics, notable items, and whether the user's goal was met.`;

  const effectiveTimeout = resolveOllamaTimeout();
  for (const currentModel of modelsToTry) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);
    try {
      const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: currentModel,
          prompt,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (response.ok) {
        const body = (await response.json()) as { response?: string };
        if (body.response && body.response.trim().length > 0) {
          return body.response.trim();
        }
      }
    } catch {
      // Continue to next model or offline fallback
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // 100% Deterministic Rule-Based Offline Fallback
  const notableList = items
    .filter((i) => i.triggeredAlert || i.confidence >= 0.8)
    .slice(0, 3)
    .map(
      (i, idx) =>
        `${idx + 1}. **${(i.text || '').slice(0, 75)}...** (Confidence: ${(i.confidence * 100).toFixed(0)}%)${i.link ? ` - [Link](${i.link})` : ''}`
    )
    .join('\n');

  const catBreakdown = Object.entries(stats.topCategories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat, count]) => `- **${cat}**: ${count}`)
    .join('\n');

  return `### Executive Summary
Scout monitored web content for the goal: **${userGoal}**. During this run, **${stats.totalScanned}** elements were scanned, detecting **${stats.totalAlerts}** high-confidence matches (${stats.matchRatePercent}% match rate).

### Key Metrics
- **Total Scanned**: ${stats.totalScanned}
- **Total Matches**: ${stats.totalAlerts}
- **Match Rate**: ${stats.matchRatePercent}%
- **Avg Inference Latency**: ${stats.avgLatencyMs}ms
${catBreakdown ? `\n### Top Categories\n${catBreakdown}` : ''}

### Notable Matches
${notableList || 'No high-confidence alerts detected in this run.'}

### Assessment
Execution completed successfully. Results are persisted to markdown and ready for interactive query and steering.`;
}

export async function queryResults(
  query: string,
  items: ScrapedItem[],
  summary?: string,
  model?: string
): Promise<{ answer: string; model: string }> {
  const ollamaBaseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const defaultModel = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct-q4_K_M';
  const primaryModel = model || defaultModel;
  const modelsToTry = Array.from(new Set([primaryModel, defaultModel, 'qwen2.5', 'llama3.2']));

  const itemsContext = items
    .slice(0, 10)
    .map(
      (item, idx) =>
        `Item ${idx + 1}: "${item.text || ''}" | Link: ${item.link || 'none'} | Confidence: ${(item.confidence * 100).toFixed(0)}% | Details: ${JSON.stringify(item.answers)}`
    )
    .join('\n');

  const prompt = `You are a System 2 Assistant for Scout browser agent.
Answer the user's question accurately based strictly on the scraped data below.

Executive Summary:
${summary || 'None available.'}

Scraped Data:
${itemsContext || 'No items available.'}

User Question: "${query}"

Provide a concise, direct answer. If the information is not in the data, state that clearly.`;

  const effectiveTimeout = resolveOllamaTimeout();
  for (const currentModel of modelsToTry) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);
    try {
      const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: currentModel,
          prompt,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (response.ok) {
        const body = (await response.json()) as { response?: string };
        if (body.response && body.response.trim().length > 0) {
          return { answer: body.response.trim(), model: currentModel };
        }
      }
    } catch {
      // Offline fallback
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // 100% Deterministic Keyword / Heuristic Offline Fallback
  const qLower = query.toLowerCase();

  // Aggregate questions
  if (qLower.includes('how many') || qLower.includes('total') || qLower.includes('count')) {
    const alerts = items.filter((i) => i.triggeredAlert).length;
    return {
      answer: `There are ${items.length} total scraped item(s) with ${alerts} matching alert(s).`,
      model: 'offline-heuristic',
    };
  }

  // Keyword matching
  const stopWords = new Set([
    'what', 'where', 'when', 'who', 'how', 'is', 'are', 'the', 'a', 'an', 'in',
    'of', 'for', 'to', 'any', 'there', 'show', 'me', 'list', 'about', 'tell'
  ]);
  const keywords = qLower
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  const scored = items.map((item) => {
    let score = 0;
    const textLower = (item.text || '').toLowerCase();
    for (const kw of keywords) {
      if (textLower.includes(kw)) score += 2;
      if (item.answers != null) {
        for (const val of Object.values(item.answers)) {
          if (val !== undefined && val !== null && String(val).toLowerCase().includes(kw)) {
            score += 1;
          }
        }
      }
    }
    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const matches = scored.filter((s) => s.score > 0).slice(0, 3);

  if (matches.length > 0) {
    const list = matches
      .map(
        (m, i) =>
          `${i + 1}. **${(m.item.text || '').slice(0, 80)}...** (Confidence: ${(m.item.confidence * 100).toFixed(0)}%)${m.item.link ? ` - [Link](${m.item.link})` : ''}`
      )
      .join('\n');
    return {
      answer: `Found ${matches.length} relevant item(s) for "${query}":\n\n${list}`,
      model: 'offline-heuristic',
    };
  }

  return {
    answer: `No items in the scraped results matched "${query}". Scanned ${items.length} total items.`,
    model: 'offline-heuristic',
  };
}

export async function steerTask(
  instruction: string,
  currentSpec: CompiledTaskSpec,
  model?: string
): Promise<{ updatedSpec: CompiledTaskSpec; explanation: string; applied: boolean }> {
  const ollamaBaseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const defaultModel = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct-q4_K_M';
  const primaryModel = model || defaultModel;
  const modelsToTry = Array.from(new Set([primaryModel, defaultModel, 'qwen2.5', 'llama3.2']));

  const systemPrompt = `You are a System 2 Task Steering Controller for Scout browser agent.
The user wants to steer the active scraping task: "${instruction}".
Current Task Spec:
${JSON.stringify(currentSpec, null, 2)}

Return a JSON object:
{
  "explanation": "Human-readable explanation of changes",
  "updatedSpec": { ...updated CompiledTaskSpec... }
}`;

  for (const currentModel of modelsToTry) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: currentModel,
          prompt: systemPrompt,
          stream: false,
          format: 'json',
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const body = (await response.json()) as { response?: string };
        if (body.response) {
          const parsed = JSON.parse(body.response);
          if (parsed.updatedSpec) {
            const sanitized = sanitizeCompiledSpec(parsed.updatedSpec);
            if (sanitized.valid && sanitized.sanitizedSpec) {
              return {
                updatedSpec: sanitized.sanitizedSpec,
                explanation: parsed.explanation || 'Applied task steering update.',
                applied: true,
              };
            }
          }
        }
      }
    } catch {
      // Offline fallback
    }
  }

  // 100% Deterministic Rule-Based Offline Fallback
  const updated = JSON.parse(JSON.stringify(currentSpec)) as CompiledTaskSpec;
  const changes: string[] = [];

  // URL detection
  const urlMatch = instruction.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    const cleanUrl = urlMatch[0].replace(/[,.;:'"!?)]+$/, '');
    updated.targetUrl = cleanUrl;
    changes.push(`Updated target URL to ${cleanUrl}`);
  }

  // Scroll step
  const scrollMatch = instruction.match(/scroll\s*(?:step)?\s*(?:to|=)?\s*(\d+)/i);
  if (scrollMatch) {
    updated.scrollStepPx = Math.max(50, Math.min(2000, Number(scrollMatch[1])));
    changes.push(`Updated scroll step to ${updated.scrollStepPx}px`);
  } else if (/scroll faster/i.test(instruction)) {
    updated.scrollStepPx = Math.min(1000, (updated.scrollStepPx || 400) + 200);
    changes.push(`Increased scroll step to ${updated.scrollStepPx}px`);
  } else if (/scroll slower/i.test(instruction)) {
    updated.scrollStepPx = Math.max(100, (updated.scrollStepPx || 400) - 150);
    changes.push(`Decreased scroll step to ${updated.scrollStepPx}px`);
  }

  // Poll interval
  const pollMatch = instruction.match(/poll\s*(?:interval)?\s*(?:to|=)?\s*(\d+)/i);
  if (pollMatch) {
    updated.pollIntervalMs = Math.max(50, Math.min(10000, Number(pollMatch[1])));
    changes.push(`Updated poll interval to ${updated.pollIntervalMs}ms`);
  } else if (/poll faster|faster poll/i.test(instruction)) {
    updated.pollIntervalMs = Math.max(100, Math.round((updated.pollIntervalMs || 800) / 2));
    changes.push(`Decreased poll interval to ${updated.pollIntervalMs}ms`);
  } else if (/poll slower|slower poll/i.test(instruction)) {
    updated.pollIntervalMs = Math.min(5000, (updated.pollIntervalMs || 800) + 500);
    changes.push(`Increased poll interval to ${updated.pollIntervalMs}ms`);
  }

  // Confidence threshold
  const confMatch = instruction.match(/confidence\s*(?:to|=)?\s*(0\.\d+)/i);
  if (confMatch) {
    updated.alertRule.minAnswerConfidence = Math.max(0.50, Math.min(0.99, Math.round(parseFloat(confMatch[1]) * 100) / 100));
    changes.push(`Updated minimum confidence to ${updated.alertRule.minAnswerConfidence}`);
  } else if (/lower confidence/i.test(instruction)) {
    const cur = updated.alertRule.minAnswerConfidence || 0.8;
    updated.alertRule.minAnswerConfidence = Math.max(0.50, Math.round((cur - 0.1) * 100) / 100);
    changes.push(`Lowered minimum confidence to ${updated.alertRule.minAnswerConfidence.toFixed(2)}`);
  } else if (/raise confidence|higher confidence/i.test(instruction)) {
    const cur = updated.alertRule.minAnswerConfidence || 0.8;
    updated.alertRule.minAnswerConfidence = Math.min(0.99, Math.round((cur + 0.1) * 100) / 100);
    changes.push(`Raised minimum confidence to ${updated.alertRule.minAnswerConfidence.toFixed(2)}`);
  }

  // Selector
  const selMatch = instruction.match(/selector\s*(?:to|=)?\s*['"]?([.#a-zA-Z0-9_\-\s,]+)['"]?/i);
  if (selMatch && selMatch[1].trim()) {
    updated.domSelector = selMatch[1].trim();
    changes.push(`Updated DOM selector to "${updated.domSelector}"`);
  }

  // Goal update
  const goalMatch = instruction.match(/(?:look for|search for|monitor for|goal to|track)\s+["']?([^"']+)["']?/i);
  if (goalMatch) {
    updated.userGoal = goalMatch[1].trim();
    changes.push(`Updated user goal to "${updated.userGoal}"`);
  }

  const sanitized = sanitizeCompiledSpec(updated);
  if (changes.length > 0 && sanitized.valid && sanitized.sanitizedSpec) {
    return {
      updatedSpec: sanitized.sanitizedSpec,
      explanation: changes.join('. ') + '.',
      applied: true,
    };
  }

  return {
    updatedSpec: currentSpec,
    explanation: `Unable to parse steering instruction: "${instruction}". No updates applied.`,
    applied: false,
  };
}
