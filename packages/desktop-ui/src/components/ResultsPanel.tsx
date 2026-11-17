import React, { useState, useMemo } from 'react';
import {
  FileText,
  Download,
  Copy,
  Check,
  Search,
  RefreshCw,
  Sparkles,
  BarChart3,
  ExternalLink,
  ShieldAlert,
  Clock,
  Code,
  Table as TableIcon,
  Filter,
} from 'lucide-react';
import { toast } from 'sonner';
import type { ScrapedItem } from '@ofln-scout/shared';
import { useScoutStore, formatLatency } from '../store/useScoutStore';
import { wsClient } from '../lib/wsClient';

// Helper function to format a single ScrapedItem into an RFC 4180 compliant CSV row
export function formatItemAsCsvRow(item: ScrapedItem): string {
  const idEscaped = `"${(item.id || '').replace(/"/g, '""')}"`;
  const linkEscaped = `"${(item.link || '').replace(/"/g, '""')}"`;
  const snippetEscaped = `"${(item.text || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const answersEscaped = `"${JSON.stringify(item.answers || {}).replace(/"/g, '""')}"`;
  return [
    idEscaped,
    item.timestamp,
    item.triggeredAlert ? 'YES' : 'NO',
    (item.confidence ?? 0).toFixed(2),
    answersEscaped,
    linkEscaped,
    snippetEscaped,
  ].join(',');
}

export function formatResultsAsCsv(items: ScrapedItem[]): string {
  const headers = ['ID', 'Timestamp', 'TriggeredAlert', 'Confidence', 'Answers', 'Link', 'Snippet'];
  const rows = items.map(formatItemAsCsvRow);
  return [headers.join(','), ...rows].join('\n');
}

// Safe inline Markdown renderer converting text to React nodes without innerHTML
function renderInlineMarkdown(text: string): React.ReactNode {
  if (!text) return null;

  // Regex matching `code`, **bold**, *italic*, and [link](url)
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(pattern);

  return parts.map((part, index) => {
    if (!part) return null;

    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={index}
          className="bg-[#18181b] text-emerald-400 px-1 py-0.5 rounded font-mono text-[11px] border border-[#383842]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={index} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      return (
        <em key={index} className="italic text-gray-300">
          {part.slice(1, -1)}
        </em>
      );
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const href = linkMatch[2];
      const safeHref = href.startsWith('http://') || href.startsWith('https://') ? href : '#';
      return (
        <a
          key={index}
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#06B6D4] hover:underline"
        >
          {linkMatch[1]}
        </a>
      );
    }

    return <span key={index}>{part}</span>;
  });
}

