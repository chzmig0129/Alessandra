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
// Input types — parameter names match the SQL function's p_* params
// ---------------------------------------------------------------------------

export interface CrearLeadArgs {
  conversation_id: string;
  user_id: string;
  category: string;
  report_type: string | null;
  report: string;
  /** null when the user provided a free-form address instead of coordinates */
  lat: number | null;
  /** null when the user provided a free-form address instead of coordinates */
  lng: number | null;
  location_address: string | null;
  /** Array of photo URLs (empty array if none) */
  media_urls: string[];
  /** 0 = critical, 1 = high, 2 = normal (default), 3 = low, 4 = minimal */
  priority: number;
  severity?: string;
  tags?: string[];
  incident_subtype?: string;
  ai_analysis?: object;
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
      p_conversation_id: args.conversation_id,
      p_user_id: args.user_id,
      p_category: args.category,
      p_report_type: args.report_type,
      p_report: args.report,
      p_lat: args.lat,
      p_lng: args.lng,
      p_location_address: args.location_address,
      p_media_urls: args.media_urls,
      p_priority: args.priority,
      p_severity: args.severity ?? null,
      p_tags: args.tags ?? [],
      p_incident_subtype: args.incident_subtype ?? null,
      p_ai_analysis: args.ai_analysis ?? null,
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
