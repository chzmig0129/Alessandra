'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { RefreshCw, Loader2, MessageCircle } from 'lucide-react';
import MessageBubble, { type ChatMessage } from './_components/MessageBubble';
import Composer, { type AttachmentDraft } from './_components/Composer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AlessandraResponse {
  text: string;
  suggestions?: string[];
  attachments?: Array<{ type: 'image' | 'document' | 'link'; url: string; label?: string }>;
  debug?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const SESSION_KEY = 'alessandra:sessionId';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ChatPage() {
  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Initialise sessionId after mount to avoid SSR/hydration mismatch
  useEffect(() => {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(SESSION_KEY, id);
    }
    setSessionId(id);
  }, []);

  // Auto-scroll to bottom whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  function handleReset() {
    localStorage.removeItem(SESSION_KEY);
    window.location.reload();
  }

  const handleSend = useCallback(
    async (message: string, attachments: AttachmentDraft) => {
      if (!sessionId || isLoading) return;

      // Optimistically add user message
      const userMsg: ChatMessage = {
        id: makeId(),
        role: 'user',
        text: message,
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            attachments:
              Object.keys(attachments).length > 0 ? attachments : undefined,
            sessionId,
          }),
        });

        const data = (await res.json()) as AlessandraResponse & { error?: string };

        if (!res.ok) {
          setMessages((prev) => [
            ...prev,
            {
              id: makeId(),
              role: 'assistant',
              text: data.error
                ? `Error: ${data.error}`
                : 'Ocurrió un error. Intenta de nuevo.',
            },
          ]);
          return;
        }

        const assistantMsg: ChatMessage = {
          id: makeId(),
          role: 'assistant',
          text: data.text,
          suggestions: data.suggestions,
          attachments: data.attachments,
          debug: data.debug,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } catch (err) {
        console.error('[chat] fetch error:', err);
        setMessages((prev) => [
          ...prev,
          {
            id: makeId(),
            role: 'assistant',
            text: 'No se pudo conectar al servidor. Verifica tu conexión e intenta de nuevo.',
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [sessionId, isLoading],
  );

  function handleSuggestionClick(text: string) {
    handleSend(text, {}).catch(console.error);
  }

  return (
    <div className="flex h-screen bg-neutral-50 overflow-hidden">
      {/* ----------------------------------------------------------------- */}
      {/* Sidebar                                                             */}
      {/* ----------------------------------------------------------------- */}
      <aside className="hidden md:flex flex-col w-64 bg-white border-r border-neutral-200 p-5 gap-6 flex-shrink-0">
        {/* Logo / brand */}
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-violet-500 flex items-center justify-center">
            <MessageCircle size={16} className="text-white" />
          </div>
          <div>
            <p className="font-semibold text-neutral-800 text-sm leading-tight">Alessandra</p>
            <p className="text-xs text-neutral-400 leading-tight">Alcaldía Cuauhtémoc</p>
          </div>
        </div>

        {/* Session info */}
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wide">Sesión</p>
          <p className="text-xs text-neutral-400 font-mono break-all">{sessionId.slice(0, 16)}…</p>
        </div>

        {/* Capabilities */}
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wide">Puedo ayudarte con</p>
          <ul className="text-xs text-neutral-600 space-y-1.5">
            <li className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0" />
              Mundial FIFA 2026
            </li>
            <li className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0" />
              Puntos Violeta
            </li>
            <li className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0" />
              Reportes ciudadanos
            </li>
          </ul>
        </div>

        {/* Reset */}
        <div className="mt-auto">
          <button
            onClick={handleReset}
            className="flex items-center gap-2 text-xs text-neutral-500 hover:text-violet-600 transition-colors"
          >
            <RefreshCw size={13} />
            Reset conversación
          </button>
        </div>
      </aside>

      {/* ----------------------------------------------------------------- */}
      {/* Main chat column                                                    */}
      {/* ----------------------------------------------------------------- */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Header (mobile + desktop) */}
        <header className="flex items-center justify-between px-4 py-3 bg-white border-b border-neutral-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            {/* Mobile brand */}
            <div className="md:hidden w-7 h-7 rounded-full bg-violet-500 flex items-center justify-center">
              <MessageCircle size={14} className="text-white" />
            </div>
            <div>
              <h1 className="font-semibold text-neutral-800 text-sm leading-tight">Alessandra</h1>
              <p className="text-xs text-neutral-400 leading-tight hidden md:block">
                Asistente ciudadano · Alcaldía Cuauhtémoc
              </p>
            </div>
          </div>
          {/* Mobile reset */}
          <button
            onClick={handleReset}
            className="md:hidden flex items-center gap-1.5 text-xs text-neutral-500 hover:text-violet-600 transition-colors"
          >
            <RefreshCw size={14} />
            Reset
          </button>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-5 flex flex-col gap-4">
          {/* Welcome message */}
          {messages.length === 0 && !isLoading && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center text-neutral-400 select-none">
              <div className="w-14 h-14 rounded-full bg-violet-100 flex items-center justify-center">
                <MessageCircle size={28} className="text-violet-400" />
              </div>
              <div>
                <p className="font-medium text-neutral-600">Hola, soy Alessandra</p>
                <p className="text-sm mt-0.5">
                  Asistente ciudadana de la Alcaldía Cuauhtémoc.
                  <br />
                  ¿En qué puedo ayudarte hoy?
                </p>
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              onSuggestionClick={handleSuggestionClick}
            />
          ))}

          {/* Loading indicator */}
          {isLoading && (
            <div className="flex items-start gap-2">
              <div className="bg-neutral-100 rounded-2xl rounded-bl-sm px-4 py-2.5 flex items-center gap-2">
                <Loader2 size={14} className="animate-spin text-violet-400" />
                <span className="text-sm text-neutral-400">Pensando…</span>
              </div>
            </div>
          )}

          {/* Auto-scroll anchor */}
          <div ref={bottomRef} />
        </div>

        {/* Composer */}
        <div className="flex-shrink-0">
          <Composer onSend={handleSend} isLoading={isLoading} />
        </div>
      </div>
    </div>
  );
}
