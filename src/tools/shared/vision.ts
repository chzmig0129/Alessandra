/**
 * Vision helper: analyzes images via Gemini with DB cache (SHA-256 key, 7-day TTL).
 *
 * Cache table: image_analysis_cache
 * Real columns (2026-04-24 schema audit):
 *   url_hash (PK, text), url (text), description (text), category (text),
 *   is_obscene (bool), is_relevant (bool), hazard_level (text),
 *   tags (jsonb), visible_elements (jsonb),
 *   analyzed_at (timestamptz), expires_at (timestamptz)
 *
 * Cache lookup: eq('url_hash', hash) + expires_at > now()
 * Cache write: upsert with onConflict:'url_hash'
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
  raw: {
    tags?: unknown;
    visible_elements?: unknown;
  };
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
  category: string | null;
  tags: unknown;
  visible_elements: unknown;
  expires_at: string | null;
}

/**
 * Look up the cache by url_hash. Returns null on miss or expired entry.
 * expires_at is compared server-side via .gte('expires_at', now).
 */
async function getFromCache(
  urlHash: string,
): Promise<ImageAnalysisResult | null> {
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("image_analysis_cache")
    .select("description, category, tags, visible_elements, expires_at")
    .eq("url_hash", urlHash)
    .gte("expires_at", now)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as CacheRow;
  return {
    description: row.description,
    suggested_category: row.category ?? undefined,
    raw: {
      tags: row.tags,
      visible_elements: row.visible_elements,
    },
  };
}

/**
 * Persist a result to the cache. Uses upsert with onConflict:'url_hash'.
 * expires_at = now + 7 days.
 */
async function saveToCache(
  urlHash: string,
  imageUrl: string,
  result: ImageAnalysisResult,
  parsedRaw: { tags?: unknown; visible_elements?: unknown },
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  await supabaseAdmin.from("image_analysis_cache").upsert(
    {
      url_hash: urlHash,
      url: imageUrl,
      description: result.description,
      category: result.suggested_category ?? null,
      tags: parsedRaw.tags ?? null,
      visible_elements: parsedRaw.visible_elements ?? null,
      analyzed_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    },
    { onConflict: "url_hash" },
  );
}

function parseResponse(text: string): {
  description: string;
  suggested_category?: string;
  tags?: unknown;
  visible_elements?: unknown;
} {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        description?: unknown;
        suggested_category?: unknown;
        tags?: unknown;
        visible_elements?: unknown;
      };
      if (typeof parsed.description === "string") {
        return {
          description: parsed.description,
          suggested_category:
            typeof parsed.suggested_category === "string" &&
            parsed.suggested_category.length > 0
              ? parsed.suggested_category
              : undefined,
          tags: parsed.tags,
          visible_elements: parsed.visible_elements,
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
  const urlHash = sha256(imageUrl);

  // 1. Try cache first (url_hash PK, expires_at > now)
  const cached = await getFromCache(urlHash);
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
    description: parsed.description,
    suggested_category: parsed.suggested_category,
    raw: {
      tags: parsed.tags,
      visible_elements: parsed.visible_elements,
    },
  };

  // 4. Save to cache (fire-and-forget — don't block caller on cache error)
  saveToCache(urlHash, imageUrl, result, parsed).catch(() => {
    // ignore cache write errors
  });

  return result;
}
