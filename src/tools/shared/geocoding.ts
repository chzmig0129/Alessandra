/**
 * Nominatim reverse-geocoding helper with DB cache and 1 req/sec rate-limit.
 */

import { supabaseAdmin } from "@/db/supabase-server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeocodingResult {
  colonia: string | null;
  alcaldia: string | null;
  ciudad: string | null;
  label_completo: string;
}

// ---------------------------------------------------------------------------
// Module-level rate-limiter
// ---------------------------------------------------------------------------

let lastCall = 0;

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCall;
  if (elapsed < 1000) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1000 - elapsed));
  }
  lastCall = Date.now();
}

// ---------------------------------------------------------------------------
// Cache key helpers
// ---------------------------------------------------------------------------

function roundCoord(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Cache: 30-day TTL
// ---------------------------------------------------------------------------

interface CacheRow {
  label_completo: string;
  payload: {
    colonia?: string | null;
    alcaldia?: string | null;
    ciudad?: string | null;
    label_completo?: string | null;
  };
}

async function getFromCache(
  lat: number,
  lng: number,
): Promise<GeocodingResult | null> {
  const roundedLat = roundCoord(lat);
  const roundedLng = roundCoord(lng);

  const { data, error } = await supabaseAdmin
    .from("location_label_cache")
    .select("label_completo, payload")
    .eq("lat", roundedLat)
    .eq("lng", roundedLng)
    .gte(
      "created_at",
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    )
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as CacheRow;
  return {
    colonia: row.payload?.colonia ?? null,
    alcaldia: row.payload?.alcaldia ?? null,
    ciudad: row.payload?.ciudad ?? null,
    label_completo: row.label_completo,
  };
}

async function saveToCache(
  lat: number,
  lng: number,
  result: GeocodingResult,
): Promise<void> {
  const roundedLat = roundCoord(lat);
  const roundedLng = roundCoord(lng);

  await supabaseAdmin.from("location_label_cache").upsert(
    {
      lat: roundedLat,
      lng: roundedLng,
      label_completo: result.label_completo,
      payload: result,
      created_at: new Date().toISOString(),
    },
    { onConflict: "lat,lng" },
  );
}

// ---------------------------------------------------------------------------
// Nominatim response shape (partial)
// ---------------------------------------------------------------------------

interface NominatimAddress {
  suburb?: string;
  neighbourhood?: string;
  borough?: string;
  city_district?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
}

interface NominatimResponse {
  display_name?: string;
  address?: NominatimAddress;
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

export async function nominatimReverseGeocode(
  lat: number,
  lng: number,
): Promise<GeocodingResult> {
  // 1. Try cache first
  const cached = await getFromCache(lat, lng);
  if (cached) return cached;

  // 2. Rate-limit before network call
  await waitForRateLimit();

  // 3. Fetch from Nominatim
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lng=${lng}&zoom=16`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Alessandra/1.0 (alcaldia-cuauhtemoc)",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const fallback: GeocodingResult = {
      colonia: null,
      alcaldia: null,
      ciudad: null,
      label_completo: `${lat},${lng}`,
    };
    return fallback;
  }

  const data = (await response.json()) as NominatimResponse;
  const addr = data.address ?? {};

  const colonia = addr.suburb ?? addr.neighbourhood ?? null;
  const alcaldia = addr.borough ?? addr.city_district ?? null;
  const ciudad = addr.city ?? addr.town ?? addr.village ?? null;
  const label_completo =
    data.display_name ?? [colonia, alcaldia, ciudad].filter(Boolean).join(", ") ?? `${lat},${lng}`;

  const result: GeocodingResult = {
    colonia,
    alcaldia,
    ciudad,
    label_completo,
  };

  // 4. Save to cache (fire-and-forget; don't block caller on cache error)
  saveToCache(lat, lng, result).catch(() => {
    // ignore cache write errors
  });

  return result;
}
