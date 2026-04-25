/**
 * Report taxonomy loader — COMPLETE REWRITE for tree-shaped schema.
 *
 * Schema (2026-04-24):
 *   report_taxonomy(slug, parent_slug, kind, name, attributes, active)
 *   - kind='category': parent_slug IS NULL — top-level categories
 *   - kind='type':     parent_slug = category slug — subtypes
 *   - attributes jsonb has: routing_area, keywords[], report_channel
 *
 * Module-level cache: TTL = 5 minutes.
 */

import { supabaseAdmin } from "@/db/supabase-server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaxonomyRow {
  slug: string;
  parent_slug: string | null;
  kind: string;
  name: string;
  attributes: Record<string, unknown> | null;
}

/** Type info stored under tipos map. */
export interface TipoInfo {
  name: string;
  attributes: Record<string, unknown>;
}

export interface TaxonomyData {
  /** Set of category slugs (kind='category', parent_slug IS NULL). */
  categorias: Set<string>;
  /**
   * Maps category slug → Map<type slug, TipoInfo>.
   * (Previously: Map<categoria, Set<tipo>> — now carries attributes inline.)
   */
  tipos: Map<string, Map<string, TipoInfo>>;
}

// ---------------------------------------------------------------------------
// Module-level cache (TTL = 5 minutes)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;

let _cache: { data: TaxonomyData; expiresAt: number } | null = null;

function emptyTaxonomy(): TaxonomyData {
  return {
    categorias: new Set<string>(),
    tipos: new Map<string, Map<string, TipoInfo>>(),
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
      .select("slug, parent_slug, kind, name, attributes")
      .eq("active", true);

    if (error) {
      console.warn("[taxonomy] Error fetching report_taxonomy:", error.message);
      const empty = emptyTaxonomy();
      // Cache briefly (1 min) so we don't hammer Supabase on errors.
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
  const tipos = new Map<string, Map<string, TipoInfo>>();

  // First pass: collect categories (kind='category', parent_slug IS NULL)
  for (const row of rows) {
    if (row.kind === "category" && row.parent_slug === null) {
      categorias.add(row.slug);
    }
  }

  // Second pass: collect types (kind='type', parent_slug = category slug)
  for (const row of rows) {
    if (row.kind === "type" && row.parent_slug !== null) {
      const catSlug = row.parent_slug;
      if (!tipos.has(catSlug)) {
        tipos.set(catSlug, new Map<string, TipoInfo>());
      }
      tipos.get(catSlug)!.set(row.slug, {
        name: row.name,
        attributes: row.attributes ?? {},
      });
    }
  }

  const result: TaxonomyData = { categorias, tipos };
  _cache = { data: result, expiresAt: now + CACHE_TTL_MS };
  return result;
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

export async function getTiposForCategoria(categoria: string): Promise<string[]> {
  const { tipos } = await loadReportTaxonomy();
  const map = tipos.get(categoria);
  return map ? Array.from(map.keys()) : [];
}

export async function getRoutingArea(
  categoria: string,
  tipo: string,
): Promise<string | undefined> {
  const { tipos } = await loadReportTaxonomy();
  const tipoInfo = tipos.get(categoria)?.get(tipo);
  if (tipoInfo === undefined) return undefined;
  const area = tipoInfo.attributes["routing_area"];
  return typeof area === "string" ? area : undefined;
}

// ---------------------------------------------------------------------------
// Urgent categories (hardcoded — no DB lookup needed)
// Slugs updated per 2026-04-24 taxonomy audit.
// 'fuga_gas' omitted: taxonomy has 'infraestructura_fuga_agua' but no fuga_gas
// type — if user describes gas leak, it maps to the 'emergencias' category.
// Any slug under category 'emergencias' is also treated as urgent.
// ---------------------------------------------------------------------------

const URGENT_TIPO_SLUGS = new Set([
  "infraestructura_fuga_agua", // water leak
  "arbolado_derribo",           // fallen/dangerous tree
]);

/**
 * Returns true when the given categoria/tipo combination is considered urgent.
 * Urgency is determined by:
 * 1. categoria === 'emergencias' (any type under this category)
 * 2. tipo slug is in the hardcoded URGENT_TIPO_SLUGS set
 */
export function isUrgentCategory(
  categoria: string,
  tipo: string,
): boolean {
  if (categoria === "emergencias") return true;
  return URGENT_TIPO_SLUGS.has(tipo);
}

// ---------------------------------------------------------------------------
// findTipoByKeywords — optional helper for keyword-based type inference
// ---------------------------------------------------------------------------

/**
 * Given a category slug and a free-text user string, iterates the types
 * under that category and returns the first type slug whose
 * attributes.keywords[] contains any token that matches userText
 * (case and accent insensitive).
 *
 * Returns null if no match is found or the category does not exist.
 *
 * @example
 *   // taxonomy has category 'infraestructura', type 'fuga_agua'
 *   // with attributes.keywords = ['fuga', 'agua', 'goteo']
 *   findTipoByKeywords('infraestructura', 'hay una fuga de agua en mi calle')
 *   // → 'fuga_agua'
 */
export async function findTipoByKeywords(
  catSlug: string,
  userText: string,
): Promise<string | null> {
  const { tipos } = await loadReportTaxonomy();
  const tiposForCat = tipos.get(catSlug);
  if (!tiposForCat) return null;

  // Normalize the user text once: lower, remove diacritics, split into tokens
  const normalizedText = userText
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

  for (const [tipoSlug, tipoInfo] of tiposForCat.entries()) {
    const keywords = tipoInfo.attributes["keywords"];
    if (!Array.isArray(keywords)) continue;

    for (const kw of keywords) {
      if (typeof kw !== "string") continue;
      const normalizedKw = kw
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "");
      if (normalizedText.includes(normalizedKw)) {
        return tipoSlug;
      }
    }
  }

  return null;
}
