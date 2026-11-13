import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ScrapedItem, ResultStats } from '@ofln-scout/shared';

export interface TaskMetadata {
  taskId: string;
  taskName?: string;
  userGoal: string;
  targetUrl: string;
  startTime?: string | number;
  systemOneModel?: string;
  systemTwoModel?: string;
  initialSummary?: string;
}

export interface ResultsStoreOptions {
  filePath?: string;
}

/**
 * Resolves the destination path for results.md based on:
 * 1. Explicit path parameter or options.filePath
 * 2. process.env.SCOUT_RESULTS_PATH
 * 3. Workspace root (detected by pnpm-workspace.yaml or root package.json)
 * 4. Fallback to process.cwd() / results.md
 */
export function resolveResultsPath(customPath?: string): string {
  if (customPath) {
    if (customPath === ':memory:') return ':memory:';
    return path.resolve(customPath);
  }
  if (process.env.SCOUT_RESULTS_PATH) {
    return path.resolve(process.env.SCOUT_RESULTS_PATH);
  }

  let currentDir = process.cwd();
  while (currentDir !== path.parse(currentDir).root) {
    try {
      if (
        fs.existsSync(path.join(currentDir, 'pnpm-workspace.yaml')) ||
        (fs.existsSync(path.join(currentDir, 'package.json')) &&
          JSON.parse(fs.readFileSync(path.join(currentDir, 'package.json'), 'utf-8')).name === 'ofln-scout')
      ) {
        return path.resolve(currentDir, 'results.md');
      }
    } catch {
      // Traverse upward on error
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  return path.resolve(process.cwd(), 'results.md');
}

/**
 * Escapes markdown table special characters (pipe and newlines).
 */
function escapeTableText(text: string): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Truncates text to specified length with ellipsis.
 */
function truncateText(text: string, maxLen: number): string {
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
}

/**
 * Formats ISO timestamp to HH:mm:ss for compact table presentation.
 */
function formatTimeOnly(isoString: string): string {
  if (!isoString) return '—';
  try {
    const parts = isoString.split('T');
    if (parts.length > 1) {
      return parts[1].slice(0, 8);
    }
    return isoString;
  } catch {
    return isoString;
  }
}

/**
 * Formats answers map for compact table display.
 */
function formatAnswersCompact(answers: Record<string, any>): string {
  if (!answers || Object.keys(answers).length === 0) return '—';
  const pairs = Object.entries(answers).map(([k, v]) => {
    const val = typeof v === 'object' && v !== null && 'answer' in v ? (v as any).answer : v;
    return `${k}: ${val}`;
  });
  return escapeTableText(pairs.join(', '));
}

export class ResultsStore {
  private filePath: string;
  private isMemoryOnly: boolean;
  private meta: TaskMetadata | null = null;
  private items: ScrapedItem[] = [];
  private summary: string = '';
  private stats: ResultStats = {
    totalScanned: 0,
    totalAlerts: 0,
    matchRatePercent: 0,
    avgLatencyMs: 0,
    topCategories: {},
  };
  private latencySum = 0;
  private latencyCount = 0;

  constructor(filePathOrOptions?: string | ResultsStoreOptions) {
    const rawPath =
      typeof filePathOrOptions === 'string'
        ? filePathOrOptions
        : filePathOrOptions?.filePath;

    this.filePath = resolveResultsPath(rawPath);
    this.isMemoryOnly = this.filePath === ':memory:';
  }

  /**
   * Initializes a new scraping task session and resets existing records.
   * Supports either TaskMetadata or CompiledTaskSpec.
   */
  public initTask(metaOrSpec: TaskMetadata | any): void {
    const taskId = metaOrSpec.taskId || metaOrSpec.id || 'task_unknown';
    const taskName = metaOrSpec.taskName || metaOrSpec.name;
    const userGoal = metaOrSpec.userGoal || '';
    const targetUrl = metaOrSpec.targetUrl || '';
    const rawStart = metaOrSpec.startTime ?? metaOrSpec.createdAt ?? new Date().toISOString();
    const startTime = typeof rawStart === 'number' ? new Date(rawStart).toISOString() : rawStart;

    this.meta = {
      taskId,
      taskName,
      userGoal,
      targetUrl,
      startTime,
      systemOneModel: metaOrSpec.systemOneModel ?? 'Laya ModernBERT (ONNX Runtime CPU)',
      systemTwoModel: metaOrSpec.systemTwoModel ?? 'qwen2.5',
      initialSummary: metaOrSpec.initialSummary,
    };
    this.items = [];
    this.summary = metaOrSpec.initialSummary ?? 'Task initialized. Scanning target page...';
    this.latencySum = 0;
    this.latencyCount = 0;
    this.stats = {
      totalScanned: 0,
      totalAlerts: 0,
      matchRatePercent: 0,
      avgLatencyMs: 0,
      topCategories: {},
    };

    this.save();
  }

  /**
   * Records a newly scraped item, recalculates stats, and flushes to results.md.
   */
  public recordItem(item: ScrapedItem, latencyMs?: number): void {
    const cleanItem: ScrapedItem = {
      ...item,
      text: typeof item.text === 'string' ? item.text : String(item.text ?? ''),
      timestamp: item.timestamp || new Date().toISOString(),
      confidence:
        typeof item.confidence === 'number' && !isNaN(item.confidence)
          ? Math.max(0, Math.min(1, item.confidence))
          : 0,
      triggeredAlert: Boolean(item.triggeredAlert),
      answers: item.answers || {},
    };

    this.items.push(cleanItem);

    const effectiveLatency = latencyMs ?? (item as any).latencyMs;
    if (typeof effectiveLatency === 'number' && !isNaN(effectiveLatency) && effectiveLatency >= 0) {
      this.latencySum += effectiveLatency;
      this.latencyCount++;
      this.stats.avgLatencyMs = Math.round((this.latencySum / this.latencyCount) * 10) / 10;
    }

    this.recalculateStats();
    this.save();
  }

  /**
   * Alias for recordItem.
   */
  public addItem(item: ScrapedItem, latencyMs?: number): void {
    this.recordItem(item, latencyMs);
  }

  /**
   * Updates executive narrative summary and optional stats overrides.
   */
  public updateSummary(summary: string, stats?: Partial<ResultStats>): void {
    if (summary !== undefined) {
      this.summary = summary;
    }
    if (stats) {
      this.stats = {
        ...this.stats,
        ...stats,
        topCategories: {
          ...this.stats.topCategories,
          ...(stats.topCategories || {}),
        },
      };
    }
    this.save();
  }

  /**
   * Alias for updateSummary.
   */
  public setSummary(summary: string, stats?: Partial<ResultStats>): void {
    this.updateSummary(summary, stats);
  }

  /**
   * Returns a copy of all accumulated scraped items.
   */
  public getItems(): ScrapedItem[] {
    return [...this.items];
  }

  /**
   * Returns a single item by ID if present.
   */
  public getItem(id: string): ScrapedItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  /**
   * Returns a snapshot of current dataset statistics.
   */
  public getStats(): ResultStats {
    return {
      ...this.stats,
      topCategories: { ...this.stats.topCategories },
    };
  }

  /**
   * Returns current executive summary narrative text.
   */
  public getSummary(): string {
    return this.summary;
  }

  /**
   * Returns task metadata.
   */
  public getTaskMetadata(): TaskMetadata | null {
    return this.meta ? { ...this.meta } : null;
  }

  /**
   * Returns destination filepath.
   */
  public getResultsPath(): string {
    return this.filePath;
  }

  /**
   * Resets all items, summary, stats, and metadata, clearing results.md on disk.
   */
  public clear(): void {
    this.meta = null;
    this.items = [];
    this.summary = '';
    this.latencySum = 0;
    this.latencyCount = 0;
    this.stats = {
      totalScanned: 0,
      totalAlerts: 0,
      matchRatePercent: 0,
      avgLatencyMs: 0,
      topCategories: {},
    };

    if (!this.isMemoryOnly) {
      try {
        if (fs.existsSync(this.filePath)) {
          fs.writeFileSync(this.filePath, '', 'utf-8');
        }
      } catch (err: any) {
        console.warn(`[ResultsStore] Notice on clear: ${err.message}`);
      }
    }
  }

  /**
   * Generates formatted GitHub-flavored markdown content.
   */
  public getMarkdown(): string {
    const lines: string[] = [];

    // 1. Header Title
    lines.push('# sysOne Scout Results\n');

    // 2. Task Metadata Section
    lines.push('## Task Metadata');
    if (this.meta) {
      lines.push(`- **Task ID**: \`${this.meta.taskId}\``);
      if (this.meta.taskName) {
        lines.push(`- **Task Name**: ${this.meta.taskName}`);
      }
      lines.push(`- **Goal**: ${this.meta.userGoal}`);
      lines.push(`- **Target URL**: ${this.meta.targetUrl}`);
      const formattedTime =
        typeof this.meta.startTime === 'number'
          ? new Date(this.meta.startTime).toISOString()
          : this.meta.startTime;
      lines.push(`- **Started**: ${formattedTime}`);
      lines.push(`- **System 1 Model**: ${this.meta.systemOneModel || 'Laya ModernBERT (ONNX Runtime CPU)'}`);
      lines.push(`- **System 2 Model**: ${this.meta.systemTwoModel || 'qwen2.5'}`);
    } else {
      lines.push('*No active task configured.*');
    }
    lines.push('');

    // 3. Executive Summary Section
    lines.push('## Executive Summary');
    lines.push(this.summary || '*No summary generated yet.*');
    lines.push('');

    // 4. Statistics Block
    lines.push('## Statistics');
    lines.push('| Metric | Value |');
    lines.push('| :--- | :--- |');
    lines.push(`| **Total Scanned** | ${this.stats.totalScanned} |`);
    lines.push(`| **Total Alerts** | ${this.stats.totalAlerts} |`);
    lines.push(`| **Match Rate** | ${this.stats.matchRatePercent.toFixed(1)}% |`);
    lines.push(`| **Average Latency** | ${this.stats.avgLatencyMs.toFixed(1)} ms |`);
    lines.push('');

    // Top Categories Breakdown
    const categoryEntries = Object.entries(this.stats.topCategories || {});
    if (categoryEntries.length > 0) {
      lines.push('### Top Categories');
      for (const [cat, count] of categoryEntries) {
        const pct =
          this.stats.totalScanned > 0
            ? ((count / this.stats.totalScanned) * 100).toFixed(1)
            : '0.0';
        lines.push(`- **${cat}**: ${count} (${pct}%)`);
      }
      lines.push('');
    }

    // 5. Scraped Items Section
    lines.push(`## Scraped Items (${this.items.length})`);
    lines.push('');

    if (this.items.length === 0) {
      lines.push('*No items scanned yet.*');
      lines.push('');
    } else {
      lines.push('| ID | Timestamp | Content Snippet | Link | Classification | Conf | Alert |');
      lines.push('| :--- | :--- | :--- | :--- | :--- | :---: | :---: |');

      for (const item of this.items) {
        const id = `\`${escapeTableText(item.id)}\``;
        const time = formatTimeOnly(item.timestamp);
        const snippet = escapeTableText(truncateText(item.text, 80));
        const link = item.link ? `[Link](${escapeTableText(item.link)})` : '—';
        const answers = formatAnswersCompact(item.answers);
        const conf = `${(item.confidence * 100).toFixed(1)}%`;
        const alert = item.triggeredAlert ? '🚨 **Yes**' : 'No';

        lines.push(`| ${id} | ${time} | ${snippet} | ${link} | ${answers} | ${conf} | ${alert} |`);
      }
      lines.push('');

      // Detailed Items Log
      lines.push('### Detailed Items Log');
      lines.push('');

      this.items.forEach((item, index) => {
        lines.push(`#### ${index + 1}. Item \`${item.id}\` — ${item.timestamp}`);
        if (item.link) {
          lines.push(`- **Link**: [${item.link}](${item.link})`);
        }
        lines.push(`- **Alert Triggered**: ${item.triggeredAlert ? '**YES**' : 'No'}`);
        lines.push(`- **Confidence**: ${(item.confidence * 100).toFixed(1)}%`);

        const ansEntries = Object.entries(item.answers || {});
        if (ansEntries.length > 0) {
          lines.push('- **Answers**:');
          for (const [k, v] of ansEntries) {
            const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
            lines.push(`  - \`${k}\`: ${valStr}`);
          }
        }

        lines.push('- **Text**:');
        lines.push('  > ' + (item.text ?? '').replace(/\r?\n/g, '\n  > '));
        lines.push('');
      });
    }

    return lines.join('\n');
  }

  /**
   * Flushes current markdown to disk.
   */
  public save(): void {
    if (this.isMemoryOnly) return;

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const markdown = this.getMarkdown();
      fs.writeFileSync(this.filePath, markdown, 'utf-8');
    } catch (err: any) {
      console.warn(`[ResultsStore] Failed to write results to ${this.filePath}: ${err.message}`);
    }
  }

  /**
   * Recalculates stats based on accumulated items.
   */
  private recalculateStats(): void {
    const totalScanned = this.items.length;
    const totalAlerts = this.items.filter((i) => i.triggeredAlert).length;
    const matchRatePercent =
      totalScanned > 0 ? Math.round((totalAlerts / totalScanned) * 1000) / 10 : 0;

    const topCategories: Record<string, number> = Object.create(null);
    for (const item of this.items) {
      if (!item.answers) continue;
      for (const [, val] of Object.entries(item.answers)) {
        if (typeof val === 'string' && val.trim().length > 0) {
          const cat = val.trim();
          topCategories[cat] = (topCategories[cat] || 0) + 1;
        } else if (typeof val === 'object' && val !== null && typeof (val as any).answer === 'string') {
          const cat = (val as any).answer.trim();
          topCategories[cat] = (topCategories[cat] || 0) + 1;
        }
      }
    }

    const sortedEntries = Object.entries(topCategories).sort(([, a], [, b]) => b - a);
    const cleanCategories = Object.fromEntries(sortedEntries);

    this.stats.totalScanned = totalScanned;
    this.stats.totalAlerts = totalAlerts;
    this.stats.matchRatePercent = matchRatePercent;
    this.stats.topCategories = cleanCategories;
  }
}
