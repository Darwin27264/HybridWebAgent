import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScoutDatabase } from './db.js';
import { ScoutWsServer } from './wsServer.js';
import { LayaEngine } from './engine/layaEngine.js';
import { BrowserRunner } from './runner/browserRunner.js';
import { JobScheduler } from './scheduler.js';
import { SystemMonitor } from './engine/systemMonitor.js';
import { ResultsStore, resolveResultsPath } from './resultsStore.js';
import type { TaskMetadata, ResultsStoreOptions } from './resultsStore.js';
import type { ScoutDaemonOptions } from './types.js';
import { llamaEngine } from './engine/llamaEngine.js';

export { ScoutDatabase } from './db.js';
export { ScoutWsServer } from './wsServer.js';
export { ResultsStore, resolveResultsPath } from './resultsStore.js';
export type { TaskMetadata, ResultsStoreOptions } from './resultsStore.js';
export {
  computeResultStats,
  generateResultsSummary,
  queryResults,
  steerTask,
  evaluateStagnation
} from './engine/systemTwoAssistant.js';
export {
  HARDWARE_LADDERS,
  getProviderLadder,
  getDeviceNameForProvider,
  instantiateLayaSession,
  probeLayaSession,
  LayaEngine,
  sanitizeStateSnippet,
  mapQuestionsToLaya,
  evaluateAlertRule,
  type LayaEngineInitOptions
} from './engine/layaEngine.js';
export {
  compileTask,
  sanitizeCompiledSpec,
  getPresetTaskSpec,
  fetchOllamaModels,
  fetchOllamaPs,
  getSystemTwoModelStats,
  resolveOllamaTimeout,
  DEFAULT_OLLAMA_TIMEOUT_MS,
  SYSTEM_TWO_LARGER_MODELS,
  DEFAULT_OLLAMA_MODELS,
  SELECTOR_PRESETS,
  estimateTokens,
  type OllamaRunningModel,
  type OllamaProcessStatus
} from './engine/compiler.js';
export { BrowserRunner, LruDeduplicator, sha1Hash, abortableSleep } from './runner/browserRunner.js';
export {
  LoopDetector,
  isAtBottomOfPage,
  isScrollStatic,
  type LoopDetectorOptions,
  type CycleTelemetry,
  type LoopDetectionResult,
  type StuckReason
} from './runner/loopDetector.js';
export { JobScheduler, parseCronField, matchesCron, calculateNextRun } from './scheduler.js';
export { SystemMonitor } from './engine/systemMonitor.js';
export * from './types.js';

export class ScoutDaemon {
  public db: ScoutDatabase;
  public wsServer: ScoutWsServer;
  public layaEngine: LayaEngine;
  public browserRunner: BrowserRunner;
  public scheduler: JobScheduler;
  public systemMonitor: SystemMonitor;
  public resultsStore: ResultsStore;
  private autoInitLaya: boolean;
  private shuttingDown = false;

  constructor(options: ScoutDaemonOptions = {}) {
    this.autoInitLaya = options.autoInitLaya ?? false;
    this.db = new ScoutDatabase(options.dbPath);
    this.resultsStore =
      options.resultsStore ??
      new ResultsStore(options.resultsPath);
    this.layaEngine = new LayaEngine();
    this.browserRunner = new BrowserRunner({
      headless: options.headlessBrowser ?? true
    });
    this.scheduler = new JobScheduler({
      db: this.db
    });
    this.systemMonitor = new SystemMonitor({
      db: this.db,
      layaEngine: this.layaEngine,
      browserRunner: this.browserRunner,
      getActiveJobsCount: () => this.scheduler.activeJobsCount
    });
    this.wsServer = new ScoutWsServer({
      port: options.port,
      host: options.host,
      db: this.db,
      layaEngine: this.layaEngine,
      browserRunner: this.browserRunner,
      scheduler: this.scheduler,
      systemMonitor: this.systemMonitor,
      resultsStore: this.resultsStore
    });
  }

  /**
   * Start daemon services and wait until server is listening.
   */
  public async start(): Promise<void> {
    await this.wsServer.waitForReady();

    // Auto-load downloaded GGUF model if available and not yet loaded
    try {
      if (!llamaEngine.isReady()) {
        const downloadedModel = llamaEngine.getModelsList().find((m) => m.downloaded);
        if (downloadedModel) {
          console.log(`[Scout Daemon] Found downloaded GGUF model "${downloadedModel.id}". Mounting on GPU...`);
          await llamaEngine.loadModel(downloadedModel.id);
          this.wsServer.setSelectedModel(downloadedModel.id);
          const telemetry = await llamaEngine.getTelemetry();
          this.wsServer.setSystemTwoStats({
            status: 'ready',
            modelName: downloadedModel.id,
            vramUsageMb: telemetry.vramUsageMb,
            gpuOffloaded: telemetry.gpuOffloaded
          });
          await this.wsServer.broadcastGgufModels();
          console.log(`[Scout Daemon] System 2 active on GPU (${telemetry.gpuName}, ${telemetry.gpuBackend}).`);
        }
      }
    } catch (err: any) {
      console.warn('[Scout Daemon] GGUF auto-load notice:', err.message);
    }

    if (this.autoInitLaya) {
      this.layaEngine
        .initialize()
        .then((ready) => {
          this.wsServer.setLayaReady(ready);
          if (ready) {
            console.log('[Scout Daemon] System 1 decision engine ready on ONNX Runtime CPU.');
          } else {
            console.log('[Scout Daemon] System 1 running in calibrated offline mode.');
          }
        })
        .catch((err) => {
          console.warn('[Scout Daemon] Engine initialization notice:', err.message);
        });
    }
  }

  /**
   * Gracefully stop all daemon services, abort runner, checkpoint DB, and close all connections.
   */
  public async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    try {
      await this.wsServer.close();
    } catch (err) {
      console.error('[Scout Daemon] Error closing WebSocket server:', err);
    }

    try {
      await this.layaEngine.close();
    } catch (err) {
      console.error('[Scout Daemon] Error closing Laya engine:', err);
    }

    try {
      this.db.close();
    } catch (err) {
      console.error('[Scout Daemon] Error closing database:', err);
    }

    try {
      await llamaEngine.unloadModel();
    } catch (err) {
      console.error('[Scout Daemon] Error unloading Llama model:', err);
    }
  }
}

/**
 * Start and run daemon instance with graceful signal handlers.
 */
export async function startDaemon(options: ScoutDaemonOptions = {}): Promise<ScoutDaemon> {
  const opts: ScoutDaemonOptions = {
    autoInitLaya: true,
    ...options
  };
  const daemon = new ScoutDaemon(opts);
  await daemon.start();

  const handleShutdown = async (signal: string) => {
    console.log(`\n[Scout Daemon] Received ${signal}. Shutting down cleanly...`);
    await daemon.stop();
    console.log('[Scout Daemon] Graceful shutdown complete.');
    process.exit(0);
  };

  process.once('SIGINT', () => void handleShutdown('SIGINT'));
  process.once('SIGTERM', () => void handleShutdown('SIGTERM'));

  return daemon;
}

// Automatically start if executed directly as CLI script
const currentFile = fileURLToPath(import.meta.url).toLowerCase();
const entryScript = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
const isDirectCli = Boolean(entryScript && entryScript === currentFile);

if (isDirectCli) {
  startDaemon()
    .then((daemon) => {
      console.log(
        `[Scout Daemon] Listening on ws://${daemon.wsServer.host}:${daemon.wsServer.port}`
      );
    })
    .catch((err) => {
      console.error('[Scout Daemon] Fatal startup error:', err);
      process.exit(1);
    });
}
