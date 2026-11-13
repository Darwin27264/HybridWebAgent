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
  ScrapedItem
} from '@ofln-scout/shared';
import type { ScoutDatabase } from './db.js';
import type { LayaEngine } from './engine/layaEngine.js';
import type { BrowserRunner } from './runner/browserRunner.js';
import { compileTask, fetchOllamaModels } from './engine/compiler.js';
import { SystemMonitor } from './engine/systemMonitor.js';
import { JobScheduler } from './scheduler.js';
import { ResultsStore } from './resultsStore.js';
import {
  generateResultsSummary,
  queryResults,
  steerTask
} from './engine/systemTwoAssistant.js';
import type { ScoutWsServerOptions, DaemonStatusPayload } from './types.js';

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
  private layaReady = false;
  private activeTaskId: string | null = null;
  private _activeRunId: string | null = null;
  private activeJobId: string | null = null;
  private activeAbortController: AbortController | null = null;
  private activeExecutionPromise: Promise<void> | null = null;
  private isClosed = false;
  private readyPromise: Promise<void>;

  private _selectedModel = 'qwen2.5';
  private _systemMonitor: SystemMonitor;
  private _scheduler: JobScheduler;

  constructor(options: ScoutWsServerOptions = {}) {
    super();
    this.db = options.db;
    this.layaEngine = options.layaEngine;
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
        payload: {
          isRunning: this.isRunning,
          layaReady: this.layaReady,
          activeTaskId: this.activeTaskId
        }
      };

      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(statusMsg));
      }

      // 2. Send initial models list
      fetchOllamaModels().then((modelsData) => {
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

      this.emit('client_connected', client);

      // 5. Setup incoming message handling
      client.on('message', (data) => {
        let message: WsClientToServerMessage;
        try {
          message = JSON.parse(data.toString()) as WsClientToServerMessage;
        } catch {
          // Ignore malformed JSON messages gracefully without crashing
          return;
        }
        try {
          this.handleClientMessage(message, client);
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
  private handleClientMessage(msg: WsClientToServerMessage, client: WebSocket): void {
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

        const modelToUse = msg.payload.ollamaModel || this._selectedModel;

        compileTask(msg.payload.userGoal, modelToUse)
          .then((spec) => {
            if (this.db && this.db.isOpen) {
              this.db.insertTask(spec);
            }
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
        if (this.activeAbortController) {
          this.activeAbortController.abort();
          this.activeAbortController = null;
        }
        this.isRunning = false;
        this.activeTaskId = null;
        this._activeRunId = null;
        this.activeJobId = null;
        this.broadcastStatus();
        this.emit('stop_task', client);
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
        fetchOllamaModels().then((data) => {
          this.broadcast({
            type: 'MODELS_LIST',
            payload: {
              models: data.models,
              selectedModel: this._selectedModel,
              ollamaOnline: data.online
            }
          });
          this.broadcast({
            type: 'DAEMON_NOTIFICATION',
            payload: {
              level: 'info',
              title: 'Model Selected',
              message: `Active System 2 model set to "${this._selectedModel}"`,
              timestamp: Date.now()
            }
          });
        });
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

      default:
        // Unknown message type
        break;
    }
  }

  /**
   * Core execution pipeline: isolates lifecycle using a unique runId to prevent
   * race conditions and premature state clearing from prior runs' .finally() blocks.
   */
  public async startExecution(spec: CompiledTaskSpec, jobId?: string): Promise<string> {
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
      this.resultsStore.initTask(spec);
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

      let scannedCount = 0;
      let alertCount = 0;
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

  /**
   * Broadcast current daemon status to all connected open clients.
   */
  public broadcastStatus(): void {
    this.broadcast({
      type: 'DAEMON_STATUS',
      payload: {
        isRunning: this.isRunning,
        layaReady: this.layaReady,
        activeTaskId: this.activeTaskId
      }
    });
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
   * Set Laya engine ready state and broadcast status update.
   */
  public setLayaReady(ready: boolean): void {
    this.layaReady = ready;
    this.broadcastStatus();
  }

  /**
   * Update internal status properties directly.
   */
  public setStatus(status: Partial<DaemonStatusPayload>): void {
    if (status.isRunning !== undefined) this.isRunning = status.isRunning;
    if (status.layaReady !== undefined) this.layaReady = status.layaReady;
    if (status.activeTaskId !== undefined) this.activeTaskId = status.activeTaskId;
    if (status.activeRunId !== undefined) this._activeRunId = status.activeRunId;
    this.broadcastStatus();
  }

  /**
   * Get current daemon status.
   */
  public getStatus(): DaemonStatusPayload {
    return {
      isRunning: this.isRunning,
      layaReady: this.layaReady,
      activeTaskId: this.activeTaskId,
      activeRunId: this._activeRunId
    };
  }

  /**
   * Inject or update LayaEngine instance.
   */
  public setLayaEngine(engine: LayaEngine): void {
    this.layaEngine = engine;
    this._systemMonitor.setLayaEngine(engine);
    this.setLayaReady(engine.isReady);
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
