/**
 * tools.ts — Mastra tools for the Puntos Violeta domain.
 *
 * Exports 2 tools (spec section 4.2):
 *   1. puntos_violeta_buscar
 *   2. puntos_violeta_detalle
 *
 * Each tool returns { ok: true, data } | { ok: false, error }.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { fetchPuntosVioleta, fetchPuntoDetalle } from "./queries";

// ---------------------------------------------------------------------------
// 1. puntos_violeta_buscar
// ---------------------------------------------------------------------------

export const puntosVioletaBuscar = createTool({
  id: "puntos_violeta_buscar",
  description:
    "Busca Puntos Violeta de la Alcaldía Cuauhtémoc. SIEMPRE invoca esta tool cuando el usuario mencione " +
    '"punto violeta", "ayuda mujer", "emergencia género" o equivalente — NO pidas información adicional antes de invocar. ' +
    "La tool acepta búsqueda sin filtros (devuelve los más relevantes) o con filtros opcionales (lat/lng, colonia, abierto_ahora).",
  inputSchema: z.object({
    lat: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe("Opcional. Latitud decimal del usuario para ordenar por distancia. Si no la tienes, omítela — la tool igual devuelve resultados. Ej: 19.4326."),
    lng: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe("Opcional. Longitud decimal del usuario para ordenar por distancia. Si no la tienes, omítela — la tool igual devuelve resultados. Ej: -99.1332."),
    radio_km: z
      .number()
      .positive()
      .optional()
      .describe(
        "Radio de búsqueda en kilómetros (requiere lat/lng). Default: 5 km.",
      ),
    colonia: z
      .string()
      .optional()
      .describe("Opcional. Si el usuario menciona una colonia explícita (Roma Norte, Doctores, Centro, Juárez, Condesa) pásala. Si no, omítela."),
    tipo_atencion: z
      .string()
      .optional()
      .describe(
        "Tipo de atención que ofrece el punto. Ej: 'jurídica', 'psicológica', 'refugio'.",
      ),
    abierto_ahora: z
      .boolean()
      .optional()
      .describe(
        'Opcional. Pásalo true cuando el usuario pida atención "24 horas", "ahorita", "de noche", "now", o equivalente.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Número máximo de resultados (default 10, max 50)."),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: z.array(
        z.object({
          id: z.number(),
          nombre: z.string().nullable(),
          direccion: z.string().nullable(),
          colonia: z.string().nullable(),
          lat: z.number().nullable(),
          lng: z.number().nullable(),
          telefono: z.string().nullable(),
          horario: z.string().nullable(),
          tipo_atencion: z.string().nullable(),
          atencion_24_7: z.boolean(),
          distance_km: z.number().optional(),
          maps_url: z.string().optional(),
          _horario_unknown: z.boolean().optional(),
        }),
      ),
      total: z.number(),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
  execute: async ({
    lat,
    lng,
    radio_km,
    colonia,
    tipo_atencion,
    abierto_ahora,
    limit,
  }: {
    lat?: number;
    lng?: number;
    radio_km?: number;
    colonia?: string;
    tipo_atencion?: string;
    abierto_ahora?: boolean;
    limit?: number;
  }) => {
    const { data, error } = await fetchPuntosVioleta({
      lat,
      lng,
      radio_km,
      colonia,
      tipo_atencion,
      abierto_ahora,
      limit,
    });

    if (error) {
      return { ok: false as const, error };
    }

    const rows = data.map((row) => ({
      id: row.id,
      nombre: row.nombre,
      direccion: row.direccion,
      colonia: row.colonia,
      lat: row.lat,
      lng: row.lng,
      telefono: row.telefono,
      horario: row.horario,
      tipo_atencion: row.tipo_atencion,
      atencion_24_7: row.atencion_24_7,
      distance_km: row.distance_km,
      maps_url: row.maps_url,
      _horario_unknown: row._horario_unknown,
    }));

    return { ok: true as const, data: rows, total: rows.length };
  },
});

// ---------------------------------------------------------------------------
// 2. puntos_violeta_detalle
// ---------------------------------------------------------------------------

export const puntosVioletaDetalle = createTool({
  id: "puntos_violeta_detalle",
  description:
    "Devuelve la información completa de un Punto Violeta específico dado su ID: " +
    "nombre, dirección completa, colonia, coordenadas, teléfono, horario, tipo de atención. " +
    "Úsala después de puntos_violeta_buscar para obtener el detalle completo de un resultado.",
  inputSchema: z.object({
    id: z.number().int().positive().describe("ID numérico devuelto por puntos_violeta_buscar. Solo usa esta tool si el usuario pide más detalles de un punto específico ya mostrado."),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: z.object({
        id: z.number(),
        nombre: z.string().nullable(),
        direccion: z.string().nullable(),
        street: z.string().nullable(),
        exterior_number: z.string().nullable(),
        colonia: z.string().nullable(),
        postal_code: z.string().nullable(),
        lat: z.number().nullable(),
        lng: z.number().nullable(),
        telefono: z.string().nullable(),
        horario: z.string().nullable(),
        tipo_atencion: z.string().nullable(),
        atencion_24_7: z.boolean(),
      }),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
  execute: async ({ id }: { id: number }) => {
    const { data, error } = await fetchPuntoDetalle(id);

    if (error) return { ok: false as const, error };
    if (!data) return { ok: false as const, error: `Punto Violeta con ID ${id} no encontrado` };

    return {
      ok: true as const,
      data: {
        id: data.id,
        nombre: data.nombre,
        direccion: data.direccion,
        street: data.street,
        exterior_number: data.exterior_number,
        colonia: data.colonia,
        postal_code: data.postal_code,
        lat: data.lat,
        lng: data.lng,
        telefono: data.telefono,
        horario: data.horario,
        tipo_atencion: data.tipo_atencion,
        atencion_24_7: data.atencion_24_7,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Re-export all tools as a named group for easy registration in orchestrator
// ---------------------------------------------------------------------------

export const puntosVioletaTools = {
  puntosVioletaBuscar,
  puntosVioletaDetalle,
} as const;
