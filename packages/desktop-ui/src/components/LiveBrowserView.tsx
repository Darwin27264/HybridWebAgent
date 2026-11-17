import React from 'react';
import {
  Globe,
  RefreshCw,
  Eye,
  ArrowDown,
  Clock,
} from 'lucide-react';
import { useScoutStore } from '../store/useScoutStore';

export const LiveBrowserView: React.FC = () => {
  const latestSnapshot = useScoutStore((state) => state.latestSnapshot);
  const daemonStatus = useScoutStore((state) => state.daemonStatus);
  const currentSpec = useScoutStore((state) => state.currentSpec);

  const displayUrl = latestSnapshot?.url || currentSpec?.targetUrl || 'about:blank';
  const pageTitle = latestSnapshot?.title || (daemonStatus.isRunning ? 'Scouting Page...' : 'Browser Standby');

  // Format screenshot source
  const screenshotSrc = latestSnapshot?.screenshot
    ? latestSnapshot.screenshot.startsWith('data:')
      ? latestSnapshot.screenshot
      : `data:image/jpeg;base64,${latestSnapshot.screenshot}`
    : null;

  // Calculate scroll stats
  const scroll = latestSnapshot?.scroll;
  const maxScroll = scroll ? Math.max(1, scroll.scrollHeight - scroll.viewportHeight) : 1;
  const scrollPercent = scroll ? Math.min(100, Math.max(0, Math.round((scroll.y / maxScroll) * 100))) : 0;

  return (
    <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col h-full min-h-[580px] 2xl:min-h-[700px]">
      {/* Header with Title and Live Status Badge */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#383842] pb-3 mb-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#06B6D4]/20 border border-[#06B6D4]/30 flex items-center justify-center">
            <Eye className="w-4 h-4 text-[#06B6D4]" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <span>Live Browser View</span>
              <span
                className={`text-xs font-mono font-medium px-2 py-0.5 rounded-full border ${
                  daemonStatus.isRunning && screenshotSrc
                    ? 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/40'
                    : daemonStatus.isRunning
                    ? 'bg-[#06B6D4]/15 text-[#06B6D4] border-[#06B6D4]/40'
                    : 'bg-[#18181b] text-gray-400 border-[#383842]'
                }`}
              >
                {daemonStatus.isRunning && screenshotSrc
                  ? 'Streaming (1 Hz)'
                  : daemonStatus.isRunning
                  ? 'Navigating...'
                  : 'Idle'}
              </span>
            </h2>
            <p className="text-xs text-gray-400 truncate max-w-sm">
              {pageTitle}
            </p>
          </div>
        </div>

        {/* Scroll Indicator */}
        {scroll && (
          <div className="flex items-center gap-2 bg-[#18181b] px-2.5 py-1 rounded-lg border border-[#383842] text-xs font-mono">
            <ArrowDown className="w-3.5 h-3.5 text-[#06B6D4]" />
            <span className="text-gray-400">Scroll:</span>
            <span className="text-white font-semibold">{scrollPercent}%</span>
            <span className="text-gray-500 text-[11px]">({scroll.y}px)</span>
          </div>
        )}
      </div>

      {/* Mock Browser URL Bar */}
      <div className="bg-[#18181b] border border-[#383842] rounded-lg px-3 py-1.5 flex items-center gap-2 mb-4 text-xs font-mono text-gray-300">
        <div className="flex items-center gap-1.5 mr-1">
          <div className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
          <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
        </div>
        <Globe className="w-3.5 h-3.5 text-[#06B6D4] shrink-0" />
        <span className="truncate flex-1 select-all">{displayUrl}</span>
        {latestSnapshot?.timestamp && (
          <span className="text-[11px] text-gray-500 flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {new Date(latestSnapshot.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Snapshot Canvas Viewport */}
      <div className="flex-1 min-h-[440px] 2xl:min-h-[560px] bg-[#18181b] border border-[#383842] rounded-lg overflow-hidden flex flex-col items-center justify-center relative">
        {screenshotSrc ? (
          <div className="w-full h-full overflow-auto flex flex-col items-center justify-start p-2">
            <img
              src={screenshotSrc}
              alt="Playwright Live Snapshot"
              className="max-w-full rounded shadow-md border border-[#383842] object-contain transition-opacity duration-150"
            />
          </div>
        ) : (
          <div className="p-8 text-center flex flex-col items-center justify-center max-w-md">
            <div className="w-12 h-12 rounded-xl bg-[#242427] border border-[#383842] flex items-center justify-center mb-3">
              <Globe className="w-6 h-6 text-gray-400" />
            </div>
            <h3 className="text-sm font-semibold text-white mb-1">
              {daemonStatus.isRunning ? 'Capturing First Snapshot...' : 'No Live Browser Session Active'}
            </h3>
            <p className="text-xs text-gray-400 leading-relaxed mb-4">
              {daemonStatus.isRunning
                ? 'Playwright Chromium runner is active and navigating the target site. Periodic snapshots stream automatically at 1 Hz.'
                : 'Launch a task or run a scheduled job to start the headless Chromium session and view real-time visual captures.'}
            </p>
            {daemonStatus.isRunning && (
              <div className="flex items-center gap-2 text-xs text-[#06B6D4] font-medium">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Streaming live frames from daemon...</span>
              </div>
            )}
          </div>
        )}

        {/* Scroll Progress Bar at Bottom of Viewport */}
        {scroll && (
          <div className="w-full h-1 bg-[#242427] absolute bottom-0 left-0">
            <div
              className="h-full bg-[#06B6D4] transition-all duration-150"
              style={{ width: `${scrollPercent}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
};
