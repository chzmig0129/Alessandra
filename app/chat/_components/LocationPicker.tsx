'use client';

import { useState } from 'react';
import { MapPin, X, Loader2 } from 'lucide-react';

export interface LatLng {
  lat: number;
  lng: number;
}

interface LocationPickerProps {
  onConfirm: (location: LatLng) => void;
  onClose: () => void;
}

export default function LocationPicker({ onConfirm, onClose }: LocationPickerProps) {
  const [lat, setLat] = useState<string>('');
  const [lng, setLng] = useState<string>('');
  const [geoError, setGeoError] = useState<string>('');
  const [geoLoading, setGeoLoading] = useState(false);

  function handleUseMyLocation() {
    if (!navigator.geolocation) {
      setGeoError('Tu navegador no soporta geolocalización.');
      return;
    }
    setGeoLoading(true);
    setGeoError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toString());
        setLng(pos.coords.longitude.toString());
        setGeoLoading(false);
      },
      (err) => {
        setGeoError(`No se pudo obtener ubicación: ${err.message}`);
        setGeoLoading(false);
      },
    );
  }

  function handleConfirm() {
    const parsedLat = parseFloat(lat);
    const parsedLng = parseFloat(lng);
    if (isNaN(parsedLat) || isNaN(parsedLng)) {
      setGeoError('Ingresa latitud y longitud válidas.');
      return;
    }
    if (parsedLat < -90 || parsedLat > 90) {
      setGeoError('Latitud debe estar entre -90 y 90.');
      return;
    }
    if (parsedLng < -180 || parsedLng > 180) {
      setGeoError('Longitud debe estar entre -180 y 180.');
      return;
    }
    onConfirm({ lat: parsedLat, lng: parsedLng });
  }

  return (
    /* Modal overlay */
    <div
      className="fixed inset-0 bg-black/50 grid place-items-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm mx-4 flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-violet-600">
            <MapPin size={20} />
            <h2 className="font-semibold text-neutral-800">Agregar ubicación</h2>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-600 transition-colors"
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Inputs */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-neutral-600">Latitud</label>
            <input
              type="number"
              step="any"
              min={-90}
              max={90}
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="ej. 19.4326"
              className="border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-neutral-600">Longitud</label>
            <input
              type="number"
              step="any"
              min={-180}
              max={180}
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              placeholder="ej. -99.1332"
              className="border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
            />
          </div>
        </div>

        {/* Error */}
        {geoError && (
          <p className="text-xs text-red-500">{geoError}</p>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <button
            onClick={handleUseMyLocation}
            disabled={geoLoading}
            className="flex items-center justify-center gap-2 border border-violet-300 text-violet-700 rounded-lg px-4 py-2 text-sm hover:bg-violet-50 transition-colors disabled:opacity-50"
          >
            {geoLoading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <MapPin size={14} />
            )}
            Usar mi ubicación
          </button>
          <button
            onClick={handleConfirm}
            className="bg-violet-500 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-violet-600 transition-colors"
          >
            Confirmar ubicación
          </button>
        </div>
      </div>
    </div>
  );
}
