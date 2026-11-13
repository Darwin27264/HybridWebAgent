import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  Zap,
  ShieldAlert,
  Clock,
  Terminal,
} from 'lucide-react';
import type { InferenceTelemetryItem } from '@ofln-scout/shared';
import { useScoutStore, formatLatency } from '../store/useScoutStore';

export const DecisionMatrix: React.FC = () => {
  const inferenceFeed = useScoutStore((state) => state.inferenceFeed);
  const daemonStatus = useScoutStore((state) => state.daemonStatus);

  return (
    <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col h-full min-h-[460px]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#383842] pb-3 mb-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#06B6D4]/20 border border-[#06B6D4]/30 flex items-center justify-center">
            <Zap className="w-4 h-4 text-[#06B6D4]" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <span>System 1 Live Inference Stream</span>
              {daemonStatus.isRunning && (
                <span className="flex h-2 w-2 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#10B981] opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[#10B981]"></span>
                </span>
              )}
            </h2>
            <p className="text-xs text-gray-400">
              Non-autoregressive forward passes on ONNX CPU (@receptron/laya)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-[#18181b] text-gray-400 border border-[#383842]">
            Buffer: {inferenceFeed.length} / 100
          </span>
        </div>
      </div>

      {/* Stream Area */}
      <div className="flex-1 overflow-y-auto pr-1 space-y-3 max-h-[750px]">
        {inferenceFeed.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center p-6 border border-dashed border-[#383842] rounded-xl bg-[#18181b]/50">
            <Activity className="w-8 h-8 text-gray-500 mb-2 animate-pulse" />
            <p className="text-sm font-medium text-gray-300">
              No inference events yet
            </p>
            <p className="text-xs text-gray-500 mt-1 max-w-sm">
              Start a task or launch the System 1 loop to begin streaming live DOM
              evaluations at up to 30+ Hz.
            </p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {inferenceFeed.map((item: InferenceTelemetryItem) => (
              <InferenceCard key={item.id} item={item} />
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
};

interface InferenceCardProps {
  item: InferenceTelemetryItem;
}

const InferenceCard: React.FC<InferenceCardProps> = ({ item }) => {
  const isAlert = item.triggeredAlert;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className={`rounded-xl border p-4 transition-colors ${
        isAlert
          ? 'bg-[#F59E0B]/10 border-[#F59E0B]/50'
          : 'bg-[#18181b] border-[#383842] hover:border-[#4d4d5a]'
      }`}
    >
      {/* Card Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-gray-400">{item.id}</span>
          {isAlert && (
            <span className="flex items-center gap-1 text-xs font-semibold font-mono px-2 py-0.5 rounded bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/40">
              <ShieldAlert className="w-3.5 h-3.5" />
              MATCH DETECTED
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-xs font-mono text-gray-400">
            <Clock className="w-3 h-3" />
            <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
          </div>

          <span
            className={`text-xs font-mono font-semibold px-2 py-0.5 rounded border tabular-nums ${
              item.latencyMs < 30
                ? 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30'
                : item.latencyMs < 60
                ? 'bg-[#06B6D4]/15 text-[#06B6D4] border-[#06B6D4]/30'
                : 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/30'
            }`}
          >
            {formatLatency(item.latencyMs)}
          </span>
        </div>
      </div>

      {/* DOM Snippet Preview */}
      <div className="mb-3 bg-[#242427] rounded-lg p-2.5 border border-[#383842] font-mono text-xs text-gray-300 break-words flex items-start gap-2">
        <Terminal className="w-3.5 h-3.5 text-[#06B6D4] mt-0.5 shrink-0" />
        <span className="line-clamp-2 select-all">{item.domSnippet}</span>
      </div>

      {/* Evaluated Answers Matrix */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {Object.entries(item.rawAnswers).map(([key, record]) => {
          const confidencePercent = Math.round(
            (record.answer_confidence ?? 0) * 100
          );
          const isHighConfidence = record.answer_confidence >= 0.8;

          return (
            <div
              key={key}
              className="bg-[#242427] rounded-lg p-2 border border-[#383842] flex flex-col justify-between"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-mono text-gray-300 font-medium truncate">
                  {key}
                </span>
                <span
                  className={`text-xs font-mono font-semibold px-1.5 py-0.5 rounded ${
                    isAlert
                      ? 'bg-[#F59E0B]/20 text-[#F59E0B]'
                      : 'bg-[#18181b] text-white border border-[#383842]'
                  }`}
                >
                  {String(record.answer)}
                </span>
              </div>

              {/* Confidence Bar */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-gray-400">P(Ans)</span>
                  <span
                    className={`tabular-nums font-semibold ${
                      isHighConfidence ? 'text-[#10B981]' : 'text-gray-400'
                    }`}
                  >
                    {confidencePercent}%
                  </span>
                </div>
                <div className="w-full h-1.5 bg-[#18181b] rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-150 ${
                      isHighConfidence
                        ? 'bg-[#10B981]'
                        : 'bg-gray-600'
                    }`}
                    style={{ width: `${confidencePercent}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
};
