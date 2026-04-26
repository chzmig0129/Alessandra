/**
 * knowledge.ts — semantic search sobre la tabla public.knowledge.
 *
 * Tool: knowledge_buscar
 * Genera embedding del query (OpenAI text-embedding-3-small, 1536-dim) y
 * llama a la función Postgres match_knowledge() (cosine similarity vía pgvector).
 *
 * Cuándo invocarla:
 *  - El usuario pregunta sobre información GENERAL de la Alcaldía Cuauhtémoc
 *    (museos, gastronomía, cultura, deportes, salud, trámites, info_general)
 *    que NO encaja en mundial / puntos_violeta / reportes.
 *
 * NO usar para:
 *  - Datos estructurados que ya tienen tool especializada (sedes Mundial, puntos
 *    violeta, etc. — esas tienen sus tools mundial_* o puntos_violeta_*).
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { embed } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { supabaseAdmin } from "@/db/supabase-server";
import { env } from "@/env";

// ---------------------------------------------------------------------------
// OpenAI client (direct, NOT via OpenRouter — OpenRouter no soporta embeddings)
// ---------------------------------------------------------------------------

const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY ?? "" });

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const InputSchema = z.object({
  query: z
    .string()
    .min(3)
    .describe(
      "Pregunta o frase del usuario para buscar en la base de conocimiento. " +
        "Ejemplos: 'museos en la alcaldía', 'requisitos del trámite de licencia de construcción', " +
        "'qué hacer en Cuauhtémoc el fin de semana', 'centros de salud cercanos'.",
    ),
  category: z
    .string()
    .optional()
    .describe(
      "Opcional. Filtrar por categoría específica. Categorías válidas en la BD: " +
        "tramites, puntos_violeta, info_general, salud, deportes, estadios, " +
        "gastronomia, cultura, servicios_urbanos, eventos, animales, " +
        "canal_atencion, seguridad, seguridad_emergencias. " +
        "Si pasas otra (ej. 'transporte'), se ignora silenciosamente y se busca en TODAS. " +
        "Si no la pasas, busca en TODAS las categorías.",
    ),
  limit: z
    .coerce.number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Número máximo de resultados (default 5, máx 10)."),
});

const OutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    results: z.array(
      z.object({
        id: z.number(),
        category: z.string(),
        subcategory: z.string().nullable(),
        title: z.string().nullable(),
        summary: z.string().nullable(),
        // Snippet del content jsonb truncado a ~1200 chars para que el LLM
        // tenga acceso a datos concretos (teléfonos, direcciones, requisitos)
        // que no caben en el summary.
        content_snippet: z.string().nullable(),
        tags: z.array(z.string()).nullable(),
        similarity: z.number(),
      }),
    ),
    total: z.number(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }),
]);

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const knowledgeBuscar = createTool({
  id: "knowledge_buscar",
  description:
    "Busca información GENERAL de la Alcaldía Cuauhtémoc en la base de conocimiento (museos, gastronomía, cultura, deportes, salud, trámites detallados, eventos, info_general). " +
    "Usa búsqueda semántica (embeddings). Devuelve hasta 10 documentos rankeados por relevancia con título, resumen y tags. " +
    "Invocar SIEMPRE que el usuario pregunte por un tema de Cuauhtémoc/CDMX que NO sea Mundial FIFA, Puntos Violeta o Reportes Ciudadanos. " +
    "Ejemplos: '¿qué museos hay?', 'recomienda restaurantes', 'requisitos para una licencia de construcción', 'eventos culturales'.",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,

  execute: async ({ query, category, limit }) => {
    if (!env.OPENAI_API_KEY) {
      return {
        ok: false as const,
        error: "OPENAI_API_KEY no configurado — no se puede generar embedding del query.",
      };
    }

    // Categorías reales en la BD. Si el LLM pasa una fuera de esta lista,
    // la descartamos en lugar de filtrar a 0 rows o lanzar error.
    const VALID_CATEGORIES = new Set([
      "tramites",
      "puntos_violeta",
      "info_general",
      "salud",
      "deportes",
      "estadios",
      "gastronomia",
      "cultura",
      "servicios_urbanos",
      "eventos",
      "animales",
      "canal_atencion",
      "seguridad",
      "seguridad_emergencias",
    ]);
    const effectiveCategory =
      category && VALID_CATEGORIES.has(category) ? category : null;
    if (category && effectiveCategory == null) {
      console.warn(
        `[knowledge_buscar] categoría '${category}' no existe en la BD — búsqueda libre.`,
      );
    }

    try {
      // 1. Generar embedding del query
      const { embedding } = await embed({
        model: openai.embedding(env.MODEL_EMBEDDINGS),
        value: query,
      });

      // 2. Llamar al RPC match_knowledge — threshold bajo para no perder
      //    datos concretos (teléfonos, direcciones) que pueden tener embedding
      //    distinto al summary aunque sean del mismo doc.
      const { data, error } = await supabaseAdmin.rpc("match_knowledge", {
        query_embedding: embedding,
        match_threshold: 0.2,
        match_count: limit ?? 5,
        filter_category: effectiveCategory,
      });

      if (error) {
        return { ok: false as const, error: `Error en match_knowledge: ${error.message}` };
      }

      const rows = (data ?? []) as Array<{
        id: number;
        category: string;
        subcategory: string | null;
        title: string | null;
        summary: string | null;
        content: unknown;
        tags: string[] | null;
        similarity: number;
      }>;

      // Extrae texto leíble desde content jsonb. La mayoría son strings; algunos
      // son objetos con claves arbitrarias — para esos serializamos a JSON
      // (truncado) para que el LLM al menos tenga el blob inspeccionable.
      const snippetOf = (c: unknown): string | null => {
        if (c == null) return null;
        const raw = typeof c === "string" ? c : JSON.stringify(c);
        const trimmed = raw.replace(/\s+/g, " ").trim();
        return trimmed.length > 1200 ? trimmed.slice(0, 1200) + "…" : trimmed;
      };

      const results = rows.map((r) => ({
        id: r.id,
        category: r.category,
        subcategory: r.subcategory,
        title: r.title,
        summary: r.summary,
        content_snippet: snippetOf(r.content),
        tags: r.tags,
        similarity: Math.round(r.similarity * 1000) / 1000,
      }));

      return { ok: true as const, results, total: results.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: `knowledge_buscar exception: ${msg}` };
    }
  },
});
