import { createTool } from "@mastra/core/tools";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { executeReadOnlyQuery, alessandraSql } from "../../db/client.js";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SCHEMA_DOC = `
Schema: public (no necesita comillas dobles).

TABLAS DISPONIBLES (las únicas que puedes consultar):

public.puntos_violeta — Red de Puntos Violeta (espacios seguros para mujeres) en CDMX. ~420 filas.
  id BIGINT PK
  name TEXT                    -- Nombre del lugar (mayúsculas en la mayoría)
  hours TEXT                   -- Horario en texto libre
  street TEXT, exterior_number TEXT, interior_number TEXT
  postal_code TEXT             -- CP (06xxx → Cuauhtémoc, otros para otras alcaldías)
  neighborhood TEXT            -- Colonia (a veces en MAYÚSCULAS, sin acentos)
  responsible TEXT             -- Área/oficina responsable
  phone TEXT                   -- Puede venir 'NO TIENE' o NULL
  facebook TEXT, instagram TEXT, twitter TEXT
  lat DOUBLE PRECISION         -- Latitud
  lng DOUBLE PRECISION         -- Longitud
  geocode_precision TEXT       -- 'exact' | 'colonia' | NULL
  active BOOLEAN               -- SIEMPRE filtra active = true
  tipo TEXT                    -- 'punto_violeta' | 'mercado' | 'farmacia' | 'hospedaje' | 'restaurante' | 'comercio'

public.centros_salud — Unidades médicas públicas en Alcaldía Cuauhtémoc. 19 filas.
  id UUID PK
  nombre TEXT
  tipo TEXT                    -- 'T-I' | 'T-II' | 'T-III' | 'Clinica' | 'Dermatologico' | 'Hospital' | 'Jurisdiccion' | 'Almacen' | 'Espacio_Interactivo' | 'Otro'
                                  -- T-I/II/III = centros de salud por nivel; Clinica = especialidades; Hospital = 2do nivel
                                  -- Jurisdiccion/Almacen/Espacio_Interactivo NO son atención directa
  nivel TEXT
  sector TEXT                  -- 'publico' | 'privado'
  direccion TEXT
  codigo_postal TEXT
  colonia TEXT
  telefono TEXT
  extension TEXT
  horario TEXT
  servicios TEXT               -- Texto libre con servicios/especialidades
  especialidades TEXT[]        -- Array (a veces NULL)
  lat DOUBLE PRECISION
  lng DOUBLE PRECISION
  alcaldia TEXT                -- Default 'Cuauhtémoc'

public.report_taxonomy — Catálogo de categorías y tipos de reporte ciudadano. 56 filas.
  id BIGINT PK
  slug TEXT UNIQUE             -- Identificador (ej. 'infraestructura_bache', 'alumbrado')
  parent_slug TEXT             -- NULL si es category; apunta a un category si es type
  kind TEXT                    -- 'category' | 'type'
  name TEXT                    -- Nombre humano (ej. 'Bacheo', 'Infraestructura urbana')
  description TEXT
  attributes JSONB             -- {keywords: text[], routing_area: text, report_channel: text, icon: text}
  active BOOLEAN               -- filtra active = true

REGLAS:
- Genera UNA sola query SELECT (o WITH ... SELECT). Nada de INSERT/UPDATE/DELETE/DDL.
- Solo puedes consultar las 3 tablas listadas. Nunca inventes nombres de tablas.
- Para texto, usa lower(col) ILIKE lower('%valor%'). NO uses unaccent — la extensión no está garantizada.
- Para Alcaldía Cuauhtémoc en puntos_violeta, filtra por bounding box:
    lat BETWEEN 19.40 AND 19.46 AND lng BETWEEN -99.19 AND -99.13
  o por CP que empieza en '06' (postal_code LIKE '06%'). Prefiere el bbox cuando la pregunta sea por la alcaldía.
- En centros_salud, alcaldia ya está en 'Cuauhtémoc' por default — no necesitas filtro adicional.
- Para conteos: SELECT count(*)::int AS total ... — siempre alias y cast a int.
- Para distancia desde el usuario, usa Haversine en SQL:
    (6371 * acos(cos(radians(:user_lat)) * cos(radians(lat)) * cos(radians(lng) - radians(:user_lng)) + sin(radians(:user_lat)) * sin(radians(lat))))
  Pero NOTA: si la pregunta es "el más cercano" usa la tool especializada findPuntoVioleta o findCentroSalud, NO esta.
- Para report_taxonomy, las categories tienen kind='category' y parent_slug IS NULL; los types tienen kind='type' y parent_slug = slug del category.
- Para buscar tipos de reporte por palabra: revisa attributes->'keywords' (jsonb array de texto). Ej:
    SELECT * FROM report_taxonomy WHERE kind='type' AND attributes->'keywords' ? 'bache'
  o más tolerante:
    SELECT * FROM report_taxonomy WHERE kind='type'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(attributes->'keywords') kw WHERE lower(kw) ILIKE lower('%bache%'))
- Responde SOLO con el SQL puro. Sin markdown, sin backticks, sin comentarios.

EJEMPLOS:

P: ¿Cuántos puntos violeta hay en la Cuauhtémoc?
SQL: SELECT count(*)::int AS total
FROM public.puntos_violeta
WHERE active = true
  AND lat BETWEEN 19.40 AND 19.46 AND lng BETWEEN -99.19 AND -99.13

P: ¿Cuántos puntos violeta hay con horario 24h?
SQL: SELECT count(*)::int AS total
FROM public.puntos_violeta
WHERE active = true
  AND (lower(coalesce(hours,'')) LIKE '%24%' OR lower(coalesce(hours,'')) LIKE '%horas%')

P: ¿Cuántos centros de salud hay por tipo?
SQL: SELECT tipo, count(*)::int AS total
FROM public.centros_salud
GROUP BY tipo
ORDER BY total DESC

P: ¿Qué hospitales hay en Cuauhtémoc?
SQL: SELECT nombre, direccion, colonia, telefono, horario
FROM public.centros_salud
WHERE tipo = 'Hospital'
ORDER BY nombre

P: ¿Qué tipos de reporte ciudadano puedo hacer?
SQL: SELECT slug, name, parent_slug
FROM public.report_taxonomy
WHERE active = true AND kind = 'type'
ORDER BY parent_slug, name

P: ¿Bajo qué categoría se reporta un bache?
SQL: SELECT t.slug, t.name AS tipo, t.parent_slug, c.name AS categoria,
       t.attributes->>'routing_area' AS area_responsable
FROM public.report_taxonomy t
LEFT JOIN public.report_taxonomy c ON c.slug = t.parent_slug AND c.kind='category'
WHERE t.kind='type' AND t.active = true
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(t.attributes->'keywords') kw
    WHERE lower(kw) ILIKE lower('%bache%')
  )

P: ¿Cuántos puntos violeta hay en la colonia Roma?
SQL: SELECT count(*)::int AS total
FROM public.puntos_violeta
WHERE active = true
  AND lower(neighborhood) ILIKE lower('%roma%')

P: ¿Cuáles son las áreas responsables de los reportes de infraestructura?
SQL: SELECT DISTINCT attributes->>'routing_area' AS area
FROM public.report_taxonomy
WHERE kind='type' AND parent_slug='infraestructura' AND active=true
  AND attributes ? 'routing_area'
`;

