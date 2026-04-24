/**
 * queries.ts — Supabase query functions for the Mundial FIFA 2026 domain.
 *
 * All queries hit the public v_mundial_* views defined in
 * migrations/sql/002_views.sql which denormalize the "mundial-fifa" schema.
 * No schema() override is needed — the views live in public.
 *
 * Column contract (from F1 view rewrite, 2026-04-24):
 *   v_mundial_partidos: id, fecha_hora_cdmx, fase, grupo, equipo_a_codigo,
 *     equipo_a_nombre, equipo_a_desc, conf_a, rank_a, equipo_b_codigo,
 *     equipo_b_nombre, equipo_b_desc, conf_b, rank_b, sede_id, sede_nombre,
 *     sede_ciudad, sede_pais, sede_lat, sede_lng, estado, goles_local,
 *     goles_visitante
 *   v_mundial_sedes: id, nombre, ciudad, pais, direccion, capacidad,
 *     latitud, longitud, zona_horaria, descripcion, google_maps_url
 *   v_mundial_equipos: codigo, nombre, nombre_en, confederacion, grupo,
 *     bandera_url, bandera_emoji, fifa_ranking
 *   v_mundial_fan_fest: id, nombre, ciudad, pais, ubicacion, latitud,
 *     longitud, fecha_inicio, fecha_fin, horario, capacidad, entrada_gratis,
 *     descripcion, url_oficial, google_maps_url
 *
 * LIMIT: max 50 rows, default 10 for searches.
 */

import { supabaseAdmin } from "@/db/supabase-server";

// ---------------------------------------------------------------------------
// Row types (match v_mundial_* view columns as aliased by F1 view rewrite)
// ---------------------------------------------------------------------------

export interface PartidoRow {
  id: number;
  fecha_hora_cdmx: string | null;
  fase: string | null;
  grupo: string | null;
  equipo_a_codigo: string | null;
  equipo_a_nombre: string | null;
  equipo_a_desc: string | null;
  conf_a: string | null;
  rank_a: number | null;
  equipo_b_codigo: string | null;
  equipo_b_nombre: string | null;
  equipo_b_desc: string | null;
  conf_b: string | null;
  rank_b: number | null;
  sede_id: number | null;
  /** Alias: nombre del estadio/sede. Previously "sede_estadio" — now "sede_nombre". */
  sede_nombre: string | null;
  sede_ciudad: string | null;
  sede_pais: string | null;
  sede_lat: number | null;
  sede_lng: number | null;
  estado: string | null;
  /** Goals scored by the local team (was "marcador_a"). */
  goles_local: number | null;
  /** Goals scored by the visiting team (was "marcador_b"). */
  goles_visitante: number | null;
  /**
   * @deprecated Use `sede_nombre` — kept for backward compat with tools.ts/formatters.ts
   * until those files are updated to the F1 column rename.
   */
  sede_estadio: string | null;
  /** @deprecated Use `goles_local` — kept for backward compat. */
  marcador_a: number | null;
  /** @deprecated Use `goles_visitante` — kept for backward compat. */
  marcador_b: number | null;
}

export interface SedeRow {
  id: number;
  nombre: string;
  ciudad: string;
  pais: string;
  direccion: string | null;
  capacidad: number | null;
  latitud: number | null;
  longitud: number | null;
  zona_horaria: string | null;
  descripcion: string | null;
  google_maps_url: string | null;
}

export interface FanFestRow {
  id: number;
  nombre: string;
  ciudad: string;
  pais: string;
  ubicacion: string | null;
  latitud: number | null;
  longitud: number | null;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  horario: string | null;
  capacidad: number | null;
  entrada_gratis: boolean | null;
  descripcion: string | null;
  url_oficial: string | null;
  google_maps_url: string | null;
}

export interface EventoRow {
  id: number;
  partido_id: number;
  minuto: number | null;
  minuto_extra: number | null;
  tipo: string | null;
  equipo_codigo: string | null;
  jugador: string | null;
  jugador_asiste: string | null;
  detalle: string | null;
}

export interface AlineacionRow {
  id: number;
  partido_id: number;
  equipo_codigo: string;
  formacion: string | null;
  tipo: string | null;
  numero: number | null;
  jugador: string | null;
  posicion: string | null;
  es_capitan: boolean | null;
}

export interface EquipoRow {
  codigo: string;
  nombre: string;
  nombre_en: string | null;
  confederacion: string | null;
  grupo: string | null;
  bandera_url: string | null;
  bandera_emoji: string | null;
  fifa_ranking: number | null;
}

