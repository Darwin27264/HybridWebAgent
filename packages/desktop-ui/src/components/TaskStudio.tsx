import React, { useState } from 'react';
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
} from 'lucide-react';
import type { CompiledTaskSpec, LayaChoiceQuestion, LayaNoulQuestion, LayaScoreQuestion } from '@ofln-scout/shared';
import { useScoutStore } from '../store/useScoutStore';
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
  const ollamaOnline = useScoutStore((state) => state.ollamaOnline);

  const [userGoal, setUserGoal] = useState<string>(PRESETS[0].goal);
  const [activePresetId, setActivePresetId] = useState<string>('hn');
  const [customModelInput, setCustomModelInput] = useState<string>('');
  const [isCustomModel, setIsCustomModel] = useState<boolean>(false);

  // Initialize with preset spec if currentSpec is null
  React.useEffect(() => {
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
    const modelToUse = isCustomModel && customModelInput.trim() ? customModelInput.trim() : selectedModel;
    wsClient.compileTask(userGoal, modelToUse);
  };

  const handleModelChange = (model: string) => {
    if (model === '__custom__') {
      setIsCustomModel(true);
    } else {
      setIsCustomModel(false);
      wsClient.setModel(model);
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
              <p className="text-xs text-gray-400">Local LLM Compilation via Ollama</p>
            </div>
          </div>

          {/* Model Selector Dropdown */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 bg-[#18181b] border border-[#383842] rounded-lg px-2.5 py-1 text-xs">
              <Cpu className="w-3.5 h-3.5 text-[#8B5CF6]" />
              <select
                value={isCustomModel ? '__custom__' : selectedModel}
                onChange={(e) => handleModelChange(e.target.value)}
                className="bg-transparent text-gray-200 text-xs font-mono focus:outline-none cursor-pointer pr-1"
                title="Select Ollama System 2 Model"
              >
                {availableModels.map((m) => (
                  <option key={m} value={m} className="bg-[#18181b] text-gray-200">
                    {m}
                  </option>
                ))}
                <option value="__custom__" className="bg-[#18181b] text-gray-200">
                  + Custom Model...
                </option>
              </select>
            </div>

            <span
              className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                ollamaOnline
                  ? 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30'
                  : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
              }`}
            >
              {ollamaOnline ? 'Ollama Online' : 'Template Fallback'}
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
