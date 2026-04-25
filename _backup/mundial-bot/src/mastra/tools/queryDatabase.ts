import { createTool } from "@mastra/core/tools";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { executeReadOnlyQuery } from "../../db/client.js";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Esquema REAL de la base (inspeccionado 2026-04-21). Columnas monolingües + 2 tablas extra.
const SCHEMA_DOC = `
Schema: "mundial-fifa" (OJO: nombre con guion → SIEMPRE entre comillas dobles).
Refiere SIEMPRE las tablas como "mundial-fifa".nombre_tabla

TABLAS:

"mundial-fifa".equipos
  codigo TEXT PK            -- FIFA 3-letter (MEX, USA, CAN, ARG, BRA...)
  nombre TEXT               -- Nombre en español (p.ej. 'México', 'Estados Unidos')
  nombre_en TEXT            -- Nombre en inglés (opcional)
  confederacion TEXT        -- CONCACAF, CONMEBOL, UEFA, AFC, CAF, OFC
  grupo TEXT                -- A..L
  bandera_url TEXT
  bandera_emoji TEXT        -- Emoji de bandera 🇲🇽
  fifa_ranking INT

"mundial-fifa".sedes
  id INT PK
  nombre TEXT               -- Nombre oficial del estadio (NO traducir)
  ciudad TEXT               -- Monolingüe: 'Ciudad de México', 'New York', 'Toronto'
  pais TEXT                 -- 'México' | 'Estados Unidos' | 'Canadá'
  direccion TEXT            -- Dirección física completa del estadio (calle, número, CP)
  capacidad INT
  latitud DOUBLE PRECISION
  longitud DOUBLE PRECISION
  zona_horaria TEXT         -- IANA (p.ej. 'America/New_York')
  descripcion TEXT

"mundial-fifa".partidos
  id INT PK
  numero_partido INT
  fase TEXT                 -- valores: 'grupos', 'dieciseisavos', 'octavos', 'cuartos', 'semifinal', 'tercer_lugar', 'final'
  grupo TEXT                -- A..L o NULL en eliminatorias
  jornada TEXT              -- p.ej. 'Matchday 1'
  fecha_utc TIMESTAMPTZ
  fecha_local TIMESTAMP
  equipo_local_codigo TEXT      -- FK equipos.codigo, NULL si aún indefinido
  equipo_visitante_codigo TEXT  -- FK equipos.codigo
  equipo_local_desc TEXT        -- placeholder textual (ej. 'Ganador Grupo A')
  equipo_visitante_desc TEXT
  sede_id INT               -- FK sedes.id
  estado TEXT               -- 'programado' | 'en_vivo' | 'finalizado' | 'suspendido'
  goles_local INT
  goles_visitante INT
  goles_local_penales INT
  goles_visitante_penales INT

"mundial-fifa".fan_fest
  id INT PK
  nombre TEXT
  ciudad TEXT
  pais TEXT
  ubicacion TEXT            -- Dirección física
  latitud DOUBLE PRECISION
  longitud DOUBLE PRECISION
  fecha_inicio DATE
  fecha_fin DATE
  horario TEXT
  capacidad INT
  entrada_gratis BOOLEAN
  descripcion TEXT
  url_oficial TEXT

"mundial-fifa".alineaciones
  id INT PK
  partido_id INT            -- FK partidos.id
  equipo_codigo TEXT        -- FK equipos.codigo
  formacion TEXT            -- p.ej. '4-3-3'
  tipo TEXT                 -- 'titular' | 'suplente' (o similar)
  numero INT                -- dorsal
  jugador TEXT
  posicion TEXT
  es_capitan BOOLEAN

"mundial-fifa".eventos_partido
  id INT PK
  partido_id INT            -- FK partidos.id
  minuto INT
  minuto_extra INT
  tipo TEXT                 -- 'gol' | 'amarilla' | 'roja' | 'cambio' | ...
  equipo_codigo TEXT
  jugador TEXT
  jugador_asiste TEXT
  detalle TEXT
`;

