import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getLlama,
  createModelDownloader,
  LlamaChatSession,
  type Llama,
  type LlamaModel,
  type LlamaContext,
  type LlamaContextSequence
} from 'node-llama-cpp';
import type { GgufModelInfo } from '@ofln-scout/shared';

export interface CatalogEntry {
  id: string;
  name: string;
  tag: string;
  uri: string;
  defaultFilename: string;
  sizeMb: number;
  description: string;
}

export const GGUF_CATALOG: CatalogEntry[] = [
  {
    id: 'qwen2.5:0.5b',
    name: 'Qwen 2.5 0.5B Instruct',
    tag: 'Ultra-Fast (0.5B) • 469 MB',
    uri: 'hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M',
    defaultFilename: 'hf_Qwen_Qwen2.5-0.5B-Instruct.Q4_K_M.gguf',
    sizeMb: 469,
    description: 'Ultra-lightweight Qwen 2.5 model. Instant download, minimal RAM usage, ideal for rapid testing.'
  },
  {
    id: 'qwen2.5:1.5b',
    name: 'Qwen 2.5 1.5B Instruct',
    tag: 'Recommended (1.5B) • 1.0 GB',
    uri: 'hf:Qwen/Qwen2.5-1.5B-Instruct-GGUF:Q4_K_M',
    defaultFilename: 'hf_Qwen_Qwen2.5-1.5B-Instruct.Q4_K_M.gguf',
    sizeMb: 1066,
    description: 'Outstanding instruction-following and structured JSON formatting in a 1.5B model.'
  },
  {
    id: 'qwen2.5:3b',
    name: 'Qwen 2.5 3B Instruct',
    tag: 'Smart & Fast (3B) • 2.0 GB',
    uri: 'hf:Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M',
    defaultFilename: 'hf_Qwen_Qwen2.5-3B-Instruct.Q4_K_M.gguf',
    sizeMb: 2007,
    description: 'Strong reasoning and DOM parsing capabilities. Excellent for complex web tasks.'
  },
  {
    id: 'phi-3.5:mini',
    name: 'Phi-3.5 Mini Instruct',
    tag: 'Microsoft Reasoning (3.8B) • 2.2 GB',
    uri: 'hf:bartowski/Phi-3.5-mini-instruct-GGUF:Q4_K_M',
    defaultFilename: 'hf_bartowski_Phi-3.5-mini-instruct-GGUF.Q4_K_M.gguf',
    sizeMb: 2282,
    description: 'Microsoft Phi-3.5 architecture with strong logical deliberation and chain-of-thought.'
  },
  {
    id: 'llama3.2:1b',
    name: 'Llama 3.2 1B Instruct',
    tag: 'Meta Lightweight (1B) • 770 MB',
    uri: 'hf:bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M',
    defaultFilename: 'hf_bartowski_Llama-3.2-1B-Instruct-GGUF.Q4_K_M.gguf',
    sizeMb: 770,
    description: 'Meta Llama 3.2 compact instruction model. Extremely low latency and low memory footprint.'
  },
  {
    id: 'llama3.2:3b',
    name: 'Llama 3.2 3B Instruct',
    tag: 'Meta Generalist (3B) • 1.9 GB',
    uri: 'hf:bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M',
    defaultFilename: 'hf_bartowski_Llama-3.2-3B-Instruct-GGUF.Q4_K_M.gguf',
    sizeMb: 1926,
    description: 'Versatile 3B model with broad general knowledge and high precision.'
  },
  {
    id: 'deepseek-r1:1.5b',
    name: 'DeepSeek-R1 Distill Qwen 1.5B',
    tag: 'Deep Reasoning (1.5B) • 1.0 GB',
    uri: 'hf:bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF:Q4_K_M',
    defaultFilename: 'hf_bartowski_DeepSeek-R1-Distill-Qwen-1.5B-GGUF.Q4_K_M.gguf',
    sizeMb: 1066,
    description: 'Distilled from DeepSeek-R1. Excellent step-by-step thinking for troubleshooting.'
  },
  {
    id: 'deepseek-r1:7b',
    name: 'DeepSeek-R1 Distill Qwen 7B',
    tag: 'Full Heavy Reasoning (7B) • 4.4 GB',
    uri: 'hf:bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF:Q4_K_M',
    defaultFilename: 'hf_bartowski_DeepSeek-R1-Distill-Qwen-7B-GGUF.Q4_K_M.gguf',
    sizeMb: 4466,
    description: 'High capacity reasoning model for deep analysis and executive data extraction.'
  }
];

