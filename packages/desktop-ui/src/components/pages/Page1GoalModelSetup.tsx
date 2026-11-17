import React, { useState, useEffect } from 'react';
import {
  Brain,
  Sparkles,
  RotateCw,
  Cpu,
  Zap,
  Download,
  HardDrive,
  Check,
  X,
  ListFilter,
  CheckCircle,
  AlertCircle,
} from 'lucide-react';
import { useScoutStore, formatLatency } from '../../store/useScoutStore';
import { wsClient } from '../../lib/wsClient';
import { PRESETS, type PresetItem } from '../presets';

export const Page1GoalModelSetup: React.FC = () => {
  const currentSpec = useScoutStore((state) => state.currentSpec);
  const setSpec = useScoutStore((state) => state.setSpec);
  const compilationStatus = useScoutStore((state) => state.compilationStatus);
  const compilationMessage = useScoutStore((state) => state.compilationMessage);
  const daemonStatus = useScoutStore((state) => state.daemonStatus);
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

  return (
    <div className="max-w-[1920px] w-full mx-auto flex flex-col gap-6 p-4 sm:p-6 lg:px-8 xl:px-10">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#2d2d35] pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#8B5CF6]/20 text-[#8B5CF6] border border-[#8B5CF6]/30 font-semibold">
              Step 1 of 4
            </span>
            <h1 className="text-xl font-bold text-white tracking-tight">System 2 Goal & Model Setup</h1>
          </div>
          <p className="text-xs text-gray-400">
            Define your high-level objective in natural language. System 2 will reason about requirements and compile a System 1 execution spec.
          </p>
        </div>
      </div>

      {/* Top Balanced Grid: Goal Formulation (Left 7 Cols) & Dual-Brain Telemetry (Right 5 Cols) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        {/* Card A: System 2 Goal & Task Compiler */}
        <div className="xl:col-span-7 bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-[#8B5CF6]/20 border border-[#8B5CF6]/30 flex items-center justify-center">
                  <Brain className="w-4 h-4 text-[#8B5CF6]" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-white">System 2 Goal Input & Reasoning Hub</h2>
                  <p className="text-xs text-gray-400">Natural Language Goal Formulation & Automated Question Derivation</p>
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

            {/* Quick Presets */}
            <div className="mb-4">
              <label className="text-xs text-gray-400 font-medium mb-2 flex items-center gap-1.5">
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
          </div>

          {/* Action Button & Status Output */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-[#383842]">
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

            <div className="text-xs text-gray-300 flex items-center gap-2 bg-[#18181b] border border-[#383842] rounded-lg px-3 py-1.5 max-w-md truncate">
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

        {/* Card C: Dual-Brain Engine Telemetry */}
        <div className="xl:col-span-5 bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#383842] pb-3 mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-[#10B981]/20 border border-[#10B981]/30 flex items-center justify-center">
                  <Cpu className="w-4 h-4 text-[#10B981]" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-white">Dual-Brain Engine Telemetry</h2>
                  <p className="text-xs text-gray-400">
                    System 1 Fast-Path ONNX Classifier & System 2 Llama.cpp Reasoner
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

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2 gap-4">
              {/* System 1 ONNX Fast-Path Engine */}
              <div className="bg-[#18181b] border border-[#383842] rounded-lg p-3.5 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-[#10B981]" />
                    <span className="text-xs font-semibold text-white uppercase tracking-wider">
                      System 1 • ONNX
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

                <div className="space-y-1 text-xs font-mono">
                  <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                    <span className="text-gray-400 font-sans">Model:</span>
                    <span className="text-gray-200 truncate max-w-[140px]">{modelStats?.systemOne?.modelName || 'modernbert-onnx-fp32'}</span>
                  </div>
                  <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                    <span className="text-gray-400 font-sans">Format:</span>
                    <span className="text-emerald-400 uppercase font-semibold">
                      {modelStats?.systemOne?.format || 'FP32'}
                    </span>
                  </div>
                  <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                    <span className="text-gray-400 font-sans">Provider:</span>
                    <span className="text-[#06B6D4] truncate max-w-[140px]">{modelStats?.systemOne?.provider || 'DirectML / CPU'}</span>
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
              <div className="bg-[#18181b] border border-[#383842] rounded-lg p-3.5 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Brain className="w-4 h-4 text-[#8B5CF6]" />
                    <span className="text-xs font-semibold text-white uppercase tracking-wider">
                      System 2 • Llama.cpp
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

                <div className="space-y-1 text-xs font-mono">
                  <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                    <span className="text-gray-400 font-sans">Active:</span>
                    <span className="text-[#8B5CF6] font-semibold truncate max-w-[140px]" title={activeGgufModelId || selectedModel}>
                      {activeGgufModelId || selectedModel}
                    </span>
                  </div>
                  <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                    <span className="text-gray-400 font-sans">Backend:</span>
                    <span className="text-[#10B981] font-semibold truncate max-w-[140px]" title={`${gpuName} (${gpuBackend})`}>
                      {gpuBackend || 'vulkan'}
                    </span>
                  </div>
                  <div className="flex justify-between py-0.5 border-b border-[#383842]/50">
                    <span className="text-gray-400 font-sans">VRAM:</span>
                    <span className="text-gray-200">
                      {vramUsageMb > 0 ? `${vramUsageMb} MB` : '0 MB'}
                    </span>
                  </div>
                  <div className="flex justify-between py-0.5">
                    <span className="text-gray-400 font-sans">Models:</span>
                    <span className="text-gray-300">
                      {ggufModels.length > 0
                        ? `${ggufModels.filter((g) => g.downloaded).length}/${ggufModels.length} local`
                        : `${availableModels.length} models`}
                    </span>
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

          <div className="mt-3 pt-2 border-t border-[#383842] flex items-center justify-between text-[11px] text-gray-400">
            <span>Dual-Engine Telemetry synchronized live</span>
            <span className="font-mono text-emerald-400">Low-latency IPC</span>
          </div>
        </div>
      </div>

      {/* Card B: GGUF Local Model Hub (Spanning Full Fluid Width Across 4 Columns) */}
      <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#383842] pb-3 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#06B6D4]/20 border border-[#06B6D4]/30 flex items-center justify-center">
              <HardDrive className="w-4 h-4 text-[#06B6D4]" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">System 2 Local Model Hub</h2>
              <p className="text-xs text-gray-400">
                In-process GGUF inference via llama.cpp • Direct Hugging Face downloads • GPU VRAM offload
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-4 gap-4">
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
    </div>
  );
};
