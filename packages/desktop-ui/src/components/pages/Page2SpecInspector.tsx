import React from 'react';
import {
  Sliders,
  Play,
  RotateCw,
  ExternalLink,
  Target,
  Layers,
  Sparkles,
} from 'lucide-react';
import type {
  LayaChoiceQuestion,
  LayaNoulQuestion,
  LayaScoreQuestion,
} from '@ofln-scout/shared';
import { useScoutStore } from '../../store/useScoutStore';
import { wsClient } from '../../lib/wsClient';
import { PRESETS } from '../presets';

export const Page2SpecInspector: React.FC = () => {
  const currentSpec = useScoutStore((state) => state.currentSpec);
  const setSpec = useScoutStore((state) => state.setSpec);
  const setPage = useScoutStore((state) => state.setPage);
  const daemonStatus = useScoutStore((state) => state.daemonStatus);
  const isLaunching = useScoutStore((state) => state.isLaunching);
  const wsConnected = useScoutStore((state) => state.wsConnected);

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

  const handleStartTask = () => {
    const specToStart = currentSpec || PRESETS[0].spec;
    if (!currentSpec) {
      setSpec(specToStart);
    }
    const sent = wsClient.startTask(specToStart);
    if (sent) {
      setPage(3);
    }
  };

  const confidencePercent = currentSpec
    ? Math.round(currentSpec.alertRule.minAnswerConfidence * 100)
    : 80;

  return (
    <div className="max-w-[1920px] w-full mx-auto flex flex-col gap-6 p-4 sm:p-6 lg:px-8 xl:px-10">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#2d2d35] pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/30 font-semibold">
              Step 2 of 4
            </span>
            <h1 className="text-xl font-bold text-white tracking-tight">System 2 Block / Spec Inspector</h1>
          </div>
          <p className="text-xs text-gray-400">
            Review and calibrate the compiled task specification, target URL, extraction selectors, and gating thresholds before execution.
          </p>
        </div>
      </div>

      {!currentSpec ? (
        <div className="bg-[#242427] border border-[#383842] rounded-xl p-8 text-center flex flex-col items-center justify-center gap-4">
          <Sliders className="w-10 h-10 text-gray-500" />
          <div>
            <h3 className="text-base font-semibold text-white">No Task Spec Compiled Yet</h3>
            <p className="text-xs text-gray-400 mt-1 max-w-md">
              Return to Step 1 to compile a natural language goal, or load a default preset to begin testing immediately.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setPage(1)}
              className="px-4 py-2 rounded-lg bg-[#8B5CF6] hover:bg-[#7c3aed] text-white text-xs font-semibold transition-colors"
            >
              Go to Goal Setup
            </button>
            <button
              onClick={() => {
                setSpec(PRESETS[0].spec);
              }}
              className="px-4 py-2 rounded-lg bg-[#27272a] hover:bg-[#323238] border border-[#3f3f46] text-gray-200 text-xs font-semibold transition-colors"
            >
              Load Hacker News Default
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Left Column (xl:col-span-5): Target Configuration & Calibration */}
          <div className="xl:col-span-5 flex flex-col gap-6">
            <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col gap-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#383842] pb-4">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-[#10B981]/20 border border-[#10B981]/30 flex items-center justify-center">
                    <Sliders className="w-4 h-4 text-[#10B981]" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-white flex items-center gap-2">
                      <span>Task Specification</span>
                      <span className="text-xs font-mono px-2 py-0.5 rounded bg-[#18181b] text-[#10B981] border border-[#383842]">
                        {currentSpec.id}
                      </span>
                    </h2>
                    <p className="text-xs text-gray-400">{currentSpec.name}</p>
                  </div>
                </div>
              </div>

              {/* Editable Target URL and Selector */}
              <div className="flex flex-col gap-4">
                <div>
                  <label className="text-xs text-gray-400 font-medium flex items-center gap-1.5 mb-1.5">
                    <ExternalLink className="w-3.5 h-3.5 text-[#06B6D4]" />
                    Target URL
                  </label>
                  <input
                    type="text"
                    value={currentSpec.targetUrl}
                    onChange={(e) => handleUpdateUrl(e.target.value)}
                    className="w-full bg-[#18181b] border border-[#383842] rounded-lg px-3 py-2 text-xs text-gray-200 font-mono focus:outline-none focus:border-[#06B6D4]"
                    placeholder="https://example.com"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-400 font-medium flex items-center gap-1.5 mb-1.5">
                    <Target className="w-3.5 h-3.5 text-[#10B981]" />
                    Target DOM Selector
                  </label>
                  <input
                    type="text"
                    value={currentSpec.domSelector}
                    onChange={(e) => handleUpdateSelector(e.target.value)}
                    className="w-full bg-[#18181b] border border-[#383842] rounded-lg px-3 py-2 text-xs text-gray-200 font-mono focus:outline-none focus:border-[#10B981]"
                    placeholder="CSS selector e.g. .article, .athing"
                  />
                </div>
              </div>

              {/* Calibrated Confidence Slider */}
              <div className="bg-[#18181b] border border-[#383842] rounded-lg p-4 flex flex-col gap-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-200 font-medium flex items-center gap-1.5">
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
                  className="w-full accent-[#F59E0B] cursor-pointer h-2 bg-[#242427] rounded-lg"
                />
                <div className="flex justify-between text-[11px] text-gray-400 font-mono">
                  <span>50% (Permissive)</span>
                  <span>80% (Default Calibration)</span>
                  <span>99% (Strict High Confidence)</span>
                </div>
              </div>

              {/* Start Task Execution Card */}
              <div className="pt-2 flex flex-col gap-3">
                <button
                  onClick={handleStartTask}
                  disabled={daemonStatus.isRunning || isLaunching || !wsConnected}
                  className={`w-full flex items-center justify-center gap-2 px-5 py-3 rounded-lg text-xs font-bold shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                    daemonStatus.isRunning
                      ? 'bg-[#27272a] text-gray-400 cursor-not-allowed border border-[#383842]'
                      : 'bg-[#10B981] hover:bg-[#059669] text-black hover:scale-[1.01]'
                  }`}
                >
                  {isLaunching ? (
                    <>
                      <RotateCw className="w-4 h-4 animate-spin" />
                      <span>Launching System 1 Loop...</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-current" />
                      <span>Start Task & Launch Execution</span>
                    </>
                  )}
                </button>
                <div className="flex items-center justify-center gap-1.5 text-[11px] text-gray-400 text-center">
                  <Sparkles className="w-3.5 h-3.5 text-[#8B5CF6]" />
                  <span>Parameters verified • Ready for autonomous cycle</span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column (xl:col-span-7): Compiled System 1 Questions */}
          <div className="xl:col-span-7 bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-[#383842] pb-3">
              <h4 className="text-xs uppercase tracking-wider text-gray-400 font-semibold flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-gray-400" />
                Compiled System 1 Questions ({Object.keys(currentSpec.questions).length})
              </h4>
              <span className="text-[11px] text-gray-400 font-mono">
                Gated on: <span className="text-[#F59E0B] font-semibold">{currentSpec.alertRule.questionKey}</span> {currentSpec.alertRule.operator} {String(currentSpec.alertRule.targetValue)}
              </span>
            </div>

            <div className="space-y-3">
              {Object.entries(currentSpec.questions).map(([key, q]) => {
                const isAlertTarget = currentSpec.alertRule.questionKey === key;
                return (
                  <div
                    key={key}
                    className={`bg-[#18181b] border rounded-lg p-3.5 transition-colors ${
                      isAlertTarget
                        ? 'border-[#F59E0B]/50 bg-[#F59E0B]/5'
                        : 'border-[#383842]'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-white">
                          {key}
                        </span>
                        {isAlertTarget && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/30 font-mono font-semibold">
                            ALERT KEY
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-[#242427] text-gray-400 border border-[#383842]">
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
                                  ? 'bg-[#10B981]/20 text-[#10B981] border-[#10B981]/40 font-semibold'
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
