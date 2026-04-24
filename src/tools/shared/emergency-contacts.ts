/**
 * Emergency contacts lookup with 5-minute module-level cache.
 *
 * Real table columns (2026-04-24 schema audit):
 *   id, number, name, category, description, available_24_7,
 *   coverage_area, website, whatsapp, priority, active
 *
 * Query: SELECT WHERE active=true AND (category=? OR ? IS NULL) ORDER BY priority
 * Return shape: id, name, number, description, available_24_7, whatsapp
 *
 * Backward-compat aliases are included so existing callers (orchestrator,
 * reportes/tools) continue to compile while the DB rename migration is applied.
 * TODO: remove deprecated aliases once orchestrator and reportes/tools are
 * updated to use real column names.
 */

import { supabaseAdmin } from "@/db/supabase-server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmergencyContact {
  id: number;
  /** Contact name — real DB col: "name". */
  name: string;
  /** Phone number — real DB col: "number". */
  number: string;
  category: string | null;
  description: string | null;
  available_24_7: boolean;
  whatsapp: string | null;
  /** @deprecated Use `name` — kept for backward compat during DB migration. */
  nombre: string;
  /** @deprecated Use `number` — kept for backward compat during DB migration. */
  telefono: string;
  /** @deprecated Use `category` — kept for backward compat during DB migration. */
  categoria: string | null;
  /** @deprecated Use `description` — kept for backward compat during DB migration. */
  descripcion: string | null;
  /** @deprecated Use available implicitly (record is active since we filter active=true). */
  activo: boolean;
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: EmergencyContact[];
  fetchedAt: number;
}

const moduleCache = new Map<string, CacheEntry>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(category: string | undefined): string {
  return category ?? "__all__";
}

// ---------------------------------------------------------------------------
// Raw DB row shape
// ---------------------------------------------------------------------------

interface RawRow {
  id: number;
  number: string;
  name: string;
  category: string | null;
  description: string | null;
  available_24_7: boolean;
  whatsapp: string | null;
  priority: number | null;
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

/**
 * Returns active emergency contacts, optionally filtered by category.
 * Results are ordered by priority (ascending = highest priority first).
 * Cached for 5 minutes per category key.
 *
 * @example
 *   lookupEmergencyContacts('mujer') // contacts for gender emergencies
 *   lookupEmergencyContacts()        // all active contacts
 */
export async function lookupEmergencyContacts(
  category?: string,
): Promise<EmergencyContact[]> {
  const key = cacheKey(category);
  const cached = moduleCache.get(key);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  let query = supabaseAdmin
    .from("emergency_contacts")
    .select("id, number, name, category, description, available_24_7, whatsapp, priority")
    .eq("active", true)
    .order("priority", { ascending: true });

  if (category !== undefined) {
    query = query.eq("category", category);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Error al consultar emergency_contacts: ${error.message}`);
  }

  // Map raw rows to EmergencyContact, populating real cols and deprecated aliases.
  const contacts: EmergencyContact[] = ((data ?? []) as RawRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    number: row.number,
    category: row.category,
    description: row.description,
    available_24_7: row.available_24_7,
    whatsapp: row.whatsapp,
    // Deprecated backward-compat aliases
    nombre: row.name,
    telefono: row.number,
    categoria: row.category,
    descripcion: row.description,
    activo: true, // always true — we filter active=true in query
  }));

  moduleCache.set(key, { data: contacts, fetchedAt: Date.now() });

  return contacts;
}
