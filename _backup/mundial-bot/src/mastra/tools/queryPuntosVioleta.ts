import { createTool } from "@mastra/core/tools";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { executeReadOnlyQuery } from "../../db/client.js";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ubicación simulada del usuario en Alcaldía Cuauhtémoc, CDMX (límite Roma/Condesa).
export const USER_LAT_DEFAULT = 19.42;
export const USER_LNG_DEFAULT = -99.16;

const SCHEMA_DOC = `
Tabla: public.puntos_violeta (420 filas aprox.)
Contiene Puntos Violeta de CDMX: espacios públicos seguros donde mujeres pueden reportar violencia, pedir orientación o resguardo temporal.

COLUMNAS:
  id BIGINT PK
  source_id TEXT              -- id externo original (ej. '#01')
  name TEXT NOT NULL          -- nombre del punto (ej. 'Edificio SEDE Alcaldía')
  hours TEXT                  -- horario en texto libre (ej. 'LUN a DOM: 8:00AM- 9:00 PM')
  street TEXT                 -- calle
  exterior_number TEXT
  interior_number TEXT
  postal_code TEXT            -- CP
  neighborhood TEXT           -- colonia (a veces en mayúsculas)
  responsible TEXT            -- área/oficina responsable
  phone TEXT                  -- teléfono de contacto
  facebook TEXT
  instagram TEXT
  twitter TEXT
  lat DOUBLE PRECISION        -- latitud decimal
  lng DOUBLE PRECISION        -- longitud decimal
  geocode_precision TEXT      -- 'exact' | otros
  active BOOLEAN NOT NULL     -- SIEMPRE filtra active = true
  created_at / updated_at
`;

const INSTRUCTIONS = `Eres un generador de SQL Postgres read-only para consultar Puntos Violeta de CDMX.

Reglas críticas:
- Devuelve UNA sola query SELECT (o WITH ... SELECT). NADA de escritura.
- Tabla: public.puntos_violeta.
- **Filtra SIEMPRE active = true.**
- Orden por cercanía: usa la fórmula de Haversine en SQL. Asume la ubicación del usuario como parámetros __USER_LAT__ y __USER_LNG__ (serán reemplazados antes de ejecutar).
  Distancia en km:
    (6371 * acos(
       cos(radians(__USER_LAT__)) * cos(radians(lat)) *
       cos(radians(lng) - radians(__USER_LNG__)) +
       sin(radians(__USER_LAT__)) * sin(radians(lat))
    )) AS distancia_km
- Cuando el usuario pregunte por el más cercano, ordena por distancia_km ASC y limita a 1–3 resultados según el tono de la pregunta.
- Incluye en el SELECT: name, street, exterior_number, neighborhood, postal_code, phone, hours, lat, lng, distancia_km.
- Si filtran por colonia/alcaldía/CP, usa lower(col) ILIKE lower('%valor%') (no hay unaccent).
- Excluye puntos sin coordenadas: WHERE lat IS NOT NULL AND lng IS NOT NULL.
- Responde SOLO con el SQL puro. Sin markdown, sin backticks, sin comentarios.

EJEMPLOS:

P: ¿Cuál es el punto violeta más cercano a mí?
SQL: SELECT name, street, exterior_number, neighborhood, postal_code, phone, hours, lat, lng,
       (6371 * acos(
          cos(radians(__USER_LAT__)) * cos(radians(lat)) *
          cos(radians(lng) - radians(__USER_LNG__)) +
          sin(radians(__USER_LAT__)) * sin(radians(lat))
       )) AS distancia_km
FROM public.puntos_violeta
WHERE active = true AND lat IS NOT NULL AND lng IS NOT NULL
ORDER BY distancia_km ASC
LIMIT 1

P: Dame los 3 más cercanos
SQL: SELECT name, street, exterior_number, neighborhood, phone, hours, lat, lng,
       (6371 * acos(
          cos(radians(__USER_LAT__)) * cos(radians(lat)) *
          cos(radians(lng) - radians(__USER_LNG__)) +
          sin(radians(__USER_LAT__)) * sin(radians(lat))
       )) AS distancia_km
FROM public.puntos_violeta
WHERE active = true AND lat IS NOT NULL AND lng IS NOT NULL
ORDER BY distancia_km ASC
LIMIT 3

P: Puntos violeta en la colonia Roma
SQL: SELECT name, street, exterior_number, neighborhood, phone, hours, lat, lng,
       (6371 * acos(
          cos(radians(__USER_LAT__)) * cos(radians(lat)) *
          cos(radians(lng) - radians(__USER_LNG__)) +
          sin(radians(__USER_LAT__)) * sin(radians(lat))
       )) AS distancia_km
FROM public.puntos_violeta
WHERE active = true AND lat IS NOT NULL AND lng IS NOT NULL
  AND lower(neighborhood) ILIKE lower('%roma%')
ORDER BY distancia_km ASC
LIMIT 5

P: ¿Hay alguno abierto 24 horas?
SQL: SELECT name, street, neighborhood, phone, hours, lat, lng,
       (6371 * acos(
          cos(radians(__USER_LAT__)) * cos(radians(lat)) *
          cos(radians(lng) - radians(__USER_LNG__)) +
          sin(radians(__USER_LAT__)) * sin(radians(lat))
       )) AS distancia_km
FROM public.puntos_violeta
WHERE active = true AND lat IS NOT NULL AND lng IS NOT NULL
  AND (lower(hours) ILIKE '%24%' OR lower(hours) ILIKE '%horas%')
ORDER BY distancia_km ASC
LIMIT 5
`;

