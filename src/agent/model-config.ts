/**
 * Centralised model configuration for Alessandra.
 *
 * All model traffic routes through OpenRouter using a single
 * createOpenAI singleton with baseURL override.  OpenRouter forwards
 * the OpenAI-compatible protocol to the underlying provider
 * (OpenAI, Google, Anthropic, Mistral, etc.) transparently.
 *
 * ---------------------------------------------------------------------------
 * HOW TO SWAP BACK TO NATIVE PROVIDERS
 * ---------------------------------------------------------------------------
 * OpenAI (direct):
 *   import { openai } from "@ai-sdk/openai";
 *   // use gpt-4o, gpt-4o-mini slugs without "openai/" prefix
 *   return openai(modelId);
 *
 * Google (direct):
 *   import { google } from "@ai-sdk/google";
 *   // use gemini-2.0-flash, gemini-1.5-pro slugs
 *   return google(modelId);
 *
 * Remove OPENROUTER_API_KEY and restore OPENAI_API_KEY /
 * GOOGLE_GENERATIVE_AI_API_KEY as required fields in src/env.ts.
 * ---------------------------------------------------------------------------
 */

import { createOpenAI } from "@ai-sdk/openai";
import { env } from "@/env";

// ---------------------------------------------------------------------------
// Singleton OpenRouter client
// ---------------------------------------------------------------------------

/**
 * One client instance per process — createOpenAI is cheap but we still
 * avoid recreating it on every getModel() call.
 */
const openrouter = createOpenAI({
  baseURL: env.OPENROUTER_BASE_URL,
  apiKey: env.OPENROUTER_API_KEY,
  headers: {
    "HTTP-Referer": env.HTTP_REFERER,
    "X-Title": env.APP_TITLE,
  },
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelTask = "router" | "main" | "sql" | "extraction" | "vision";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the configured AI SDK provider model for the given task.
 *
 * Task → env var → OpenRouter slug default:
 *   router     → MODEL_ROUTER     → openai/gpt-4o-mini
 *   main       → MODEL_MAIN       → openai/gpt-4o-mini
 *   sql        → MODEL_SQL        → openai/gpt-4o
 *   extraction → MODEL_EXTRACTION → openai/gpt-4o-mini
 *   vision     → MODEL_VISION     → google/gemini-2.5-flash-lite
 *
 * Note: not all OpenRouter models support vision (image inputs).
 * The default MODEL_VISION (google/gemini-2.5-flash-lite) does.
 * If you swap to a non-vision model here vision.ts calls will fail.
 * (The previous default `google/gemini-2.0-flash-exp:free` was retired by
 * OpenRouter and now returns 404 — do not revert.)
 */
export function getModel(task: ModelTask) {
  switch (task) {
    case "router":
      return openrouter(env.MODEL_ROUTER);

    case "main":
      return openrouter(env.MODEL_MAIN);

    case "sql":
      return openrouter(env.MODEL_SQL);

    case "extraction":
      return openrouter(env.MODEL_EXTRACTION);

    case "vision":
      return openrouter(env.MODEL_VISION);
  }
}
