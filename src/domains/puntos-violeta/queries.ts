/**
 * queries.ts — Supabase query functions for the Puntos Violeta domain.
 *
 * All queries hit the public.v_puntos_violeta view defined in
 * migrations/sql/002_views.sql.
 *
 * Column contract (from F1 view rewrite, 2026-04-24):
 *   v_puntos_violeta: id, nombre, direccion, colonia, alcaldia, lat, lng,
 *     telefono, horario, tipo_atencion, atencion_24_7, geocode_precision
 *
 * Distance ordering is done client-side via haversine because Supabase
 * PostgREST does not expose the acos/haversine SQL expression as a
 * sortable column through the REST API without custom RPC.
 *
 * atencion_24_7 is now a pre-computed boolean in the view — no need to
 * parse the horario string to determine 24/7 availability.
 */

import { supabaseAdmin } from "@/db/supabase-server";
import { googleMapsDirectionsUrl } from "@/lib/geo";

// ---------------------------------------------------------------------------
// Row types (match v_puntos_violeta view columns per F1 rewrite)
// ---------------------------------------------------------------------------

export interface PuntoVioletaRow {
  id: number;
  nombre: string | null;
  direccion: string | null;
  colonia: string | null;
  /** Alcaldía/demarcación — added in F1 view rewrite. */
  alcaldia: string | null;
  lat: number | null;
  lng: number | null;
  telefono: string | null;
  horario: string | null;
  tipo_atencion: string | null;
  /** Pre-computed in view — true when the punto operates 24/7. */
  atencion_24_7: boolean;
  /** Geocoding precision hint (e.g. "exact", "interpolated", "centroid"). */
  geocode_precision: string | null;
  /**
   * @deprecated Not in F1 view — always null. Kept for backward compat with
   * puntos-violeta/tools.ts until that file is updated to the F1 schema.
   */
  street: string | null;
  /** @deprecated Not in F1 view — always null. Kept for backward compat. */
  exterior_number: string | null;
  /** @deprecated Not in F1 view — always null. Kept for backward compat. */
  postal_code: string | null;
  /** @deprecated Not in F1 view — always true (we filter active at view level). Kept for backward compat. */
  active: boolean;
}

