import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { mundialSql } from "../../db/client.js";

interface FanFestRow {
  id: number;
  nombre: string;
  ciudad: string;
  pais: string;
  ubicacion: string | null;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  horario: string | null;
  entrada_gratis: boolean | null;
  url_oficial: string | null;
  google_maps_url: string | null;
  latitud: number | null;
  longitud: number | null;
  distance_km: number | null;
}

function formatDistance(km: number): string {
  if (km < 1) return `~${Math.round(km * 1000)} m`;
  return `~${km.toFixed(1)} km`;
}

function formatDateRange(inicio: string | null, fin: string | null): string | null {
  if (!inicio && !fin) return null;
  const fmt = (s: string) => {
    const d = new Date(s + "T00:00:00Z");
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString("es-MX", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  };
  if (inicio && fin && inicio !== fin) return `${fmt(inicio)} – ${fmt(fin)}`;
  return fmt(inicio ?? fin!);
}

function buildDisplay(r: FanFestRow & { maps_url: string }): string {
  const lines: string[] = [];
  const distSuffix = r.distance_km != null ? ` (${formatDistance(r.distance_km)})` : "";
  lines.push(`**${r.nombre}** — ${r.ciudad}, ${r.pais}${distSuffix}`);
  const dateRange = formatDateRange(r.fecha_inicio, r.fecha_fin);
  if (dateRange) lines.push(`🗓 ${dateRange}`);
  if (r.horario && r.horario.trim()) lines.push(`🕒 ${r.horario.trim()}`);
  if (r.ubicacion && r.ubicacion.trim()) lines.push(`📍 ${r.ubicacion.trim()}`);
  if (r.entrada_gratis === true) lines.push(`🆓 Entrada gratis`);
  lines.push(`🗺 [Ver en Google Maps](${r.maps_url})`);
  if (r.url_oficial && r.url_oficial.trim()) lines.push(`🔗 [Sitio oficial](${r.url_oficial.trim()})`);
  return lines.join("\n");
}

export const findFanFest = createTool({
  id: "findFanFest",
  description:
    "Busca FIFA Fan Festivals del Mundial 2026. Úsala para preguntas sobre Fan Fests por ciudad, país, o el más cercano a la ubicación del usuario. Devuelve un campo `display` con el bloque markdown listo (nombre, ciudad/país, fechas, horario, entrada, link de Maps y distancia si aplica).",
  inputSchema: z.object({
    ciudad: z.string().optional().describe("Filtra por ciudad. Ej: 'Guadalajara', 'Toronto'."),
    pais: z
      .string()
      .optional()
      .describe("Filtra por país. Acepta variantes EN/ES: 'Canada'/'Canadá', etc."),
    userLat: z.number().optional(),
    userLng: z.number().optional(),
    limit: z.number().int().min(1).max(14).optional().describe("Default 1."),
  }),
  outputSchema: z.object({
    rowCount: z.number(),
    hasUserLocation: z.boolean(),
    rows: z.array(
      z.object({
        id: z.number(),
        nombre: z.string(),
        ciudad: z.string(),
        pais: z.string(),
        ubicacion: z.string().nullable(),
        fecha_inicio: z.string().nullable(),
        fecha_fin: z.string().nullable(),
        horario: z.string().nullable(),
        entrada_gratis: z.boolean().nullable(),
        url_oficial: z.string().nullable(),
        google_maps_url: z.string().nullable(),
        latitud: z.number().nullable(),
        longitud: z.number().nullable(),
        distance_km: z.number().nullable(),
        maps_url: z.string(),
        display: z.string(),
      })
    ),
    error: z.string().optional(),
  }),
  execute: async ({
    ciudad,
    pais,
    userLat,
    userLng,
    limit,
  }: {
    ciudad?: string;
    pais?: string;
    userLat?: number;
    userLng?: number;
    limit?: number;
  }) => {
    const n = limit ?? 1;
    const hasLoc = typeof userLat === "number" && typeof userLng === "number";
    const sql = mundialSql;

    const paisNorm = pais
      ?.trim()
      .toLowerCase()
      .replace(/^canada$/i, "canad")
      .replace(/^canadá$/i, "canad")
      .replace(/^mexico$/i, "m_xico")
      .replace(/^méxico$/i, "m_xico")
      .replace(/^(usa|estados unidos|united states|eua|eeuu)$/i, "estados");

    try {
      const rows = await sql<FanFestRow[]>`
        SELECT
          id, nombre, ciudad, pais, ubicacion, fecha_inicio, fecha_fin,
          horario, entrada_gratis, url_oficial, google_maps_url,
          latitud, longitud,
          CASE WHEN ${hasLoc}::bool AND latitud IS NOT NULL AND longitud IS NOT NULL THEN
            (6371 * acos(
              cos(radians(${userLat ?? 0})) * cos(radians(latitud)) *
              cos(radians(longitud) - radians(${userLng ?? 0})) +
              sin(radians(${userLat ?? 0})) * sin(radians(latitud))
            ))::float
          ELSE NULL END AS distance_km
        FROM "mundial-fifa".fan_fest
        WHERE (${ciudad ?? null}::text IS NULL
               OR lower(ciudad) LIKE lower('%' || ${ciudad ?? ""} || '%'))
          AND (${paisNorm ?? null}::text IS NULL
               OR lower(pais) LIKE ('%' || ${paisNorm ?? ""} || '%'))
        ORDER BY
          CASE WHEN ${hasLoc}::bool AND latitud IS NOT NULL THEN
            (6371 * acos(
              cos(radians(${userLat ?? 0})) * cos(radians(latitud)) *
              cos(radians(longitud) - radians(${userLng ?? 0})) +
              sin(radians(${userLat ?? 0})) * sin(radians(latitud))
            ))
          ELSE NULL END ASC NULLS LAST,
          nombre ASC
        LIMIT ${n}
      `;

      const out = {
        rowCount: rows.length,
        hasUserLocation: hasLoc,
        rows: rows.map((r) => {
          const distance_km =
            r.distance_km == null ? null : Math.round(r.distance_km * 10) / 10;
          const maps_url =
            r.google_maps_url ??
            (r.latitud != null && r.longitud != null
              ? `https://www.google.com/maps/search/?api=1&query=${r.latitud},${r.longitud}`
              : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.nombre)}`);
          const enriched = { ...r, id: Number(r.id), distance_km, maps_url };
          return { ...enriched, display: buildDisplay(enriched) };
        }),
      };
      console.log("[findFanFest] returning:", JSON.stringify(out, null, 2));
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[findFanFest] fallo:", message);
      return { rowCount: 0, hasUserLocation: hasLoc, rows: [], error: message };
    }
  },
});
