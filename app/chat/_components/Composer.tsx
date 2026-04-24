'use client';

import { useRef, useState, KeyboardEvent } from 'react';
import { Send, MapPin } from 'lucide-react';
import ImagePicker from './ImagePicker';
import LocationPicker, { type LatLng } from './LocationPicker';

export interface AttachmentDraft {
  imageUrl?: string;
  lat?: number;
  lng?: number;
}

interface ComposerProps {
  onSend: (message: string, attachments: AttachmentDraft) => void;
  isLoading: boolean;
}

export default function Composer({ onSend, isLoading }: ComposerProps) {
  const [text, setText] = useState('');
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentDraft>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    autoResize();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed, attachments);
    setText('');
    setAttachments({});
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleLocationConfirm(loc: LatLng) {
    setAttachments((prev) => ({ ...prev, lat: loc.lat, lng: loc.lng }));
    setShowLocationPicker(false);
  }

  function handleImageUploaded(url: string) {
    setAttachments((prev) => ({ ...prev, imageUrl: url }));
  }

  const hasLocation = attachments.lat !== undefined && attachments.lng !== undefined;
  const canSend = text.trim().length > 0 && !isLoading;

  return (
    <>
      {/* Location chip */}
      {hasLocation && (
        <div className="flex items-center gap-1.5 px-3 py-1 bg-violet-50 border-t border-violet-100">
          <MapPin size={12} className="text-violet-500" />
          <span className="text-xs text-violet-700">
            {attachments.lat!.toFixed(5)}, {attachments.lng!.toFixed(5)}
          </span>
          <button
            onClick={() => setAttachments((prev) => ({ ...prev, lat: undefined, lng: undefined }))}
            className="ml-1 text-violet-400 hover:text-violet-600 text-xs leading-none"
            aria-label="Quitar ubicación"
          >
            ✕
          </button>
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-1 border-t border-neutral-200 bg-white px-3 py-2">
        {/* Location button */}
        <button
          type="button"
          onClick={() => setShowLocationPicker(true)}
          disabled={isLoading}
          className={`p-2 transition-colors disabled:opacity-40 ${
            hasLocation
              ? 'text-violet-500'
              : 'text-neutral-400 hover:text-violet-500'
          }`}
          aria-label="Agregar ubicación"
          title="Agregar ubicación"
        >
          <MapPin size={20} />
        </button>

        {/* Image picker */}
        <ImagePicker onImageUploaded={handleImageUploaded} disabled={isLoading} />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Escribe tu mensaje…"
          disabled={isLoading}
          className="flex-1 resize-none rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-violet-400 disabled:opacity-60 min-h-[40px] max-h-[180px] overflow-y-auto"
        />

        {/* Send button */}
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className="p-2 rounded-xl bg-violet-500 text-white hover:bg-violet-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          aria-label="Enviar mensaje"
        >
          <Send size={18} />
        </button>
      </div>

      {/* Location Picker modal */}
      {showLocationPicker && (
        <LocationPicker
          onConfirm={handleLocationConfirm}
          onClose={() => setShowLocationPicker(false)}
        />
      )}
    </>
  );
}
