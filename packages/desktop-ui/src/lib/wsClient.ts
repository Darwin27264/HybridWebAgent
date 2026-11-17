import { toast } from 'sonner';
import type {
  CompiledTaskSpec,
  WsClientToServerMessage,
  WsServerToClientMessage,
} from '@ofln-scout/shared';
import { useScoutStore } from '../store/useScoutStore';

export const WS_DEFAULT_URL = 'ws://127.0.0.1:4040';

export class ScoutWsClient {
  private url: string;
  private ws: WebSocket | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private maxBackoffMs = 10000;
  private shouldReconnect = true;
  private hasEverConnected = false;

  constructor(url: string = WS_DEFAULT_URL) {
    this.url = url;
  }

  public connect(): void {
    this.shouldReconnect = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.backoffMs = 1000;
        this.hasEverConnected = true;
        useScoutStore.getState().setConnected(true);
        toast.success('Connected to Scout Daemon', { duration: 2500 });

        // Query initial models, metrics, and jobs
        this.getModels();
        this.getMetrics();
        this.getJobs();
        this.getResults();
        this.getModelStats();
      };

      this.ws.onclose = () => {
        const wasConnected = useScoutStore.getState().wsConnected;
        useScoutStore.getState().setConnected(false);
        this.ws = null;

        if (wasConnected || this.hasEverConnected) {
          toast.error('Scout Daemon Disconnected', {
            description: 'Attempting to reconnect...',
            duration: 3000,
          });
        }

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        useScoutStore.getState().setConnected(false);
        if (this.ws) {
          this.ws.close();
        }
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string) as WsServerToClientMessage;
          this.handleServerMessage(data);
        } catch (err) {
          console.error('[ScoutWsClient] Failed to parse message:', err);
        }
      };
    } catch (err) {
      console.error('[ScoutWsClient] Connection error:', err);
      this.scheduleReconnect();
    }
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    useScoutStore.getState().setConnected(false);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, this.backoffMs);

    // Exponential backoff up to 10s
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  private handleServerMessage(msg: WsServerToClientMessage): void {
    const store = useScoutStore.getState();

    switch (msg.type) {
      case 'DAEMON_STATUS':
        store.setStatus(msg.payload);
        if (msg.payload.modelStats) {
          store.setModelStats(msg.payload.modelStats);
        }
        break;

      case 'CHECKPOINT_SAVED':
        store.setLastCheckpoint(msg.payload);
        break;

      case 'RESULTS_UPDATE':
        store.setResults(msg.payload);
        break;

      case 'QUERY_RESULTS_RESPONSE':
        store.addChatMessage({
          id: `query-resp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          role: 'assistant',
          type: 'query',
          content: msg.payload.answer,
          timestamp: typeof msg.payload.timestamp === 'string' ? new Date(msg.payload.timestamp).getTime() : Date.now(),
          meta: {
            model: msg.payload.model,
          },
        });
        store.setChatLoading(false);
        break;

      case 'STEER_TASK_RESPONSE':
        store.addChatMessage({
          id: `steer-resp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          role: 'assistant',
          type: 'steer',
          content: msg.payload.explanation,
          timestamp: typeof msg.payload.timestamp === 'string' ? new Date(msg.payload.timestamp).getTime() : Date.now(),
          meta: {
            applied: msg.payload.applied,
            explanation: msg.payload.explanation,
          },
        });
        store.setChatLoading(false);
        if (msg.payload.applied) {
          toast.success(`Steer applied: ${msg.payload.instruction}`);
        } else {
          toast.warning(`Steer not applied: ${msg.payload.explanation}`);
        }
        break;

      case 'MODEL_STATS':
        store.setModelStats(msg.payload);
        break;

      case 'COMPILATION_PROGRESS':
        store.setCompilation(msg.payload.status, msg.payload.message, msg.payload.spec);
        if (msg.payload.status === 'ready' && msg.payload.spec) {
          store.setSpec(msg.payload.spec);
          toast.success(`Task compiled successfully: ${msg.payload.spec.name}`);
        } else if (msg.payload.status === 'error') {
          toast.error(`Compilation error: ${msg.payload.message}`);
        }
        break;

      case 'INFERENCE_EVENT':
        store.addInference(msg.payload);
        break;

      case 'ALERT_MATCH':
        store.addAlert(msg.payload);
        toast.warning(`Match Detected!`, {
          description: msg.payload.domSnippet.slice(0, 80) + '...',
          duration: 4000,
        });
        break;

      case 'AGENT_ACTION':
        store.addAction(msg.payload);
        break;

      case 'BROWSER_SNAPSHOT':
        store.setLatestSnapshot(msg.payload);
        break;

      case 'MODELS_LIST':
        store.setModelsList(
          msg.payload.models,
          msg.payload.selectedModel,
          msg.payload.ollamaOnline
        );
        break;

      case 'GGUF_MODELS_LIST':
        store.setGgufModelsList(msg.payload);
        break;

      case 'MODEL_DOWNLOAD_PROGRESS':
        store.updateModelDownloadProgress(msg.payload);
        if (msg.payload.status === 'completed') {
          toast.success('Model Download Complete', {
            description: `"${msg.payload.modelId}" is ready to load onto GPU.`
          });
        } else if (msg.payload.status === 'error') {
          toast.error('Model Download Failed', {
            description: msg.payload.error || 'Failed to download GGUF from Hugging Face'
          });
        }
        break;

      case 'METRICS_UPDATE':
        store.setMetrics(msg.payload);
        break;

      case 'JOBS_LIST':
        store.setJobs(msg.payload);
        break;

      case 'JOB_STATUS':
        store.updateJobStatus(msg.payload.jobId, msg.payload.status, msg.payload.activeRunId);
        break;

      case 'DAEMON_NOTIFICATION':
        if (msg.payload.level === 'error') {
          toast.error(msg.payload.title, { description: msg.payload.message });
        } else if (msg.payload.level === 'warning') {
          toast.warning(msg.payload.title, { description: msg.payload.message });
        } else {
          toast.info(msg.payload.title, { description: msg.payload.message });
        }
        break;

      default:
        console.warn('[ScoutWsClient] Unhandled message type:', (msg as any)?.type);
        break;
    }
  }

  public send(message: WsClientToServerMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[ScoutWsClient] Cannot send message, socket not connected.');
      return false;
    }
    this.ws.send(JSON.stringify(message));
    return true;
  }

  public compileTask(userGoal: string, ollamaModel?: string): boolean {
    return this.send({
      type: 'COMPILE_TASK',
      payload: { userGoal, ollamaModel },
    });
  }

  public startTask(spec: CompiledTaskSpec): boolean {
    // Fresh run execution reset ensures second runs clear stale state
    useScoutStore.getState().startFreshRun();
    useScoutStore.getState().setIsLaunching(true);
    return this.send({
      type: 'START_TASK',
      payload: { spec },
    });
  }

  public stopTask(): boolean {
    useScoutStore.getState().setIsStopping(true);
    return this.send({
      type: 'STOP_TASK',
    });
  }

  public resumeTask(taskId?: string, checkpointId?: string): boolean {
    const store = useScoutStore.getState();
    const effectiveTaskId = taskId || store.lastCheckpoint?.taskId || store.daemonStatus.activeTaskId || '';
    if (!effectiveTaskId) {
      console.warn('[ScoutWsClient] Cannot resume task: no taskId provided');
      return false;
    }
    useScoutStore.getState().setIsLaunching(true);
    return this.send({
      type: 'RESUME_TASK',
      payload: {
        taskId: effectiveTaskId,
        checkpointId: checkpointId || store.lastCheckpoint?.id,
      },
    });
  }

  public clearAlerts(): boolean {
    const ok = this.send({
      type: 'CLEAR_ALERTS',
    });
    if (ok) {
      useScoutStore.getState().clearAlerts();
    }
    return ok;
  }

  public getModels(): boolean {
    return this.send({
      type: 'GET_MODELS',
    });
  }

  public getGgufModels(): boolean {
    return this.send({
      type: 'GET_GGUF_MODELS',
    });
  }

  public downloadModel(modelId: string): boolean {
    return this.send({
      type: 'DOWNLOAD_MODEL',
      payload: { modelId },
    });
  }

  public cancelDownload(modelId: string): boolean {
    return this.send({
      type: 'CANCEL_DOWNLOAD',
      payload: { modelId },
    });
  }

  public loadModel(modelId: string): boolean {
    return this.send({
      type: 'LOAD_MODEL',
      payload: { modelId },
    });
  }

  public setModel(model: string): boolean {
    useScoutStore.getState().setSelectedModel(model);
    return this.send({
      type: 'SET_MODEL',
      payload: { model },
    });
  }

  public getMetrics(): boolean {
    return this.send({
      type: 'GET_METRICS',
    });
  }

  public getJobs(): boolean {
    return this.send({
      type: 'GET_JOBS',
    });
  }

  public createJob(
    name: string,
    spec: CompiledTaskSpec,
    cronSchedule?: string,
    isScheduled?: boolean
  ): boolean {
    return this.send({
      type: 'CREATE_JOB',
      payload: { name, spec, cronSchedule, isScheduled },
    });
  }

  public updateJob(
    id: string,
    name?: string,
    spec?: CompiledTaskSpec,
    cronSchedule?: string,
    isScheduled?: boolean
  ): boolean {
    return this.send({
      type: 'UPDATE_JOB',
      payload: { id, name, spec, cronSchedule, isScheduled },
    });
  }

  public deleteJob(id: string): boolean {
    return this.send({
      type: 'DELETE_JOB',
      payload: { id },
    });
  }

  public startJob(jobId: string): boolean {
    useScoutStore.getState().startFreshRun();
    useScoutStore.getState().setIsLaunching(true);
    useScoutStore.getState().setActiveJobId(jobId);
    return this.send({
      type: 'START_JOB',
      payload: { jobId },
    });
  }

  public stopJob(jobId: string): boolean {
    useScoutStore.getState().setIsStopping(true);
    return this.send({
      type: 'STOP_JOB',
      payload: { jobId },
    });
  }

  public getResults(taskId?: string): boolean {
    return this.send({
      type: 'GET_RESULTS',
      payload: { taskId },
    });
  }

  public queryResults(query: string, taskId?: string): boolean {
    const trimmed = (query || '').trim();
    if (!trimmed) return false;
    const store = useScoutStore.getState();
    store.addChatMessage({
      id: `query-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: 'user',
      type: 'query',
      content: trimmed,
      timestamp: Date.now(),
    });
    store.setChatLoading(true);
    const sent = this.send({
      type: 'QUERY_RESULTS',
      payload: { query: trimmed, taskId },
    });
    if (!sent) {
      store.setChatLoading(false);
      return false;
    }
    return true;
  }

  public steerTask(instruction: string, taskId?: string): boolean {
    const trimmed = (instruction || '').trim();
    if (!trimmed) return false;
    const store = useScoutStore.getState();
    store.addChatMessage({
      id: `steer-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: 'user',
      type: 'steer',
      content: trimmed,
      timestamp: Date.now(),
    });
    store.setChatLoading(true);
    const sent = this.send({
      type: 'STEER_TASK',
      payload: { instruction: trimmed, taskId },
    });
    if (!sent) {
      store.setChatLoading(false);
      return false;
    }
    return true;
  }

  public getModelStats(): boolean {
    return this.send({
      type: 'GET_MODEL_STATS',
    });
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

// Global singleton instance for UI usage
export const wsClient = new ScoutWsClient();
