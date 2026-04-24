/**
 * Folio creation — wraps the Supabase RPC `crear_lead`.
 *
 * IMPORTANT: This module NEVER generates or constructs a folio string in
 * TypeScript.  Folio generation is done atomically inside the Postgres
 * function.  We only consume what the RPC returns and validate the shape.
 */

import { supabaseAdmin } from "@/db/supabase-server";
import { FolioSchema } from "@/validation/zod-schemas";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CrearLeadArgs {
  p_user_id: string;
  p_categoria: string;
  p_tipo: string;
  p_descripcion: string;
  /** null when the user provided a free-form address instead of coordinates */
  p_lat: number | null;
  /** null when the user provided a free-form address instead of coordinates */
  p_lng: number | null;
  p_colonia: string | null;
  /** Array of photo URLs (empty array if none) */
  p_image_urls: string[];
  /** 0 = critical, 1 = high, 2 = normal (default), 3 = low, 4 = minimal */
  p_priority?: number;
  p_assigned_to_area?: string | null;
  p_extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type CrearLeadResult =
  | { ok: true; folio: string; lead_id: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// RPC response row type
// ---------------------------------------------------------------------------

interface RpcRow {
  folio: unknown;
  lead_id: unknown;
}

// ---------------------------------------------------------------------------
// callCrearLead
// ---------------------------------------------------------------------------

/**
 * Calls the Supabase RPC `crear_lead` and returns the folio + lead_id on
 * success, or an error object on failure.
 *
 * The folio is validated against FolioSchema (CUH-YYYYMMDD-NNN) before
 * being returned.  If the shape is unexpected the function returns an error.
 */
export async function callCrearLead(args: CrearLeadArgs): Promise<CrearLeadResult> {
  try {
    const { data, error } = await supabaseAdmin.rpc("crear_lead", {
      p_user_id: args.p_user_id,
      p_categoria: args.p_categoria,
      p_tipo: args.p_tipo,
      p_descripcion: args.p_descripcion,
      p_lat: args.p_lat,
      p_lng: args.p_lng,
      p_colonia: args.p_colonia,
      p_image_urls: args.p_image_urls,
      p_priority: args.p_priority ?? 2,
      p_assigned_to_area: args.p_assigned_to_area ?? null,
      p_extra: args.p_extra ?? {},
    });

    if (error) {
      return { ok: false, error: error.message };
    }

    // `crear_lead` returns a TABLE — Supabase JS surfaces it as an array.
    if (!Array.isArray(data) || data.length === 0) {
      return {
        ok: false,
        error: "La función crear_lead no devolvió ninguna fila.",
      };
    }

    const row = data[0] as RpcRow;

    // Validate folio format
    const folioResult = FolioSchema.safeParse(row.folio);
    if (!folioResult.success) {
      return {
        ok: false,
        error: `Folio recibido con formato inesperado: ${String(row.folio)}`,
      };
    }

    // Validate lead_id
    const leadId = row.lead_id;
    if (typeof leadId !== "string" || leadId.length === 0) {
      return {
        ok: false,
        error: `lead_id recibido con formato inesperado: ${String(leadId)}`,
      };
    }

    return {
      ok: true,
      folio: folioResult.data,
      lead_id: leadId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
