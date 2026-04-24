/**
 * Emergency contacts lookup with 5-minute module-level cache.
 */

import { supabaseAdmin } from "@/db/supabase-server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmergencyContact {
  id: number;
  nombre: string;
  telefono: string;
  categoria: string | null;
  descripcion: string | null;
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
// Public function
// ---------------------------------------------------------------------------

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
    .select("id, nombre, telefono, categoria, descripcion, activo")
    .eq("activo", true);

  if (category !== undefined) {
    query = query.eq("categoria", category);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Error al consultar emergency_contacts: ${error.message}`);
  }

  const contacts = (data ?? []) as EmergencyContact[];

  moduleCache.set(key, { data: contacts, fetchedAt: Date.now() });

  return contacts;
}
