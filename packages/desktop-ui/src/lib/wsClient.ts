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

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

// Global singleton instance for UI usage
export const wsClient = new ScoutWsClient();