function stripSqlFences(s: string): string {
  return s.trim().replace(/^```(?:sql)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export const queryPuntosVioleta = createTool({
  id: "queryPuntosVioleta",
  description:
    "Consulta puntos violeta de CDMX (ubicaciones, horarios, distancia desde el usuario). Úsala cuando el usuario pregunte por puntos violeta, dónde reportar, lugares seguros, ayuda para mujeres en la ciudad, etc.",
  inputSchema: z.object({
    question: z.string().describe("La pregunta del usuario en lenguaje natural."),
    userLat: z
      .number()
      .optional()
      .describe("Latitud del usuario (decimal). Si no se provee, se asume Alcaldía Cuauhtémoc, CDMX."),
    userLng: z
      .number()
      .optional()
      .describe("Longitud del usuario (decimal)."),
  }),
  outputSchema: z.object({
    sql: z.string().optional(),
    rows: z.array(z.record(z.any())).optional(),
    rowCount: z.number().optional(),
    error: z.string().optional(),
    userLocation: z.object({ lat: z.number(), lng: z.number() }).optional(),
  }),
  execute: async ({
    question,
    userLat,
    userLng,
  }: {
    question: string;
    userLat?: number;
    userLng?: number;
  }) => {
    const lat = userLat ?? USER_LAT_DEFAULT;
    const lng = userLng ?? USER_LNG_DEFAULT;

    try {
      const system =
        INSTRUCTIONS +
        "\n\nESQUEMA:\n" +
        SCHEMA_DOC +
        `\n\nUBICACIÓN DEL USUARIO EN ESTA LLAMADA:\n__USER_LAT__ = ${lat}\n__USER_LNG__ = ${lng}\n` +
        `Cuando el SQL use __USER_LAT__ o __USER_LNG__ los sustituiremos por ${lat} y ${lng} respectivamente antes de ejecutar. Puedes dejarlos como tokens en el SQL o ya usar los números — ambas funcionan.`;

      const { text } = await generateText({
        model: openai("gpt-5.4-nano"),
        system,
        prompt: `P: ${question}\nSQL:`,
      });

      let generatedSql = stripSqlFences(text);
      // Sustituye placeholders por los decimales reales (numéricos, sin comillas).
      generatedSql = generatedSql
        .replace(/__USER_LAT__/g, String(lat))
        .replace(/__USER_LNG__/g, String(lng));

      const rows = await executeReadOnlyQuery(generatedSql, 5000);

      return {
        sql: generatedSql,
        rows,
        rowCount: rows.length,
        userLocation: { lat, lng },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[queryPuntosVioleta] fallo:", { question, message });
      return {
        error: `No pude consultar los puntos violeta: ${message}. Intenta con otra pregunta.`,
      };
    }
  },
});
