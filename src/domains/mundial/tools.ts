/**
 * tools.ts — Mastra tools for the Mundial FIFA 2026 domain.
 *
 * Exports 5 tools (spec section 4.1):
 *   1. mundial_partidos_buscar
 *   2. mundial_sede_info
 *   3. mundial_fan_fest
 *   4. mundial_partido_detalle
 *   5. mundial_equipo_info
 *
 * Each tool:
 *   - Has a zod inputSchema
 *   - Calls functions from queries.ts
 *   - Returns { ok: true, data } | { ok: false, error: string }
 *   - NEVER infers team names — uses equipo_a_desc / equipo_b_desc literally
 *     when equipo_a_codigo / equipo_b_codigo is null.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  fetchPartidos,
  fetchSedeInfo,
  fetchFanFest,
  fetchPartidoDetalle,
  fetchEquipo,
  fetchSedeById,
  fetchFanFestById,
} from "./queries";
import { haversineKm, googleMapsDirectionsUrl } from "@/lib/geo";
import {
  partidoToReadable,
  partidoToDisplay,
  sedeToDisplay,
  fanFestToDisplay,
  equipoToDisplay,
  eventoToReadable,
  alineacionToReadable,
} from "./formatters";

// ---------------------------------------------------------------------------
// 1. mundial_partidos_buscar
// ---------------------------------------------------------------------------

export const mundialPartidosBuscar = createTool({
  id: "mundial_partidos_buscar",
  description:
    "Búsqueda flexible de partidos. Si el usuario pregunta cuándo juega un equipo SIN mencionar día específico, usa solo el filtro equipo (NO añadas fecha). " +
    "Si pregunta por una ciudad, usa solo ciudad. Si pregunta por una fase/grupo, usa solo eso. " +
    "SOLO combina filtros si el usuario los pide explícitamente.",
  inputSchema: z.object({
    fecha: z
      .string()
      .optional()
      .describe(
        "Fecha en formato YYYY-MM-DD (hora Mexico). Ej: '2026-06-11'. " +
        "IMPORTANTE: NO combines fecha con equipo a menos que el usuario haya pedido un día específico " +
        "(ej: \"qué juega México el 15 de junio\"). Si el usuario solo dice \"cuándo juega México\", usa solo equipo:\"MEX\" sin fecha.",
      ),
    equipo: z
      .string()
      .optional()
      .describe(
        "Código FIFA de 3 letras en MAYÚSCULAS. Ej: MEX, USA, CAN, ARG, BRA, GER, ESP, FRA, GBR, ITA, NED, POR, BEL, URU, COL. " +
        "NO uses nombres como Mexico/México — solo códigos de 3 letras.",
      ),
    ciudad: z
      .string()
      .optional()
      .describe(
        "Ciudad donde se juega, exactamente como aparece en la BD. Acepta solo el nombre del MUNICIPIO real, NO el área metropolitana. " +
        "Ej: 'Ciudad de México', 'Zapopan' (NO Guadalajara — Estadio Akron está en Zapopan), 'Guadalupe' (NO Monterrey — Estadio BBVA está en Guadalupe). " +
        "Estados Unidos: 'Arlington', 'Atlanta', 'East Rutherford', 'Foxborough', 'Houston', 'Inglewood', 'Kansas City', 'Miami Gardens', 'Philadelphia', 'Santa Clara', 'Seattle'. " +
        "Canadá: 'Toronto', 'Vancouver'.",
      ),
    pais: z
      .string()
      .optional()
      .describe(
        "País: 'México', 'Estados Unidos', o 'Canadá'. Acepta también 'USA', 'Mexico', 'Canada' — se normalizan.",
      ),
    fase: z
      .string()
      .optional()
      .describe(
        "Fase del torneo: 'grupos' | 'dieciseisavos' | 'octavos' | 'cuartos' | 'semifinal' | 'tercer_lugar' | 'final'",
      ),
    grupo: z
      .string()
      .optional()
      .describe("Letra del grupo A-L. Solo aplica en fase de grupos."),
    estado: z
      .string()
      .optional()
      .describe(
        "Estado del partido: 'programado' | 'en_vivo' | 'finalizado' | 'suspendido'",
      ),
    proximos: z
      .preprocess((val) => {
        if (typeof val === "string") {
          const v = val.trim().toLowerCase();
          if (v === "true") return true;
          if (v === "false") return false;
        }
        return val;
      }, z.boolean())
      .optional()
      .describe("Si true, solo partidos desde ahora en adelante."),
    order_by: z
      .enum(["asc", "desc"])
      .optional()
      .describe("Orden por fecha. Default 'asc'."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Número máximo de partidos a devolver (default 10, max 50)."),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: z.array(
        z.object({
          id: z.number(),
          fecha_iso_utc: z.string().nullable().describe("ISO timestamp in UTC. Do NOT show to user — use 'display' field instead."),
          fase: z.string().nullable(),
          grupo: z.string().nullable(),
          equipo_a: z.string(),
          equipo_b: z.string(),
          equipo_a_codigo: z.string().nullable(),
          equipo_b_codigo: z.string().nullable(),
          sede_estadio: z.string().nullable(),
          sede_ciudad: z.string().nullable(),
          sede_pais: z.string().nullable(),
          estado: z.string().nullable(),
          marcador_a: z.number().nullable(),
          marcador_b: z.number().nullable(),
          rank_a: z.number().nullable(),
          rank_b: z.number().nullable(),
          bandera_a: z.string().nullable(),
          bandera_b: z.string().nullable(),
          readable: z.string(),
          display: z.string(),
        }),
      ),
      total: z.number(),
      note: z.string().optional().describe("Nota informativa cuando se removió un filtro automáticamente para ampliar resultados."),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
  execute: async ({
    fecha,
    equipo,
    ciudad,
    pais,
    fase,
    grupo,
    estado,
    proximos,
    order_by,
    limit,
  }: {
    fecha?: string;
    equipo?: string;
    ciudad?: string;
    pais?: string;
    fase?: string;
    grupo?: string;
    estado?: string;
    proximos?: unknown;
    order_by?: "asc" | "desc";
    limit?: number;
  }) => {
    const { data, error } = await fetchPartidos({
      fecha,
      equipo,
      ciudad,
      pais,
      fase,
      grupo,
      estado,
      proximos: proximos as boolean | undefined,
      order_by,
      limit,
    });

    if (error) {
      return { ok: false as const, error };
    }

    // GUARD RULE: if equipo+fecha combo returned no results, retry without fecha
    let guardNote: string | undefined;
    let finalData = data;
    if (equipo && fecha && data.length === 0) {
      const { data: retryData, error: retryError } = await fetchPartidos({
        equipo,
        ciudad,
        pais,
        fase,
        grupo,
        estado,
        proximos: proximos as boolean | undefined,
        order_by,
        limit,
      });
      if (!retryError && retryData.length > 0) {
        finalData = retryData;
        guardNote =
          "Removí el filtro de fecha porque la combinación equipo+fecha no devolvió partidos. Estos son todos los partidos del equipo.";
      }
    }

    const rows = finalData.map((row) => ({
      id: row.id,
      fecha_iso_utc: row.fecha_utc,
      fase: row.fase,
      grupo: row.grupo,
      // NEVER infer: if code is null, use desc literally
      equipo_a: row.equipo_a_codigo
        ? (row.equipo_a_nombre ?? row.equipo_a_codigo)
        : (row.equipo_a_desc ?? "Por confirmar"),
      equipo_b: row.equipo_b_codigo
        ? (row.equipo_b_nombre ?? row.equipo_b_codigo)
        : (row.equipo_b_desc ?? "Por confirmar"),
      equipo_a_codigo: row.equipo_a_codigo,
      equipo_b_codigo: row.equipo_b_codigo,
      sede_estadio: row.sede_estadio,
      sede_ciudad: row.sede_ciudad,
      sede_pais: row.sede_pais,
      estado: row.estado,
      marcador_a: row.marcador_a,
      marcador_b: row.marcador_b,
      rank_a: row.rank_a,
      rank_b: row.rank_b,
      bandera_a: row.bandera_a,
      bandera_b: row.bandera_b,
      readable: partidoToReadable(row),
      display: partidoToDisplay(row),
    }));

    return {
      ok: true as const,
      data: rows,
      total: rows.length,
      ...(guardNote !== undefined ? { note: guardNote } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// 2. mundial_sede_info
// ---------------------------------------------------------------------------

export const mundialSedeInfo = createTool({
  id: "mundial_sede_info",
  description:
    "Devuelve información completa de un estadio sede del Mundial 2026 (nombre, ciudad, dirección, capacidad, zona horaria, Google Maps). " +
    "Una invocación devuelve todos los datos disponibles del estadio.",
  inputSchema: z.object({
    id_or_city: z
      .string()
      .describe(
        "Identificador de la sede. Acepta UNO de tres formatos equivalentes que devuelven el mismo registro: " +
          "(a) ID numérico (ej: \"8\"), (b) nombre del estadio (ej: \"Estadio Azteca\"), o (c) nombre de ciudad (ej: \"Ciudad de México\"). " +
          "El formato más natural es el nombre del estadio si lo conoces; la ciudad funciona cuando solo sabes la ubicación. " +
          "Una sola invocación es suficiente — si la primera devuelve ok:false, el lugar no existe en la base, no reintentes con otro formato.",
      ),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: z.object({
        id: z.number(),
        nombre: z.string(),
        ciudad: z.string(),
        pais: z.string(),
        direccion: z.string().nullable(),
        capacidad: z.number().nullable(),
        latitud: z.number().nullable(),
        longitud: z.number().nullable(),
        zona_horaria: z.string().nullable(),
        descripcion: z.string().nullable(),
        google_maps_url: z.string().nullable(),
        display: z.string(),
      }),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
  execute: async ({ id_or_city }: { id_or_city: string }) => {
    const { data, error } = await fetchSedeInfo(id_or_city);
    if (error) return { ok: false as const, error };
    if (!data) return { ok: false as const, error: `Sede "${id_or_city}" no encontrada` };

    return {
      ok: true as const,
      data: {
        id: data.id,
        nombre: data.nombre,
        ciudad: data.ciudad,
        pais: data.pais,
        direccion: data.direccion,
        capacidad: data.capacidad,
        latitud: data.latitud,
        longitud: data.longitud,
        zona_horaria: data.zona_horaria,
        descripcion: data.descripcion,
        google_maps_url: data.google_maps_url,
        display: sedeToDisplay(data),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// 3. mundial_fan_fest
// ---------------------------------------------------------------------------

export const mundialFanFest = createTool({
  id: "mundial_fan_fest",
  description:
    "Busca los Fan Festivals oficiales de la FIFA para el Mundial 2026. " +
    "Filtra por ciudad o país. Devuelve nombre, fechas, horario, ubicación, " +
    "información de entrada y link de Google Maps.",
  inputSchema: z.object({
    ciudad: z
      .string()
      .optional()
      .describe("Ciudad donde buscar Fan Fests. Ej: 'Guadalajara', 'Toronto'."),
    pais: z
      .string()
      .optional()
      .describe(
        "País donde buscar Fan Fests. Acepta variantes ES/EN. " +
          "Ej: 'México', 'Canada', 'Estados Unidos'.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Máximo de resultados a devolver (default 10, max 50)."),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: z.array(
        z.object({
          id: z.number(),
          nombre: z.string(),
          ciudad: z.string(),
          pais: z.string(),
          ubicacion: z.string().nullable(),
          fecha_inicio: z.string().nullable(),
          fecha_fin: z.string().nullable(),
          horario: z.string().nullable(),
          capacidad: z.number().nullable(),
          entrada_gratis: z.boolean().nullable(),
          descripcion: z.string().nullable(),
          url_oficial: z.string().nullable(),
          google_maps_url: z.string().nullable(),
          display: z.string(),
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
    ciudad,
    pais,
    limit,
  }: {
    ciudad?: string;
    pais?: string;
    limit?: number;
  }) => {
    const { data, error } = await fetchFanFest({ ciudad, pais, limit });
    if (error) return { ok: false as const, error };

    const rows = data.map((row) => ({
      id: row.id,
      nombre: row.nombre,
      ciudad: row.ciudad,
      pais: row.pais,
      ubicacion: row.ubicacion,
      fecha_inicio: row.fecha_inicio,
      fecha_fin: row.fecha_fin,
      horario: row.horario,
      capacidad: row.capacidad,
      entrada_gratis: row.entrada_gratis,
      descripcion: row.descripcion,
      url_oficial: row.url_oficial,
      google_maps_url: row.google_maps_url,
      display: fanFestToDisplay(row),
    }));

    return { ok: true as const, data: rows, total: rows.length };
  },
});

// ---------------------------------------------------------------------------
// 4. mundial_partido_detalle
// ---------------------------------------------------------------------------

export const mundialPartidoDetalle = createTool({
  id: "mundial_partido_detalle",
  description:
    "Devuelve información completa de un partido específico: " +
    "equipos, marcador, sede, eventos (goles, tarjetas, cambios) y alineaciones. " +
    "Úsala cuando el usuario pregunta por los detalles de un partido concreto por ID.",
  inputSchema: z.object({
    partido_id: z
      .number()
      .int()
      .positive()
      .describe(
        "ID numérico devuelto por mundial_partidos_buscar. " +
          "Solo usa esta tool si el usuario pidió detalles de UN partido específico " +
          "(alineaciones, eventos, goles).",
      ),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: z.object({
        id: z.number(),
        fecha_utc: z.string().nullable(),
        fecha_hora_cdmx: z.string().nullable(),
        fase: z.string().nullable(),
        grupo: z.string().nullable(),
        equipo_a: z.string(),
        equipo_b: z.string(),
        equipo_a_codigo: z.string().nullable(),
        equipo_b_codigo: z.string().nullable(),
        sede_estadio: z.string().nullable(),
        sede_ciudad: z.string().nullable(),
        estado: z.string().nullable(),
        marcador_a: z.number().nullable(),
        marcador_b: z.number().nullable(),
        display: z.string(),
        eventos: z.array(
          z.object({
            id: z.number(),
            minuto: z.number().nullable(),
            minuto_extra: z.number().nullable(),
            tipo: z.string().nullable(),
            equipo_codigo: z.string().nullable(),
            jugador: z.string().nullable(),
            jugador_asiste: z.string().nullable(),
            detalle: z.string().nullable(),
            readable: z.string(),
          }),
        ),
        alineaciones: z.array(
          z.object({
            id: z.number(),
            equipo_codigo: z.string(),
            tipo: z.string().nullable(),
            numero: z.number().nullable(),
            jugador: z.string().nullable(),
            posicion: z.string().nullable(),
            es_capitan: z.boolean().nullable(),
            formacion: z.string().nullable(),
            readable: z.string(),
          }),
        ),
        has_alineaciones: z.boolean(),
      }),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
  execute: async ({ partido_id }: { partido_id: number }) => {
    const { data, error } = await fetchPartidoDetalle(partido_id);
    if (error) return { ok: false as const, error };
    if (!data) return { ok: false as const, error: `Partido ${partido_id} no encontrado` };

    return {
      ok: true as const,
      data: {
        id: data.id,
        fecha_utc: data.fecha_utc,
        fecha_hora_cdmx: data.fecha_hora_cdmx,
        fase: data.fase,
        grupo: data.grupo,
        // NEVER infer team names
        equipo_a: data.equipo_a_codigo
          ? (data.equipo_a_nombre ?? data.equipo_a_codigo)
          : (data.equipo_a_desc ?? "Por confirmar"),
        equipo_b: data.equipo_b_codigo
          ? (data.equipo_b_nombre ?? data.equipo_b_codigo)
          : (data.equipo_b_desc ?? "Por confirmar"),
        equipo_a_codigo: data.equipo_a_codigo,
        equipo_b_codigo: data.equipo_b_codigo,
        sede_estadio: data.sede_estadio,
        sede_ciudad: data.sede_ciudad,
        estado: data.estado,
        marcador_a: data.marcador_a,
        marcador_b: data.marcador_b,
        display: partidoToDisplay(data),
        eventos: data.eventos.map((e) => ({
          id: e.id,
          minuto: e.minuto,
          minuto_extra: e.minuto_extra,
          tipo: e.tipo,
          equipo_codigo: e.equipo_codigo,
          jugador: e.jugador,
          jugador_asiste: e.jugador_asiste,
          detalle: e.detalle,
          readable: eventoToReadable(e),
        })),
        alineaciones: data.alineaciones.map((a) => ({
          id: a.id,
          equipo_codigo: a.equipo_codigo,
          tipo: a.tipo,
          numero: a.numero,
          jugador: a.jugador,
          posicion: a.posicion,
          es_capitan: a.es_capitan,
          formacion: a.formacion,
          readable: alineacionToReadable(a),
        })),
        has_alineaciones: data.alineaciones.length > 0,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// 5. mundial_equipo_info
// ---------------------------------------------------------------------------

export const mundialEquipoInfo = createTool({
  id: "mundial_equipo_info",
  description:
    "Devuelve información de un equipo del Mundial 2026: " +
    "nombre, código, confederación, grupo, ranking FIFA, bandera, " +
    "y sus próximos partidos programados. " +
    "Úsala para: ¿cuál es el ranking de Argentina?, ¿en qué grupo está México?, " +
    "¿cuándo juega Brasil?, etc.",
  inputSchema: z.object({
    equipo: z
      .string()
      .describe(
        "Código FIFA de 3 letras (MEX, USA, ARG…) o nombre del equipo en español o inglés. " +
          "Acepta tanto código como nombre: 'MEX' o 'México' o 'Mexico', 'ARG' o 'Argentina', " +
          "'BRA' o 'Brasil' o 'Brazil', 'USA' o 'Estados Unidos', 'ESP' o 'España', " +
          "'FRA' o 'Francia', 'GER' o 'Alemania', 'POR' o 'Portugal'. " +
          "Códigos canónicos: MEX, USA, CAN, ARG, BRA, GER, ESP, FRA, GBR, ITA, NED, POR, BEL, URU, COL.",
      ),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: z.object({
        equipo: z.object({
          codigo: z.string(),
          nombre: z.string(),
          nombre_en: z.string().nullable(),
          confederacion: z.string().nullable(),
          grupo: z.string().nullable(),
          bandera_url: z.string().nullable(),
          bandera_emoji: z.string().nullable(),
          fifa_ranking: z.number().nullable(),
          display: z.string(),
        }),
        proximos_partidos: z.array(
          z.object({
            id: z.number(),
            fecha_utc: z.string().nullable(),
            fecha_hora_cdmx: z.string().nullable(),
            equipo_a: z.string(),
            equipo_b: z.string(),
            equipo_a_codigo: z.string().nullable(),
            equipo_b_codigo: z.string().nullable(),
            sede_estadio: z.string().nullable(),
            sede_ciudad: z.string().nullable(),
            fase: z.string().nullable(),
            grupo: z.string().nullable(),
            estado: z.string().nullable(),
            readable: z.string(),
          }),
        ),
      }),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
  execute: async ({ equipo }: { equipo: string }) => {
    const { equipo: eq, proximos_partidos, error } = await fetchEquipo(equipo);

    if (error && !eq) {
      return { ok: false as const, error: error ?? "Equipo no encontrado" };
    }

    if (!eq) {
      return { ok: false as const, error: "Equipo no encontrado" };
    }

    const partidos = proximos_partidos.map((row) => ({
      id: row.id,
      fecha_utc: row.fecha_utc,
      fecha_hora_cdmx: row.fecha_hora_cdmx,
      // NEVER infer
      equipo_a: row.equipo_a_codigo
        ? (row.equipo_a_nombre ?? row.equipo_a_codigo)
        : (row.equipo_a_desc ?? "Por confirmar"),
      equipo_b: row.equipo_b_codigo
        ? (row.equipo_b_nombre ?? row.equipo_b_codigo)
        : (row.equipo_b_desc ?? "Por confirmar"),
      equipo_a_codigo: row.equipo_a_codigo,
      equipo_b_codigo: row.equipo_b_codigo,
      sede_estadio: row.sede_estadio,
      sede_ciudad: row.sede_ciudad,
      fase: row.fase,
      grupo: row.grupo,
      estado: row.estado,
      readable: partidoToReadable(row),
    }));

    return {
      ok: true as const,
      data: {
        equipo: {
          codigo: eq.codigo,
          nombre: eq.nombre,
          nombre_en: eq.nombre_en,
          confederacion: eq.confederacion,
          grupo: eq.grupo,
          bandera_url: eq.bandera_url,
          bandera_emoji: eq.bandera_emoji,
          fifa_ranking: eq.fifa_ranking,
          display: equipoToDisplay(eq),
        },
        proximos_partidos: partidos,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// 6. mundial_como_llegar
// ---------------------------------------------------------------------------

export const mundialComoLlegar = createTool({
  id: "mundial_como_llegar",
  description:
    "Calcula la ruta en Google Maps desde la ubicación del usuario hasta una sede del Mundial (estadio) o un Fan Fest. " +
    "Si no tienes lat/lng del usuario, NO llames esta tool — primero pídele que comparta su ubicación.",
  inputSchema: z.object({
    tipo: z
      .enum(["sede", "fan_fest"])
      .describe("Tipo de destino: 'sede' para estadios, 'fan_fest' para Fan Festivals."),
    destino_id: z.coerce
      .number()
      .int()
      .positive()
      .describe("ID numérico del destino en v_mundial_sedes o v_mundial_fan_fest."),
    lat: z.coerce.number().describe("Latitud del usuario (WGS84)."),
    lng: z.coerce.number().describe("Longitud del usuario (WGS84)."),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      destino: z.object({
        nombre: z.string(),
        direccion: z.string().nullable().optional(),
        lat: z.number(),
        lng: z.number(),
        ciudad: z.string().nullable().optional(),
      }),
      distance_km: z.number(),
      maps_url: z.string(),
      note: z.string().optional(),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
  execute: async ({
    tipo,
    destino_id,
    lat,
    lng,
  }: {
    tipo: "sede" | "fan_fest";
    destino_id: number;
    lat: number;
    lng: number;
  }) => {
    // Validate user coordinates
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { ok: false as const, error: "coordenadas inválidas" };
    }

    // v_mundial_sedes aliases latitud→lat, longitud→lng. v_mundial_fan_fest may keep originals.
    // Read both forms to be resilient to view-shape drift.
    const pickCoord = (row: Record<string, unknown>, primary: string, alt: string): number | null => {
      const v = row[primary] ?? row[alt];
      return typeof v === "number" ? v : null;
    };

    if (tipo === "sede") {
      const { data, error } = await fetchSedeById(destino_id);
      if (error) return { ok: false as const, error };
      if (!data) return { ok: false as const, error: "destino no encontrado" };
      const dLat = pickCoord(data as unknown as Record<string, unknown>, "lat", "latitud");
      const dLng = pickCoord(data as unknown as Record<string, unknown>, "lng", "longitud");
      if (dLat === null || dLng === null) {
        return { ok: false as const, error: "destino sin coordenadas registradas" };
      }

      const origin = { lat, lng };
      const destination = { lat: dLat, lng: dLng };
      const distance_km = Math.round(haversineKm(origin, destination) * 10) / 10;
      const maps_url = googleMapsDirectionsUrl(origin, destination);

      return {
        ok: true as const,
        destino: {
          nombre: data.nombre,
          direccion: data.direccion,
          lat: dLat,
          lng: dLng,
          ciudad: data.ciudad,
        },
        distance_km,
        maps_url,
      };
    } else {
      const { data, error } = await fetchFanFestById(destino_id);
      if (error) return { ok: false as const, error };
      if (!data) return { ok: false as const, error: "destino no encontrado" };
      const dLat = pickCoord(data as unknown as Record<string, unknown>, "lat", "latitud");
      const dLng = pickCoord(data as unknown as Record<string, unknown>, "lng", "longitud");
      if (dLat === null || dLng === null) {
        return { ok: false as const, error: "destino sin coordenadas registradas" };
      }

      const origin = { lat, lng };
      const destination = { lat: dLat, lng: dLng };
      const distance_km = Math.round(haversineKm(origin, destination) * 10) / 10;
      const maps_url = googleMapsDirectionsUrl(origin, destination);

      return {
        ok: true as const,
        destino: {
          nombre: data.nombre,
          direccion: data.ubicacion,
          lat: dLat,
          lng: dLng,
          ciudad: data.ciudad,
        },
        distance_km,
        maps_url,
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Re-export all tools as a named group for easy registration in orchestrator
// ---------------------------------------------------------------------------

export const mundialTools = {
  mundialPartidosBuscar,
  mundialSedeInfo,
  mundialFanFest,
  mundialPartidoDetalle,
  mundialEquipoInfo,
  mundialComoLlegar,
} as const;
