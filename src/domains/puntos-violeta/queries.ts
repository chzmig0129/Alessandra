/**
 * queries.ts — Supabase query functions for the Puntos Violeta domain.
 *
 * All queries hit the public.v_puntos_violeta view defined in
 * migrations/sql/002_views.sql.
 *
 * Distance ordering is done client-side via haversine because Supabase
 * PostgREST does not expose the acos/haversine SQL expression as a
 * sortable column through the REST API without custom RPC.
 */

import { supabaseAdmin } from "@/db/supabase-server";

// ---------------------------------------------------------------------------
// Row types (match v_puntos_violeta view columns)
// ---------------------------------------------------------------------------

export interface PuntoVioletaRow {
  id: number;
  nombre: string | null;
  direccion: string | null;
  street: string | null;
  exterior_number: string | null;
  colonia: string | null;
  postal_code: string | null;
  lat: number | null;
  lng: number | null;
  telefono: string | null;
  horario: string | null;
  tipo_atencion: string | null;
  atencion_24_7: boolean;
  active: boolean;
}

// Extended row that may include distance_km when lat/lng filter is applied
export interface PuntoVioletaRowWithDistance extends PuntoVioletaRow {
  distance_km?: number;
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
  /** Neighborhood filter (partial match) */
  colonia?: string;
  /** Attention type filter (partial match) */
  tipo_atencion?: string;
  /** If true, only return currently open points */
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
    // Match pattern: optional day spec then time range
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
 * Returns true if `now` falls within any TimeRange. Returns null if unknown.
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
    query = query.ilike("colonia", `%${filters.colonia}%`);
  }

  if (filters.tipo_atencion) {
    query = query.ilike("tipo_atencion", `%${filters.tipo_atencion}%`);
  }

  const { data, error } = await query;

  if (error) {
    return { data: [], error: error.message };
  }

  let rows = (data ?? []) as PuntoVioletaRowWithDistance[];

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
      }))
      .sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
  }

  // abierto_ahora filter
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
  return { data: data as PuntoVioletaRow | null, error: null };
}