const INSTRUCTIONS = `Eres un generador de SQL Postgres read-only para una base sobre la Copa Mundial FIFA 2026.

Reglas:
- Genera UNA sola query SELECT (o WITH ... SELECT). Nada de INSERT/UPDATE/DELETE/DDL.
- Las tablas viven en schema "mundial-fifa". Refiere SIEMPRE como "mundial-fifa".tabla.
- Las tablas son MONOLINGÜES: columnas como nombre, ciudad, pais contienen español (o el idioma nativo del lugar). Solo equipos tiene un nombre_en opcional.
- Para filtrar por texto de forma tolerante (case-insensitive y con tolerancia ligera): usa ILIKE con % , p.ej. lower(columna) ILIKE lower('%valor%'). NO uses unaccent() — la extensión no está instalada.
- Cuando el usuario escribe en inglés un nombre que en la base está en español (ej. "Mexico City" → "Ciudad de México"), traduce mentalmente antes de filtrar o usa ILIKE con la raíz probable.
- Haz JOINs cuando necesites mostrar datos legibles (p.ej. partidos → equipos y sedes).
- Ordena por fecha_utc ASC cuando la respuesta sea un listado de partidos.
- Para "próximo partido" filtra WHERE fecha_utc >= now() y ORDER BY fecha_utc ASC LIMIT 1.
- Los valores de fase son en minúsculas sin espacios: 'grupos', 'octavos', 'cuartos', 'semifinal', 'tercer_lugar', 'final'.
- Formatea las fechas como TEXTO con to_char para evitar ambigüedad de zonas. Devuelve SOLO la hora local:
    to_char(p.fecha_local, 'YYYY-MM-DD HH24:MI') AS hora_local
  NO incluyas hora UTC en el SELECT a menos que el usuario la pida explícitamente.
  Nunca devuelvas las columnas fecha_utc/fecha_local crudas sin formatear.
- Cuando devuelvas partidos, usa SIEMPRE los alias home_code/home_flag/home_team y away_code/away_flag/away_team para evitar ambigüedad ("local" puede confundirse con el país anfitrión). Incluye el código del equipo (codigo) además del nombre y la bandera.
- Cuando aún no haya equipo confirmado (eliminatorias), incluye también p.equipo_local_desc AS home_placeholder y p.equipo_visitante_desc AS away_placeholder.
- Incluye s.direccion en el SELECT cuando el usuario pregunte por "dónde queda", "cómo llegar", "dirección", "address", "ubicación", "where is", etc. Para listados generales de partidos no hace falta.
- Si la pregunta es ambigua, elige la interpretación más probable; no pidas aclaración.
- Responde SOLO con el SQL puro. Sin markdown, sin backticks, sin comentarios, sin explicaciones.

EJEMPLOS:

P: ¿Cuándo juega México?
SQL: SELECT p.numero_partido, p.fase,
       to_char(p.fecha_local, 'YYYY-MM-DD HH24:MI') AS hora_local,
       el.codigo AS home_code, el.bandera_emoji AS home_flag, el.nombre AS home_team,
       ev.codigo AS away_code, ev.bandera_emoji AS away_flag, ev.nombre AS away_team,
       p.equipo_local_desc AS home_placeholder, p.equipo_visitante_desc AS away_placeholder,
       s.nombre AS estadio, s.ciudad, s.zona_horaria
FROM "mundial-fifa".partidos p
LEFT JOIN "mundial-fifa".equipos el ON el.codigo = p.equipo_local_codigo
LEFT JOIN "mundial-fifa".equipos ev ON ev.codigo = p.equipo_visitante_codigo
LEFT JOIN "mundial-fifa".sedes s ON s.id = p.sede_id
WHERE p.equipo_local_codigo = 'MEX' OR p.equipo_visitante_codigo = 'MEX'
ORDER BY p.fecha_utc ASC

P: Próximo partido de México
SQL: SELECT p.numero_partido, p.fase,
       to_char(p.fecha_local, 'YYYY-MM-DD HH24:MI') AS hora_local,
       el.codigo AS home_code, el.bandera_emoji AS home_flag, el.nombre AS home_team,
       ev.codigo AS away_code, ev.bandera_emoji AS away_flag, ev.nombre AS away_team,
       s.nombre AS estadio, s.ciudad, s.zona_horaria
FROM "mundial-fifa".partidos p
LEFT JOIN "mundial-fifa".equipos el ON el.codigo = p.equipo_local_codigo
LEFT JOIN "mundial-fifa".equipos ev ON ev.codigo = p.equipo_visitante_codigo
LEFT JOIN "mundial-fifa".sedes s ON s.id = p.sede_id
WHERE (p.equipo_local_codigo = 'MEX' OR p.equipo_visitante_codigo = 'MEX')
  AND p.fecha_utc >= now()
ORDER BY p.fecha_utc ASC
LIMIT 1

P: What matches are in New York?
SQL: SELECT p.numero_partido, p.fase,
       to_char(p.fecha_local, 'YYYY-MM-DD HH24:MI') AS local_time,
       el.codigo AS home_code, el.bandera_emoji AS home_flag, el.nombre_en AS home_team,
       ev.codigo AS away_code, ev.bandera_emoji AS away_flag, ev.nombre_en AS away_team,
       p.equipo_local_desc AS home_placeholder, p.equipo_visitante_desc AS away_placeholder,
       s.nombre AS stadium, s.ciudad, s.zona_horaria
FROM "mundial-fifa".partidos p
LEFT JOIN "mundial-fifa".sedes s ON s.id = p.sede_id
LEFT JOIN "mundial-fifa".equipos el ON el.codigo = p.equipo_local_codigo
LEFT JOIN "mundial-fifa".equipos ev ON ev.codigo = p.equipo_visitante_codigo
WHERE lower(s.ciudad) ILIKE lower('%new york%')
   OR lower(s.ciudad) ILIKE lower('%nueva york%')
   OR lower(s.ciudad) ILIKE lower('%east rutherford%')
ORDER BY p.fecha_utc ASC

P: Fan Fest en Guadalajara
SQL: SELECT nombre, ubicacion, fecha_inicio, fecha_fin, horario, capacidad, entrada_gratis, url_oficial
FROM "mundial-fifa".fan_fest
WHERE lower(ciudad) ILIKE lower('%guadalajara%')

P: Stadiums in Canada
SQL: SELECT nombre, ciudad, capacidad, zona_horaria
FROM "mundial-fifa".sedes
WHERE lower(pais) ILIKE lower('%canad%')
ORDER BY capacidad DESC NULLS LAST

P: ¿Dónde queda el Estadio Azteca?
SQL: SELECT nombre, ciudad, pais, direccion, capacidad, zona_horaria, latitud, longitud
FROM "mundial-fifa".sedes
WHERE lower(nombre) ILIKE lower('%azteca%')
LIMIT 1

P: ¿Qué equipos están en el grupo A?
SQL: SELECT codigo, nombre, bandera_emoji, confederacion, fifa_ranking
FROM "mundial-fifa".equipos
WHERE grupo = 'A'
ORDER BY fifa_ranking ASC NULLS LAST

P: Who plays the opening match?
SQL: SELECT to_char(p.fecha_local, 'YYYY-MM-DD HH24:MI') AS local_time,
       el.codigo AS home_code, el.bandera_emoji AS home_flag, el.nombre_en AS home_team,
       ev.codigo AS away_code, ev.bandera_emoji AS away_flag, ev.nombre_en AS away_team,
       s.nombre AS stadium, s.ciudad, s.zona_horaria
FROM "mundial-fifa".partidos p
LEFT JOIN "mundial-fifa".equipos el ON el.codigo = p.equipo_local_codigo
LEFT JOIN "mundial-fifa".equipos ev ON ev.codigo = p.equipo_visitante_codigo
LEFT JOIN "mundial-fifa".sedes s ON s.id = p.sede_id
ORDER BY p.fecha_utc ASC
LIMIT 1

P: ¿Cómo va Pumas vs Juárez?
SQL: SELECT p.id, p.estado, p.goles_local, p.goles_visitante,
       el.bandera_emoji AS home_flag, el.codigo AS home_code, el.nombre AS home_team,
       ev.bandera_emoji AS away_flag, ev.codigo AS away_code, ev.nombre AS away_team,
       s.nombre AS estadio, s.ciudad
FROM "mundial-fifa".partidos p
LEFT JOIN "mundial-fifa".equipos el ON el.codigo = p.equipo_local_codigo
LEFT JOIN "mundial-fifa".equipos ev ON ev.codigo = p.equipo_visitante_codigo
LEFT JOIN "mundial-fifa".sedes s ON s.id = p.sede_id
WHERE (p.equipo_local_codigo IN ('PUM','JUA') AND p.equipo_visitante_codigo IN ('PUM','JUA'))
ORDER BY p.fecha_utc DESC
LIMIT 1

P: Eventos del partido de Pumas
SQL: SELECT ep.minuto, ep.minuto_extra, ep.tipo, ep.jugador, ep.jugador_asiste, ep.detalle,
       eq.codigo AS equipo_code, eq.bandera_emoji AS equipo_flag, eq.nombre AS equipo
FROM "mundial-fifa".eventos_partido ep
LEFT JOIN "mundial-fifa".equipos eq ON eq.codigo = ep.equipo_codigo
WHERE ep.partido_id = (
  SELECT p.id FROM "mundial-fifa".partidos p
  WHERE p.equipo_local_codigo = 'PUM' OR p.equipo_visitante_codigo = 'PUM'
  ORDER BY p.fecha_utc DESC LIMIT 1
)
ORDER BY ep.minuto ASC, ep.minuto_extra ASC NULLS FIRST, ep.id ASC

P: Alineación titular de Pumas hoy
SQL: SELECT a.numero, a.jugador, a.posicion, a.es_capitan, a.formacion
FROM "mundial-fifa".alineaciones a
WHERE a.equipo_codigo = 'PUM'
  AND a.tipo = 'titular'
  AND a.partido_id = (
    SELECT id FROM "mundial-fifa".partidos
    WHERE equipo_local_codigo = 'PUM' OR equipo_visitante_codigo = 'PUM'
    ORDER BY fecha_utc DESC LIMIT 1
  )
ORDER BY a.numero ASC

P: Alineación titular de Argentina en su primer partido
SQL: SELECT a.numero, a.jugador, a.posicion, a.es_capitan
FROM "mundial-fifa".alineaciones a
JOIN "mundial-fifa".partidos p ON p.id = a.partido_id
WHERE a.equipo_codigo = 'ARG' AND a.tipo = 'titular'
  AND p.id = (
    SELECT id FROM "mundial-fifa".partidos
    WHERE equipo_local_codigo = 'ARG' OR equipo_visitante_codigo = 'ARG'
    ORDER BY fecha_utc ASC LIMIT 1
  )
ORDER BY a.numero ASC
`;