export interface DownloadProgressEvent {
  modelId: string;
  percent: number;
  downloadedMb: number;
  totalMb: number;
  speedMbps: number;
  status: 'downloading' | 'completed' | 'error' | 'cancelled';
  error?: string;
}

class LlamaEngineManager {
  private llama: Llama | null = null;
  private currentModel: LlamaModel | null = null;
  private currentContext: LlamaContext | null = null;
  private currentSequence: LlamaContextSequence | null = null;
  private currentChatSession: LlamaChatSession | null = null;
  private activeModelId: string | null = null;
  private modelsDir: string;
  private initPromise: Promise<void> | null = null;
  private activeDownloads = new Map<
    string,
    {
      abortController: AbortController;
      downloader: any;
      progress: DownloadProgressEvent;
    }
  >();
  private generationLock: Promise<void> = Promise.resolve();

  constructor() {
    this.modelsDir = process.env.LLAMA_MODELS_DIR || path.resolve(process.cwd(), 'models');
    if (!fs.existsSync(this.modelsDir)) {
      try {
        fs.mkdirSync(this.modelsDir, { recursive: true });
      } catch {
        // ignore
      }
    }
  }

  public async getLlamaInstance(): Promise<Llama> {
    if (this.llama) return this.llama;
    if (this.initPromise) {
      await this.initPromise;
      return this.llama!;
    }

    this.initPromise = (async () => {
      try {
        this.llama = await getLlama({
          gpu: 'auto'
        });
      } finally {
        this.initPromise = null;
      }
    })();

    await this.initPromise;
    return this.llama!;
  }

  public getModelsDirectory(): string {
    return this.modelsDir;
  }

