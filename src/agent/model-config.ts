/**
 * Centralised model configuration for Alessandra.
 *
 * Maps logical task names to AI SDK provider models.
 * All model IDs are driven by environment variables so you can swap
 * provider or model version without touching this file.
 *
 * ---------------------------------------------------------------------------
 * HOW TO SWAP TO OPENROUTER
 * ---------------------------------------------------------------------------
 * Replace the `openai(...)` calls below with:
 *
 *   import { createOpenAI } from "@ai-sdk/openai";
 *   const openrouter = createOpenAI({
 *     baseURL: "https://openrouter.ai/api/v1",
 *     apiKey: process.env.OPENROUTER_API_KEY ?? "",
 *   });
 *
 * Then substitute `openai(modelId)` → `openrouter(modelId)` in getModel().
 * The google() call for vision can be replaced similarly using
 * createOpenAI with the OpenRouter Gemini model slug.
 * ---------------------------------------------------------------------------
 */

import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { env } from "@/env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelTask = "router" | "main" | "sql" | "extraction" | "vision";

// ---------------------------------------------------------------------------
// Model ID helpers
// ---------------------------------------------------------------------------

/**
 * Read an env var by name, falling back to a sensible default.
 * Prefer env-based overrides over hard-coded values.
 */
function modelId(envVar: string, fallback: string): string {
  // process.env is the raw source; env proxy validates declared vars only.
  const val = process.env[envVar];
  return typeof val === "string" && val.length > 0 ? val : fallback;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the configured AI SDK provider model for the given task.
 *
 * Task → env var → fallback:
 *   router     → MODEL_ROUTER     → gpt-4o-mini
 *   main       → MODEL_MAIN       → gpt-4o
 *   sql        → MODEL_SQL        → (from validated env, default gemini-2.0-flash)
 *   extraction → MODEL_EXTRACTION → gpt-4o-mini
 *   vision     → MODEL_VISION     → (from validated env, default gemini-2.0-flash)
 */
export function getModel(task: ModelTask) {
  switch (task) {
    case "vision":
      return google(env.MODEL_VISION);

    case "sql":
      return openai(env.MODEL_SQL);

    case "router":
      return openai(modelId("MODEL_ROUTER", "gpt-4o-mini"));

    case "main":
      return openai(modelId("MODEL_MAIN", "gpt-4o"));

    case "extraction":
      return openai(modelId("MODEL_EXTRACTION", "gpt-4o-mini"));
  }
}
