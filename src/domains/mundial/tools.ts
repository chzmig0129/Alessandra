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
} from "./queries";
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
    "Busca partidos del Mundial FIFA 2026 filtrando por fecha, equipo, ciudad sede, fase, grupo o estado. " +
    "Devuelve lista de partidos con marcadores, equipos, sede y fase. " +
    "Úsala para responder: ¿cuándo juega X?, partidos de hoy, partidos en grupo A, semifinales, etc.",
  inputSchema: z.object({
    fecha: z
      .string()
      .optional()
      .describe("Fecha en formato YYYY-MM-DD (hora Mexico). Ej: '2026-06-11'"),
    equipo: z
      .string()
      .optional()
      .describe(
        "Código FIFA de 3 letras (MEX, USA, CAN…) o fragmento de nombre. Ej: 'México', 'ARG'.",
      ),
    ciudad: z
      .string()
      .optional()
      .describe("Ciudad donde se juega. Ej: 'Ciudad de México', 'Toronto'."),
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
      .boolean()
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
          fecha_hora_cdmx: z.string().nullable(),
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
          readable: z.string(),
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
    fecha,
    equipo,
    ciudad,
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
    fase?: string;
    grupo?: string;
    estado?: string;
    proximos?: boolean;
    order_by?: "asc" | "desc";
    limit?: number;
  }) => {
    const { data, error } = await fetchPartidos({
      fecha,
      equipo,
      ciudad,
      fase,
      grupo,
      estado,
      proximos,
      order_by,
      limit,
    });

    if (error) {
      return { ok: false as const, error };
    }

    const rows = data.map((row) => ({
      id: row.id,
      fecha_hora_cdmx: row.fecha_hora_cdmx,
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
      readable: partidoToReadable(row),
      display: partidoToDisplay(row),
    }));

    return { ok: true as const, data: rows, total: rows.length };
  },
});

// ---------------------------------------------------------------------------
// 2. mundial_sede_info
// ---------------------------------------------------------------------------

export const mundialSedeInfo = createTool({
  id: "mundial_sede_info",
  description:
    "Devuelve información completa de un estadio sede del Mundial 2026: " +
    "nombre, ciudad, dirección, capacidad, zona horaria, Google Maps. " +
    "Úsala para: ¿dónde está el Estadio Azteca?, ¿cómo llego al SoFi Stadium?, etc.",
  inputSchema: z.object({
    id_or_city: z
      .string()
      .describe(
        "ID numérico de la sede, nombre del estadio o nombre de ciudad. " +
          "Ej: '1', 'Azteca', 'Toronto', 'Ciudad de México'.",
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
    partido_id: z.number().int().positive().describe("ID numérico del partido."),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: z.object({
        id: z.number(),
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
          "Ej: 'MEX', 'México', 'Argentina', 'USA'.",
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
// Re-export all tools as a named group for easy registration in orchestrator
// ---------------------------------------------------------------------------

export const mundialTools = {
  mundialPartidosBuscar,
  mundialSedeInfo,
  mundialFanFest,
  mundialPartidoDetalle,
  mundialEquipoInfo,
} as const;