export interface PartidoDetalleRow extends PartidoRow {
  eventos: EventoRow[];
  alineaciones: AlineacionRow[];
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface PartidoFilters {
  /** ISO date string, YYYY-MM-DD — matches fecha_hora_cdmx date part */
  fecha?: string;
  /** Team code (3-letter FIFA) or name fragment */
  equipo?: string;
  /** Venue city (matches sede_ciudad) */
  ciudad?: string;
  /** Match phase: 'grupos' | 'dieciseisavos' | 'octavos' | 'cuartos' | 'semifinal' | 'tercer_lugar' | 'final' */
  fase?: string;
  /** Group letter A-L */
  grupo?: string;
  /** Match status: 'programado' | 'en_vivo' | 'finalizado' | 'suspendido' */
  estado?: string;
  /** 'asc' | 'desc' — default 'asc' */
  order_by?: "asc" | "desc";
  /** Number of rows to return — default 10, max 50 */
  limit?: number;
  /** Only matches scheduled at or after now() */
  proximos?: boolean;
}

export interface FanFestFilters {
  ciudad?: string;
  pais?: string;
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
 * Map a raw view row to PartidoRow, populating deprecated aliases from real cols.
 * The view exposes sede_nombre/goles_local/goles_visitante; we alias back to
 * sede_estadio/marcador_a/marcador_b so existing consumers (tools.ts, formatters.ts)
 * continue to compile without modification.
 * TODO: remove aliases once tools.ts and formatters.ts are updated.
 */
function toPartidoRow(raw: Record<string, unknown>): PartidoRow {
  const r = raw as Record<string, unknown>;
  const sede_nombre = (r["sede_nombre"] ?? null) as string | null;
  const goles_local = (r["goles_local"] ?? null) as number | null;
  const goles_visitante = (r["goles_visitante"] ?? null) as number | null;
  return {
    id: r["id"] as number,
    fecha_hora_cdmx: (r["fecha_hora_cdmx"] ?? null) as string | null,
    fase: (r["fase"] ?? null) as string | null,
    grupo: (r["grupo"] ?? null) as string | null,
    equipo_a_codigo: (r["equipo_a_codigo"] ?? null) as string | null,
    equipo_a_nombre: (r["equipo_a_nombre"] ?? null) as string | null,
    equipo_a_desc: (r["equipo_a_desc"] ?? null) as string | null,
    conf_a: (r["conf_a"] ?? null) as string | null,
    rank_a: (r["rank_a"] ?? null) as number | null,
    equipo_b_codigo: (r["equipo_b_codigo"] ?? null) as string | null,
    equipo_b_nombre: (r["equipo_b_nombre"] ?? null) as string | null,
    equipo_b_desc: (r["equipo_b_desc"] ?? null) as string | null,
    conf_b: (r["conf_b"] ?? null) as string | null,
    rank_b: (r["rank_b"] ?? null) as number | null,
    sede_id: (r["sede_id"] ?? null) as number | null,
    sede_nombre,
    sede_ciudad: (r["sede_ciudad"] ?? null) as string | null,
    sede_pais: (r["sede_pais"] ?? null) as string | null,
    sede_lat: (r["sede_lat"] ?? null) as number | null,
    sede_lng: (r["sede_lng"] ?? null) as number | null,
    estado: (r["estado"] ?? null) as string | null,
    goles_local,
    goles_visitante,
    // Deprecated aliases — keep in sync with real values
    sede_estadio: sede_nombre,
    marcador_a: goles_local,
    marcador_b: goles_visitante,
  };
}

// ---------------------------------------------------------------------------
// fetchPartidos
// ---------------------------------------------------------------------------

export async function fetchPartidos(
  filters: PartidoFilters = {},
): Promise<{ data: PartidoRow[]; error: string | null }> {
  const limit = clampLimit(filters.limit);

  let query = supabaseAdmin
    .from("v_mundial_partidos")
    .select("*")
    .limit(limit);

  if (filters.fecha) {
    // fecha_hora_cdmx is timestamptz; filter by date range in CDMX timezone.
    query = query
      .gte("fecha_hora_cdmx", `${filters.fecha}T00:00:00`)
      .lt("fecha_hora_cdmx", `${filters.fecha}T23:59:59`);
  }

  if (filters.proximos) {
    query = query.gte("fecha_hora_cdmx", new Date().toISOString());
  }

  if (filters.fase) {
    query = query.eq("fase", filters.fase);
  }

  if (filters.grupo) {
    query = query.eq("grupo", filters.grupo.toUpperCase());
  }

  if (filters.estado) {
    query = query.eq("estado", filters.estado);
  }

  if (filters.ciudad) {
    // sede_ciudad is the column name in F1's rewritten view (was "ciudad").
    query = query.ilike("sede_ciudad", `%${filters.ciudad}%`);
  }

  if (filters.equipo) {
    const eq = filters.equipo.toUpperCase();
    // Match either local OR visitante (code or name).
    // Using .or() per spec: equipo filter must match equipo_a_codigo OR equipo_b_codigo.
    query = query.or(
      `equipo_a_codigo.eq.${eq},equipo_b_codigo.eq.${eq},` +
        `equipo_a_nombre.ilike.%${filters.equipo}%,equipo_b_nombre.ilike.%${filters.equipo}%,` +
        `equipo_a_desc.ilike.%${filters.equipo}%,equipo_b_desc.ilike.%${filters.equipo}%`,
    );
  }

  // Default order: fecha_hora_cdmx ASC
  const order = filters.order_by === "desc" ? { ascending: false } : { ascending: true };
  query = query.order("fecha_hora_cdmx", order);

  const { data, error } = await query;

  if (error) {
    return { data: [], error: error.message };
  }
  const rows = (data ?? []).map((raw) => toPartidoRow(raw as Record<string, unknown>));
  return { data: rows, error: null };
}

// ---------------------------------------------------------------------------
// fetchSedeInfo
// ---------------------------------------------------------------------------

export async function fetchSedeInfo(
  idOrCity: string | number,
): Promise<{ data: SedeRow | null; error: string | null }> {
  if (typeof idOrCity === "number" || /^\d+$/.test(String(idOrCity))) {
    const { data, error } = await supabaseAdmin
      .from("v_mundial_sedes")
      .select("*")
      .eq("id", Number(idOrCity))
      .maybeSingle();
    if (error) return { data: null, error: error.message };
    return { data: data as SedeRow | null, error: null };
  }

  // Search by city or stadium name fragment (ciudad ILIKE per spec)
  const { data, error } = await supabaseAdmin
    .from("v_mundial_sedes")
    .select("*")
    .or(
      `ciudad.ilike.%${idOrCity}%,nombre.ilike.%${idOrCity}%`,
    )
    .limit(1)
    .maybeSingle();

  if (error) return { data: null, error: error.message };
  return { data: data as SedeRow | null, error: null };
}

// ---------------------------------------------------------------------------
// fetchFanFest
// ---------------------------------------------------------------------------

export async function fetchFanFest(
  filters: FanFestFilters = {},
): Promise<{ data: FanFestRow[]; error: string | null }> {
  const limit = clampLimit(filters.limit);

  let query = supabaseAdmin
    .from("v_mundial_fan_fest")
    .select("*")
    .limit(limit)
    .order("nombre", { ascending: true });

  if (filters.ciudad) {
    query = query.ilike("ciudad", `%${filters.ciudad}%`);
  }

  if (filters.pais) {
    query = query.ilike("pais", `%${filters.pais}%`);
  }

  const { data, error } = await query;
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as FanFestRow[], error: null };
}

// ---------------------------------------------------------------------------
// fetchPartidoDetalle
// ---------------------------------------------------------------------------

export async function fetchPartidoDetalle(
  id: number,
): Promise<{ data: PartidoDetalleRow | null; error: string | null }> {
  // Fetch the partido from the view
  const { data: partido, error: pErr } = await supabaseAdmin
    .from("v_mundial_partidos")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (pErr) return { data: null, error: pErr.message };
  if (!partido) return { data: null, error: `Partido ${id} no encontrado` };

  const base = toPartidoRow(partido as Record<string, unknown>);

  // Fetch match events
  const { data: eventosData, error: eErr } = await supabaseAdmin
    .from("v_mundial_eventos_partido")
    .select("*")
    .eq("partido_id", id)
    .order("minuto", { ascending: true });

  if (eErr) {
    return { data: null, error: eErr.message };
  }

  const eventos = (eventosData ?? []) as EventoRow[];

  // TODO: No view v_mundial_alineaciones exists yet in 002_views.sql.
  //       Returning empty array until the view is created.
  const alineaciones: AlineacionRow[] = [];

  return {
    data: { ...base, eventos, alineaciones },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// fetchEquipo
// ---------------------------------------------------------------------------

export interface EquipoConPartidosResult {
  equipo: EquipoRow | null;
  proximos_partidos: PartidoRow[];
  error: string | null;
}

export async function fetchEquipo(
  codeOrName: string,
): Promise<EquipoConPartidosResult> {
  const upper = codeOrName.toUpperCase();

  // Try exact code first
  let { data: equipo, error: eqErr } = await supabaseAdmin
    .from("v_mundial_equipos")
    .select("*")
    .eq("codigo", upper)
    .maybeSingle();

  if (eqErr) return { equipo: null, proximos_partidos: [], error: eqErr.message };

  // If no exact code match, search by name (nombre OR nombre_en ILIKE)
  if (!equipo) {
    const { data: byName, error: nameErr } = await supabaseAdmin
      .from("v_mundial_equipos")
      .select("*")
      .or(
        `nombre.ilike.%${codeOrName}%,nombre_en.ilike.%${codeOrName}%`,
      )
      .limit(1)
      .maybeSingle();

    if (nameErr) return { equipo: null, proximos_partidos: [], error: nameErr.message };
    equipo = byName;
  }

  if (!equipo) {
    return {
      equipo: null,
      proximos_partidos: [],
      error: `Equipo "${codeOrName}" no encontrado`,
    };
  }

  const codigo = (equipo as EquipoRow).codigo;

  // Fetch upcoming matches for this team.
  // Filter uses equipo_a_codigo OR equipo_b_codigo (per spec: .or() for both sides).
  const { data: partidos, error: pErr } = await fetchPartidos({
    equipo: codigo,
    proximos: true,
    order_by: "asc",
    limit: 5,
  });

  if (pErr) {
    return {
      equipo: equipo as EquipoRow,
      proximos_partidos: [],
      error: pErr,
    };
  }

  return {
    equipo: equipo as EquipoRow,
    proximos_partidos: partidos,
    error: null,
  };
}