// Pure React Markdown parser for headings, lists, tables, blockquotes, and code blocks
export const SafeMarkdownViewer: React.FC<{ content: string }> = ({ content }) => {
  if (!content || !content.trim()) {
    return (
      <div className="text-gray-500 text-xs italic py-4 text-center">
        No markdown report generated yet.
      </div>
    );
  }

  const lines = content.split(/\r?\n/);
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block ```
    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre
          key={`code-${i}`}
          className="bg-[#18181b] p-3 rounded-lg font-mono text-xs overflow-x-auto text-emerald-300 border border-[#383842] my-3 leading-relaxed"
        >
          {codeLines.join('\n')}
        </pre>
      );
      continue;
    }

    // Markdown Table (lines with |)
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }

      if (tableLines.length >= 2) {
        const headerRow = tableLines[0]
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim());
        const hasSeparator = tableLines[1].includes('---');
        const dataRows = (hasSeparator ? tableLines.slice(2) : tableLines.slice(1)).map((rowStr) =>
          rowStr
            .slice(1, -1)
            .split('|')
            .map((c) => c.trim())
        );

        elements.push(
          <div key={`table-${i}`} className="overflow-x-auto my-3 rounded-lg border border-[#383842]">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-[#18181b] border-b border-[#383842]">
                <tr>
                  {headerRow.map((th, thIdx) => (
                    <th key={thIdx} className="px-3 py-2 text-gray-300 font-semibold font-mono uppercase text-[11px]">
                      {renderInlineMarkdown(th)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#383842] bg-[#242427]">
                {dataRows.map((row, rIdx) => (
                  <tr key={rIdx} className="hover:bg-[#18181b]/50 transition-colors">
                    {row.map((cell, cIdx) => (
                      <td key={cIdx} className="px-3 py-2 text-gray-200">
                        {renderInlineMarkdown(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }

    // Blockquote
    if (line.trim().startsWith('>')) {
      const quoteText = line.replace(/^>\s?/, '');
      elements.push(
        <blockquote
          key={`quote-${i}`}
          className="border-l-4 border-[#8B5CF6] pl-3 py-1.5 my-2.5 bg-[#18181b]/60 text-gray-300 italic text-xs rounded-r"
        >
          {renderInlineMarkdown(quoteText)}
        </blockquote>
      );
      i++;
      continue;
    }

    // Headings
    if (line.startsWith('#### ')) {
      elements.push(
        <h4 key={`h4-${i}`} className="text-xs font-semibold text-gray-200 uppercase tracking-wider mt-3 mb-1">
          {renderInlineMarkdown(line.slice(5))}
        </h4>
      );
      i++;
      continue;
    }
    if (line.startsWith('### ')) {
      elements.push(
        <h3 key={`h3-${i}`} className="text-sm font-semibold text-white mt-3.5 mb-1.5">
          {renderInlineMarkdown(line.slice(4))}
        </h3>
      );
      i++;
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(
        <h2 key={`h2-${i}`} className="text-base font-semibold text-white mt-4 mb-2 border-b border-[#383842] pb-1">
          {renderInlineMarkdown(line.slice(3))}
        </h2>
      );
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      elements.push(
        <h1 key={`h1-${i}`} className="text-lg font-bold text-white mt-4 mb-2">
          {renderInlineMarkdown(line.slice(2))}
        </h1>
      );
      i++;
      continue;
    }

    // Unordered List item
    if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      elements.push(
        <div key={`li-${i}`} className="flex items-start gap-2 my-1 text-xs text-gray-300 pl-2">
          <span className="text-[#8B5CF6] font-bold">•</span>
          <span className="leading-relaxed">{renderInlineMarkdown(line.trim().slice(2))}</span>
        </div>
      );
      i++;
      continue;
    }

    // Numbered List item
    const numMatch = line.trim().match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      elements.push(
        <div key={`nli-${i}`} className="flex items-start gap-2 my-1 text-xs text-gray-300 pl-2">
          <span className="font-mono text-[#06B6D4] text-[11px] font-semibold">{numMatch[1]}.</span>
          <span className="leading-relaxed">{renderInlineMarkdown(numMatch[2])}</span>
        </div>
      );
      i++;
      continue;
    }

    // Blank line
    if (!line.trim()) {
      elements.push(<div key={`blank-${i}`} className="h-2" />);
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={`p-${i}`} className="text-xs text-gray-300 leading-relaxed my-1">
        {renderInlineMarkdown(line)}
      </p>
    );
    i++;
  }

  return <div className="space-y-0.5 text-xs text-gray-300">{elements}</div>;
};

export const ResultsPanel: React.FC = () => {
  const resultsMarkdown = useScoutStore((state) => state.resultsMarkdown);
  const resultsSummary = useScoutStore((state) => state.resultsSummary);
  const resultsStats = useScoutStore((state) => state.resultsStats);
  const resultsItems = useScoutStore((state) => state.resultsItems);
  const resultsLastUpdated = useScoutStore((state) => state.resultsLastUpdated);
  const telemetryStats = useScoutStore((state) => state.telemetryStats);
  const activeGgufModelId = useScoutStore((state) => state.activeGgufModelId);
  const selectedModel = useScoutStore((state) => state.selectedModel);
  const gpuBackend = useScoutStore((state) => state.gpuBackend);

  const [activeView, setActiveView] = useState<'formatted' | 'raw' | 'items'>('formatted');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterAlertsOnly, setFilterAlertsOnly] = useState(false);
  const [copied, setCopied] = useState(false);

  // Compute effective stats from resultsStore or live telemetry fallback
  const totalScanned = resultsStats?.totalScanned ?? telemetryStats.totalScanned;
  const totalAlerts = resultsStats?.totalAlerts ?? telemetryStats.totalAlerts;
  const matchRate =
    resultsStats?.matchRatePercent ??
    (totalScanned > 0 ? Number(((totalAlerts / totalScanned) * 100).toFixed(1)) : 0);
  const avgLatency = resultsStats?.avgLatencyMs ?? telemetryStats.avgLatencyMs;

  // Filtered scraped items for the data table
  const filteredItems = useMemo(() => {
    let list = resultsItems;
    if (filterAlertsOnly) {
      list = list.filter((item) => item.triggeredAlert);
    }
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      list = list.filter(
        (item) =>
          item.id.toLowerCase().includes(q) ||
          item.text.toLowerCase().includes(q) ||
          (item.link && item.link.toLowerCase().includes(q)) ||
          JSON.stringify(item.answers).toLowerCase().includes(q)
      );
    }
    return list;
  }, [resultsItems, filterAlertsOnly, searchTerm]);

  // Export to results.md
  const handleExportMarkdown = () => {
    const mdContent =
      resultsMarkdown ||
      `# Scout Task Results\n\n${resultsSummary || 'No summary available.'}\n\n*Total Scanned:* ${totalScanned}\n*Total Alerts:* ${totalAlerts}\n`;
    const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `scout-results-${Date.now()}.md`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success('Downloaded results.md');
  };

  // Export to results.json
  const handleExportJson = () => {
    const payload = {
      timestamp: resultsLastUpdated ? new Date(resultsLastUpdated).toISOString() : new Date().toISOString(),
      stats: {
        totalScanned,
        totalAlerts,
        matchRatePercent: matchRate,
        avgLatencyMs: avgLatency,
        topCategories: resultsStats?.topCategories ?? {},
      },
      summary: resultsSummary,
      markdown: resultsMarkdown,
      items: resultsItems,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `scout-results-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success('Downloaded results.json');
  };

  // Export to CSV
  const handleExportCsv = () => {
    if (resultsItems.length === 0) {
      toast.info('No scraped items to export as CSV');
      return;
    }
    const headers = ['ID', 'Timestamp', 'TriggeredAlert', 'Confidence', 'Answers', 'Link', 'Snippet'];
    const rows = resultsItems.map((item) => {
      const idEscaped = `"${(item.id || '').replace(/"/g, '""')}"`;
      const linkEscaped = `"${(item.link || '').replace(/"/g, '""')}"`;
      const snippetEscaped = `"${(item.text || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
      const answersEscaped = `"${JSON.stringify(item.answers || {}).replace(/"/g, '""')}"`;
      return [
        idEscaped,
        item.timestamp,
        item.triggeredAlert ? 'YES' : 'NO',
        (item.confidence ?? 0).toFixed(2),
        answersEscaped,
        linkEscaped,
        snippetEscaped,
      ].join(',');
    });
    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `scout-items-${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${resultsItems.length} items as CSV`);
  };

  // Copy report to clipboard
  const handleCopyReport = () => {
    const textToCopy =
      resultsMarkdown ||
      resultsSummary ||
      `Total Scanned: ${totalScanned}\nTotal Alerts: ${totalAlerts}\nMatch Rate: ${matchRate}%`;
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    toast.success('Report copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRefresh = () => {
    wsClient.getResults();
    toast.info('Requesting latest results...');
  };

  return (
    <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col gap-5">
      {/* Header and Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#383842] pb-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#8B5CF6]/20 border border-[#8B5CF6]/30 flex items-center justify-center">
            <FileText className="w-4 h-4 text-[#8B5CF6]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-white">Task Results & Dataset</h2>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#18181b] text-[#10B981] border border-[#383842]">
                results.md
              </span>
            </div>
            <p className="text-xs text-gray-400">
              Aggregated System 1 item extractions and System 2 strategic analysis
            </p>
          </div>
        </div>

        {/* Action Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#18181b] hover:bg-[#2c2c31] text-gray-200 text-xs font-medium border border-[#383842] transition-colors"
            title="Refresh Results from Daemon"
          >
            <RefreshCw className="w-3.5 h-3.5 text-[#06B6D4]" />
            <span>Sync</span>
          </button>

          <button
            onClick={handleCopyReport}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#18181b] hover:bg-[#2c2c31] text-gray-200 text-xs font-medium border border-[#383842] transition-colors"
            title="Copy Report to Clipboard"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-[#10B981]" /> : <Copy className="w-3.5 h-3.5 text-gray-400" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>

          <button
            onClick={handleExportMarkdown}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#18181b] hover:bg-[#2c2c31] text-gray-200 text-xs font-medium border border-[#383842] transition-colors"
            title="Download results.md"
          >
            <Download className="w-3.5 h-3.5 text-[#8B5CF6]" />
            <span>Export MD</span>
          </button>

          <button
            onClick={handleExportJson}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#18181b] hover:bg-[#2c2c31] text-gray-200 text-xs font-medium border border-[#383842] transition-colors"
            title="Download results.json"
          >
            <Download className="w-3.5 h-3.5 text-[#06B6D4]" />
            <span>JSON</span>
          </button>

          <button
            onClick={handleExportCsv}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#10B981] hover:bg-[#059669] text-black text-xs font-semibold rounded transition-colors"
            title="Download dataset as CSV"
          >
            <Download className="w-3.5 h-3.5 text-black" />
            <span>CSV ({resultsItems.length})</span>
          </button>
        </div>
      </div>

      {/* Match & Novelty Statistics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-[#18181b] border border-[#383842] rounded-lg p-3 flex flex-col">
          <span className="text-xs uppercase text-gray-400 font-medium">Total Scanned</span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-xl font-bold font-mono text-white">{totalScanned}</span>
            <span className="text-[11px] text-gray-500">items</span>
          </div>
        </div>

        <div className="bg-[#18181b] border border-[#383842] rounded-lg p-3 flex flex-col">
          <span className="text-xs uppercase text-gray-400 font-medium">Matches Flagged</span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-xl font-bold font-mono text-[#F59E0B]">{totalAlerts}</span>
            <span className="text-[11px] text-gray-500">alerts</span>
          </div>
        </div>

        <div className="bg-[#18181b] border border-[#383842] rounded-lg p-3 flex flex-col">
          <span className="text-xs uppercase text-gray-400 font-medium">Match Rate</span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-xl font-bold font-mono text-[#10B981]">{matchRate}%</span>
            <span className="text-[11px] text-gray-500">yield</span>
          </div>
        </div>

        <div className="bg-[#18181b] border border-[#383842] rounded-lg p-3 flex flex-col">
          <span className="text-xs uppercase text-gray-400 font-medium">Avg Latency</span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-xl font-bold font-mono text-[#06B6D4]">{formatLatency(avgLatency)}</span>
          </div>
        </div>
      </div>

      {/* Category / Answer Breakdown if available */}
      {resultsStats?.topCategories && Object.keys(resultsStats.topCategories).length > 0 && (
        <div className="bg-[#18181b] border border-[#383842] rounded-lg p-3.5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-1.5">
              <BarChart3 className="w-3.5 h-3.5 text-[#8B5CF6]" />
              Classification Breakdown
            </span>
            <span className="text-[11px] font-mono text-gray-400">
              {Object.keys(resultsStats.topCategories).length} Categories
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {Object.entries(resultsStats.topCategories).map(([cat, count]) => {
              const pct = totalScanned > 0 ? ((count / totalScanned) * 100).toFixed(0) : 0;
              return (
                <div key={cat} className="bg-[#242427] border border-[#383842] rounded px-2.5 py-1.5 flex flex-col">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono text-gray-200 truncate" title={cat}>
                      {cat}
                    </span>
                    <span className="font-mono font-bold text-[#10B981]">{count}</span>
                  </div>
                  <div className="w-full bg-[#18181b] h-1.5 rounded-full mt-1.5 overflow-hidden">
                    <div className="bg-[#8B5CF6] h-full rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* System 2 English Narrative Summary */}
      <div className="bg-[#18181b] border border-[#383842] rounded-lg p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#8B5CF6]" />
            <h3 className="text-sm font-semibold text-white">System 2 Executive Summary</h3>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30">
              {activeGgufModelId ? `${activeGgufModelId} (${gpuBackend || 'GPU'})` : selectedModel}
            </span>
          </div>
          {resultsLastUpdated && (
            <span className="text-[11px] font-mono text-gray-400 flex items-center gap-1">
              <Clock className="w-3 h-3 text-gray-500" />
              {new Date(resultsLastUpdated).toLocaleTimeString()}
            </span>
          )}
        </div>

        {resultsSummary ? (
          <div className="text-xs text-gray-300 leading-relaxed font-sans bg-[#242427]/50 p-3 rounded-md border border-[#383842]/50 whitespace-pre-wrap">
            {resultsSummary}
          </div>
        ) : (
          <div className="text-xs text-gray-500 italic py-2">
            No executive summary produced yet. System 2 automatically synthesizes results as browsing extractions accumulate.
          </div>
        )}
      </div>

      {/* View Switcher: Formatted Markdown vs Raw Markdown vs Scraped Items */}
      <div className="flex items-center justify-between border-b border-[#383842] pb-2">
        <div className="flex items-center bg-[#18181b] p-1 rounded-lg border border-[#383842] gap-1">
          <button
            onClick={() => setActiveView('formatted')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
              activeView === 'formatted'
                ? 'bg-[#242427] text-white shadow-sm border border-[#383842]'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <FileText className="w-3.5 h-3.5 text-[#8B5CF6]" />
            <span>Formatted Report</span>
          </button>

          <button
            onClick={() => setActiveView('raw')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
              activeView === 'raw'
                ? 'bg-[#242427] text-white shadow-sm border border-[#383842]'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Code className="w-3.5 h-3.5 text-[#06B6D4]" />
            <span>Raw Markdown</span>
          </button>

          <button
            onClick={() => setActiveView('items')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
              activeView === 'items'
                ? 'bg-[#242427] text-white shadow-sm border border-[#383842]'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <TableIcon className="w-3.5 h-3.5 text-[#10B981]" />
            <span>Scraped Items ({resultsItems.length})</span>
          </button>
        </div>
      </div>

      {/* Content Area Based on Active View */}
      {activeView === 'formatted' && (
        <div className="bg-[#18181b] border border-[#383842] rounded-lg p-5 max-h-[500px] overflow-y-auto">
          <SafeMarkdownViewer content={resultsMarkdown || resultsSummary || ''} />
        </div>
      )}

      {activeView === 'raw' && (
        <div className="relative">
          <pre className="bg-[#18181b] border border-[#383842] rounded-lg p-4 font-mono text-xs text-gray-200 overflow-x-auto max-h-[500px] leading-relaxed whitespace-pre-wrap">
            {resultsMarkdown || 'No raw markdown generated yet.'}
          </pre>
        </div>
      )}

      {activeView === 'items' && (
        <div className="flex flex-col gap-3">
          {/* Table Filters */}
          <div className="flex flex-wrap items-center justify-between gap-2 bg-[#18181b] p-2.5 rounded-lg border border-[#383842]">
            <div className="flex items-center gap-2 flex-1 min-w-[200px]">
              <Search className="w-3.5 h-3.5 text-gray-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search snippets, answers, IDs..."
                className="bg-transparent text-xs text-gray-200 placeholder-gray-500 focus:outline-none w-full"
              />
            </div>

            <button
              onClick={() => setFilterAlertsOnly(!filterAlertsOnly)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border transition-colors ${
                filterAlertsOnly
                  ? 'bg-[#F59E0B]/20 text-[#F59E0B] border-[#F59E0B]/40'
                  : 'bg-[#242427] text-gray-400 border-[#383842] hover:text-gray-200'
              }`}
            >
              <Filter className="w-3 h-3" />
              <span>Alerts Only</span>
            </button>
          </div>

          {/* Items Table */}
          <div className="overflow-x-auto rounded-lg border border-[#383842] bg-[#18181b] max-h-[460px]">
            {filteredItems.length === 0 ? (
              <div className="p-8 text-center text-gray-500 text-xs">
                No scraped items match current filter criteria.
              </div>
            ) : (
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-[#242427] border-b border-[#383842] sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-2 text-gray-400 font-mono text-[11px] uppercase w-24">ID</th>
                    <th className="px-3 py-2 text-gray-400 font-mono text-[11px] uppercase w-28">Status</th>
                    <th className="px-3 py-2 text-gray-400 font-mono text-[11px] uppercase w-48">Answers</th>
                    <th className="px-3 py-2 text-gray-400 font-mono text-[11px] uppercase">Snippet</th>
                    <th className="px-3 py-2 text-gray-400 font-mono text-[11px] uppercase w-16 text-center">Link</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#383842]">
                  {filteredItems.slice(0, 100).map((item) => (
                    <tr key={item.id} className="hover:bg-[#242427]/40 transition-colors">
                      <td className="px-3 py-2 font-mono text-[11px] text-gray-400 truncate max-w-[120px]" title={item.id}>
                        {item.id}
                      </td>
                      <td className="px-3 py-2">
                        {item.triggeredAlert ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-[#F59E0B]/15 text-[#F59E0B] border border-[#F59E0B]/30 font-semibold">
                            <ShieldAlert className="w-2.5 h-2.5" />
                            ALERT
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30">
                            MATCH
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-gray-300">
                        {Object.entries(item.answers || {}).map(([k, v]) => (
                          <div key={k} className="truncate max-w-[200px] xl:max-w-[320px]">
                            <span className="text-gray-500">{k}:</span>{' '}
                            <span className="text-emerald-400 font-semibold">{String(v)}</span>
                          </div>
                        ))}
                      </td>
                      <td className="px-3 py-2 text-gray-300 font-sans max-w-md xl:max-w-xl 2xl:max-w-2xl">
                        <p className="line-clamp-2 leading-relaxed" title={item.text}>
                          {item.text}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-center">
                        {item.link ? (
                          <a
                            href={item.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[#06B6D4] hover:text-[#22d3ee] inline-block p-1"
                            title={item.link}
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {filteredItems.length > 100 && (
            <div className="text-[11px] text-gray-400 text-center font-mono">
              Displaying first 100 of {filteredItems.length} items. Use Export CSV or JSON for full dataset.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