function stripSqlFences(s: string): string {
  let out = s.trim();
  out = out.replace(/^```(?:sql)?\s*/i, "").replace(/\s*```$/i, "");
  return out.trim();
}

export const queryDatabase = createTool({
  id: "queryDatabase",
  description:
    "Consulta la base de datos del Mundial 2026 (partidos, sedes, equipos, Fan Fests, alineaciones, eventos) a partir de una pregunta en lenguaje natural. Úsala para toda información estática del torneo.",
  inputSchema: z.object({
    question: z
      .string()
      .describe("La pregunta del usuario en lenguaje natural (ES o EN)."),
  }),
  outputSchema: z.object({
    sql: z.string().optional(),
    rows: z.array(z.record(z.any())).optional(),
    rowCount: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ question }: { question: string }) => {
    try {
      const { text } = await generateText({
        model: openai("gpt-5.4-nano"),
        system: INSTRUCTIONS + "\n\nESQUEMA:\n" + SCHEMA_DOC,
        prompt: `P: ${question}\nSQL:`,
      });

      const generatedSql = stripSqlFences(text);

      const rows = await executeReadOnlyQuery(generatedSql, 5000);

      return {
        sql: generatedSql,
        rows,
        rowCount: rows.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[queryDatabase] fallo:", {
        question,
        message,
        stack: err instanceof Error ? err.stack : undefined,
      });
      return {
        error: `No pude ejecutar la consulta: ${message}. Reformula la pregunta o responde con lo que sepas.`,
      };
    }
  },
});
