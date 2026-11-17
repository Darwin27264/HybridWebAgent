import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type {
  WsClientToServerMessage,
  WsServerToClientMessage,
  CompiledTaskSpec,
  InferenceTelemetryItem,
  AgentAction,
  BrowserSnapshot,
  Job,
  ScrapedItem,
  ModelStats,
  ModelLoadingStatus,
  TaskCheckpoint
} from '@ofln-scout/shared';
import type { ScoutDatabase } from './db.js';
import type { LayaEngine } from './engine/layaEngine.js';
import type { BrowserRunner } from './runner/browserRunner.js';
import {
  compileTask,
  fetchOllamaModels,
  fetchOllamaPs,
  getSystemTwoModelStats,
  DEFAULT_OLLAMA_MODELS
} from './engine/compiler.js';
import { SystemMonitor } from './engine/systemMonitor.js';
import { JobScheduler } from './scheduler.js';
import { ResultsStore } from './resultsStore.js';
import { llamaEngine } from './engine/llamaEngine.js';
import {
  generateResultsSummary,
  queryResults,
  steerTask
} from './engine/systemTwoAssistant.js';
import type { ScoutWsServerOptions, DaemonStatusPayload, ActiveModelMetadata } from './types.js';

export class ScoutWsServer extends EventEmitter {
  private wss: WebSocketServer;
  private db?: ScoutDatabase;
  private layaEngine?: LayaEngine;
  private browserRunner?: BrowserRunner;
  private resultsStore: ResultsStore;
  private activeSpec: CompiledTaskSpec | null = null;
  private _host: string;
  private _port: number;
  private isRunning = false;
  private _isStopping = false;
  private layaReady = false;
  private activeTaskId: string | null = null;
  private _activeRunId: string | null = null;
  private activeJobId: string | null = null;
  private activeAbortController: AbortController | null = null;
  private activeExecutionPromise: Promise<void> | null = null;
  private lastKnownCheckpoint?: TaskCheckpoint;
  private isClosed = false;
  private readyPromise: Promise<void>;

  private _selectedModel = 'qwen2.5';
  private _systemOneStats: ModelStats['systemOne'] = {
    modelName: 'laya.onnx',
    format: 'fp32',
    provider: 'cpu',
    device: 'CPU',
    status: 'idle',
    avgLatencyMs: 0
  };
  private _systemTwoStatus: ModelLoadingStatus = 'idle';
  private _availableModels: string[] = [...DEFAULT_OLLAMA_MODELS];
  private _systemTwoVramMb?: number;
  private _systemTwoGpuOffloaded?: boolean;
  private _systemTwoError?: string;
  private _activeModelMetadata?: ActiveModelMetadata;
  private _systemMonitor: SystemMonitor;
  private _scheduler: JobScheduler;

  constructor(options: ScoutWsServerOptions = {}) {
    super();
    this.db = options.db;
    this.layaEngine = options.layaEngine;
    if (this.layaEngine) {
      this.layaReady = this.layaEngine.isReady;
      if (typeof (this.layaEngine as any).getModelStats === 'function') {
        this._systemOneStats = (this.layaEngine as any).getModelStats();
      } else {
        this._systemOneStats.status = this.layaReady ? 'ready' : 'idle';
      }
    }
    this.browserRunner = options.browserRunner;
    this.resultsStore = options.resultsStore ?? new ResultsStore();
    this._host = options.host ?? process.env.SCOUT_WS_HOST ?? '127.0.0.1';
    this._port =
      options.port !== undefined
        ? options.port
        : process.env.SCOUT_WS_PORT !== undefined
        ? Number(process.env.SCOUT_WS_PORT)
        : 4040;

    this._systemMonitor =
      options.systemMonitor ??
      new SystemMonitor({
        db: this.db,
        layaEngine: this.layaEngine,
        browserRunner: this.browserRunner,
        getActiveJobsCount: () => (this._scheduler ? this._scheduler.activeJobsCount : 0)
      });

    this._scheduler =
      options.scheduler ??
      new JobScheduler({
        db: this.db
      });

    this._scheduler.setTriggerHandler(async (job: Job) => {
      await this.startExecution(job.spec, job.id);
    });

    this.wss = new WebSocketServer({
      host: this._host,
      port: this._port
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      if (this.wss.address()) {
        this.onListeningStarted();
        resolve();
      } else {
        const onListening = () => {
          this.wss.off('error', onError);
          this.onListeningStarted();
          resolve();
        };
        const onError = (err: Error) => {
          this.wss.off('listening', onListening);
          reject(err);
        };
        this.wss.once('listening', onListening);
        this.wss.once('error', onError);
      }
    });

    this.setupServer();
  }

  private onListeningStarted(): void {
    // Start periodic performance metrics monitoring and scheduler
    this._systemMonitor.start(2000, (metrics) => {
      this.broadcast({
        type: 'METRICS_UPDATE',
        payload: metrics
      });
    });

    if (this.db) {
      this._scheduler.start();
    }
  }

