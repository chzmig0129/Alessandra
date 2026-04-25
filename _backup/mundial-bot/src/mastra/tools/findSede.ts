import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { mundialSql } from "../../db/client.js";

interface SedeRow {
  id: number;
  nombre: string;
  ciudad: string;
  pais: string;
  capacidad: number | null;
  direccion: string | null;
  zona_horaria: string | null;
  google_maps_url: string | null;
  latitud: number;
  longitud: number;
  distance_km: number | null;
}

function formatDistance(km: number): string {
  if (km < 1) return `~${Math.round(km * 1000)} m`;
  return `~${km.toFixed(1)} km`;
}

function buildDisplay(r: SedeRow & { maps_url: string }): string {
  const lines: string[] = [];
  const distSuffix = r.distance_km != null ? ` (${formatDistance(r.distance_km)})` : "";
  lines.push(`**${r.nombre}** — ${r.ciudad}, ${r.pais}${distSuffix}`);
  if (r.capacidad != null) lines.push(`🏟 Capacidad ${r.capacidad.toLocaleString("es-MX")}`);
  if (r.direccion && r.direccion.trim()) lines.push(`📍 ${r.direccion.trim()}`);
  lines.push(`🗺 [Ver en Google Maps](${r.maps_url})`);
  return lines.join("\n");
}

export const findSede = createTool({
  id: "findSede",
  description:
    "Busca estadios sede del Mundial 2026. Úsala cuando el usuario pregunte por un estadio (ej. 'Estadio Azteca', 'MetLife', 'cómo llegar al Akron'), por estadios en una ciudad ('estadios en CDMX'), por país ('estadios en Canadá'), o por las sedes más cercanas a su ubicación. Devuelve un campo `display` con el bloque markdown listo (nombre, ciudad/país, capacidad, dirección, link de Maps y distancia si aplica).",
  inputSchema: z.object({
    nombre: z.string().optional().describe("Match parcial por nombre. Ej: 'azteca', 'metlife'."),
    ciudad: z.string().optional().describe("Filtra por ciudad. Ej: 'Ciudad de México', 'New York'."),
    pais: z
      .string()
      .optional()
      .describe(
        "Filtra por país (match parcial case-insensitive). Útil para 'estadios en Canadá', 'estadios en EUA'. Acepta variantes: 'Canada'/'Canadá', 'Mexico'/'México', 'USA'/'United States'/'Estados Unidos'."
      ),
    userLat: z.number().optional(),
    userLng: z.number().optional(),
    limit: z.number().int().min(1).max(16).optional().describe("Default 1."),
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
        capacidad: z.number().nullable(),
        direccion: z.string().nullable(),
        zona_horaria: z.string().nullable(),
        google_maps_url: z.string().nullable(),
        latitud: z.number(),
        longitud: z.number(),
        distance_km: z.number().nullable(),
        maps_url: z.string(),
        display: z.string(),
      })
    ),
    error: z.string().optional(),
  }),
  execute: async ({
    nombre,
    ciudad,
    pais,
    userLat,
    userLng,
    limit,
  }: {
    nombre?: string;
    ciudad?: string;
    pais?: string;
    userLat?: number;
    userLng?: number;
    limit?: number;
  }) => {
    const n = limit ?? 1;
    const hasLoc = typeof userLat === "number" && typeof userLng === "number";
    const sql = mundialSql;

    // Normaliza variantes comunes de país (sin tilde, EN/ES, alias).
    const paisNorm = pais
      ?.trim()
      .toLowerCase()
      .replace(/^canada$/i, "canad")
      .replace(/^canadá$/i, "canad")
      .replace(/^mexico$/i, "m_xico") // covers "México" via _ wildcard? simplify below
      .replace(/^méxico$/i, "m_xico")
      .replace(/^(usa|estados unidos|united states|eua|eeuu)$/i, "estados");

    try {
      const rows = await sql<SedeRow[]>`
        SELECT
          id, nombre, ciudad, pais, capacidad, direccion, zona_horaria,
          google_maps_url, latitud, longitud,
          CASE WHEN ${hasLoc}::bool AND latitud IS NOT NULL AND longitud IS NOT NULL THEN
            (6371 * acos(
              cos(radians(${userLat ?? 0})) * cos(radians(latitud)) *
              cos(radians(longitud) - radians(${userLng ?? 0})) +
              sin(radians(${userLat ?? 0})) * sin(radians(latitud))
            ))::float
          ELSE NULL END AS distance_km
        FROM "mundial-fifa".sedes
        WHERE (${nombre ?? null}::text IS NULL
               OR lower(nombre) LIKE lower('%' || ${nombre ?? ""} || '%'))
          AND (${ciudad ?? null}::text IS NULL
               OR lower(ciudad) LIKE lower('%' || ${ciudad ?? ""} || '%'))
          AND (${paisNorm ?? null}::text IS NULL
               OR lower(pais) LIKE ('%' || ${paisNorm ?? ""} || '%'))
        ORDER BY
          CASE WHEN ${hasLoc}::bool THEN
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
            `https://www.google.com/maps/search/?api=1&query=${r.latitud},${r.longitud}`;
          const enriched = { ...r, id: Number(r.id), distance_km, maps_url };
          return { ...enriched, display: buildDisplay(enriched) };
        }),
      };
      console.log(
        "[findSede] returning rowCount:",
        out.rowCount,
        "first:",
        out.rows[0]?.display?.split("\n")[0]
      );
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[findSede] fallo:", message);
      return { rowCount: 0, hasUserLocation: hasLoc, rows: [], error: message };
    }
  },
});
