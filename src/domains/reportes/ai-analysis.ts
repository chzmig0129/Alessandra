/**
 * AI analysis helper for citizen reports (Alcaldía Cuauhtémoc CDMX).
 *
 * analyzeReportContent() calls Gemini via generateObject (structured output)
 * and returns a ReportAiAnalysis object.
 *
 * - Uses getModel('vision') when media_urls are provided, getModel('main') otherwise.
 * - Falls back deterministically when Gemini times out or returns a 5xx error.
 * - Helper tagsFromTaxonomy() reads report_taxonomy.attributes.keywords via supabaseAdmin.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "@/agent/model-config";
import { supabaseAdmin } from "@/db/supabase-server";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ReportAiAnalysis {
  tags: string[];
  category: string;
  severity: "low" | "medium" | "high";
  confidence: number;            // 0.0–1.0
  report_type: string;
  hazard_level: "low" | "medium" | "high";
  visual_evidence: boolean;      // true si las fotos confirman el problema
  visible_elements: string[];    // qué se ve en la foto (vacío si no hay foto)
  description_clean: string;     // descripción saneada (sin slang, completa)
  enriched_description: string;  // contexto + interpretación del riesgo
  has_injury_or_hazard: boolean;
}

// ---------------------------------------------------------------------------
// Zod schema (mirrors ReportAiAnalysis exactly)
// ---------------------------------------------------------------------------

const ReportAiAnalysisSchema = z.object({
  tags: z.array(z.string()),
  category: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
  report_type: z.string(),
  hazard_level: z.enum(["low", "medium", "high"]),
  visual_evidence: z.boolean(),
  visible_elements: z.array(z.string()),
  description_clean: z.string(),
  enriched_description: z.string(),
  has_injury_or_hazard: z.boolean(),
});

// ---------------------------------------------------------------------------
// Internal helper: read keywords from report_taxonomy
// ---------------------------------------------------------------------------

async function tagsFromTaxonomy(report_type: string | null): Promise<string[]> {
  if (!report_type) return [];

  try {
    const { data, error } = await supabaseAdmin
      .from("report_taxonomy")
      .select("attributes")
      .eq("slug", report_type)
      .limit(1)
      .maybeSingle();

    if (error || !data) return [];

    const attrs = data.attributes as Record<string, unknown> | null | undefined;
    if (!attrs) return [];

    const keywords = attrs["keywords"];
    if (!Array.isArray(keywords)) return [];

    return (keywords as unknown[])
      .filter((k): k is string => typeof k === "string")
      .slice(0, 4);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(input: {
  descripcion: string;
  categoria: string;
  report_type: string | null;
  location_label?: string | null;
  hasMedia: boolean;
}): string {
  return [
    "Eres un asistente municipal de la Alcaldía Cuauhtémoc, Ciudad de México.",
    "Tu tarea es analizar reportes ciudadanos y devolver un JSON estructurado.",
    "",
    "REGLAS ESTRICTAS:",
    "- NUNCA inventes nombres propios (personas, calles, colonias).",
    "- Usa solo la información provista en el reporte.",
    "- severity por categoría (salvo evidencia contraria en la descripción):",
    "    alumbrado           → medium",
    "    bache, socavón, árbol caído, fuga de agua, fuga de gas → high",
    "    trámite, queja      → low",
    "    otros               → medium",
    "- hazard_level sigue la misma lógica que severity.",
    "- has_injury_or_hazard es true solo si la descripción menciona explícitamente lesionados o riesgo inmediato.",
    "- visual_evidence es true solo si se adjuntan fotos Y confirman el problema.",
    "- visible_elements: lista lo que se puede ver en las fotos (vacío si no hay fotos).",
    "- description_clean: reescribe la descripción sin slang, completa y formal.",
    "- enriched_description: añade contexto municipal y la interpretación del riesgo.",
    "- tags: palabras clave relevantes (máx 6).",
    "- confidence: qué tan seguro estás del análisis (0.0–1.0).",
    "",
    `Categoría del reporte: ${input.categoria}`,
    `Tipo de reporte: ${input.report_type ?? "no especificado"}`,
    input.location_label ? `Ubicación aproximada: ${input.location_label}` : "",
    `Fotos adjuntas: ${input.hasMedia ? "sí" : "no"}`,
    "",
    "Descripción del ciudadano:",
    input.descripcion,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

export async function analyzeReportContent(input: {
  descripcion: string;
  categoria: string;
  report_type: string | null;
  media_urls: string[];
  location_label?: string | null;
}): Promise<ReportAiAnalysis> {
  const hasMedia = input.media_urls.length > 0;
  const model = getModel(hasMedia ? "vision" : "main");
  const prompt = buildPrompt({ ...input, hasMedia });

  // Build messages array — attach image URLs when present
  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image"; image: URL }
  > = [{ type: "text", text: prompt }];

  if (hasMedia) {
    for (const url of input.media_urls) {
      try {
        userContent.push({ type: "image", image: new URL(url) });
      } catch {
        // Skip malformed URLs silently
      }
    }
  }

  try {
    const { object } = await generateObject({
      model,
      schema: ReportAiAnalysisSchema,
      messages: [
        {
          role: "user",
          content: userContent,
        },
      ],
    });

    return object;
  } catch (err) {
    console.warn("[ai-analysis] generateObject failed, using deterministic fallback:", err);

    // Deterministic fallback
    const fallbackTags = await tagsFromTaxonomy(input.report_type);

    const fallback: ReportAiAnalysis = {
      tags: fallbackTags,
      category: input.categoria,
      report_type: input.report_type ?? input.categoria,
      severity: "medium",
      confidence: 0.0,
      hazard_level: "medium",
      visual_evidence: false,
      visible_elements: [],
      description_clean: input.descripcion,
      enriched_description: input.descripcion,
      has_injury_or_hazard: false,
    };

    return fallback;
  }
}
