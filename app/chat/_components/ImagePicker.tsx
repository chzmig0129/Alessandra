'use client';

import { useRef, useState } from 'react';
import { Paperclip, X, Loader2 } from 'lucide-react';

interface UploadResult {
  url: string;
}

interface ImagePickerProps {
  onImageUploaded: (url: string) => void;
  disabled?: boolean;
}

export default function ImagePicker({ onImageUploaded, disabled }: ImagePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>('');
  const [preview, setPreview] = useState<string>('');

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Basic client-side validation
    if (!file.type.startsWith('image/')) {
      setError('Solo se permiten imágenes.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('La imagen no puede superar 10 MB.');
      return;
    }

    setError('');
    setUploading(true);

    // Build a local preview immediately
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as UploadResult;
      onImageUploaded(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al subir imagen.');
      setPreview('');
    } finally {
      setUploading(false);
      // Reset so the same file can be re-selected
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  function clearPreview() {
    setPreview('');
    setError('');
  }

  return (
    <div className="flex items-center gap-2">
      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
        disabled={disabled || uploading}
      />

      {/* Visible trigger button */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || uploading}
        className="p-2 text-neutral-400 hover:text-violet-500 transition-colors disabled:opacity-40"
        aria-label="Adjuntar imagen"
        title="Adjuntar imagen"
      >
        {uploading ? (
          <Loader2 size={20} className="animate-spin text-violet-500" />
        ) : (
          <Paperclip size={20} />
        )}
      </button>

      {/* Preview thumbnail */}
      {preview && !uploading && (
        <div className="relative inline-block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview}
            alt="Vista previa"
            className="h-10 w-10 rounded-lg object-cover border border-neutral-200"
          />
          <button
            type="button"
            onClick={clearPreview}
            className="absolute -top-1.5 -right-1.5 bg-white rounded-full border border-neutral-200 text-neutral-500 hover:text-red-500 transition-colors"
            aria-label="Quitar imagen"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Inline error */}
      {error && (
        <span className="text-xs text-red-500 max-w-[160px] truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
