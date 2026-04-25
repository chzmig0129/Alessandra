import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { alessandraSql } from "../../db/client.js";

// Default cuando no hay ubicación del usuario aún (centro Cuauhtémoc, límite Roma/Condesa).
export const USER_LAT_DEFAULT = 19.42;
export const USER_LNG_DEFAULT = -99.16;


interface PuntoRow {
  id: number;
  name: string;
  street: string | null;
  exterior_number: string | null;
  neighborhood: string | null;
  postal_code: string | null;
  phone: string | null;
  hours: string | null;
  lat: number;
  lng: number;
  geocode_precision: string | null;
  distance_km: number;
}

function isMeaningful(s: string | null | undefined): boolean {
  if (!s) return false;
  const t = s.trim().toLowerCase();
  if (!t) return false;
  return !["no tiene", "n/a", "na", "sin dato", "ninguno", "-", "--"].includes(t);
}

function formatDistance(km: number): string {
  if (km < 0.1) return "a pasos";
  if (km < 1) return `~${Math.round(km * 1000)} m`;
  return `~${km.toFixed(1)} km`;
}

function buildDisplay(r: PuntoRow & { maps_url: string; isDefaultLoc: boolean }): string {
  const lines: string[] = [];
  lines.push(`**${r.name}**`);

  const street = isMeaningful(r.street) ? r.street!.trim() : "";
  const ext = isMeaningful(r.exterior_number) ? ` ${r.exterior_number!.trim()}` : "";
  const colonia = isMeaningful(r.neighborhood) ? `Col. ${r.neighborhood!.trim()}` : "";
  const cp = isMeaningful(r.postal_code) ? `C.P. ${r.postal_code!.trim()}` : "";
  const addrParts = [`${street}${ext}`.trim(), colonia, cp].filter(Boolean);
  const addr = addrParts.join(", ");
  const distSuffix = r.isDefaultLoc ? "" : ` (${formatDistance(r.distance_km)})`;
  if (addr) lines.push(`📍 ${addr}${distSuffix}`);

  if (isMeaningful(r.phone)) lines.push(`📞 ${r.phone!.trim()}`);
  if (isMeaningful(r.hours)) lines.push(`🕒 ${r.hours!.trim()}`);
  lines.push(`🗺 [Ver en Google Maps](${r.maps_url})`);
  if (r.geocode_precision === "colonia") {
    lines.push(`_(ubicación aproximada al centro de la colonia)_`);
  }
  return lines.join("\n");
}

export const findPuntoVioleta = createTool({
  id: "findPuntoVioleta",
  description:
    "Encuentra el o los Puntos Violeta MÁS CERCANOS a la ubicación del usuario. Para conteos o consultas más generales, usa queryAlessandra en su lugar.",
  inputSchema: z.object({
    userLat: z.number().optional().describe("Latitud del usuario en decimal."),
    userLng: z.number().optional().describe("Longitud del usuario en decimal."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Cuántos puntos devolver (1-10). Default 1."),
    neighborhood: z
      .string()
      .optional()
      .describe("Filtra por colonia (match parcial case-insensitive)."),
    only24h: z.boolean().optional().describe("Si true, solo puntos con horario 24h. Default false."),
  }),
  outputSchema: z.object({
    usedLocation: z.object({
      lat: z.number(),
      lng: z.number(),
      isDefault: z.boolean(),
    }),
    rowCount: z.number(),
    rows: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        street: z.string().nullable(),
        exterior_number: z.string().nullable(),
        neighborhood: z.string().nullable(),
        postal_code: z.string().nullable(),
        phone: z.string().nullable(),
        hours: z.string().nullable(),
        lat: z.number(),
        lng: z.number(),
        geocode_precision: z.string().nullable(),
        distance_km: z.number(),
        maps_url: z.string(),
        display: z.string(),
      })
    ),
    error: z.string().optional(),
  }),
  execute: async ({
    userLat,
    userLng,
    limit,
    neighborhood,
    only24h,
  }: {
    userLat?: number;
    userLng?: number;
    limit?: number;
    neighborhood?: string;
    only24h?: boolean;
  }) => {
    const lat = userLat ?? USER_LAT_DEFAULT;
    const lng = userLng ?? USER_LNG_DEFAULT;
    const isDefault = userLat === undefined || userLng === undefined;
    const n = limit ?? 1;
    const sql = alessandraSql();
    console.log(
      `[findPuntoVioleta] received userLat=${userLat} userLng=${userLng} → using lat=${lat} lng=${lng} isDefault=${isDefault} neighborhood=${neighborhood} only24h=${only24h} limit=${n}`
    );

    try {
      const rows = await sql<PuntoRow[]>`
        SELECT
          id, name, street, exterior_number, neighborhood, postal_code,
          phone, hours, lat, lng, geocode_precision,
          (6371 * acos(
            cos(radians(${lat})) * cos(radians(lat)) *
            cos(radians(lng) - radians(${lng})) +
            sin(radians(${lat})) * sin(radians(lat))
          ))::float AS distance_km
        FROM puntos_violeta
        WHERE active = true
          AND lat IS NOT NULL
          AND lng IS NOT NULL
          AND (${neighborhood ?? null}::text IS NULL
               OR lower(neighborhood) LIKE lower('%' || ${neighborhood ?? ""} || '%'))
          AND (${only24h ?? false}::bool = false
               OR lower(coalesce(hours, '')) LIKE '%24%'
               OR lower(coalesce(hours, '')) LIKE '%horas%')
        ORDER BY distance_km ASC
        LIMIT ${n}
      `;

      const out = {
        usedLocation: { lat, lng, isDefault },
        rowCount: rows.length,
        rows: rows.map((r) => {
          const distance_km = Math.round(r.distance_km * 100) / 100;
          const maps_url = `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}`;
          const enriched = { ...r, id: Number(r.id), distance_km, maps_url };
          return {
            ...enriched,
            display: buildDisplay({ ...enriched, isDefaultLoc: isDefault }),
          };
        }),
      };
      console.log("[findPuntoVioleta] returning rowCount:", out.rowCount, "first display:", out.rows[0]?.display?.split("\n")[0]);
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[findPuntoVioleta] fallo:", message);
      return {
        usedLocation: { lat, lng, isDefault },
        rowCount: 0,
        rows: [],
        error: `No pude consultar los Puntos Violeta: ${message}`,
      };
    }
  },
});