// Extended row that may include distance_km and maps_url when lat/lng filter is applied
export interface PuntoVioletaRowWithDistance extends PuntoVioletaRow {
  distance_km?: number;
  maps_url?: string;
  _horario_unknown?: boolean;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface PuntosVioletaFilters {
  /** Latitude of the user's location for distance ordering */
  lat?: number;
  /** Longitude of the user's location for distance ordering */
  lng?: number;
  /** Search radius in km (requires lat/lng) */
  radio_km?: number;
  /** Neighborhood filter (partial match against colonia) */
  colonia?: string;
  /** Attention type filter (exact match against tipo_atencion) */
  tipo_atencion?: string;
  /** If true, only return points with atencion_24_7=true */
  abierto_ahora?: boolean;
  /** Maximum number of results (default 10, max 50) */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function clampLimit(n: number | undefined): number {
  return Math.min(n ?? DEFAULT_LIMIT, MAX_LIMIT);
}

/**
 * Map a raw Supabase row to PuntoVioletaRow, filling deprecated fields with
 * safe null/true defaults since v_puntos_violeta no longer exposes them.
 * TODO: remove deprecated fields once puntos-violeta/tools.ts is updated.
 */
function toPuntoVioletaRow(raw: Record<string, unknown>): PuntoVioletaRow {
  const r = raw as Record<string, unknown>;
  return {
    id: r["id"] as number,
    nombre: (r["nombre"] ?? null) as string | null,
    direccion: (r["direccion"] ?? null) as string | null,
    colonia: (r["colonia"] ?? null) as string | null,
    alcaldia: (r["alcaldia"] ?? null) as string | null,
    lat: (r["lat"] ?? null) as number | null,
    lng: (r["lng"] ?? null) as number | null,
    telefono: (r["telefono"] ?? null) as string | null,
    horario: (r["horario"] ?? null) as string | null,
    tipo_atencion: (r["tipo_atencion"] ?? null) as string | null,
    atencion_24_7: (r["atencion_24_7"] ?? false) as boolean,
    geocode_precision: (r["geocode_precision"] ?? null) as string | null,
    // Deprecated backward-compat fields — not in F1 view, set to safe defaults
    street: null,
    exterior_number: null,
    postal_code: null,
    active: true,
  };
}

/**
 * Haversine distance in kilometres between two lat/lng points.
 */
function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ---------------------------------------------------------------------------
// Schedule / horario parsing (best-effort)
// NOTE: With atencion_24_7 pre-computed in the view, this is only used when
// abierto_ahora=true AND atencion_24_7=false to narrow by horario string.
// ---------------------------------------------------------------------------

function dayNumberFromCode(code: string): number {
  const map: Record<string, number> = {
    L: 1,
    M: 2,
    MI: 3,
    J: 4,
    V: 5,
    S: 6,
    D: 7,
    LU: 1,
    MA: 2,
    MIE: 3,
    JU: 4,
    VI: 5,
    SA: 6,
    DO: 7,
  };
  return map[code.toUpperCase()] ?? -1;
}

interface TimeRange {
  openMinutes: number;
  closeMinutes: number;
  days: number[]; // 1=Mon … 7=Sun
}

function parseTimeHHMM(s: string): number | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = m[1];
  const min = m[2];
  if (!h || !min) return null;
  return parseInt(h, 10) * 60 + parseInt(min, 10);
}

/**
 * Parse a range like "L-V" or "S-D" or "L,V" into an array of day numbers.
 * Returns null if parsing fails.
 */
function parseDayRange(segment: string): number[] | null {
  const trimmed = segment.trim().toUpperCase();

  // Handle "L-V" style (hyphen range)
  const rangeMatch = trimmed.match(/^([A-Z]{1,3})-([A-Z]{1,3})$/);
  if (rangeMatch) {
    const startCode = rangeMatch[1];
    const endCode = rangeMatch[2];
    if (!startCode || !endCode) return null;
    const start = dayNumberFromCode(startCode);
    const end = dayNumberFromCode(endCode);
    if (start < 0 || end < 0) return null;
    const days: number[] = [];
    for (let d = start; d <= end; d++) days.push(d);
    return days.length > 0 ? days : null;
  }

  // Handle single day
  const single = dayNumberFromCode(trimmed);
  if (single > 0) return [single];

  return null;
}

/**
 * Attempt to parse a horario string into TimeRange segments.
 * Format examples:
 *   "L-V 09:00-18:00; S 10:00-14:00"
 *   "L-V 08:00-20:00"
 *   "Lunes a Viernes 09:00-18:00, Sabado 10:00-14:00"
 * Returns null if the string is not parseable.
 */
function parseHorario(horario: string): TimeRange[] | null {
  // Split on semicolons or commas
  const segments = horario.split(/[;,]+/).map((s) => s.trim()).filter(Boolean);
  const ranges: TimeRange[] = [];

  for (const seg of segments) {
    // Expect: <day_spec> <HH:MM>-<HH:MM>
    const m = seg.match(
      /^([A-Za-z\-]+(?:\s+[Aa]\s+[A-Za-z]+)?)\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/,
    );
    if (!m) return null;
    const rawDaySpec = m[1];
    const rawOpen = m[2];
    const rawClose = m[3];
    if (!rawDaySpec || !rawOpen || !rawClose) return null;

    const daySpec = rawDaySpec.trim();
    const openMinutes = parseTimeHHMM(rawOpen);
    const closeMinutes = parseTimeHHMM(rawClose);

    if (openMinutes === null || closeMinutes === null) return null;

    // Handle "Lunes a Viernes" style
    const expandedDaySpec = daySpec
      .replace(/lunes\s+a\s+viernes/i, "L-V")
      .replace(/lunes/i, "L")
      .replace(/martes/i, "M")
      .replace(/mi[eé]rcoles/i, "Mi")
      .replace(/jueves/i, "J")
      .replace(/viernes/i, "V")
      .replace(/s[aá]bado/i, "S")
      .replace(/domingo/i, "D");

    const days = parseDayRange(expandedDaySpec);
    if (!days) return null;

    ranges.push({ days, openMinutes, closeMinutes });
  }

  return ranges.length > 0 ? ranges : null;
}

/**
 * Returns true if `now` falls within any TimeRange.
 * Since atencion_24_7 is now a view column, we only reach here for
 * non-24/7 points when the caller asks for abierto_ahora.
 * Returns null if schedule is unknown/unparseable.
 */
function isOpenNow(
  horario: string | null,
  atencion_24_7: boolean,
  now: Date = new Date(),
): boolean | null {
  if (atencion_24_7) return true;
  if (!horario) return null;

  const lower = horario.toLowerCase();
  if (lower.includes("24/7") || lower.includes("24 horas") || lower.includes("las 24")) {
    return true;
  }

  const ranges = parseHorario(horario);
  if (!ranges) return null;

  // JS getDay(): 0=Sun, 1=Mon…6=Sat. Convert to our 1-7 (1=Mon, 7=Sun).
  const jsDay = now.getDay();
  const ourDay = jsDay === 0 ? 7 : jsDay;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  for (const range of ranges) {
    if (
      range.days.includes(ourDay) &&
      currentMinutes >= range.openMinutes &&
      currentMinutes < range.closeMinutes
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// fetchPuntosVioleta
// ---------------------------------------------------------------------------

export async function fetchPuntosVioleta(
  filters: PuntosVioletaFilters = {},
): Promise<{ data: PuntoVioletaRowWithDistance[]; error: string | null }> {
  const limit = clampLimit(filters.limit);

  const hasLocation =
    typeof filters.lat === "number" && typeof filters.lng === "number";
  const radioKm = filters.radio_km ?? 5;

  let query = supabaseAdmin
    .from("v_puntos_violeta")
    .select("*");

  // Bounding box pre-filter if lat/lng provided (cheap row reduction before haversine)
  if (hasLocation && filters.lat !== undefined && filters.lng !== undefined) {
    const latDelta = radioKm / 111; // ~1 degree latitude = 111 km
    const lngDelta = radioKm / (111 * Math.cos((filters.lat * Math.PI) / 180));

    query = query
      .gte("lat", filters.lat - latDelta)
      .lte("lat", filters.lat + latDelta)
      .gte("lng", filters.lng - lngDelta)
      .lte("lng", filters.lng + lngDelta);
  }

  if (filters.colonia) {
    // DB stores colonias in non-canonical forms ("ROMA NTE", "DEL VALLE NORTE",
    // etc.). Tokenise the user input and OR-match each token >= 3 chars so
    // "Roma Norte" matches "ROMA NTE", "Del Valle" matches "DEL VALLE NORTE", etc.
    const tokens = filters.colonia
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ""))
      .filter((t) => t.length >= 3);
    if (tokens.length > 0) {
      const orFilter = tokens.map((t) => `colonia.ilike.%${t}%`).join(",");
      query = query.or(orFilter);
    }
  }

  if (filters.tipo_atencion) {
    // tipo_atencion: use eq (exact) per spec; caller can pass partial if needed
    query = query.eq("tipo_atencion", filters.tipo_atencion);
  }

  // abierto_ahora: since atencion_24_7 is pre-computed in the view,
  // we can push this filter to the DB for 24/7 points.
  // Non-24/7 schedule check is done client-side after fetch.
  if (filters.abierto_ahora === true) {
    // NOTE: We do NOT filter at DB level here because non-24/7 points with
    // valid horario should still be included — client-side isOpenNow handles them.
    // We do NOT add .eq("atencion_24_7", true) to avoid excluding valid
    // non-24/7 but currently-open points.
  }

  const { data, error } = await query;

  if (error) {
    return { data: [], error: error.message };
  }

  let rows: PuntoVioletaRowWithDistance[] = (data ?? []).map(
    (raw) => toPuntoVioletaRow(raw as Record<string, unknown>) as PuntoVioletaRowWithDistance,
  );

  // Compute haversine distance and sort if location given
  if (hasLocation && filters.lat !== undefined && filters.lng !== undefined) {
    const origin = { lat: filters.lat, lng: filters.lng };
    rows = rows
      .filter((row) => row.lat !== null && row.lng !== null)
      .map((row) => ({
        ...row,
        distance_km: haversineKm(origin, {
          lat: row.lat as number,
          lng: row.lng as number,
        }),
        maps_url: googleMapsDirectionsUrl(origin, {
          lat: row.lat as number,
          lng: row.lng as number,
        }),
      }))
      .sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
  }

  // abierto_ahora filter — atencion_24_7 is already a view column
  if (filters.abierto_ahora === true) {
    const now = new Date();
    rows = rows.filter((row) => {
      const open = isOpenNow(row.horario, row.atencion_24_7, now);
      if (open === null) {
        // Unknown schedule: include but mark
        row._horario_unknown = true;
        return true;
      }
      return open === true;
    });
  }

  return { data: rows.slice(0, limit), error: null };
}

// ---------------------------------------------------------------------------
// fetchPuntoDetalle
// ---------------------------------------------------------------------------

export async function fetchPuntoDetalle(
  id: number,
): Promise<{ data: PuntoVioletaRow | null; error: string | null }> {
  const { data, error } = await supabaseAdmin
    .from("v_puntos_violeta")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) return { data: null, error: error.message };
  if (!data) return { data: null, error: null };
  return { data: toPuntoVioletaRow(data as Record<string, unknown>), error: null };
}
