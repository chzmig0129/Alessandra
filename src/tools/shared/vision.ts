/**
 * Vision helper: analyzes images via Gemini with DB cache (SHA-256 key, 7-day TTL).
 */

import { createHash } from "node:crypto";
import { google } from "@ai-sdk/google";
import { generateText } from "ai";
import { supabaseAdmin } from "@/db/supabase-server";
import { env } from "@/env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageAnalysisResult {
  description: string;
  suggested_category?: string;
  raw: string;
}

// ---------------------------------------------------------------------------
// Default prompt
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT =
  'Describe brevemente esta imagen para un reporte ciudadano (bache, basura, alumbrado, etc). ' +
  'Si claramente identificas la categoría, responde JSON {"description":"...", "suggested_category":"..."} ' +
  'con categoría EXACTA de esta lista o vacío si no sabes: bache, alumbrado, basura, fuga_agua, fuga_gas, arbol, vialidad, otros.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

interface CacheRow {
  description: string;
  suggested_category: string | null;
  raw: string;
}

async function getFromCache(
  imageHash: string,
): Promise<ImageAnalysisResult | null> {
  const { data, error } = await supabaseAdmin
    .from("image_analysis_cache")
    .select("description, suggested_category, raw")
    .eq("image_sha256", imageHash)
    .gte(
      "created_at",
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    )
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as CacheRow;
  return {
    description: row.description,
    suggested_category: row.suggested_category ?? undefined,
    raw: row.raw,
  };
}

async function saveToCache(
  imageHash: string,
  imageUrl: string,
  result: ImageAnalysisResult,
): Promise<void> {
  await supabaseAdmin.from("image_analysis_cache").upsert(
    {
      image_sha256: imageHash,
      image_url: imageUrl,
      description: result.description,
      suggested_category: result.suggested_category ?? null,
      raw: { text: result.raw },
      created_at: new Date().toISOString(),
    },
    { onConflict: "image_sha256" },
  );
}

function parseResponse(text: string): Omit<ImageAnalysisResult, "raw"> {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        description?: unknown;
        suggested_category?: unknown;
      };
      if (typeof parsed.description === "string") {
        return {
          description: parsed.description,
          suggested_category:
            typeof parsed.suggested_category === "string" &&
            parsed.suggested_category.length > 0
              ? parsed.suggested_category
              : undefined,
        };
      }
    } catch {
      // fall through to plain-text fallback
    }
  }
  return {
    description: text,
    suggested_category: undefined,
  };
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

export async function analyzeImage(
  imageUrl: string,
  prompt?: string,
): Promise<ImageAnalysisResult> {
  const imageHash = sha256(imageUrl);

  // 1. Try cache first
  const cached = await getFromCache(imageHash);
  if (cached) return cached;

  // 2. Call Gemini Vision
  const effectivePrompt = prompt ?? DEFAULT_PROMPT;

  const { text } = await generateText({
    model: google(env.MODEL_VISION),
    messages: [
      {
        role: "user",
        content: [
          { type: "image", image: new URL(imageUrl) },
          { type: "text", text: effectivePrompt },
        ],
      },
    ],
  });

  // 3. Parse response
  const parsed = parseResponse(text);
  const result: ImageAnalysisResult = {
    ...parsed,
    raw: text,
  };

  // 4. Save to cache (fire-and-forget)
  saveToCache(imageHash, imageUrl, result).catch(() => {
    // ignore cache write errors
  });

  return result;
}
