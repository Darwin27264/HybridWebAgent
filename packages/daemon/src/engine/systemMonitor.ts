import os from 'node:os';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type {
  SystemPerformanceMetrics,
  ServiceHealthItem
} from '@ofln-scout/shared';
import type { ScoutDatabase } from '../db.js';
import type { LayaEngine } from './layaEngine.js';
import type { BrowserRunner } from '../runner/browserRunner.js';

export interface SystemMonitorOptions {
  db?: ScoutDatabase;
  layaEngine?: LayaEngine;
  browserRunner?: BrowserRunner;
  getActiveJobsCount?: () => number;
  ollamaUrl?: string;
}

export class SystemMonitor {
  private db?: ScoutDatabase;
  private layaEngine?: LayaEngine;
  private browserRunner?: BrowserRunner;
  private getActiveJobsCount?: () => number;
  private ollamaUrl: string;

  private prevCpuUsage: NodeJS.CpuUsage;
  private prevCpuTime: bigint;
  private prevOsCpuTimes: Array<{ idle: number; total: number }>;

  private elHistogram: IntervalHistogram | null = null;
  private timer: NodeJS.Timeout | null = null;
  private latestMetrics: SystemPerformanceMetrics;
  private ollamaHealth: ServiceHealthItem = {
    name: 'Ollama System 2',
    status: 'idle',
    message: 'Ollama model discovery ready'
  };

  constructor(options: SystemMonitorOptions = {}) {
    this.db = options.db;
    this.layaEngine = options.layaEngine;
    this.browserRunner = options.browserRunner;
    this.getActiveJobsCount = options.getActiveJobsCount;
    this.ollamaUrl = options.ollamaUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

    this.prevCpuUsage = process.cpuUsage();
    this.prevCpuTime = process.hrtime.bigint();
    this.prevOsCpuTimes = this.sampleOsCpuTimes();

    try {
      this.elHistogram = monitorEventLoopDelay({ resolution: 20 });
      this.elHistogram.enable();
    } catch {
      this.elHistogram = null;
    }

    this.latestMetrics = this.sampleMetrics();
  }

  private sampleOsCpuTimes(): Array<{ idle: number; total: number }> {
    const cpus = os.cpus() || [];
    return cpus.map((cpu) => {
      const times = cpu.times;
      const total = times.user + times.nice + times.sys + times.idle + times.irq;
      return { idle: times.idle, total };
    });
  }

  private calculateCpuPercent(): { processPercent: number; systemPercent: number } {
    const nowTime = process.hrtime.bigint();
    const elapsedNs = nowTime - this.prevCpuTime;
    const elapsedUs = Number(elapsedNs) / 1000;

    const currentCpuUsage = process.cpuUsage(this.prevCpuUsage);
    this.prevCpuUsage = process.cpuUsage();
    this.prevCpuTime = nowTime;

    const numCpus = os.cpus().length || 1;
    let processPercent = 0;
    if (elapsedUs > 0) {
      const totalUserSystemUs = currentCpuUsage.user + currentCpuUsage.system;
      processPercent = Math.min(100, Math.max(0, (totalUserSystemUs / (elapsedUs * numCpus)) * 100));
    }

    // System total CPU percentage calculation
    const currentOsCpu = this.sampleOsCpuTimes();
    let totalDelta = 0;
    let idleDelta = 0;

    for (let i = 0; i < currentOsCpu.length && i < this.prevOsCpuTimes.length; i++) {
      totalDelta += currentOsCpu[i].total - this.prevOsCpuTimes[i].total;
      idleDelta += currentOsCpu[i].idle - this.prevOsCpuTimes[i].idle;
    }
    this.prevOsCpuTimes = currentOsCpu;

    let systemPercent = 0;
    if (totalDelta > 0) {
      const busy = Math.max(0, totalDelta - idleDelta);
      systemPercent = Math.min(100, Math.max(0, (busy / totalDelta) * 100));
    } else {
      systemPercent = processPercent;
    }

    return {
      processPercent: Math.round(processPercent * 10) / 10,
      systemPercent: Math.round(systemPercent * 10) / 10
    };
  }