  private setupServer(): void {
    this.wss.on('connection', (client: WebSocket) => {
      // 1. Send current status upon client connection
      const statusMsg: WsServerToClientMessage = {
        type: 'DAEMON_STATUS',
        payload: this.getDaemonStatusPayload()
      };

      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(statusMsg));
      }

      // 2. Send initial models list
      fetchOllamaModels().then((modelsData) => {
        if (modelsData.models && modelsData.models.length > 0) {
          this._availableModels = modelsData.models;
        }
        if (client.readyState === WebSocket.OPEN) {
          const modelsMsg: WsServerToClientMessage = {
            type: 'MODELS_LIST',
            payload: {
              models: modelsData.models,
              selectedModel: this._selectedModel,
              ollamaOnline: modelsData.online
            }
          };
          client.send(JSON.stringify(modelsMsg));
        }

        // Send GGUF models list with download and GPU telemetry
        llamaEngine.getTelemetry().then((telemetry) => {
          if (client.readyState === WebSocket.OPEN) {
            const ggufMsg: WsServerToClientMessage = {
              type: 'GGUF_MODELS_LIST',
              payload: {
                models: llamaEngine.getModelsList(),
                activeModelId: llamaEngine.getActiveModelId(),
                gpuName: telemetry.gpuName,
                gpuBackend: telemetry.gpuBackend,
                vramUsageMb: telemetry.vramUsageMb,
                totalVramMb: telemetry.totalVramMb
              }
            };
            client.send(JSON.stringify(ggufMsg));
          }
        }).catch(() => {});
      });

      // 3. Send current metrics
      if (client.readyState === WebSocket.OPEN) {
        const metricsMsg: WsServerToClientMessage = {
          type: 'METRICS_UPDATE',
          payload: this._systemMonitor.getMetrics()
        };
        client.send(JSON.stringify(metricsMsg));
      }

      // 4. Send jobs list if DB is attached
      if (this.db && client.readyState === WebSocket.OPEN) {
        const jobsMsg: WsServerToClientMessage = {
          type: 'JOBS_LIST',
          payload: this.db.listJobs()
        };
        client.send(JSON.stringify(jobsMsg));
      }

      // 5. Send initial results update if results exist
      if (this.resultsStore && client.readyState === WebSocket.OPEN) {
        const items = this.resultsStore.getItems();
        if (items.length > 0 || this.resultsStore.getSummary()) {
          const resultsMsg: WsServerToClientMessage = {
            type: 'RESULTS_UPDATE',
            payload: {
              markdown: this.resultsStore.getMarkdown(),
              summary: this.resultsStore.getSummary(),
              stats: this.resultsStore.getStats(),
              items,
              timestamp: new Date().toISOString()
            }
          };
          client.send(JSON.stringify(resultsMsg));
        }
      }

      // 6. Send initial MODEL_STATS
      if (client.readyState === WebSocket.OPEN) {
        const modelStatsMsg: WsServerToClientMessage = {
          type: 'MODEL_STATS',
          payload: this.getModelStats()
        };
        client.send(JSON.stringify(modelStatsMsg));
      }

      this.emit('client_connected', client);

      // 5. Setup incoming message handling
      client.on('message', async (data) => {
        let message: WsClientToServerMessage;
        try {
          message = JSON.parse(data.toString()) as WsClientToServerMessage;
        } catch {
          // Ignore malformed JSON messages gracefully without crashing
          return;
        }
        try {
          await this.handleClientMessage(message, client);
        } catch (err: any) {
          console.warn('[ScoutWsServer] Error handling client message:', err.message);
        }
      });

      client.on('close', () => {
        this.emit('client_disconnected', client);
      });

      client.on('error', (err) => {
        this.emit('client_error', err, client);
      });
    });

    this.wss.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /**
   * Route incoming client message according to defined contracts.
   */
  private async handleClientMessage(msg: WsClientToServerMessage, client: WebSocket): Promise<void> {
    if (!msg || typeof msg !== 'object' || !msg.type) {
      return;
    }

    switch (msg.type) {
      case 'COMPILE_TASK': {
        if (!msg.payload || !msg.payload.userGoal) {
          console.warn('[ScoutWsServer] COMPILE_TASK received without valid userGoal');
          break;
        }
        const progress: WsServerToClientMessage = {
          type: 'COMPILATION_PROGRESS',
          payload: {
            status: 'compiling',
            message: `Task compilation initiated for goal: "${msg.payload.userGoal}"`
          }
        };
        this.broadcast(progress);
        this.emit('compile_task', msg.payload, client);

        this._systemTwoStatus = 'loading';
        this.broadcastModelStats();

        const modelToUse = msg.payload.ollamaModel || this._selectedModel;

        compileTask(msg.payload.userGoal, modelToUse)
          .then((spec) => {
            if (this.db && this.db.isOpen) {
              this.db.insertTask(spec);
            }
            this._systemTwoStatus = 'ready';
            this.broadcastModelStats();
            this.broadcast({
              type: 'COMPILATION_PROGRESS',
              payload: {
                status: 'ready',
                message: `Task "${spec.name}" compiled and validated successfully.`,
                spec
              }
            });
          })
          .catch((err: Error) => {
            this._systemTwoStatus = 'error';
            this._systemTwoError = err.message;
            this.broadcastModelStats();
            this.broadcast({
              type: 'COMPILATION_PROGRESS',
              payload: {
                status: 'error',
                message: `Compilation failed: ${err.message}`
              }
            });
          });
        break;
      }

      case 'START_TASK': {
        const spec = msg.payload?.spec;
        if (!spec || !spec.id) {
          console.warn('[ScoutWsServer] START_TASK received without valid task spec');
          this.broadcast({
            type: 'DAEMON_NOTIFICATION',
            payload: {
              level: 'warning',
              title: 'Invalid Task',
              message: 'START_TASK received without valid task spec',
              timestamp: Date.now()
            }
          });
          break;
        }
        this.emit('start_task', spec, client);
        this.startExecution(spec).catch((err: Error) => {
          console.warn(`[ScoutWsServer] startExecution error: ${err.message}`);
        });
        break;
      }

      case 'STOP_TASK': {
        await this.stopTask();
        this.emit('stop_task', client);
        break;
      }

      case 'RESUME_TASK': {
        if (!msg.payload || !msg.payload.taskId) {
          console.warn('[ScoutWsServer] RESUME_TASK received without taskId');
          break;
        }
        this.emit('resume_task', msg.payload, client);
        this.resumeTask(msg.payload.taskId, msg.payload.checkpointId).catch((err: Error) => {
          console.warn(`[ScoutWsServer] resumeTask error: ${err.message}`);
          this.broadcast({
            type: 'DAEMON_NOTIFICATION',
            payload: {
              level: 'error',
              title: 'Resume Failed',
              message: err.message,
              timestamp: Date.now()
            }
          });
        });
        break;
      }

      case 'GET_CHECKPOINTS': {
        if (!msg.payload || !msg.payload.taskId) {
          console.warn('[ScoutWsServer] GET_CHECKPOINTS received without taskId');
          break;
        }
        let checkpoints: TaskCheckpoint[] = [];
        if (this.db && this.db.isOpen) {
          checkpoints = this.db.listCheckpoints(msg.payload.taskId);
        } else if (this.lastKnownCheckpoint && this.lastKnownCheckpoint.taskId === msg.payload.taskId) {
          checkpoints = [this.lastKnownCheckpoint];
        }
        const reply: WsServerToClientMessage = {
          type: 'CHECKPOINTS_LIST',
          payload: checkpoints
        };
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(reply));
        }
        break;
      }

      case 'CLEAR_ALERTS': {
        if (this.db) {
          this.db.clearAlerts();
        }
        this.broadcastStatus();
        this.emit('clear_alerts', client);
        break;
      }

      case 'GET_MODELS': {
        fetchOllamaModels().then((data) => {
          const reply: WsServerToClientMessage = {
            type: 'MODELS_LIST',
            payload: {
              models: data.models,
              selectedModel: this._selectedModel,
              ollamaOnline: data.online
            }
          };
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(reply));
          }
        });
        break;
      }

      case 'SET_MODEL': {
        if (!msg.payload || !msg.payload.model) {
          console.warn('[ScoutWsServer] SET_MODEL received without valid model');
          break;
        }
        this._selectedModel = msg.payload.model;
        this._systemTwoStatus = 'loading';
        this.broadcastModelStats();

        getSystemTwoModelStats(this._selectedModel)
          .then((stats) => {
            this._systemTwoStatus = stats.status;
            this._systemTwoVramMb = stats.vramUsageMb;
            this._systemTwoGpuOffloaded = stats.gpuOffloaded;
            this._systemTwoError = stats.error;
            if (stats.availableModels.length > 0) {
              this._availableModels = stats.availableModels;
            }
            this.broadcast({
              type: 'MODELS_LIST',
              payload: {
                models: this._availableModels,
                selectedModel: this._selectedModel,
                ollamaOnline: stats.status !== 'idle' && !stats.error?.includes('offline')
              }
            });
            this.broadcastModelStats();
            this.broadcast({
              type: 'DAEMON_NOTIFICATION',
              payload: {
                level: 'info',
                title: 'Model Selected',
                message: `Active System 2 model set to "${this._selectedModel}"`,
                timestamp: Date.now()
              }
            });
          })
          .catch((err: Error) => {
            this._systemTwoStatus = 'error';
            this._systemTwoError = err.message;
            this.broadcastModelStats();
          });
        break;
      }

      case 'GET_GGUF_MODELS': {
        llamaEngine.getTelemetry().then((telemetry) => {
          const reply: WsServerToClientMessage = {
            type: 'GGUF_MODELS_LIST',
            payload: {
              models: llamaEngine.getModelsList(),
              activeModelId: llamaEngine.getActiveModelId(),
              gpuName: telemetry.gpuName,
              gpuBackend: telemetry.gpuBackend,
              vramUsageMb: telemetry.vramUsageMb,
              totalVramMb: telemetry.totalVramMb
            }
          };
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(reply));
          }
        }).catch(() => {});
        break;
      }

      case 'DOWNLOAD_MODEL': {
        if (!msg.payload || !msg.payload.modelId) break;
        const targetModelId = msg.payload.modelId;
        this.broadcastNotification('info', 'Download Started', `Downloading "${targetModelId}" from Hugging Face...`);

        llamaEngine.downloadModel(targetModelId, (progress) => {
          this.broadcast({
            type: 'MODEL_DOWNLOAD_PROGRESS',
            payload: progress
          });
          if (progress.status === 'completed') {
            this.broadcastGgufModels();
            this.broadcastNotification('info', 'Download Completed', `Model "${targetModelId}" is downloaded and ready to load.`);
          }
        }).catch((err: Error) => {
          this.broadcastNotification('error', 'Download Failed', err.message);
        });
        break;
      }

      case 'CANCEL_DOWNLOAD': {
        if (!msg.payload || !msg.payload.modelId) break;
        await llamaEngine.cancelDownload(msg.payload.modelId);
        this.broadcastGgufModels();
        this.broadcastNotification('info', 'Download Cancelled', `Download of "${msg.payload.modelId}" was cancelled.`);
        break;
      }

      case 'LOAD_MODEL': {
        if (!msg.payload || !msg.payload.modelId) break;
        const loadTarget = msg.payload.modelId;
        this._systemTwoStatus = 'loading';
        this.broadcastModelStats();

        try {
          await llamaEngine.loadModel(loadTarget);
          this._selectedModel = loadTarget;
          this._systemTwoStatus = 'ready';
          const telemetry = await llamaEngine.getTelemetry();
          this._systemTwoVramMb = telemetry.vramUsageMb;
          this._systemTwoGpuOffloaded = telemetry.gpuOffloaded;
          this._systemTwoError = undefined;

          await this.broadcastGgufModels();
          this.broadcastModelStats();
          this.broadcastNotification('info', 'Model Activated', `"${loadTarget}" is active on GPU (${telemetry.gpuName}).`);
        } catch (err: any) {
          this._systemTwoStatus = 'error';
          this._systemTwoError = err?.message || String(err);
          this.broadcastModelStats();
          this.broadcastNotification('error', 'Model Load Error', err?.message || String(err));
        }
        break;
      }

      case 'GET_METRICS': {
        const metrics = this._systemMonitor.getMetrics();
        const reply: WsServerToClientMessage = {
          type: 'METRICS_UPDATE',
          payload: metrics
        };
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(reply));
        }
        break;
      }

      case 'GET_JOBS': {
        if (this.db) {
          const jobs = this.db.listJobs();
          const reply: WsServerToClientMessage = {
            type: 'JOBS_LIST',
            payload: jobs
          };
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(reply));
          }
        }
        break;
      }

      case 'CREATE_JOB': {
        if (!msg.payload || !msg.payload.name || !msg.payload.spec) {
          console.warn('[ScoutWsServer] CREATE_JOB received without required name or spec');
          break;
        }
        if (this.db) {
          const created = this.db.createJob({
            name: msg.payload.name,
            spec: msg.payload.spec,
            cronSchedule: msg.payload.cronSchedule,
            isScheduled: msg.payload.isScheduled
          });
          this.broadcastJobsList();
          this.broadcast({
            type: 'DAEMON_NOTIFICATION',
            payload: {
              level: 'info',
              title: 'Job Created',
              message: `Job "${created.name}" created successfully.`,
              timestamp: Date.now()
            }
          });
        }
        break;
      }

      case 'UPDATE_JOB': {
        if (!msg.payload || !msg.payload.id) {
          console.warn('[ScoutWsServer] UPDATE_JOB received without jobId');
          break;
        }
        if (this.db) {
          this.db.updateJob(msg.payload.id, {
            name: msg.payload.name,
            spec: msg.payload.spec,
            cronSchedule: msg.payload.cronSchedule,
            isScheduled: msg.payload.isScheduled
          });
          this.broadcastJobsList();
        }
        break;
      }

      case 'DELETE_JOB': {
        if (!msg.payload || !msg.payload.id) {
          console.warn('[ScoutWsServer] DELETE_JOB received without jobId');
          break;
        }
        if (this.db) {
          this.db.deleteJob(msg.payload.id);
          this.broadcastJobsList();
          this.broadcast({
            type: 'DAEMON_NOTIFICATION',
            payload: {
              level: 'info',
              title: 'Job Deleted',
              message: `Job ${msg.payload.id} deleted.`,
              timestamp: Date.now()
            }
          });
        }
        break;
      }

      case 'START_JOB': {
        if (!msg.payload || !msg.payload.jobId) {
          console.warn('[ScoutWsServer] START_JOB received without jobId');
          break;
        }
        if (this._scheduler.isJobRunning(msg.payload.jobId)) {
          console.warn(`[ScoutWsServer] Job ${msg.payload.jobId} is already running`);
          this.broadcast({
            type: 'DAEMON_NOTIFICATION',
            payload: {
              level: 'warning',
              title: 'Job Already Running',
              message: `Job ${msg.payload.jobId} is already running`,
              timestamp: Date.now()
            }
          });
          break;
        }
        if (this.db) {
          const job = this.db.getJob(msg.payload.jobId);
          if (job) {
            this._scheduler.triggerJob(job.id).catch((err: Error) => {
              console.warn(`[ScoutWsServer] triggerJob error for ${job.id}: ${err.message}`);
            });
          }
        }
        break;
      }

      case 'STOP_JOB': {
        if (!msg.payload || !msg.payload.jobId) {
          console.warn('[ScoutWsServer] STOP_JOB received without jobId');
          break;
        }
        if (this.activeJobId === msg.payload.jobId && this.activeAbortController) {
          this.activeAbortController.abort();
          this.activeAbortController = null;
          this.isRunning = false;
          this.activeTaskId = null;
          this._activeRunId = null;
          this.activeJobId = null;
          this.broadcastStatus();
          this.broadcast({
            type: 'JOB_STATUS',
            payload: {
              jobId: msg.payload.jobId,
              status: 'idle'
            }
          });
        }
        break;
      }

      case 'GET_RESULTS': {
        if (this.resultsStore && client.readyState === WebSocket.OPEN) {
          client.send(
            JSON.stringify({
              type: 'RESULTS_UPDATE',
              payload: {
                markdown: this.resultsStore.getMarkdown(),
                summary: this.resultsStore.getSummary(),
                stats: this.resultsStore.getStats(),
                items: this.resultsStore.getItems(),
                timestamp: new Date().toISOString()
              }
            })
          );
        }
        break;
      }

      case 'QUERY_RESULTS': {
        if (!msg.payload || typeof msg.payload.query !== 'string') {
          console.warn('[ScoutWsServer] QUERY_RESULTS received without valid query');
          break;
        }
        const query = msg.payload.query;
        const items = this.resultsStore ? this.resultsStore.getItems() : [];
        const summary = this.resultsStore ? this.resultsStore.getSummary() : '';
        const model = this._selectedModel;

        queryResults(query, items, summary, model)
          .then((res) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'QUERY_RESULTS_RESPONSE',
                  payload: {
                    query,
                    answer: res.answer,
                    timestamp: new Date().toISOString(),
                    model: res.model
                  }
                })
              );
            }
          })
          .catch((err: Error) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'QUERY_RESULTS_RESPONSE',
                  payload: {
                    query,
                    answer: `Error: ${err.message}`,
                    timestamp: new Date().toISOString(),
                    model: 'error'
                  }
                })
              );
            }
          });
        break;
      }

      case 'STEER_TASK': {
        if (!msg.payload || typeof msg.payload.instruction !== 'string') {
          console.warn('[ScoutWsServer] STEER_TASK received without valid instruction');
          break;
        }
        const instruction = msg.payload.instruction;
        const requestedTaskId = msg.payload.taskId;

        let targetSpec: CompiledTaskSpec | null = null;

        if (requestedTaskId) {
          if (this.activeTaskId === requestedTaskId && this.activeSpec) {
            targetSpec = this.activeSpec;
          } else if (this.db?.isOpen) {
            const taskRecord = this.db.getTask(requestedTaskId);
            targetSpec = taskRecord ? (((taskRecord as any).spec || taskRecord) as CompiledTaskSpec) : null;
          }

          if (!targetSpec) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'STEER_TASK_RESPONSE',
                  payload: {
                    instruction,
                    explanation: `Task with ID "${requestedTaskId}" not found`,
                    applied: false,
                    timestamp: new Date().toISOString()
                  }
                })
              );
            }
            break;
          }
        } else {
          targetSpec =
            this.activeSpec ||
            (this.activeTaskId && this.db?.isOpen
              ? (() => {
                  const taskRecord = this.db.getTask(this.activeTaskId);
                  return taskRecord ? (((taskRecord as any).spec || taskRecord) as CompiledTaskSpec) : null;
                })()
              : null);

          if (!targetSpec) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'STEER_TASK_RESPONSE',
                  payload: {
                    instruction,
                    explanation: 'No active or persisted task spec found to steer.',
                    applied: false,
                    timestamp: new Date().toISOString()
                  }
                })
              );
            }
            break;
          }
        }

        steerTask(instruction, targetSpec, this._selectedModel)
          .then((res) => {
            if (res.applied) {
              if (
                this.activeTaskId === res.updatedSpec.id ||
                (!requestedTaskId && this.activeSpec)
              ) {
                this.activeSpec = res.updatedSpec;
                if (this.isRunning && this.browserRunner) {
                  this.browserRunner.applySteering(res.updatedSpec);
                }
              }
              if (this.db && this.db.isOpen) {
                this.db.insertTask(res.updatedSpec);
              }
            }
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'STEER_TASK_RESPONSE',
                  payload: {
                    instruction,
                    explanation: res.explanation,
                    applied: res.applied,
                    timestamp: new Date().toISOString()
                  }
                })
              );
            }
            if (res.applied) {
              this.broadcast({
                type: 'DAEMON_NOTIFICATION',
                payload: {
                  level: 'info',
                  title: 'Task Steered',
                  message: res.explanation,
                  timestamp: Date.now()
                }
              });
            }
          })
          .catch((err: Error) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'STEER_TASK_RESPONSE',
                  payload: {
                    instruction,
                    explanation: `Steering failure: ${err.message}`,
                    applied: false,
                    timestamp: new Date().toISOString()
                  }
                })
              );
            }
          });
        break;
      }

      case 'GET_MODEL_STATS': {
        const statsMsg: WsServerToClientMessage = {
          type: 'MODEL_STATS',
          payload: this.getModelStats()
        };
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(statsMsg));
        }
        break;
      }

      default:
        // Unknown message type
        break;
    }
  }

  /**
   * Stop the active task execution, checkpointing runner coordinates to SQLite.
   */
  public async stopTask(): Promise<TaskCheckpoint | null> {
    if (this._isStopping || !this.isRunning || !this.activeTaskId || !this.activeSpec) {
      return null;
    }
    this._isStopping = true;

    const activeTaskId = this.activeTaskId;
    const activeSpec = this.activeSpec;
    const activeRunId = this._activeRunId;
    const activeAbortController = this.activeAbortController;

    try {
      let runnerState: any = null;
      if (this.browserRunner) {
        try {
          runnerState = await this.browserRunner.getCurrentState();
        } catch {
          // fallback
        }
      }
      const now = Date.now();
      const savedCheckpoint: TaskCheckpoint = {
        id: `chk-${now}-${Math.random().toString(36).slice(2, 7)}`,
        taskId: activeTaskId,
        runId: activeRunId || `run-${now}`,
        createdAt: now,
        updatedAt: now,
        status: 'stopped',
        targetUrl: activeSpec.targetUrl,
        currentUrl: runnerState?.currentUrl || activeSpec.targetUrl,
        pageTitle: runnerState?.pageTitle,
        scroll: runnerState?.scroll || { y: 0, scrollHeight: 0, viewportHeight: 0 },
        totalScanned: runnerState?.totalScanned ?? (this.resultsStore?.getStats().totalScanned ?? 0),
        totalAlerts: runnerState?.totalAlerts ?? (this.resultsStore?.getStats().totalAlerts ?? 0),
        activeStepCount: runnerState?.activeStepCount ?? 0,
        dedupHashes: runnerState?.dedupHashes ?? (this.browserRunner?.deduplicator.getHashes() || []),
        modelConfig: {
          systemOneModel: this._systemOneStats.modelName,
          systemTwoModel: this._selectedModel
        }
      };

      if (this.db && this.db.isOpen) {
        try {
          this.db.insertTask(activeSpec);
          this.db.saveCheckpoint(savedCheckpoint);
        } catch (err: any) {
          console.warn('[ScoutWsServer] Error saving checkpoint on stopTask:', err.message);
        }
      }
      this.lastKnownCheckpoint = savedCheckpoint;
      this.broadcast({
        type: 'CHECKPOINT_SAVED',
        payload: savedCheckpoint
      });

      if (activeAbortController) {
        activeAbortController.abort();
        if (this.activeAbortController === activeAbortController) {
          this.activeAbortController = null;
        }
      }

      if (this.activeTaskId === activeTaskId && (this._activeRunId === null || this._activeRunId === activeRunId)) {
        this.isRunning = false;
        this.activeTaskId = null;
        this._activeRunId = null;
        this.activeJobId = null;
        this.broadcastStatus();
      }
      return savedCheckpoint;
    } finally {
      this._isStopping = false;
    }
  }

  /**
   * Resume an existing task from a checkpoint.
   */
  public async resumeTask(taskId: string, checkpointId?: string): Promise<string> {
    if (this._isStopping) {
      const startWait = Date.now();
      while (this._isStopping && Date.now() - startWait < 5000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    let checkpoint: TaskCheckpoint | null = null;
    if (this.db && this.db.isOpen) {
      if (checkpointId) {
        checkpoint = this.db.getCheckpoint(checkpointId);
      }
      if (!checkpoint) {
        checkpoint = this.db.getLatestCheckpoint(taskId);
      }
    }
    if (!checkpoint && this.lastKnownCheckpoint && this.lastKnownCheckpoint.taskId === taskId) {
      checkpoint = this.lastKnownCheckpoint;
    }
    if (!checkpoint) {
      throw new Error(`No checkpoint found for task "${taskId}"`);
    }

    let spec: CompiledTaskSpec | null = null;
    if (this.activeSpec && this.activeSpec.id === taskId) {
      spec = this.activeSpec;
    } else if (this.db && this.db.isOpen) {
      spec = this.db.getTask(taskId);
    }
    if (!spec) {
      throw new Error(`Task specification not found for task "${taskId}"`);
    }

    return this.startExecution(spec, undefined, checkpoint);
  }

  /**
   * Core execution pipeline: isolates lifecycle using a unique runId to prevent
   * race conditions and premature state clearing from prior runs' .finally() blocks.
   */
  public async startExecution(
    spec: CompiledTaskSpec,
    jobId?: string,
    resumeCheckpoint?: TaskCheckpoint
  ): Promise<string> {
    if (!spec || !spec.id) {
      console.warn('[ScoutWsServer] startExecution called with missing or invalid spec');
      return '';
    }

    if (this.db && this.db.isOpen) {
      this.db.insertTask(spec);
    }

    // Abort previous running task if any
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    // Wait for prior runner execution to finish teardown cleanly
    if (this.activeExecutionPromise) {
      try {
        await this.activeExecutionPromise;
      } catch {
        // Ignore prior execution cancellation errors
      }
    }

    const currentRunId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this._activeRunId = currentRunId;
    this.activeTaskId = spec.id;
    this.activeSpec = spec;
    if (this.resultsStore) {
      if (!resumeCheckpoint) {
        this.resultsStore.initTask(spec);
      }
    }
    if (resumeCheckpoint) {
      this.lastKnownCheckpoint = resumeCheckpoint;
    }
    this.activeJobId = jobId ?? null;
    this.isRunning = true;

    if (this.db && this.db.isOpen && jobId) {
      this.db.createRun({ id: currentRunId, jobId });
    }

    this.broadcastStatus();

    if (jobId) {
      this.broadcast({
        type: 'JOB_STATUS',
        payload: {
          jobId,
          status: 'running',
          activeRunId: currentRunId
        }
      });
    }

    // Launch BrowserRunner and LayaEngine loop if configured
    if (this.browserRunner && this.layaEngine) {
      const controller = new AbortController();
      this.activeAbortController = controller;

      let scannedCount = resumeCheckpoint ? (resumeCheckpoint.totalScanned || 0) : 0;
      let alertCount = resumeCheckpoint ? (resumeCheckpoint.totalAlerts || 0) : 0;
      let latencySum = 0;

      const runPromise = (async () => {
        try {
          await this.browserRunner!.runTask(
            spec,
            async (candidate) => {
              if (controller.signal.aborted || this._activeRunId !== currentRunId) return;

              const telemetryItem = await this.layaEngine!.evaluateDomBatch(
                candidate.text,
                spec
              );

              scannedCount++;
              latencySum += telemetryItem.latencyMs;

              if (telemetryItem.triggeredAlert) {
                alertCount++;
              }

              const targetConfidence =
                telemetryItem.rawAnswers[spec.alertRule.questionKey]?.answer_confidence ?? 0.8;
              const scrapedItem: ScrapedItem = {
                id: telemetryItem.id,
                timestamp: new Date(telemetryItem.timestamp).toISOString(),
                text: candidate.text,
                link: candidate.link || undefined,
                answers: Object.fromEntries(
                  Object.entries(telemetryItem.rawAnswers).map(([k, v]) => [k, v.answer])
                ),
                confidence: targetConfidence,
                triggeredAlert: telemetryItem.triggeredAlert
              };

              if (this.resultsStore) {
                this.resultsStore.recordItem(scrapedItem, telemetryItem.latencyMs);

                if (telemetryItem.triggeredAlert) {
                  this.broadcast({
                    type: 'RESULTS_UPDATE',
                    payload: {
                      markdown: this.resultsStore.getMarkdown(),
                      summary: this.resultsStore.getSummary(),
                      stats: this.resultsStore.getStats(),
                      items: this.resultsStore.getItems(),
                      timestamp: new Date().toISOString()
                    }
                  });
                }
              }

              this.emitInference(telemetryItem, currentRunId);
            },
            controller.signal,
            (action: AgentAction) => {
              if (this._activeRunId === currentRunId) {
                if (this.db && this.db.isOpen) {
                  try {
                    this.db.saveAgentAction(action, currentRunId);
                  } catch {}
                }
                this.broadcast({
                  type: 'AGENT_ACTION',
                  payload: action
                });
              }
            },
            (snapshot: BrowserSnapshot) => {
              if (this._activeRunId === currentRunId) {
                this.broadcast({
                  type: 'BROWSER_SNAPSHOT',
                  payload: snapshot
                });
              }
            },
            () => alertCount,
            resumeCheckpoint,
            async (chk) => {
              if (this.db && this.db.isOpen && this._activeRunId === currentRunId) {
                const periodicCheckpoint: TaskCheckpoint = {
                  id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                  taskId: spec.id,
                  runId: currentRunId,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                  status: 'running',
                  targetUrl: chk.targetUrl || spec.targetUrl,
                  currentUrl: chk.currentUrl || spec.targetUrl,
                  pageTitle: chk.pageTitle,
                  scroll: chk.scroll || { y: 0, scrollHeight: 0, viewportHeight: 0 },
                  totalScanned: chk.totalScanned ?? scannedCount,
                  totalAlerts: chk.totalAlerts ?? alertCount,
                  activeStepCount: chk.activeStepCount ?? 0,
                  dedupHashes: chk.dedupHashes ?? [],
                  modelConfig: {
                    systemOneModel: this._systemOneStats.modelName,
                    systemTwoModel: this._selectedModel
                  }
                };
                try {
                  this.db.saveCheckpoint(periodicCheckpoint);
                  this.lastKnownCheckpoint = periodicCheckpoint;
                } catch {
                  // ignore
                }
              }
            }
          );
        } catch (err: any) {
          if (!controller.signal.aborted) {
            console.warn(`[ScoutWsServer] Runner loop warning for task ${spec.id}: ${err.message}`);
          }
        } finally {
          // Only clear active state if this run is still the currently active run!
          if (this._activeRunId === currentRunId) {
            this.isRunning = false;
            this.activeTaskId = null;
            this._activeRunId = null;
            this.activeJobId = null;
            this.activeAbortController = null;
            this.broadcastStatus();

            if (jobId) {
              this.broadcast({
                type: 'JOB_STATUS',
                payload: {
                  jobId,
                  status: 'idle'
                }
              });
            }
          }

          if (this.db && this.db.isOpen && jobId) {
            const avgLatency = scannedCount > 0 ? latencySum / scannedCount : 0;
            this.db.completeRun(currentRunId, {
              status: controller.signal.aborted ? 'stopped' : 'completed',
              totalScanned: scannedCount,
              totalAlerts: alertCount,
              avgLatencyMs: Math.round(avgLatency * 10) / 10
            });
          }

          if (this.resultsStore) {
            try {
              const summary = await generateResultsSummary(
                this.resultsStore.getItems(),
                this.resultsStore.getStats(),
                spec.userGoal,
                this._selectedModel
              );
              this.resultsStore.updateSummary(summary);
              this.resultsStore.save();
              this.broadcast({
                type: 'RESULTS_UPDATE',
                payload: {
                  markdown: this.resultsStore.getMarkdown(),
                  summary: this.resultsStore.getSummary(),
                  stats: this.resultsStore.getStats(),
                  items: this.resultsStore.getItems(),
                  timestamp: new Date().toISOString()
                }
              });
            } catch (err: any) {
              console.warn(`[ScoutWsServer] Results summary generation notice: ${err.message}`);
            }
          }

          if (this._activeRunId === currentRunId) {
            this.activeExecutionPromise = null;
          }
        }
      })();

      this.activeExecutionPromise = runPromise;
      await runPromise;
    }

    return currentRunId;
  }

  public broadcastJobsList(): void {
    if (this.db) {
      this.broadcast({
        type: 'JOBS_LIST',
        payload: this.db.listJobs()
      });
    }
  }

  /**
   * Broadcast message to all connected clients whose readyState is OPEN.
   */
  public broadcast(msg: WsServerToClientMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  public getDaemonStatusPayload(): DaemonStatusPayload & { lastCheckpoint?: TaskCheckpoint } {
    const payload: DaemonStatusPayload & { lastCheckpoint?: TaskCheckpoint } = {
      isRunning: this.isRunning,
      layaReady: this.layaReady,
      activeTaskId: this.activeTaskId
    };
    if (this._activeRunId) {
      payload.activeRunId = this._activeRunId;
    }
    // Only attach activeModel when layaEngine is present, layaReady is true, or metadata is configured
    if (this.layaEngine || this.layaReady || this._activeModelMetadata) {
      payload.activeModel = this.getActiveModelMetadata();
    }
    let lastCheckpoint: TaskCheckpoint | undefined = this.lastKnownCheckpoint;
    if (this.db && this.db.isOpen) {
      try {
        if (this.activeTaskId) {
          const chk = this.db.getLatestCheckpoint(this.activeTaskId);
          if (chk) lastCheckpoint = chk;
        } else if (!lastCheckpoint) {
          const tasks = this.db.listTasks();
          if (tasks.length > 0 && tasks[0].id) {
            const chk = this.db.getLatestCheckpoint(tasks[0].id);
            if (chk) lastCheckpoint = chk;
          }
        }
      } catch {
        // Ignore DB query errors
      }
    }
    if (lastCheckpoint) {
      payload.lastCheckpoint = lastCheckpoint;
    }
    return payload;
  }

  public getActiveModelMetadata(): ActiveModelMetadata | undefined {
    if (this._activeModelMetadata) {
      return this._activeModelMetadata;
    }
    const currentStats = this.getModelStats();
    return {
      systemOne: {
        name: currentStats.systemOne.modelName,
        format: currentStats.systemOne.format,
        provider: currentStats.systemOne.provider,
        device: currentStats.systemOne.device,
        status: currentStats.systemOne.status
      },
      systemTwo: {
        name: currentStats.systemTwo.modelName,
        status: currentStats.systemTwo.status,
        gpuOffloaded: currentStats.systemTwo.gpuOffloaded,
        vramUsageMb: currentStats.systemTwo.vramUsageMb
      }
    };
  }

  public setActiveModelMetadata(metadata?: ActiveModelMetadata): void {
    this._activeModelMetadata = metadata;
    this.broadcastStatus();
  }

  /**
   * Broadcast current daemon status to all connected open clients.
   */
  public broadcastStatus(): void {
    this.broadcast({
      type: 'DAEMON_STATUS',
      payload: this.getDaemonStatusPayload()
    });
  }

  /**
   * Get comprehensive ModelStats across System 1 and System 2.
   */
  public getModelStats(): ModelStats {
    let s1: ModelStats['systemOne'];
    if (this.layaEngine && typeof (this.layaEngine as any).getModelStats === 'function') {
      s1 = (this.layaEngine as any).getModelStats();
    } else {
      s1 = {
        ...this._systemOneStats,
        status: this.layaReady ? 'ready' : this._systemOneStats.status
      };
    }

    return {
      systemOne: s1,
      systemTwo: {
        modelName: this._selectedModel,
        availableModels: this._availableModels,
        status: this._systemTwoStatus,
        vramUsageMb: this._systemTwoVramMb,
        gpuOffloaded: this._systemTwoGpuOffloaded,
        error: this._systemTwoError
      }
    };
  }

  /**
   * Broadcast MODEL_STATS payload to all connected open clients.
   */
  public broadcastModelStats(stats?: ModelStats): void {
    const payload = stats ?? this.getModelStats();
    this.broadcast({
      type: 'MODEL_STATS',
      payload
    });
  }

  public broadcastNotification(level: 'info' | 'warning' | 'error', title: string, message: string): void {
    this.broadcast({
      type: 'DAEMON_NOTIFICATION',
      payload: {
        level,
        title,
        message,
        timestamp: Date.now()
      }
    });
  }

  public async broadcastGgufModels(): Promise<void> {
    try {
      const telemetry = await llamaEngine.getTelemetry();
      const models = llamaEngine.getModelsList();
      this.broadcast({
        type: 'GGUF_MODELS_LIST',
        payload: {
          models,
          activeModelId: llamaEngine.getActiveModelId(),
          gpuName: telemetry.gpuName,
          gpuBackend: telemetry.gpuBackend,
          vramUsageMb: telemetry.vramUsageMb,
          totalVramMb: telemetry.totalVramMb
        }
      });
    } catch {
      // ignore
    }
  }

  public setSystemOneStats(stats: Partial<ModelStats['systemOne']>): void {
    this._systemOneStats = { ...this._systemOneStats, ...stats };
    if (stats.status === 'ready') {
      this.layaReady = true;
    } else if (stats.status === 'error' || stats.status === 'idle') {
      this.layaReady = false;
    }
    this.broadcastStatus();
    this.broadcastModelStats();
  }

  public setSystemTwoStats(stats: {
    status?: ModelLoadingStatus;
    modelName?: string;
    vramUsageMb?: number;
    gpuOffloaded?: boolean;
    error?: string;
    availableModels?: string[];
  }): void {
    if (stats.status !== undefined) this._systemTwoStatus = stats.status;
    if (stats.modelName !== undefined) this._selectedModel = stats.modelName;
    if (stats.vramUsageMb !== undefined) this._systemTwoVramMb = stats.vramUsageMb;
    if (stats.gpuOffloaded !== undefined) this._systemTwoGpuOffloaded = stats.gpuOffloaded;
    if (stats.error !== undefined) this._systemTwoError = stats.error;
    if (stats.availableModels !== undefined) this._availableModels = stats.availableModels;
    this.broadcastStatus();
    this.broadcastModelStats();
  }

  public setSelectedModel(model: string): void {
    this._selectedModel = model;
    this.broadcastModelStats();
  }

  /**
   * Set Laya engine ready state and broadcast status update.
   */
  public setLayaReady(ready: boolean): void {
    this.layaReady = ready;
    this._systemOneStats.status = ready ? 'ready' : 'idle';
    this.broadcastStatus();
    this.broadcastModelStats();
  }

  /**
   * Update internal status properties directly.
   */
  public setStatus(status: Partial<DaemonStatusPayload & { lastCheckpoint?: TaskCheckpoint }>): void {
    if (status.isRunning !== undefined) this.isRunning = status.isRunning;
    if (status.layaReady !== undefined) this.layaReady = status.layaReady;
    if (status.activeTaskId !== undefined) this.activeTaskId = status.activeTaskId;
    if (status.activeRunId !== undefined) this._activeRunId = status.activeRunId;
    if (status.activeModel !== undefined) this._activeModelMetadata = status.activeModel;
    if (status.lastCheckpoint !== undefined) this.lastKnownCheckpoint = status.lastCheckpoint;
    this.broadcastStatus();
  }

  /**
   * Get current daemon status.
   */
  public getStatus(): DaemonStatusPayload & { lastCheckpoint?: TaskCheckpoint } {
    return this.getDaemonStatusPayload();
  }

  /**
   * Inject or update LayaEngine instance.
   */
  public setLayaEngine(engine: LayaEngine): void {
    this.layaEngine = engine;
    this._systemMonitor.setLayaEngine(engine);
    if (typeof (engine as any).on === 'function') {
      (engine as any).on('status_change', () => {
        this.broadcastStatus();
        this.broadcastModelStats();
      });
    }
    this.setLayaReady(engine.isReady);
  }

  /**
   * Emit an inference telemetry event to connected clients.
   * If triggeredAlert is true, stores alert in DB and broadcasts ALERT_MATCH and AGENT_ACTION.
   */
  public emitInference(item: InferenceTelemetryItem, runId?: string): void {
    const effectiveRunId = runId || this._activeRunId || undefined;
    if (this.db && this.db.isOpen && item.triggeredAlert) {
      try {
        this.db.saveAlert(item, effectiveRunId);
      } catch (err: any) {
        console.warn(`[ScoutWsServer] Alert save notice: ${err.message}`);
      }
    }
    this.broadcast({
      type: 'INFERENCE_EVENT',
      payload: item
    });
    if (item.triggeredAlert) {
      this.broadcast({
        type: 'ALERT_MATCH',
        payload: item
      });
      this.broadcast({
        type: 'AGENT_ACTION',
        payload: {
          id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          taskId: item.taskId,
          timestamp: item.timestamp,
          type: 'alert',
          status: 'warning',
          message: `Alert rule triggered on: "${item.domSnippet.slice(0, 50)}"`,
          details: item.rawAnswers
        }
      });
    }
  }



  /**
   * Inject or update BrowserRunner instance.
   */
  public setBrowserRunner(runner: BrowserRunner): void {
    this.browserRunner = runner;
    this._systemMonitor.setBrowserRunner(runner);
  }

  /**
   * Get ResultsStore instance.
   */
  public getResultsStore(): ResultsStore {
    return this.resultsStore;
  }

  /**
   * Inject or update ResultsStore instance.
   */
  public setResultsStore(store: ResultsStore): void {
    this.resultsStore = store;
  }

  public get activeRunId(): string | null {
    return this._activeRunId;
  }

  public get selectedModel(): string {
    return this._selectedModel;
  }

  public get systemMonitor(): SystemMonitor {
    return this._systemMonitor;
  }

  public get scheduler(): JobScheduler {
    return this._scheduler;
  }

  /**
   * Number of currently connected WebSocket clients.
   */
  public get connectedClientsCount(): number {
    return this.wss.clients.size;
  }

  /**
   * Get effective port (especially useful if initialized with port 0).
   */
  public get port(): number {
    const addr = this.wss.address();
    if (addr && typeof addr === 'object') {
      return (addr as AddressInfo).port;
    }
    return this._port;
  }

  /**
   * Get host binding.
   */
  public get host(): string {
    return this._host;
  }

  /**
   * Await until the WebSocket server has finished binding.
   */
  public async waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Graceful close method: terminates all sockets, aborts active runner, stops monitor and scheduler, and closes the server.
   */
  public async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this._isStopping = false;

    this._systemMonitor.stop();
    this._scheduler.stop();

    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    if (this.activeExecutionPromise) {
      try {
        await this.activeExecutionPromise;
      } catch {
        // Ignore
      }
    }

    this.isRunning = false;
    this.activeTaskId = null;
    this._activeRunId = null;
    this.activeJobId = null;

    for (const client of this.wss.clients) {
      try {
        client.terminate();
      } catch {
        // Ignore error terminating closed client
      }
    }

    return new Promise<void>((resolve) => {
      this.wss.close(() => {
        resolve();
      });
    });
  }

  /**
   * Underlying WebSocketServer instance.
   */
  public get rawServer(): WebSocketServer {
    return this.wss;
  }
}
