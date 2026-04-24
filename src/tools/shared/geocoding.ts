/**
 * Nominatim reverse-geocoding helper with DB cache and 1 req/sec rate-limit.
 *
 * Cache table: location_label_cache
 * Real columns (2026-04-24 schema audit):
 *   coord_hash (PK, text), lat_rounded (numeric), lng_rounded (numeric),
 *   label (text), full_display_name (text),
 *   resolved_at (timestamptz), expires_at (timestamptz)
 *
 * Cache key: sha256(lat.toFixed(4) + ',' + lng.toFixed(4))
 * Cache lookup: eq('coord_hash', hash) + expires_at > now
 * Cache write: upsert with onConflict:'coord_hash', expires_at = now + 30d
 */

import { createHash } from "node:crypto";
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
// Module-level rate-limiter (1 req/sec to Nominatim)
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

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Returns the cache key for a given coordinate pair.
 * Rounds to 4 decimal places (~11m precision) to maximize cache hits.
 */
function coordHash(lat: number, lng: number): string {
  return sha256(`${lat.toFixed(4)},${lng.toFixed(4)}`);
}

function roundCoord(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Cache: 30-day TTL
// ---------------------------------------------------------------------------

interface CacheRow {
  label: string | null;
  full_display_name: string | null;
  // NOTE: colonia, alcaldia, ciudad are not direct columns; they are derived
  // from full_display_name on cache miss and stored as separate lookup fields.
  // Since the real table only has label + full_display_name, we re-parse on
  // cache hit when individual fields are needed.
  // ASSUMPTION: the DB schema does not have colonia/alcaldia/ciudad columns;
  // we store the full result JSON in full_display_name and use label for
  // the short form. On miss we fetch from Nominatim and store both.
}

/**
 * Try to get a cached geocoding result by coord_hash.
 * Returns null on miss or if expires_at has passed (checked server-side via .gte).
 */
async function getFromCache(
  lat: number,
  lng: number,
): Promise<GeocodingResult | null> {
  const hash = coordHash(lat, lng);
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("location_label_cache")
    .select("label, full_display_name, lat_rounded, lng_rounded, expires_at")
    .eq("coord_hash", hash)
    .gte("expires_at", now)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as {
    label: string | null;
    full_display_name: string | null;
    expires_at: string | null;
  };

  // label stores a JSON-encoded GeocodingResult for reconstruction
  if (row.label) {
    try {
      const parsed = JSON.parse(row.label) as Partial<GeocodingResult>;
      if (typeof parsed.label_completo === "string") {
        return {
          colonia: parsed.colonia ?? null,
          alcaldia: parsed.alcaldia ?? null,
          ciudad: parsed.ciudad ?? null,
          label_completo: parsed.label_completo,
        };
      }
    } catch {
      // fall through — try full_display_name
    }
  }

  if (row.full_display_name) {
    return {
      colonia: null,
      alcaldia: null,
      ciudad: null,
      label_completo: row.full_display_name,
    };
  }

  return null;
}

/**
 * Persist a geocoding result.
 * - label: JSON.stringify(result) — stores all fields for reconstruction
 * - full_display_name: human-readable string (for direct display)
 * - expires_at: now + 30 days
 */
async function saveToCache(
  lat: number,
  lng: number,
  result: GeocodingResult,
): Promise<void> {
  const hash = coordHash(lat, lng);
  const latRounded = roundCoord(lat);
  const lngRounded = roundCoord(lng);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  await supabaseAdmin.from("location_label_cache").upsert(
    {
      coord_hash: hash,
      lat_rounded: latRounded,
      lng_rounded: lngRounded,
      label: JSON.stringify(result),
      full_display_name: result.label_completo,
      resolved_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    },
    { onConflict: "coord_hash" },
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
  // 1. Try cache first (coord_hash PK, expires_at > now)
  const cached = await getFromCache(lat, lng);
  if (cached) return cached;

  // 2. Rate-limit before network call
  await waitForRateLimit();

  // 3. Fetch from Nominatim
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16`;
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

  // colonia: suburb or neighbourhood
  const colonia = addr.suburb ?? addr.neighbourhood ?? null;
  // alcaldia: city_district or borough
  const alcaldia = addr.city_district ?? addr.borough ?? null;
  // ciudad: city, town, or village
  const ciudad = addr.city ?? addr.town ?? addr.village ?? null;
  // full_display_name from Nominatim
  const label_completo =
    data.display_name ??
    [colonia, alcaldia, ciudad].filter(Boolean).join(", ") ??
    `${lat},${lng}`;

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
