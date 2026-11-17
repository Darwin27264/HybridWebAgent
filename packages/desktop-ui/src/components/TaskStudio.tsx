import React, { useState, useEffect } from 'react';
import {
  Brain,
  Sparkles,
  Sliders,
  Play,
  CheckCircle,
  AlertCircle,
  ExternalLink,
  Target,
  ListFilter,
  Layers,
  RotateCw,
  Cpu,
  Zap,
  Download,
  HardDrive,
  Check,
  X,
} from 'lucide-react';
import type { CompiledTaskSpec, LayaChoiceQuestion, LayaNoulQuestion, LayaScoreQuestion } from '@ofln-scout/shared';
import { useScoutStore, formatLatency } from '../store/useScoutStore';
import { wsClient } from '../lib/wsClient';

interface PresetItem {
  id: string;
  name: string;
  badge: string;
  goal: string;
  spec: CompiledTaskSpec;
}

const PRESETS: PresetItem[] = [
  {
    id: 'hn',
    name: 'Hacker News',
    badge: 'Show HN AI',
    goal: 'Monitor Hacker News for new local AI tools, ONNX libraries, and modernBERT decision engine releases',
    spec: {
      id: 'task-hn-ai-01',
      name: 'Hacker News Show HN AI Monitor',
      userGoal: 'Monitor Hacker News for new local AI tools and ONNX libraries',
      targetUrl: 'https://news.ycombinator.com',
      domSelector: '.athing',
      pollIntervalMs: 500,
      scrollStepPx: 300,
      questions: {
        topic: {
          type: 'choice',
          question: 'What is the main topic of this post?',
          options: ['local_ai', 'web_dev', 'crypto', 'other'],
        },
        is_relevant: {
          type: 'noul',
          statement: 'This post announces or discusses local AI, ONNX, or offline machine learning.',
        },
      },
      alertRule: {
        questionKey: 'topic',
        operator: 'equals',
        targetValue: 'local_ai',
        minAnswerConfidence: 0.80,
      },
      createdAt: Date.now(),
    },
  },
  {
    id: 'reddit',
    name: 'Reddit',
    badge: 'r/LocalLLaMA',
    goal: 'Scout r/LocalLLaMA for GGUF and INT8 quantization benchmarks',
    spec: {
      id: 'task-reddit-localllama-01',
      name: 'Reddit LocalLlama Quantization Monitor',
      userGoal: 'Scout r/LocalLLaMA for GGUF and INT8 quantization benchmarks',
      targetUrl: 'https://reddit.com/r/LocalLLaMA',
      domSelector: 'shreddit-post, .thing',
      pollIntervalMs: 800,
      scrollStepPx: 450,
      questions: {
        relevance: {
          type: 'choice',
          question: 'Is this post discussing model quantization or benchmarks?',
          options: ['quantization_or_benchmark', 'general_discussion', 'meme_or_fluff'],
        },
      },
      alertRule: {
        questionKey: 'relevance',
        operator: 'equals',
        targetValue: 'quantization_or_benchmark',
        minAnswerConfidence: 0.85,
      },
      createdAt: Date.now(),
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    badge: 'Trending AI',
    goal: 'Track trending repositories related to local offline LLMs and ONNX runtime tools',
    spec: {
      id: 'task-github-ai-01',
      name: 'GitHub Trending AI Scout',
      userGoal: 'Track trending repositories related to local offline LLMs and ONNX runtime tools',
      targetUrl: 'https://github.com/trending',
      domSelector: '.Box-row',
      pollIntervalMs: 1000,
      scrollStepPx: 400,
      questions: {
        category: {
          type: 'choice',
          question: 'What is the primary category of this project?',
          options: ['ai_ml_tools', 'developer_utilities', 'documentation', 'other'],
        },
        quality_score: {
          type: 'score',
          question: 'Rate repository stars/impact score',
          rubric: {
            1: 'under 100 stars',
            2: '100-500 stars',
            3: '500-2k stars',
            4: '2k-10k stars',
            5: '10k+ viral',
          },
        },
      },
      alertRule: {
        questionKey: 'category',
        operator: 'equals',
        targetValue: 'ai_ml_tools',
        minAnswerConfidence: 0.80,
      },
      createdAt: Date.now(),
    },
  },
  {
    id: 'generic',
    name: 'Generic Web',
    badge: 'Universal',
    goal: 'Scan page for announcements and technical breakthroughs',
    spec: {
      id: 'task-generic-01',
      name: 'Generic Web Page Scout',
      userGoal: 'Scan page for announcements and technical breakthroughs',
      targetUrl: 'https://example.com',
      domSelector: 'article, .post, .item',
      pollIntervalMs: 600,
      scrollStepPx: 350,
      questions: {
        is_announcement: {
          type: 'noul',
          statement: 'This content is a formal technical announcement or release.',
        },
      },
      alertRule: {
        questionKey: 'is_announcement',
        operator: 'boolean_true',
        targetValue: true,
        minAnswerConfidence: 0.80,
      },
      createdAt: Date.now(),
    },
  },
];

export const TaskStudio: React.FC = () => {
  const currentSpec = useScoutStore((state) => state.currentSpec);
  const setSpec = useScoutStore((state) => state.setSpec);
  const compilationStatus = useScoutStore((state) => state.compilationStatus);
  const compilationMessage = useScoutStore((state) => state.compilationMessage);
  const daemonStatus = useScoutStore((state) => state.daemonStatus);
  const isLaunching = useScoutStore((state) => state.isLaunching);
  const wsConnected = useScoutStore((state) => state.wsConnected);
  const selectedModel = useScoutStore((state) => state.selectedModel);
  const availableModels = useScoutStore((state) => state.availableModels);
  const modelStats = useScoutStore((state) => state.modelStats);
  const telemetryStats = useScoutStore((state) => state.telemetryStats);
  const ggufModels = useScoutStore((state) => state.ggufModels);
  const activeGgufModelId = useScoutStore((state) => state.activeGgufModelId);
  const gpuName = useScoutStore((state) => state.gpuName);
  const gpuBackend = useScoutStore((state) => state.gpuBackend);
  const vramUsageMb = useScoutStore((state) => state.vramUsageMb);
  const totalVramMb = useScoutStore((state) => state.totalVramMb);

  const [userGoal, setUserGoal] = useState<string>(PRESETS[0].goal);
  const [activePresetId, setActivePresetId] = useState<string>('hn');
  const [customModelInput, setCustomModelInput] = useState<string>('');
  const [isCustomModel, setIsCustomModel] = useState<boolean>(false);
  const [loadingModelId, setLoadingModelId] = useState<string | null>(null);

  // Trigger model stats and gguf catalog on mount or reconnect
  useEffect(() => {
    wsClient.getModelStats();
    wsClient.getGgufModels();
  }, [wsConnected]);

  // Clear local loading state once active model matches
  useEffect(() => {
    if (loadingModelId && activeGgufModelId === loadingModelId) {
      setLoadingModelId(null);
    }
  }, [activeGgufModelId, loadingModelId]);

  // Initialize with preset spec if currentSpec is null
  useEffect(() => {
    if (!currentSpec) {
      setSpec(PRESETS[0].spec);
    }
  }, [currentSpec, setSpec]);

  const handleSelectPreset = (preset: PresetItem) => {
    setActivePresetId(preset.id);
    setUserGoal(preset.goal);
    setSpec(preset.spec);
  };

  const handleCompile = () => {
    if (!userGoal.trim()) return;
    const modelToUse = isCustomModel && customModelInput.trim()
      ? customModelInput.trim()
      : (activeGgufModelId || selectedModel);
    wsClient.compileTask(userGoal, modelToUse);
  };

  const handleModelChange = (model: string) => {
    if (model === '__custom__') {
      setIsCustomModel(true);
    } else {
      setIsCustomModel(false);
      const matchedGguf = ggufModels.find((m) => m.id === model);
      if (matchedGguf) {
        if (matchedGguf.downloaded) {
          setLoadingModelId(matchedGguf.id);
          wsClient.loadModel(matchedGguf.id);
        } else {
          wsClient.downloadModel(matchedGguf.id);
        }
      } else {
        wsClient.setModel(model);
      }
    }
  };

  const handleCustomModelSubmit = () => {
    if (customModelInput.trim()) {
      wsClient.setModel(customModelInput.trim());
    }
  };

  const handleUpdateUrl = (targetUrl: string) => {
    if (!currentSpec) return;
    setSpec({ ...currentSpec, targetUrl });
  };

  const handleUpdateSelector = (domSelector: string) => {
    if (!currentSpec) return;
    setSpec({ ...currentSpec, domSelector });
  };

  const handleUpdateThreshold = (thresholdPercent: number) => {
    if (!currentSpec) return;
    const clamped = Math.max(0.50, Math.min(0.99, thresholdPercent / 100));
    setSpec({
      ...currentSpec,
      alertRule: {
        ...currentSpec.alertRule,
        minAnswerConfidence: clamped,
      },
    });
  };

  const handleLaunch = () => {
    if (!currentSpec) return;
    wsClient.startTask(currentSpec);
  };

  const confidencePercent = currentSpec
    ? Math.round(currentSpec.alertRule.minAnswerConfidence * 100)
    : 80;

  return (
    <div className="flex flex-col gap-6">
      {/* System 2 Task Builder Card */}
      <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#8B5CF6]/20 border border-[#8B5CF6]/30 flex items-center justify-center">
              <Brain className="w-4 h-4 text-[#8B5CF6]" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">System 2 Task Studio</h2>
              <p className="text-xs text-gray-400">Embedded Llama.cpp Reasoner & Natural Language Compiler</p>
            </div>
          </div>

          {/* Model Selector Dropdown */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 bg-[#18181b] border border-[#383842] rounded-lg px-2.5 py-1 text-xs">
              <Cpu className="w-3.5 h-3.5 text-[#8B5CF6]" />
              <select
                value={isCustomModel ? '__custom__' : (activeGgufModelId || selectedModel)}
                onChange={(e) => handleModelChange(e.target.value)}
                className="bg-transparent text-gray-200 text-xs font-mono focus:outline-none cursor-pointer pr-1"
                title="Select System 2 Model"
              >
                {ggufModels.length > 0 && (
                  <optgroup label="Embedded GGUF Models">
                    {ggufModels.map((m) => (
                      <option key={m.id} value={m.id} className="bg-[#18181b] text-gray-200">
                        {m.name} ({m.active ? 'Active' : m.downloaded ? 'Downloaded' : 'Download Needed'})
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Catalog / Custom Models">
                  {availableModels.map((m) => (
                    <option key={m} value={m} className="bg-[#18181b] text-gray-200">
                      {m}
                    </option>
                  ))}
                  <option value="__custom__" className="bg-[#18181b] text-gray-200">
                    + Custom Model...
                  </option>
                </optgroup>
              </select>
            </div>

            <span
              className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                activeGgufModelId
                  ? 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30'
                  : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
              }`}
            >
              {activeGgufModelId ? `GPU: ${activeGgufModelId}` : 'Offline Template Fallback'}
            </span>
          </div>
        </div>

        {/* Custom Model Input if selected */}
        {isCustomModel && (
          <div className="mb-4 flex items-center gap-2 bg-[#18181b] p-2.5 rounded-lg border border-[#383842]">
            <input
              type="text"
              value={customModelInput}
              onChange={(e) => setCustomModelInput(e.target.value)}
              placeholder="e.g. deepseek-r1:14b or llama3:instruct"
              className="flex-1 bg-transparent text-xs text-gray-200 font-mono focus:outline-none"
            />
            <button
              onClick={handleCustomModelSubmit}
              className="px-3 py-1 bg-[#8B5CF6] hover:bg-[#7c3aed] text-white text-xs font-medium rounded transition-colors"
            >
              Set Model
            </button>
          </div>
        )}

        {/* Preset Pills */}
        <div className="mb-4">
          <label className="text-xs text-gray-400 font-medium block mb-2 flex items-center gap-1.5">
            <ListFilter className="w-3.5 h-3.5 text-gray-400" />
            Quick Presets
          </label>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => {
              const isSelected = activePresetId === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => handleSelectPreset(p)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 ${
                    isSelected
                      ? 'bg-[#8B5CF6] border-[#8B5CF6] text-white shadow-sm'
                      : 'bg-[#18181b] border-[#383842] text-gray-300 hover:text-white hover:border-[#4d4d5a]'
                  }`}
                >
                  <span>{p.name}</span>
                  <span
                    className={`text-[10px] px-1 py-0.2 rounded ${
                      isSelected ? 'bg-white/20 text-white' : 'bg-[#242427] text-gray-300'
                    }`}
                  >
                    {p.badge}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Goal Textarea */}
        <div className="mb-4">
          <label className="text-xs text-gray-400 font-medium block mb-1.5">
            Natural Language Goal
          </label>
          <textarea
            value={userGoal}
            onChange={(e) => setUserGoal(e.target.value)}
            rows={3}
            placeholder="Describe what DOM elements to scout and which conditions require immediate alerts..."
            className="w-full bg-[#18181b] border border-[#383842] rounded-lg p-3 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-[#8B5CF6] transition-colors resize-none font-sans"
          />
        </div>

        {/* Action Button & Status */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            onClick={handleCompile}
            disabled={compilationStatus === 'compiling' || !wsConnected}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#8B5CF6] hover:bg-[#7c3aed] text-white text-xs font-semibold shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {compilationStatus === 'compiling' ? (
              <>
                <RotateCw className="w-3.5 h-3.5 animate-spin" />
                <span>Compiling Spec...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" />
                <span>Compile Task Spec</span>
              </>
            )}
          </button>

          <div className="text-xs text-gray-400 flex items-center gap-1.5 truncate max-w-xs">
            {compilationStatus === 'compiling' && (
              <RotateCw className="w-3.5 h-3.5 text-[#8B5CF6] animate-spin shrink-0" />
            )}
            {compilationStatus === 'ready' && (
              <CheckCircle className="w-3.5 h-3.5 text-[#10B981] shrink-0" />
            )}
            {compilationStatus === 'error' && (
              <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
            )}
            <span className="truncate">{compilationMessage}</span>
          </div>
        </div>
      </div>

      {/* System 2 Local Model Hub Card */}
      <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#383842] pb-3 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#06B6D4]/20 border border-[#06B6D4]/30 flex items-center justify-center">
              <HardDrive className="w-4 h-4 text-[#06B6D4]" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">System 2 Local Model Hub</h2>
              <p className="text-xs text-gray-400">
                In-process GGUF inference via llama.cpp • Zero external daemon required • Direct Hugging Face downloads
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* GPU Telemetry Pill */}
            <div className="flex items-center gap-2 bg-[#18181b] border border-[#383842] rounded-lg px-3 py-1.5 text-xs font-mono">
              <Zap className="w-3.5 h-3.5 text-[#10B981]" />
              <span className="text-gray-200 font-semibold">{gpuName || 'Intel Arc B580'}</span>
              <span className="text-gray-500">•</span>
              <span className="text-[#06B6D4] uppercase font-semibold">{gpuBackend || 'vulkan'}</span>
              <span className="text-gray-500">•</span>
              <span className="text-[#8B5CF6]">
                {vramUsageMb > 0 ? `${vramUsageMb} MB` : '0 MB'} VRAM
                {totalVramMb > 0 && <span className="text-gray-400"> / {(totalVramMb / 1024).toFixed(1)} GB</span>}
              </span>
            </div>

            <button
              onClick={() => {
                wsClient.getGgufModels();
                wsClient.getModelStats();
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#18181b] hover:bg-[#2c2c31] text-gray-300 text-xs border border-[#383842] transition-colors"
              title="Refresh Models & VRAM Status"
            >
              <RotateCw className="w-3.5 h-3.5 text-[#06B6D4]" />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* Catalog Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {ggufModels.map((m) => {
            const isDownloading = m.isDownloading;
            const isLoaded = m.active;
            const isDownloaded = m.downloaded;

            return (
              <div
                key={m.id}
                className={`bg-[#18181b] border rounded-xl p-4 flex flex-col justify-between transition-all ${
                  isLoaded
                    ? 'border-[#10B981] bg-[#10B981]/5 shadow-sm'
                    : isDownloaded
                    ? 'border-[#383842] hover:border-[#4f4f5c]'
                    : 'border-[#2e2e38] opacity-90'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <h3 className="text-sm font-semibold text-white truncate" title={m.name}>
                      {m.name}
                    </h3>
                    {isLoaded ? (
                      <span className="shrink-0 flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/40 font-bold">
                        <Check className="w-3 h-3" /> ACTIVE
                      </span>
                    ) : isDownloading ? (
                      <span className="shrink-0 flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse">
                        <RotateCw className="w-3 h-3 animate-spin" /> DOWNLOADING
                      </span>
                    ) : isDownloaded ? (
                      <span className="shrink-0 text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#3b82f6]/20 text-[#60a5fa] border border-[#3b82f6]/40 font-semibold">
                        LOCAL GGUF
                      </span>
                    ) : (
                      <span className="shrink-0 text-[10px] font-mono px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700">
                        CLOUD
                      </span>
                    )}
                  </div>

                  <span className="text-[11px] font-mono text-[#8B5CF6] block mb-2">
                    {m.tag}
                  </span>

                  <p className="text-xs text-gray-400 line-clamp-2 leading-relaxed">
                    {m.description}
                  </p>
                </div>

                {/* Card Action Controls */}
                <div className="mt-4 pt-3 border-t border-[#27272a]">
                  {isDownloading ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-[11px] font-mono text-gray-300">
                        <span className="text-amber-400 font-semibold">
                          {m.downloadProgress ? `${m.downloadProgress.percent.toFixed(1)}%` : 'Starting...'}
                        </span>
                        <span>
                          {m.downloadProgress
                            ? `${m.downloadProgress.downloadedMb} / ${m.downloadProgress.totalMb} MB`
                            : `${m.sizeMb} MB`}
                        </span>
                      </div>
                      <div className="w-full bg-[#27272a] rounded-full h-1.5 overflow-hidden">
                        <div
                          className="bg-amber-400 h-full transition-all duration-300"
                          style={{ width: `${Math.min(100, Math.max(0, m.downloadProgress?.percent || 0))}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between pt-0.5">
                        <span className="text-[10px] font-mono text-gray-500">
                          {m.downloadProgress ? `${m.downloadProgress.speedMbps.toFixed(1)} MB/s` : 'Connecting...'}
                        </span>
                        <button
                          onClick={() => wsClient.cancelDownload(m.id)}
                          className="flex items-center gap-1 text-[11px] text-rose-400 hover:text-rose-300 font-medium transition-colors"
                        >
                          <X className="w-3 h-3" /> Cancel
                        </button>
                      </div>
                    </div>
                  ) : isLoaded ? (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs text-[#10B981] font-mono font-medium">
                        <span className="w-2 h-2 rounded-full bg-[#10B981]" />
                        <span>Mounted in VRAM</span>
                      </div>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30">
                        Ready
                      </span>
                    </div>
                  ) : isDownloaded ? (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-mono text-gray-400">
                        {m.sizeMb} MB
                      </span>
                      <button
                        onClick={() => {
                          setLoadingModelId(m.id);
                          wsClient.loadModel(m.id);
                        }}
                        disabled={loadingModelId !== null}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#8B5CF6] hover:bg-[#7c3aed] text-white text-xs font-semibold shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {loadingModelId === m.id ? (
                          <>
                            <RotateCw className="w-3 h-3 animate-spin" />
                            <span>Loading...</span>
                          </>
                        ) : (
                          <>
                            <Zap className="w-3 h-3" />
                            <span>Load GPU</span>
                          </>
                        )}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-mono text-gray-400">
                        ~{m.sizeMb} MB
                      </span>
                      <button
                        onClick={() => wsClient.downloadModel(m.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#27272a] hover:bg-[#323238] border border-[#3f3f46] text-white text-xs font-semibold shadow-sm transition-colors"
                      >
                        <Download className="w-3 h-3 text-[#06B6D4]" />
                        <span>Download</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Dual-Brain Model Telemetry & Lifecycle Card */}
      <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#383842] pb-3 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#10B981]/20 border border-[#10B981]/30 flex items-center justify-center">
              <Cpu className="w-4 h-4 text-[#10B981]" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Dual-Brain Engine Telemetry</h2>
              <p className="text-xs text-gray-400">
                System 1 Fast-Path ONNX Classifier & System 2 Ollama Reasoner
              </p>
            </div>
          </div>

          <button
            onClick={() => wsClient.getModelStats()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#18181b] hover:bg-[#2c2c31] text-gray-300 text-xs border border-[#383842] transition-colors"
            title="Refresh Model Telemetry"
          >
            <RotateCw className="w-3.5 h-3.5 text-[#10B981]" />
            <span>Refresh</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* System 1 ONNX Fast-Path Engine */}
          <div className="bg-[#18181b] border border-[#383842] rounded-lg p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-[#10B981]" />
                <span className="text-xs font-semibold text-white uppercase tracking-wider">
                  System 1 • ONNX Engine
                </span>
              </div>
              <span
                className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border uppercase ${
                  (modelStats?.systemOne?.status || (daemonStatus.layaReady ? 'ready' : (daemonStatus.isRunning ? 'loading' : 'idle'))) === 'ready'
                    ? 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30'
                    : (modelStats?.systemOne?.status || (daemonStatus.layaReady ? 'ready' : (daemonStatus.isRunning ? 'loading' : 'idle'))) === 'loading'
                    ? 'bg-amber-500/15 text-amber-400 border-amber-500/30 animate-pulse'
                    : (modelStats?.systemOne?.status) === 'error'
                    ? 'bg-rose-500/15 text-rose-400 border-rose-500/30'
                    : 'bg-gray-700/20 text-gray-400 border-gray-700/40'
                }`}
              >
                {modelStats?.systemOne?.status || (daemonStatus.layaReady ? 'ready' : (daemonStatus.isRunning ? 'loading' : 'idle'))}
              </span>
            </div>

            <div className="space-y-1.5 text-xs font-mono">
              <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                <span className="text-gray-400 font-sans">Model:</span>
                <span className="text-gray-200">{modelStats?.systemOne?.modelName || 'modernbert-onnx-fp32'}</span>
              </div>
              <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                <span className="text-gray-400 font-sans">Format:</span>
                <span className="text-emerald-400 uppercase font-semibold">
                  {modelStats?.systemOne?.format || 'FP32'}
                </span>
              </div>
              <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                <span className="text-gray-400 font-sans">Provider:</span>
                <span className="text-[#06B6D4]">{modelStats?.systemOne?.provider || 'DirectML / CPU'}</span>
              </div>
              <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                <span className="text-gray-400 font-sans">Device:</span>
                <span className="text-gray-300 truncate max-w-[160px]" title={modelStats?.systemOne?.device || 'DirectML Execution Provider'}>
                  {modelStats?.systemOne?.device || 'DirectML Execution Provider'}
                </span>
              </div>
              <div className="flex justify-between py-0.5">
                <span className="text-gray-400 font-sans">Avg Latency:</span>
                <span className="text-[#10B981] font-bold">
                  {formatLatency(modelStats?.systemOne?.avgLatencyMs ?? telemetryStats.avgLatencyMs)}
                </span>
              </div>
            </div>

            {modelStats?.systemOne?.error && (
              <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 rounded p-2 text-[11px] font-mono">
                {modelStats.systemOne.error}
              </div>
            )}
          </div>

          {/* System 2 Llama.cpp Strategic Reasoner */}
          <div className="bg-[#18181b] border border-[#383842] rounded-lg p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Brain className="w-4 h-4 text-[#8B5CF6]" />
                <span className="text-xs font-semibold text-white uppercase tracking-wider">
                  System 2 • Llama.cpp Engine
                </span>
              </div>
              <span
                className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border uppercase ${
                  activeGgufModelId || (modelStats?.systemTwo?.status === 'ready')
                    ? 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30'
                    : loadingModelId || (modelStats?.systemTwo?.status === 'loading')
                    ? 'bg-amber-500/15 text-amber-400 border-amber-500/30 animate-pulse'
                    : 'bg-gray-700/20 text-gray-400 border-gray-700/40'
                }`}
              >
                {activeGgufModelId ? 'READY' : loadingModelId ? 'LOADING' : 'FALLBACK'}
              </span>
            </div>

            <div className="space-y-1.5 text-xs font-mono">
              <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                <span className="text-gray-400 font-sans">Active Model:</span>
                <span className="text-[#8B5CF6] font-semibold truncate max-w-[160px]" title={activeGgufModelId || selectedModel}>
                  {activeGgufModelId || selectedModel}
                </span>
              </div>
              <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                <span className="text-gray-400 font-sans">Hardware Backend:</span>
                <span className="text-[#10B981] font-semibold truncate max-w-[160px]" title={`${gpuName} (${gpuBackend})`}>
                  {gpuName || 'Intel Arc B580'} ({gpuBackend || 'vulkan'})
                </span>
              </div>
              <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                <span className="text-gray-400 font-sans">VRAM Allocation:</span>
                <span className="text-gray-200">
                  {vramUsageMb > 0 ? `${vramUsageMb} MB` : '0 MB'} {totalVramMb > 0 ? ` / ${(totalVramMb / 1024).toFixed(1)} GB` : ''}
                </span>
              </div>
              <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                <span className="text-gray-400 font-sans">Available Models:</span>
                <span className="text-gray-300">
                  {ggufModels.length > 0
                    ? `${ggufModels.filter((g) => g.downloaded).length} of ${ggufModels.length} downloaded`
                    : `${availableModels.length} models`}
                </span>
              </div>
              <div className="flex justify-between py-0.5">
                <span className="text-gray-400 font-sans">Reasoning Role:</span>
                <span className="text-gray-300">In-Process Reasoning & Steering</span>
              </div>
            </div>

            {modelStats?.systemTwo?.error && (
              <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 rounded p-2 text-[11px] font-mono">
                {modelStats.systemTwo.error}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Interactive Spec Inspector */}
      {currentSpec && (
        <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col gap-5">
          <div className="flex items-center justify-between border-b border-[#383842] pb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-[#10B981]/20 border border-[#10B981]/30 flex items-center justify-center">
                <Sliders className="w-4 h-4 text-[#10B981]" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <span>Spec Inspector</span>
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-[#18181b] text-[#10B981] border border-[#383842]">
                    {currentSpec.id}
                  </span>
                </h3>
                <p className="text-xs text-gray-400">{currentSpec.name}</p>
              </div>
            </div>

            <button
              onClick={handleLaunch}
              disabled={daemonStatus.isRunning || isLaunching || !wsConnected}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                daemonStatus.isRunning
                  ? 'bg-[#27272a] text-gray-400 cursor-not-allowed border border-[#383842]'
                  : 'bg-[#10B981] hover:bg-[#059669] text-black'
              }`}
            >
              {isLaunching ? (
                <>
                  <RotateCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Launching...</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Launch System 1 Loop</span>
                </>
              )}
            </button>
          </div>

          {/* Editable Target URL and Selector */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 font-medium flex items-center gap-1.5 mb-1">
                <ExternalLink className="w-3 h-3 text-[#06B6D4]" />
                Target URL
              </label>
              <input
                type="text"
                value={currentSpec.targetUrl}
                onChange={(e) => handleUpdateUrl(e.target.value)}
                className="w-full bg-[#18181b] border border-[#383842] rounded-lg px-3 py-1.5 text-xs text-gray-200 font-mono focus:outline-none focus:border-[#06B6D4]"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 font-medium flex items-center gap-1.5 mb-1">
                <Target className="w-3 h-3 text-[#10B981]" />
                Target DOM Selector
              </label>
              <input
                type="text"
                value={currentSpec.domSelector}
                onChange={(e) => handleUpdateSelector(e.target.value)}
                className="w-full bg-[#18181b] border border-[#383842] rounded-lg px-3 py-1.5 text-xs text-gray-200 font-mono focus:outline-none focus:border-[#10B981]"
              />
            </div>
          </div>

          {/* Calibrated Confidence Slider */}
          <div className="bg-[#18181b] border border-[#383842] rounded-lg p-3.5 flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-300 font-medium flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[#F59E0B]" />
                Calibrated Alert Threshold
              </span>
              <span className="font-mono tabular-nums text-sm font-bold text-[#F59E0B]">
                {confidencePercent}%
              </span>
            </div>
            <input
              type="range"
              min={50}
              max={99}
              step={1}
              value={confidencePercent}
              onChange={(e) => handleUpdateThreshold(Number(e.target.value))}
              className="w-full accent-[#F59E0B] cursor-pointer"
            />
            <div className="flex justify-between text-xs text-gray-400 font-mono">
              <span>50% (Permissive)</span>
              <span>80% (Default)</span>
              <span>99% (Strict)</span>
            </div>
          </div>

          {/* Visual Question Cards */}
          <div>
            <h4 className="text-xs uppercase tracking-wider text-gray-400 font-semibold mb-3 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-gray-400" />
              Compiled System 1 Questions ({Object.keys(currentSpec.questions).length})
            </h4>

            <div className="space-y-3">
              {Object.entries(currentSpec.questions).map(([key, q]) => {
                const isAlertTarget = currentSpec.alertRule.questionKey === key;
                return (
                  <div
                    key={key}
                    className={`bg-[#18181b] border rounded-lg p-3 transition-colors ${
                      isAlertTarget
                        ? 'border-[#F59E0B]/50 bg-[#F59E0B]/5'
                        : 'border-[#383842]'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-white">
                          {key}
                        </span>
                        {isAlertTarget && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/30 font-mono">
                            ALERT KEY
                          </span>
                        )}
                      </div>
                      <span className="text-xs uppercase font-mono px-2 py-0.5 rounded bg-[#242427] text-gray-400 border border-[#383842]">
                        {q.type}
                      </span>
                    </div>

                    {q.type === 'choice' && (
                      <div>
                        <p className="text-xs text-gray-300 mb-2">
                          {(q as LayaChoiceQuestion).question}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {(Array.isArray((q as LayaChoiceQuestion).options)
                            ? ((q as LayaChoiceQuestion).options as string[])
                            : Object.values((q as LayaChoiceQuestion).options)
                          ).map((opt) => (
                            <span
                              key={opt}
                              className={`text-xs px-2 py-0.5 rounded font-mono border ${
                                isAlertTarget &&
                                currentSpec.alertRule.targetValue === opt
                                  ? 'bg-[#10B981]/20 text-[#10B981] border-[#10B981]/40'
                                  : 'bg-[#242427] text-gray-400 border-[#383842]'
                              }`}
                            >
                              {opt}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {q.type === 'noul' && (
                      <div>
                        <p className="text-xs text-gray-300 italic">
                          "{(q as LayaNoulQuestion).statement}"
                        </p>
                      </div>
                    )}

                    {q.type === 'score' && (
                      <div>
                        <p className="text-xs text-gray-300 mb-2">
                          {(q as LayaScoreQuestion).question}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries((q as LayaScoreQuestion).rubric).map(
                            ([lvl, desc]) => (
                              <span
                                key={lvl}
                                className="text-xs px-2 py-0.5 rounded font-mono bg-[#242427] text-gray-400 border border-[#383842]"
                              >
                                {lvl}: {desc}
                              </span>
                            )
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
