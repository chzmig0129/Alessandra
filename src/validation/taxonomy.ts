/**
 * Report taxonomy loader.
 * Queries public.report_taxonomy with a 5-minute module-level cache.
 */

import { supabaseAdmin } from "@/db/supabase-server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaxonomyRow {
  id: string | number;
  categoria: string;
  tipo: string;
  attributes: Record<string, unknown> | null;
}

export interface TaxonomyData {
  categorias: Set<string>;
  /** Maps categoria → set of valid tipos */
  tipos: Map<string, Set<string>>;
  /** Maps "<categoria>/<tipo>" → attributes record */
  attributesByTipo: Map<string, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Module-level cache (TTL = 5 minutes)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;

let _cache: { data: TaxonomyData; expiresAt: number } | null = null;

function emptyTaxonomy(): TaxonomyData {
  return {
    categorias: new Set<string>(),
    tipos: new Map<string, Set<string>>(),
    attributesByTipo: new Map<string, Record<string, unknown>>(),
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadReportTaxonomy(): Promise<TaxonomyData> {
  const now = Date.now();

  if (_cache !== null && now < _cache.expiresAt) {
    return _cache.data;
  }

  let rows: TaxonomyRow[] = [];

  try {
    const { data, error } = await supabaseAdmin
      .from("report_taxonomy")
      .select("*");

    if (error) {
      console.warn("[taxonomy] Error fetching report_taxonomy:", error.message);
      const empty = emptyTaxonomy();
      // Cache the empty result briefly (1 min) so we don't hammer Supabase on errors
      _cache = { data: empty, expiresAt: now + 60_000 };
      return empty;
    }

    rows = (data ?? []) as TaxonomyRow[];
  } catch (err) {
    console.warn("[taxonomy] Unexpected error loading taxonomy:", err);
    const empty = emptyTaxonomy();
    _cache = { data: empty, expiresAt: now + 60_000 };
    return empty;
  }

  if (rows.length === 0) {
    const empty = emptyTaxonomy();
    _cache = { data: empty, expiresAt: now + CACHE_TTL_MS };
    return empty;
  }

  const categorias = new Set<string>();
  const tipos = new Map<string, Set<string>>();
  const attributesByTipo = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const cat = row.categoria;
    const tipo = row.tipo;

    categorias.add(cat);

    if (!tipos.has(cat)) {
      tipos.set(cat, new Set<string>());
    }
    tipos.get(cat)!.add(tipo);

    const key = `${cat}/${tipo}`;
    attributesByTipo.set(key, row.attributes ?? {});
  }

  const data: TaxonomyData = { categorias, tipos, attributesByTipo };
  _cache = { data, expiresAt: now + CACHE_TTL_MS };
  return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function isValidCategoria(categoria: string): Promise<boolean> {
  const { categorias } = await loadReportTaxonomy();
  return categorias.has(categoria);
}

export async function isValidTipo(
  categoria: string,
  tipo: string,
): Promise<boolean> {
  const { tipos } = await loadReportTaxonomy();
  const tiposForCat = tipos.get(categoria);
  if (tiposForCat === undefined) return false;
  return tiposForCat.has(tipo);
}

export async function getRoutingArea(
  categoria: string,
  tipo: string,
): Promise<string | undefined> {
  const { attributesByTipo } = await loadReportTaxonomy();
  const key = `${categoria}/${tipo}`;
  const attrs = attributesByTipo.get(key);
  if (attrs === undefined) return undefined;
  const area = attrs["routing_area"];
  return typeof area === "string" ? area : undefined;
}

// Hardcoded list — no DB lookup needed.
const URGENT_TIPOS = new Set([
  "fuga_gas",
  "arbol_caido",
  "cable_vivo",
  "alumbrado_total_colonia",
]);

/**
 * Returns true when the given categoria/tipo combination is considered urgent.
 * The urgency list is hardcoded and does not depend on the taxonomy DB.
 */
export function isUrgentCategory(
  _categoria: string,
  tipo: string,
): boolean {
  return URGENT_TIPOS.has(tipo);
}