  /**
   * Scans models directory to find matching files for catalog entries or custom .gguf files
   */
  public getModelsList(): GgufModelInfo[] {
    const list: GgufModelInfo[] = [];

    // Check each catalog entry
    for (const entry of GGUF_CATALOG) {
      const activeDownload = this.activeDownloads.get(entry.id);
      const isDownloading = activeDownload?.progress.status === 'downloading';
      const downloaded = this.isModelDownloaded(entry);

      list.push({
        id: entry.id,
        name: entry.name,
        tag: entry.tag,
        description: entry.description,
        sizeMb: entry.sizeMb,
        downloaded,
        active: this.activeModelId === entry.id,
        isDownloading,
        downloadProgress: isDownloading
          ? {
              percent: activeDownload.progress.percent,
              downloadedMb: activeDownload.progress.downloadedMb,
              totalMb: activeDownload.progress.totalMb,
              speedMbps: activeDownload.progress.speedMbps
            }
          : undefined
      });
    }

    // Also include any custom GGUF files in modelsDir that aren't in catalog
    try {
      if (fs.existsSync(this.modelsDir)) {
        const files = fs.readdirSync(this.modelsDir);
        for (const file of files) {
          if (file.toLowerCase().endsWith('.gguf')) {
            const alreadyInList = list.some(
              (m) =>
                m.id === file ||
                GGUF_CATALOG.some(
                  (c) =>
                    c.defaultFilename.toLowerCase() === file.toLowerCase() ||
                    file.toLowerCase().includes(c.id.replace(':', '_').toLowerCase())
                )
            );
            if (!alreadyInList) {
              const fullPath = path.join(this.modelsDir, file);
              const stat = fs.statSync(fullPath);
              const sizeMb = Math.round(stat.size / (1024 * 1024));
              list.push({
                id: file,
                name: file.replace(/\.gguf$/i, ''),
                tag: `Local File • ${sizeMb} MB`,
                description: `Custom local model file at ${file}`,
                sizeMb,
                downloaded: true,
                active: this.activeModelId === file
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }

    return list;
  }

  private isModelDownloaded(entry: CatalogEntry): boolean {
    try {
      if (!fs.existsSync(this.modelsDir)) return false;

      // 1. Direct default filename check
      const directPath = path.join(this.modelsDir, entry.defaultFilename);
      if (fs.existsSync(directPath)) {
        const stat = fs.statSync(directPath);
        if (stat.size > 10 * 1024 * 1024) return true; // file > 10MB
      }

      // 2. Scan directory for matches by id or pattern
      const files = fs.readdirSync(this.modelsDir);
      const cleanId = entry.id.replace(/[:\/]/g, '_').toLowerCase();
      const nameParts = entry.id.split(':'); // e.g. ['qwen2.5', '1.5b']

      return files.some((f) => {
        const lower = f.toLowerCase();
        if (!lower.endsWith('.gguf')) return false;
        if (lower.includes(cleanId)) return true;
        if (nameParts.length === 2 && lower.includes(nameParts[0]) && lower.includes(nameParts[1])) {
          return true;
        }
        return false;
      });
    } catch {
      return false;
    }
  }

  public getModelFilePath(modelId: string): string | null {
    if (!fs.existsSync(this.modelsDir)) return null;

    // Check direct path if an absolute path was passed
    if (fs.existsSync(modelId)) return modelId;

    // Check catalog default filename
    const catalogEntry = GGUF_CATALOG.find((m) => m.id === modelId);
    if (catalogEntry) {
      const direct = path.join(this.modelsDir, catalogEntry.defaultFilename);
      if (fs.existsSync(direct)) return direct;
    }

    // Check if filename in modelsDir matches modelId
    const directFile = path.join(this.modelsDir, modelId);
    if (fs.existsSync(directFile)) return directFile;

    // Search directory
    const cleanId = modelId.replace(/[:\/]/g, '_').toLowerCase();
    const nameParts = modelId.split(':');
    const files = fs.readdirSync(this.modelsDir);

    for (const f of files) {
      const lower = f.toLowerCase();
      if (!lower.endsWith('.gguf')) continue;
      if (lower.includes(cleanId)) return path.join(this.modelsDir, f);
      if (nameParts.length === 2 && lower.includes(nameParts[0]) && lower.includes(nameParts[1])) {
        return path.join(this.modelsDir, f);
      }
    }

    return null;
  }

  /**
   * Start downloading a model from Hugging Face
   */
  public async downloadModel(
    modelId: string,
    onProgress: (event: DownloadProgressEvent) => void
  ): Promise<string> {
    const catalogEntry = GGUF_CATALOG.find((m) => m.id === modelId);
    if (!catalogEntry) {
      throw new Error(`Model "${modelId}" is not in the recognized Hugging Face catalog.`);
    }

    // If already downloaded, return path immediately
    const existing = this.getModelFilePath(modelId);
    if (existing) {
      onProgress({
        modelId,
        percent: 100,
        downloadedMb: catalogEntry.sizeMb,
        totalMb: catalogEntry.sizeMb,
        speedMbps: 0,
        status: 'completed'
      });
      return existing;
    }

    // Cancel any existing download for this model
    if (this.activeDownloads.has(modelId)) {
      await this.cancelDownload(modelId);
    }

    const abortController = new AbortController();

    const progressEvent: DownloadProgressEvent = {
      modelId,
      percent: 0,
      downloadedMb: 0,
      totalMb: catalogEntry.sizeMb,
      speedMbps: 0,
      status: 'downloading'
    };

    onProgress(progressEvent);

    try {
      const downloader = await createModelDownloader({
        modelUri: catalogEntry.uri,
        dirPath: this.modelsDir,
        showCliProgress: false,
        onProgress: (status) => {
          const downloadedMb = Math.round(status.downloadedSize / (1024 * 1024));
          const totalMb = Math.round(status.totalSize / (1024 * 1024)) || catalogEntry.sizeMb;
          const percent = totalMb > 0 ? Math.min(100, Math.round((status.downloadedSize / status.totalSize) * 100)) : 0;
          const speedMbps = Math.round((status.averageSpeed / (1024 * 1024)) * 10) / 10;

          progressEvent.percent = percent;
          progressEvent.downloadedMb = downloadedMb;
          progressEvent.totalMb = totalMb;
          progressEvent.speedMbps = speedMbps;
          progressEvent.status = 'downloading';

          onProgress({ ...progressEvent });
        }
      });

      this.activeDownloads.set(modelId, {
        abortController,
        downloader,
        progress: progressEvent
      });

      const downloadedPath = await downloader.download({ signal: abortController.signal });

      progressEvent.percent = 100;
      progressEvent.status = 'completed';
      onProgress({ ...progressEvent });

      this.activeDownloads.delete(modelId);
      return downloadedPath;
    } catch (err: any) {
      this.activeDownloads.delete(modelId);
      if (abortController.signal.aborted) {
        progressEvent.status = 'cancelled';
        onProgress({ ...progressEvent });
        throw new Error(`Download of ${modelId} was cancelled.`);
      } else {
        progressEvent.status = 'error';
        progressEvent.error = err?.message || String(err);
        onProgress({ ...progressEvent });
        throw err;
      }
    }
  }

  /**
   * Cancel an in-progress model download
   */
  public async cancelDownload(modelId: string): Promise<void> {
    const active = this.activeDownloads.get(modelId);
    if (active) {
      active.abortController.abort();
      try {
        await active.downloader.cancel({ deleteTempFile: true });
      } catch {
        // ignore
      }
      this.activeDownloads.delete(modelId);
    }
  }

  /**
   * Load a downloaded model into GPU/RAM
   */
  public async loadModel(modelId: string): Promise<boolean> {
    let filePath = this.getModelFilePath(modelId);

    // If not on disk, cannot load
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Model "${modelId}" is not downloaded yet. Please download it first.`);
    }

    if (this.activeModelId === modelId && this.currentModel) {
      return true; // Already loaded
    }

    const llama = await this.getLlamaInstance();

    // Unload existing model
    await this.unloadModel();

    try {
      const model = await llama.loadModel({
        modelPath: filePath,
        gpuLayers: 'auto'
      });

      const context = await model.createContext();
      this.currentSequence = context.getSequence();
      this.currentChatSession = new LlamaChatSession({
        contextSequence: this.currentSequence,
        autoDisposeSequence: false,
      });
      this.currentModel = model;
      this.currentContext = context;
      this.activeModelId = modelId;

      return true;
    } catch (err: any) {
      await this.unloadModel();
      throw err;
    }
  }

  public async unloadModel(): Promise<void> {
    if (this.currentChatSession) {
      try {
        this.currentChatSession.dispose();
      } catch {
        // ignore
      }
      this.currentChatSession = null;
    }
    if (this.currentSequence) {
      try {
        this.currentSequence.dispose();
      } catch {
        // ignore
      }
      this.currentSequence = null;
    }
    if (this.currentContext) {
      try {
        await this.currentContext.dispose();
      } catch {
        // ignore
      }
      this.currentContext = null;
    }
    if (this.currentModel) {
      try {
        await this.currentModel.dispose();
      } catch {
        // ignore
      }
      this.currentModel = null;
    }
    this.activeModelId = null;
  }

  public isReady(): boolean {
    return this.currentModel !== null && this.currentContext !== null;
  }

  public getActiveModelId(): string | null {
    return this.activeModelId;
  }

  public async getTelemetry(): Promise<{
    online: boolean;
    provider: string;
    gpuName: string;
    gpuBackend: string;
    vramUsageMb: number;
    totalVramMb: number;
    gpuOffloaded: boolean;
    status: 'idle' | 'loading' | 'ready' | 'error';
    activeModelId: string | null;
  }> {
    let gpuName = 'CPU Only';
    let gpuBackend = 'cpu';
    let vramUsageMb = 0;
    let totalVramMb = 0;
    let gpuOffloaded = false;

    try {
      const llama = await this.getLlamaInstance();
      gpuBackend = String(llama.gpu || 'cpu');
      gpuOffloaded = Boolean(llama.gpu);

      const gpuNames = await llama.getGpuDeviceNames();
      if (gpuNames && gpuNames.length > 0) {
        gpuName = gpuNames.join(', ');
      }

      const vram = await llama.getVramState();
      if (vram) {
        vramUsageMb = Math.round(vram.used / (1024 * 1024));
        totalVramMb = Math.round(vram.total / (1024 * 1024));
      }
    } catch {
      // ignore
    }

    return {
      online: true,
      provider: 'node-llama-cpp (Embedded)',
      gpuName,
      gpuBackend,
      vramUsageMb,
      totalVramMb,
      gpuOffloaded,
      status: this.isReady() ? 'ready' : 'idle',
      activeModelId: this.activeModelId
    };
  }

  /**
   * Run prompt completion with generation lock
   */
  public async generateText(
    prompt: string,
    options?: {
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
      maintainHistory?: boolean;
    }
  ): Promise<string | null> {
    if (!this.isReady() || !this.currentContext || !this.currentSequence) {
      return null;
    }

    let releaseLock: () => void = () => {};
    const lockWait = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const previousLock = this.generationLock;
    this.generationLock = lockWait;
    await previousLock;

    try {
      if (!this.currentChatSession || this.currentChatSession.disposed) {
        this.currentChatSession = new LlamaChatSession({
          contextSequence: this.currentSequence,
          autoDisposeSequence: false,
        });
      }

      if (!options?.maintainHistory) {
        this.currentChatSession.resetChatHistory();
      }

      if (options?.systemPrompt) {
        this.currentChatSession.setChatHistory([
          { type: 'system', text: options.systemPrompt }
        ]);
      }

      const response = await this.currentChatSession.prompt(prompt, {
        maxTokens: options?.maxTokens || 1024,
        temperature: options?.temperature ?? 0.2
      });

      return response ? response.trim() : null;
    } catch (err: any) {
      console.warn('[LlamaEngine] generateText error:', err?.message || err);
      return null;
    } finally {
      releaseLock();
    }
  }
}

export const llamaEngine = new LlamaEngineManager();
