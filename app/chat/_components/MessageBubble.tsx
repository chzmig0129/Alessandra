'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface Attachment {
  type: 'image' | 'document' | 'link';
  url: string;
  label?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  suggestions?: string[];
  attachments?: Attachment[];
  debug?: {
    tool_calls?: ToolCall[];
    [key: string]: unknown;
  };
}

interface MessageBubbleProps {
  message: ChatMessage;
  onSuggestionClick?: (text: string) => void;
}

export default function MessageBubble({ message, onSuggestionClick }: MessageBubbleProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const isUser = message.role === 'user';
  const hasToolCalls =
    !isUser &&
    message.debug?.tool_calls &&
    message.debug.tool_calls.length > 0;

  return (
    <div className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      {/* Bubble */}
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? 'bg-violet-500 text-white rounded-br-sm'
            : 'bg-neutral-100 text-neutral-900 rounded-bl-sm'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        ) : (
          <div className="prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-1.5 prose-code:text-violet-700 prose-pre:bg-neutral-800 prose-pre:text-neutral-100">
            <ReactMarkdown>{message.text}</ReactMarkdown>
          </div>
        )}
      </div>

      {/* Attachments */}
      {message.attachments && message.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 max-w-[80%]">
          {message.attachments.map((att, i) => (
            <a
              key={i}
              href={att.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-violet-600 underline underline-offset-2 hover:text-violet-800"
            >
              {att.label ?? att.url}
            </a>
          ))}
        </div>
      )}

      {/* Suggestions */}
      {message.suggestions && message.suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2 max-w-[80%] mt-1">
          {message.suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => onSuggestionClick?.(s)}
              className="text-xs bg-white border border-violet-200 text-violet-700 rounded-full px-3 py-1 hover:bg-violet-50 transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Collapsible reasoning */}
      {hasToolCalls && (
        <div className="max-w-[80%] w-full">
          <button
            onClick={() => setReasoningOpen((o) => !o)}
            className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-600 transition-colors mt-0.5"
          >
            {reasoningOpen ? (
              <ChevronUp size={12} />
            ) : (
              <ChevronDown size={12} />
            )}
            Ver razonamiento
          </button>
          {reasoningOpen && (
            <pre className="mt-1 p-3 rounded-xl bg-neutral-900 text-neutral-100 text-xs overflow-x-auto max-h-64 overflow-y-auto">
              {JSON.stringify(message.debug!.tool_calls, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
