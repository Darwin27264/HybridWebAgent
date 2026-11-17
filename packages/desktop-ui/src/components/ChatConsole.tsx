import React, { useState, useRef, useEffect } from 'react';
import {
  MessageSquare,
  Sparkles,
  Compass,
  Send,
  Trash2,
  Cpu,
  HelpCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useScoutStore } from '../store/useScoutStore';
import { wsClient } from '../lib/wsClient';
import { SafeMarkdownViewer } from './ResultsPanel';

const QUERY_SUGGESTIONS = [
  'Summarize key findings so far',
  'List top 5 highest confidence items',
  'What categories appeared most often?',
  'Explain why the last item triggered an alert',
];

const STEER_SUGGESTIONS = [
  'Scroll faster by increasing step to 500px',
  'Scroll slower by reducing step to 150px',
  'Focus only on announcements or release posts',
  'Paginate to next page or click load more',
];

export const ChatConsole: React.FC = () => {
  const chatMessages = useScoutStore((state) => state.chatMessages);
  const isChatLoading = useScoutStore((state) => state.isChatLoading);
  const clearChatMessages = useScoutStore((state) => state.clearChatMessages);
  const selectedModel = useScoutStore((state) => state.selectedModel);
  const ollamaOnline = useScoutStore((state) => state.ollamaOnline);
  const activeGgufModelId = useScoutStore((state) => state.activeGgufModelId);
  const daemonStatus = useScoutStore((state) => state.daemonStatus);

  const [mode, setMode] = useState<'query' | 'steer'>('query');
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll chat to bottom when messages update or loading state changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, isChatLoading]);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = inputText.trim();
    if (!text || isChatLoading) return;

    if (mode === 'query') {
      const ok = wsClient.queryResults(text, daemonStatus.activeTaskId || undefined);
      if (!ok) {
        toast.error('Failed to send query. Ensure daemon is connected.');
        return;
      }
    } else {
      const ok = wsClient.steerTask(text, daemonStatus.activeTaskId || undefined);
      if (!ok) {
        toast.error('Failed to send steer command. Ensure daemon is connected.');
        return;
      }
    }

    setInputText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setInputText(suggestion);
  };

  return (
    <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-col h-full min-h-[560px]">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#383842] pb-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#8B5CF6]/20 border border-[#8B5CF6]/30 flex items-center justify-center">
            <MessageSquare className="w-4 h-4 text-[#8B5CF6]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-white">System 2 Chat & Steering</h2>
              <span
                className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                  activeGgufModelId || ollamaOnline
                    ? 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30'
                    : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                }`}
              >
                {activeGgufModelId ? `GPU: ${activeGgufModelId}` : ollamaOnline ? selectedModel : 'Deterministic Fallback'}
              </span>
            </div>
            <p className="text-xs text-gray-400">
              Conversational query engine and real-time crawler steering
            </p>
          </div>
        </div>

        {chatMessages.length > 0 && (
          <button
            onClick={clearChatMessages}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-white px-2.5 py-1 rounded bg-[#18181b] border border-[#383842] hover:border-[#4d4d5a] transition-colors"
            title="Clear Chat History"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear</span>
          </button>
        )}
      </div>

      {/* Mode Selector Tabs */}
      <div className="flex items-center justify-between bg-[#18181b] p-1 rounded-lg border border-[#383842] mb-3">
        <button
          onClick={() => setMode('query')}
          className={`flex items-center justify-center gap-2 flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors ${
            mode === 'query'
              ? 'bg-[#06B6D4] text-black shadow-sm'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Query Results</span>
        </button>

        <button
          onClick={() => setMode('steer')}
          className={`flex items-center justify-center gap-2 flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors ${
            mode === 'steer'
              ? 'bg-[#8B5CF6] text-white shadow-sm'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          <Compass className="w-3.5 h-3.5" />
          <span>Steer Crawler</span>
        </button>
      </div>

      {/* Message Stream */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1 max-h-[520px] 2xl:max-h-[660px] min-h-[360px] mb-3">
        {chatMessages.length === 0 ? (
          <div className="h-44 flex flex-col items-center justify-center text-center p-6 border border-dashed border-[#383842] rounded-xl bg-[#18181b]/50">
            <Sparkles className="w-7 h-7 text-gray-500 mb-2" />
            <p className="text-sm font-medium text-gray-300">
              System 2 is ready for interaction
            </p>
            <p className="text-xs text-gray-500 mt-1 max-w-sm">
              Ask questions about scraped findings or issue strategic directives to adapt crawler behavior in real time.
            </p>
          </div>
        ) : (
          chatMessages.map((msg) => {
            const isUser = msg.role === 'user';
            const isQuery = msg.type === 'query';

            return (
              <div
                key={msg.id}
                className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}
              >
                {/* Message Header Pill */}
                <div className="flex items-center gap-2 px-1">
                  <span className="text-[10px] font-mono uppercase text-gray-400">
                    {isUser ? (
                      isQuery ? (
                        <span className="text-[#06B6D4] font-semibold">User Query</span>
                      ) : (
                        <span className="text-[#8B5CF6] font-semibold">User Steer</span>
                      )
                    ) : (
                      <span className="text-emerald-400 font-semibold flex items-center gap-1">
                        <Cpu className="w-2.5 h-2.5" />
                        {msg.meta?.model || selectedModel}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] font-mono text-gray-500">
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </span>
                  {!isUser && msg.meta?.applied !== undefined && (
                    <span
                      className={`text-[9px] font-mono font-bold px-1.5 py-0.2 rounded border ${
                        msg.meta.applied
                          ? 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30'
                          : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                      }`}
                    >
                      {msg.meta.applied ? 'APPLIED' : 'NOT APPLIED'}
                    </span>
                  )}
                </div>

                {/* Message Bubble */}
                <div
                  className={`max-w-[85%] rounded-lg p-3 text-xs leading-relaxed ${
                    isUser
                      ? isQuery
                        ? 'bg-[#06B6D4]/15 border border-[#06B6D4]/30 text-white rounded-br-none'
                        : 'bg-[#8B5CF6]/15 border border-[#8B5CF6]/30 text-white rounded-br-none'
                      : 'bg-[#18181b] border border-[#383842] text-gray-200 rounded-bl-none shadow-sm'
                  }`}
                >
                  {isUser ? (
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  ) : (
                    <SafeMarkdownViewer content={msg.content} />
                  )}
                </div>
              </div>
            );
          })
        )}

        {/* Thinking Indicator */}
        {isChatLoading && (
          <div className="flex items-center gap-2.5 p-3 rounded-lg bg-[#18181b] border border-[#383842] max-w-[260px]">
            <div className="w-3.5 h-3.5 border-2 border-[#8B5CF6] border-t-transparent rounded-full animate-spin" />
            <span className="text-xs font-mono text-[#8B5CF6] animate-pulse">
              System 2 Reasoning...
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Suggestion Chips */}
      <div className="mb-3">
        <div className="flex items-center gap-1.5 text-[11px] text-gray-400 mb-1.5 font-medium">
          <HelpCircle className="w-3 h-3 text-gray-500" />
          <span>Suggested {mode === 'query' ? 'Queries' : 'Steering Actions'}:</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(mode === 'query' ? QUERY_SUGGESTIONS : STEER_SUGGESTIONS).map((sugg, idx) => (
            <button
              key={idx}
              onClick={() => handleSuggestionClick(sugg)}
              className="px-2.5 py-1 rounded bg-[#18181b] hover:bg-[#2c2c31] text-[11px] text-gray-300 border border-[#383842] hover:border-gray-500 transition-colors text-left truncate max-w-full"
            >
              {sugg}
            </button>
          ))}
        </div>
      </div>

      {/* Dual-Mode Input Form */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-2 bg-[#18181b] p-2.5 rounded-lg border border-[#383842]">
        <div className="flex items-start gap-2">
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              mode === 'query'
                ? activeGgufModelId
                  ? `Ask ${activeGgufModelId} on GPU about findings, trends, or stats... (Enter to send)`
                  : 'Ask about findings, trends, or specific items... (Press Enter to send)'
                : 'Direct crawler: e.g. "Scroll slower", "Click next page button", "Ignore sidebars"...'
            }
            rows={2}
            className="flex-1 bg-transparent text-xs text-gray-200 placeholder-gray-500 focus:outline-none resize-none leading-relaxed font-sans"
          />

          <button
            type="submit"
            disabled={!inputText.trim() || isChatLoading}
            className={`px-3 py-2 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors self-end ${
              mode === 'query'
                ? 'bg-[#06B6D4] hover:bg-[#0891b2] text-black disabled:opacity-40 disabled:hover:bg-[#06B6D4]'
                : 'bg-[#8B5CF6] hover:bg-[#7c3aed] text-white disabled:opacity-40 disabled:hover:bg-[#8B5CF6]'
            }`}
          >
            <span>Send</span>
            <Send className="w-3 h-3" />
          </button>
        </div>

        <div className="flex items-center justify-between text-[10px] text-gray-500 border-t border-[#383842]/60 pt-1.5">
          <span className="font-mono">
            Mode:{' '}
            <span className={mode === 'query' ? 'text-[#06B6D4] font-semibold' : 'text-[#8B5CF6] font-semibold'}>
              {mode === 'query' ? 'Query Results Data' : 'Steer Crawler Trajectory'}
            </span>
          </span>
          <span className="hidden sm:inline">Press Enter to send, Shift+Enter for new line</span>
        </div>
      </form>
    </div>
  );
};
