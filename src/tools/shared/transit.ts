/**
 * Transit directions stub — GTFS integration pending phase 2.
 */

import type { LatLng } from "@/validation/zod-schemas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransitResult {
  ok: false;
  error: string;
  hint: string;
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

export async function howToGetTo(
  _originLatLng: LatLng,
  _destLatLng: LatLng,
): Promise<TransitResult> {
  return {
    ok: false,
    error: "GTFS pendiente fase 2",
    hint: "Indicaciones genéricas: usa Metro/Metrobús más cercano",
  };
}