  private sampleEventLoopLag(): { lagMs: number; p99LagMs: number } {
    if (this.elHistogram) {
      const meanNs = this.elHistogram.mean;
      const p99Ns = this.elHistogram.percentile(99);
      this.elHistogram.reset();

      const lagMs = isNaN(meanNs) ? 0 : Math.round((meanNs / 1e6) * 100) / 100;
      const p99LagMs = isNaN(p99Ns) ? 0 : Math.round((p99Ns / 1e6) * 100) / 100;
      return { lagMs: Math.max(0, lagMs), p99LagMs: Math.max(0, p99LagMs) };
    }
    return { lagMs: 0.1, p99LagMs: 0.5 };
  }

  private checkServices(): Record<string, ServiceHealthItem> {
    const services: Record<string, ServiceHealthItem> = {};

    // 1. WebSocket Bus
    services.wsServer = {
      name: 'WebSocket RPC Bus',
      status: 'healthy',
      message: 'Active and listening'
    };

    // 2. Database
    if (this.db) {
      const isOpen = this.db.isOpen;
      services.database = {
        name: 'SQLite (WAL Mode)',
        status: isOpen ? 'healthy' : 'offline',
        message: isOpen ? 'WAL mode operational' : 'Database connection closed'
      };
    } else {
      services.database = {
        name: 'SQLite (WAL Mode)',
        status: 'idle',
        message: 'No DB instance bound'
      };
    }

    // 3. Laya Engine
    if (this.layaEngine) {
      const isReady = this.layaEngine.isReady;
      services.layaEngine = {
        name: 'ModernBERT ONNX CPU',
        status: isReady ? 'healthy' : 'degraded',
        message: isReady ? 'Inference engine ready' : 'Model weights not yet loaded'
      };
    } else {
      services.layaEngine = {
        name: 'ModernBERT ONNX CPU',
        status: 'idle',
        message: 'Engine instance not attached'
      };
    }

    // 4. Browser Runner
    if (this.browserRunner) {
      services.browserRunner = {
        name: 'Playwright Chromium',
        status: 'healthy',
        message: 'Headless browser automation ready'
      };
    } else {
      services.browserRunner = {
        name: 'Playwright Chromium',
        status: 'idle',
        message: 'Runner not attached'
      };
    }

    // 5. Ollama System 2
    services.ollama = this.ollamaHealth;

    return services;
  }

  public setOllamaHealth(health: ServiceHealthItem): void {
    this.ollamaHealth = health;
  }

  public setDatabase(db: ScoutDatabase): void {
    this.db = db;
  }

  public setLayaEngine(engine: LayaEngine): void {
    this.layaEngine = engine;
  }

  public setBrowserRunner(runner: BrowserRunner): void {
    this.browserRunner = runner;
  }

  public setActiveJobsCountGetter(getter: () => number): void {
    this.getActiveJobsCount = getter;
  }

  public sampleMetrics(): SystemPerformanceMetrics {
    const cpu = this.calculateCpuPercent();
    const memUsage = process.memoryUsage();
    const eventLoop = this.sampleEventLoopLag();
    const services = this.checkServices();
    const activeJobsCount = this.getActiveJobsCount ? this.getActiveJobsCount() : 0;

    const metrics: SystemPerformanceMetrics = {
      timestamp: Date.now(),
      cpu,
      memory: {
        rssBytes: memUsage.rss,
        heapUsedBytes: memUsage.heapUsed,
        heapTotalBytes: memUsage.heapTotal,
        externalBytes: memUsage.external,
        systemFreeBytes: os.freemem(),
        systemTotalBytes: os.totalmem()
      },
      eventLoop,
      services,
      activeJobsCount
    };

    this.latestMetrics = metrics;
    return metrics;
  }

  public getMetrics(): SystemPerformanceMetrics {
    return this.sampleMetrics();
  }

  /**
   * Start periodic sampling and broadcasting.
   */
  public start(intervalMs = 2000, onSample?: (metrics: SystemPerformanceMetrics) => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const metrics = this.sampleMetrics();
      if (onSample) {
        onSample(metrics);
      }
    }, intervalMs);
  }

  /**
   * Stop periodic sampling and clean up histogram.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.elHistogram) {
      this.elHistogram.disable();
    }
  }
}