const INSTRUCTIONS = `Eres un generador de SQL Postgres read-only para la base de Alessandra (Alcaldía Cuauhtémoc, CDMX).

Solo accedes a 3 tablas del schema public: puntos_violeta, centros_salud, report_taxonomy. Si la pregunta es sobre algo fuera de eso (leads, usuarios, conversaciones, mundial), responde con un SELECT trivial que devuelva 0 filas — el agente lo manejará.

Sigue todas las reglas del schema. Devuelve SOLO el SQL.`;

function stripSqlFences(s: string): string {
  return s.trim().replace(/^```(?:sql)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export const queryAlessandra = createTool({
  id: "queryAlessandra",
  description:
    "Tool de consulta general (text-to-SQL) sobre la base de Alessandra: puntos_violeta, centros_salud, report_taxonomy. Úsala para preguntas que NO encajan en las tools especializadas: conteos, agregados, listados con filtros exóticos, búsquedas por palabra clave en taxonomía de reportes, comparaciones, etc. NO la uses para 'el más cercano' (usa findPuntoVioleta/findCentroSalud) ni para crear reportes (usa createLead).",
  inputSchema: z.object({
    question: z.string().describe("Pregunta del usuario en lenguaje natural."),
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
      console.log("[queryAlessandra] generated SQL:", generatedSql);

      const rows = await executeReadOnlyQuery(generatedSql, 5000, alessandraSql());

      return {
        sql: generatedSql,
        rows,
        rowCount: rows.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[queryAlessandra] fallo:", { question, message });
      return {
        error: `No pude ejecutar la consulta: ${message}. Reformula la pregunta o usa otra tool.`,
      };
    }
  },
});
