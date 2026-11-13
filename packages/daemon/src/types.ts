import type {
  CompiledTaskSpec,
  InferenceTelemetryItem,
  ModelLoadingStatus,
  ModelStats
} from '@ofln-scout/shared';
import type { ScoutDatabase } from './db.js';
import type { LayaEngine } from './engine/layaEngine.js';
import type { BrowserRunner } from './runner/browserRunner.js';
import type { JobScheduler } from './scheduler.js';
import type { SystemMonitor } from './engine/systemMonitor.js';
import type { ResultsStore } from './resultsStore.js';

export interface ScoutDatabaseOptions {
  dbPath?: string;
}

export interface ScoutWsServerOptions {
  port?: number;
  host?: string;
  db?: ScoutDatabase;
  layaEngine?: LayaEngine;
  browserRunner?: BrowserRunner;
  scheduler?: JobScheduler;
  systemMonitor?: SystemMonitor;
  resultsStore?: ResultsStore;
}

export interface ScoutDaemonOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  resultsPath?: string;
  resultsStore?: ResultsStore;
  layaModelDir?: string;
  headlessBrowser?: boolean;
  autoInitLaya?: boolean;
}

export interface ActiveModelMetadata {
  systemOne?: {
    name: string;
    format: 'fp32' | 'int8';
    provider: string;
    device?: string;
    status: ModelLoadingStatus;
  };
  systemTwo?: {
    name: string;
    status: ModelLoadingStatus;
    gpuOffloaded?: boolean;
    vramUsageMb?: number;
  };
}

export interface DaemonStatusPayload {
  isRunning: boolean;
  layaReady: boolean;
  activeTaskId: string | null;
  activeRunId?: string | null;
  activeModel?: ActiveModelMetadata;
  modelStats?: ModelStats;
}
