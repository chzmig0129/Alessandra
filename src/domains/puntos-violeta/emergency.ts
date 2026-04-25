/**
 * emergency.ts — Emergency escalation functions for the Puntos Violeta domain.
 *
 * emergencia_mujer_canalizar is a plain async function (NOT a Mastra tool)
 * invoked directly by the pre-LLM guardrail when a gender emergency is detected.
 * It is intentionally NOT wrapped in createTool to ensure zero LLM latency on
 * the critical path.
 *
 * emergencia_mujer_tool is the Mastra-wrapped version for cases where the LLM
 * needs to call it explicitly (e.g. the user asks for emergency resources).
 *
 * Column contract (v_puntos_violeta per F1 view rewrite, 2026-04-24):
 *   id, nombre, direccion, colonia, alcaldia, lat, lng, telefono,
 *   horario, tipo_atencion, atencion_24_7, geocode_precision
 *
 * emergency_contacts real cols (2026-04-24):
 *   id, number, name, category, description, available_24_7,
 *   coverage_area, website, whatsapp, priority, active
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { supabaseAdmin } from "@/db/supabase-server";
import {
  lookupEmergencyContacts,
  type EmergencyContact,
} from "@/tools/shared/emergency-contacts";
import type { LatLng } from "@/validation/zod-schemas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PuntoVioleta24_7 {
  id: number;
  nombre: string | null;
  direccion: string | null;
  colonia: string | null;
  /** Alcaldía — added in F1 view rewrite. */
  alcaldia: string | null;
  lat: number | null;
  lng: number | null;
  telefono: string | null;
  distance_km?: number;
}

export interface EmergenciaMujerResult {
  puntos_violeta_24_7: PuntoVioleta24_7[];
  contactos: EmergencyContact[];
  telefonos_clave: string[];
}

// ---------------------------------------------------------------------------
// Haversine (local, no cross-module dep for hot path)
// ---------------------------------------------------------------------------

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
// Public plain async function — called by guardrails (NOT via LLM)
// ---------------------------------------------------------------------------

const TELEFONOS_CLAVE: string[] = [
  "*765 LUNAS",
  "911",
  "55 5658-1111 LOCATEL",
];

/**
 * Returns top-3 24/7 Puntos Violeta (ordered by distance if lat/lng provided),
 * emergency contacts for category "mujer", and the hardcoded key phone numbers.
 *
 * This function runs on the critical pre-LLM path — keep it fast.
 * Throws on Supabase errors so the caller can handle gracefully.
 *
 * Uses v_puntos_violeta WHERE atencion_24_7=true ORDER BY haversine LIMIT 3.
 */
export async function emergencia_mujer_canalizar(
  params: Partial<LatLng> = {},
): Promise<EmergenciaMujerResult> {
  const hasLocation =
    typeof params.lat === "number" && typeof params.lng === "number";

  // Fetch all 24/7 puntos violeta using the view's pre-computed atencion_24_7 column.
  // Select only the columns needed (matches F1 view rewrite column names).
  const { data: raw, error } = await supabaseAdmin
    .from("v_puntos_violeta")
    .select(
      "id, nombre, direccion, colonia, alcaldia, lat, lng, telefono, atencion_24_7",
    )
    .eq("atencion_24_7", true);

  if (error) {
    throw new Error(
      `emergencia_mujer_canalizar: error al consultar v_puntos_violeta: ${error.message}`,
    );
  }

  const puntos = (raw ?? []) as Array<{
    id: number;
    nombre: string | null;
    direccion: string | null;
    colonia: string | null;
    alcaldia: string | null;
    lat: number | null;
    lng: number | null;
    telefono: string | null;
    atencion_24_7: boolean;
  }>;

  // Sort by haversine distance if location is available
  let puntosWithDistance: PuntoVioleta24_7[];

  if (hasLocation && params.lat !== undefined && params.lng !== undefined) {
    const origin = { lat: params.lat, lng: params.lng };
    puntosWithDistance = puntos
      .map((p) => ({
        id: p.id,
        nombre: p.nombre,
        direccion: p.direccion,
        colonia: p.colonia,
        alcaldia: p.alcaldia,
        lat: p.lat,
        lng: p.lng,
        telefono: p.telefono,
        distance_km:
          p.lat !== null && p.lng !== null
            ? haversineKm(origin, { lat: p.lat, lng: p.lng })
            : undefined,
      }))
      .sort(
        (a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity),
      );
  } else {
    puntosWithDistance = puntos.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      direccion: p.direccion,
      colonia: p.colonia,
      alcaldia: p.alcaldia,
      lat: p.lat,
      lng: p.lng,
      telefono: p.telefono,
    }));
  }

  const top3 = puntosWithDistance.slice(0, 3);

  // Fetch emergency contacts for "mujer" category via lookupEmergencyContacts.
  // EmergencyContact type now matches real cols (name, number, available_24_7, whatsapp).
  const contactos = await lookupEmergencyContacts("mujer");

  return {
    puntos_violeta_24_7: top3,
    contactos,
    telefonos_clave: TELEFONOS_CLAVE,
  };
}

// ---------------------------------------------------------------------------
// Mastra tool wrapper — for explicit LLM-callable access
// ---------------------------------------------------------------------------

export const emergencia_mujer_tool = createTool({
  id: "emergencia_mujer_canalizar",
  description:
    "Activa el protocolo de emergencia para situaciones de violencia de género. " +
    "Devuelve los 3 Puntos Violeta 24/7 más cercanos (si se proporcionan coordenadas), " +
    "los contactos de emergencia para mujeres, y los teléfonos clave (*765 LUNAS, 911, LOCATEL). " +
    "Úsala SIEMPRE que la usuaria exprese una situación de violencia, miedo o emergencia.",
  inputSchema: z.object({
    lat: z.coerce
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe("Latitud del usuario para ordenar puntos violeta por distancia."),
    lng: z.coerce
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe("Longitud del usuario para ordenar puntos violeta por distancia."),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: z.object({
        puntos_violeta_24_7: z.array(
          z.object({
            id: z.number(),
            nombre: z.string().nullable(),
            direccion: z.string().nullable(),
            colonia: z.string().nullable(),
            alcaldia: z.string().nullable(),
            lat: z.number().nullable(),
            lng: z.number().nullable(),
            telefono: z.string().nullable(),
            distance_km: z.number().optional(),
          }),
        ),
        contactos: z.array(
          z.object({
            id: z.number(),
            name: z.string(),
            number: z.string(),
            category: z.string().nullable(),
            description: z.string().nullable(),
            available_24_7: z.boolean(),
            whatsapp: z.string().nullable(),
          }),
        ),
        telefonos_clave: z.array(z.string()),
      }),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
  execute: async ({ lat, lng }: { lat?: number; lng?: number }) => {
    try {
      const result = await emergencia_mujer_canalizar({ lat, lng });
      return { ok: true as const, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  },
});
