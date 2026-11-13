import React from 'react';
import {
  ShieldAlert,
  Trash2,
  Copy,
  ExternalLink,
  Download,
  FileText,
  Clock,
} from 'lucide-react';
import { toast } from 'sonner';
import type { InferenceTelemetryItem } from '@ofln-scout/shared';
import { useScoutStore } from '../store/useScoutStore';
import { wsClient } from '../lib/wsClient';

export const AlertsDrawer: React.FC = () => {
  const alerts = useScoutStore((state) => state.alerts);
  const currentSpec = useScoutStore((state) => state.currentSpec);

  const handleClearAlerts = () => {
    wsClient.clearAlerts();
    toast.info('All alerts cleared');
  };

  const handleCopyAlertJson = (item: InferenceTelemetryItem) => {
    try {
      navigator.clipboard.writeText(JSON.stringify(item, null, 2));
      toast.success('Alert JSON payload copied to clipboard');
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  const handleExportMarkdown = () => {
    if (alerts.length === 0) return;
    const lines = [
      `# sysOne Scout Flagged Matches Report`,
      `**Generated:** ${new Date().toISOString()}`,
      `**Total Alerts:** ${alerts.length}`,
      `**Target Task:** ${currentSpec?.name || 'Unknown'}`,
      `\n---\n`,
    ];

    alerts.forEach((alert, index) => {
      lines.push(`### Alert #${index + 1} — ${new Date(alert.timestamp).toLocaleTimeString()}`);
      lines.push(`- **ID**: \`${alert.id}\``);
      lines.push(`- **Latency**: ${alert.latencyMs.toFixed(1)} ms`);
      lines.push(`- **Snippet**: \`${alert.domSnippet}\``);
      lines.push(`- **Answers**:`);
      for (const [k, v] of Object.entries(alert.rawAnswers)) {
        lines.push(`  - **${k}**: \`${v.answer}\` (Confidence: ${(v.answer_confidence * 100).toFixed(1)}%)`);
      }
      lines.push(`\n`);
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scout-alerts-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Markdown report downloaded');
  };

  const handleExportCsv = () => {
    if (alerts.length === 0) return;
    const headers = ['id', 'timestamp', 'latencyMs', 'domSnippet', 'answers'];
    const rows = alerts.map((a) => {
      const answersStr = JSON.stringify(a.rawAnswers).replace(/"/g, '""');
      const snippetStr = a.domSnippet.replace(/"/g, '""');
      return `"${a.id}","${a.timestamp}","${a.latencyMs}","${snippetStr}","${answersStr}"`;
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scout-alerts-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('CSV export downloaded');
  };

  const handleOpenSourceUrl = (item: InferenceTelemetryItem) => {
    let url = currentSpec?.targetUrl || 'https://news.ycombinator.com';
    const match = item.domSnippet.match(/https?:\/\/[^\s"'<>]+/);
    if (match) {
      url = match[0];
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col h-full">
      {/* Header & Actions Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#383842] pb-3 mb-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#F59E0B]/20 border border-[#F59E0B]/30 flex items-center justify-center">
            <ShieldAlert className="w-4 h-4 text-[#F59E0B]" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <span>Flagged Matches</span>
              <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded-full bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/30">
                {alerts.length}
              </span>
            </h3>
            <p className="text-xs text-gray-400">
              Persistent detections crossing calibrated threshold
            </p>
          </div>
        </div>

        {/* Global Toolbar Buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleExportMarkdown}
            disabled={alerts.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#18181b] border border-[#383842] hover:border-[#4d4d5a] text-xs text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Export Markdown"
          >
            <FileText className="w-3.5 h-3.5 text-[#06B6D4]" />
            <span className="hidden sm:inline">Export MD</span>
          </button>

          <button
            onClick={handleExportCsv}
            disabled={alerts.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#18181b] border border-[#383842] hover:border-[#4d4d5a] text-xs text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Export CSV"
          >
            <Download className="w-3.5 h-3.5 text-[#10B981]" />
            <span className="hidden sm:inline">CSV</span>
          </button>

          <button
            onClick={handleClearAlerts}
            disabled={alerts.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#EF4444]/15 border border-[#EF4444]/30 hover:bg-[#EF4444]/25 text-xs text-[#EF4444] disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
            title="Clear All Alerts"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Clear All</span>
          </button>
        </div>
      </div>

      {/* Alerts List */}
      <div className="flex-1 overflow-y-auto space-y-3 max-h-[600px] pr-1">
        {alerts.length === 0 ? (
          <div className="h-44 flex flex-col items-center justify-center text-center p-6 border border-dashed border-[#383842] rounded-xl bg-[#18181b]/50">
            <ShieldAlert className="w-7 h-7 text-gray-500 mb-2" />
            <p className="text-sm font-medium text-gray-300">
              No flagged matches yet
            </p>
            <p className="text-xs text-gray-500 mt-1 max-w-xs">
              Matching elements will appear here when calibrated confidence exceeds
              the alert threshold.
            </p>
          </div>
        ) : (
          alerts.map((item) => (
            <div
              key={item.id}
              className="bg-[#18181b] border border-[#F59E0B]/40 rounded-xl p-3.5 shadow-sm flex flex-col gap-2 hover:border-[#F59E0B] transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-semibold text-[#F59E0B]">
                    {item.id}
                  </span>
                  <span className="text-xs font-mono text-gray-400 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {new Date(item.timestamp).toLocaleTimeString()}
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleOpenSourceUrl(item)}
                    className="p-1.5 rounded hover:bg-[#242427] text-gray-400 hover:text-white transition-colors"
                    title="Open Source URL"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleCopyAlertJson(item)}
                    className="p-1.5 rounded hover:bg-[#242427] text-gray-400 hover:text-white transition-colors"
                    title="Copy JSON Payload"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* DOM snippet */}
              <div className="bg-[#242427] p-2.5 rounded-lg border border-[#383842] text-xs font-mono text-gray-300">
                <p className="line-clamp-2 select-all">{item.domSnippet}</p>
              </div>

              {/* Answer summary */}
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(item.rawAnswers).map(([k, v]) => (
                  <span
                    key={k}
                    className="text-xs font-mono px-2 py-0.5 rounded bg-[#242427] text-[#10B981] border border-[#383842] flex items-center gap-1"
                  >
                    <span className="text-gray-400">{k}:</span>
                    <span className="font-semibold">{String(v.answer)}</span>
                    <span className="text-gray-400">
                      ({Math.round((v.answer_confidence ?? 0) * 100)}%)
                    </span>
                  </span>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
