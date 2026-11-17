import React from 'react';
import {
  Compass,
  Zap,
  ArrowDown,
  ShieldAlert,
  Terminal,
  Layers,
  CheckCircle2,
  AlertCircle,
  Clock,
  Trash2,
  Activity,
  ListOrdered,
  AlertTriangle,
  Brain,
} from 'lucide-react';
import type { AgentAction } from '@ofln-scout/shared';
import { useScoutStore } from '../store/useScoutStore';

export const AgentActionTimeline: React.FC = () => {
  const agentActions = useScoutStore((state) => state.agentActions);
  const clearActions = useScoutStore((state) => state.clearActions);
  const telemetryStats = useScoutStore((state) => state.telemetryStats);

  // Compute findings summary from actions and store
  const navigationCount = agentActions.filter((a) => a.type === 'navigation').length;
  const extractionCount = agentActions.filter((a) => a.type === 'extraction').length;
  const inferenceCount = agentActions.filter((a) => a.type === 'inference').length;
  const alertCount = agentActions.filter((a) => a.type === 'alert').length;
  const stagnationCount = agentActions.filter((a) => a.type === 'stagnation_detected').length;
  const handoverCount = agentActions.filter((a) => a.type === 'system2_handover').length;

  const getActionIcon = (type: AgentAction['type']) => {
    switch (type) {
      case 'navigation':
        return <Compass className="w-3.5 h-3.5 text-[#06B6D4]" />;
      case 'extraction':
        return <Layers className="w-3.5 h-3.5 text-[#8B5CF6]" />;
      case 'inference':
        return <Zap className="w-3.5 h-3.5 text-[#10B981]" />;
      case 'scroll':
        return <ArrowDown className="w-3.5 h-3.5 text-blue-400" />;
      case 'alert':
        return <ShieldAlert className="w-3.5 h-3.5 text-[#F59E0B]" />;
      case 'stagnation_detected':
        return <AlertTriangle className="w-3.5 h-3.5 text-[#F59E0B]" />;
      case 'system2_handover':
        return <Brain className="w-3.5 h-3.5 text-[#8B5CF6]" />;
      case 'system':
      default:
        return <Terminal className="w-3.5 h-3.5 text-gray-400" />;
    }
  };

  const getStatusBadge = (status: AgentAction['status']) => {
    switch (status) {
      case 'success':
        return (
          <span className="flex items-center gap-1 text-[11px] font-mono font-medium px-2 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30">
            <CheckCircle2 className="w-3 h-3" />
            OK
          </span>
        );
      case 'warning':
        return (
          <span className="flex items-center gap-1 text-[11px] font-mono font-medium px-2 py-0.5 rounded bg-[#F59E0B]/15 text-[#F59E0B] border border-[#F59E0B]/30">
            <AlertCircle className="w-3 h-3" />
            WARN
          </span>
        );
      case 'error':
        return (
          <span className="flex items-center gap-1 text-[11px] font-mono font-medium px-2 py-0.5 rounded bg-rose-500/15 text-rose-400 border border-rose-500/30">
            <AlertCircle className="w-3 h-3" />
            ERR
          </span>
        );
      case 'pending':
      default:
        return (
          <span className="flex items-center gap-1 text-[11px] font-mono font-medium px-2 py-0.5 rounded bg-gray-700/20 text-gray-400 border border-gray-700/40">
            <Clock className="w-3 h-3" />
            PENDING
          </span>
        );
    }
  };

  return (
    <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col h-full min-h-[460px]">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#383842] pb-3 mb-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#8B5CF6]/20 border border-[#8B5CF6]/30 flex items-center justify-center">
            <ListOrdered className="w-4 h-4 text-[#8B5CF6]" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <span>Agent Action Sequence</span>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-[#18181b] text-gray-300 border border-[#383842]">
                {agentActions.length} Actions
              </span>
            </h2>
            <p className="text-xs text-gray-400">
              Ordered chronological execution trajectory of the browsing agent
            </p>
          </div>
        </div>

        {agentActions.length > 0 && (
          <button
            onClick={clearActions}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-white px-2.5 py-1 rounded bg-[#18181b] border border-[#383842] hover:border-[#4d4d5a] transition-colors"
            title="Clear Action History"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear</span>
          </button>
        )}
      </div>

      {/* Findings Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4 bg-[#18181b] p-3 rounded-lg border border-[#383842]">
        <div className="flex flex-col">
          <span className="text-xs uppercase text-gray-400 font-medium">Navigations</span>
          <span className="text-sm font-semibold font-mono text-[#06B6D4]">
            {navigationCount}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs uppercase text-gray-400 font-medium">Extractions</span>
          <span className="text-sm font-semibold font-mono text-[#8B5CF6]">
            {extractionCount}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs uppercase text-gray-400 font-medium">Inferences</span>
          <span className="text-sm font-semibold font-mono text-[#10B981]">
            {inferenceCount > 0 ? inferenceCount : telemetryStats.totalScanned}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs uppercase text-gray-400 font-medium">Matches Flagged</span>
          <span className="text-sm font-semibold font-mono text-[#F59E0B]">
            {alertCount > 0 ? alertCount : telemetryStats.totalAlerts}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs uppercase text-gray-400 font-medium">Stagnations</span>
          <span className="text-sm font-semibold font-mono text-[#F59E0B]">
            {stagnationCount}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs uppercase text-gray-400 font-medium">Handovers</span>
          <span className="text-sm font-semibold font-mono text-[#8B5CF6]">
            {handoverCount}
          </span>
        </div>
      </div>

      {/* Timeline Stream Area */}
      <div className="flex-1 overflow-y-auto space-y-2.5 pr-1 max-h-[600px]">
        {agentActions.length === 0 ? (
          <div className="h-44 flex flex-col items-center justify-center text-center p-6 border border-dashed border-[#383842] rounded-xl bg-[#18181b]/50">
            <Activity className="w-7 h-7 text-gray-500 mb-2" />
            <p className="text-sm font-medium text-gray-300">
              No agent actions recorded yet
            </p>
            <p className="text-xs text-gray-500 mt-1 max-w-xs">
              Actions such as page navigation, DOM extraction, scroll steps, and evaluations will stream here in real time.
            </p>
          </div>
        ) : (
          agentActions.map((action, idx) => (
            <div
              key={action.id || `action-${idx}`}
              className={`bg-[#18181b] border rounded-lg p-3 flex flex-col gap-1.5 hover:border-[#4d4d5a] transition-colors ${
                action.type === 'stagnation_detected'
                  ? 'border-[#F59E0B]/40 bg-[#F59E0B]/5'
                  : action.type === 'system2_handover'
                  ? 'border-[#8B5CF6]/40 bg-[#8B5CF6]/5'
                  : 'border-[#383842]'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded bg-[#242427] border border-[#383842] flex items-center justify-center">
                    {getActionIcon(action.type)}
                  </div>

                  {action.type === 'stagnation_detected' ? (
                    <span className="flex items-center gap-1.5 text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/40 uppercase">
                      <AlertTriangle className="w-3 h-3 text-[#F59E0B]" />
                      Stagnation Detected
                    </span>
                  ) : action.type === 'system2_handover' ? (
                    <span className="flex items-center gap-1.5 text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-[#8B5CF6]/20 text-[#8B5CF6] border border-[#8B5CF6]/40 uppercase">
                      <Brain className="w-3 h-3 text-[#8B5CF6]" />
                      System 2 Handover
                    </span>
                  ) : (
                    <span className="text-xs font-mono font-semibold text-white uppercase">
                      {action.type}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-gray-400">
                    {new Date(action.timestamp).toLocaleTimeString()}
                  </span>
                  {getStatusBadge(action.status)}
                </div>
              </div>

              <p className="text-xs text-gray-300 font-sans leading-relaxed pl-8">
                {action.message}
              </p>

              {/* Special Structured Details for Stagnation & Handover */}
              {action.type === 'stagnation_detected' && action.details && (
                <div className="pl-8 pt-1">
                  <div className="bg-[#242427] rounded p-2.5 text-xs font-mono border border-[#F59E0B]/30 flex flex-col gap-1.5">
                    {action.details.stuckReason && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-amber-400 font-semibold">Stuck Reason:</span>
                        <span className="text-gray-200">{String(action.details.stuckReason)}</span>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400">
                      {action.details.consecutiveEmptyCycles !== undefined && (
                        <span>
                          <span className="text-gray-500">Empty Cycles:</span>{' '}
                          <span className="text-amber-300 font-semibold">{String(action.details.consecutiveEmptyCycles)}</span>
                        </span>
                      )}
                      {(action.details.scrollState || action.details.y !== undefined) && (
                        <span>
                          <span className="text-gray-500">Scroll:</span>{' '}
                          <span className="text-gray-300">
                            Y={action.details.scrollState?.y ?? action.details.y ?? 0} / Max={action.details.scrollState?.scrollHeight ?? action.details.scrollHeight ?? 'N/A'}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {action.type === 'system2_handover' && action.details && (
                <div className="pl-8 pt-1">
                  <div className="bg-[#242427] rounded p-2.5 text-xs font-mono border border-[#8B5CF6]/30 flex flex-col gap-1.5">
                    {(action.details.action || action.details.decision) && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[#8B5CF6] font-semibold">Strategic Decision:</span>
                        <span className="px-1.5 py-0.5 rounded bg-[#8B5CF6]/20 text-[#8B5CF6] border border-[#8B5CF6]/40 uppercase text-[10px] font-bold">
                          {String(action.details.action || action.details.decision)}
                        </span>
                      </div>
                    )}
                    {action.details.rationale && (
                      <div className="text-[11px] text-gray-300 font-sans italic">
                        "{String(action.details.rationale)}"
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* General details for other action types */}
              {action.type !== 'stagnation_detected' && action.type !== 'system2_handover' && action.details && Object.keys(action.details).length > 0 && (
                <div className="pl-8 pt-1">
                  <div className="bg-[#242427] rounded p-2 text-[11px] font-mono text-gray-400 border border-[#383842] flex flex-wrap gap-x-3 gap-y-1">
                    {Object.entries(action.details).map(([k, v]) => (
                      <span key={k}>
                        <span className="text-gray-500">{k}:</span>{' '}
                        <span className="text-gray-300 font-semibold">{String(v)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
