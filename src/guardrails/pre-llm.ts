/**
 * Pre-LLM guardrails: rate limiting, gender-emergency detection, jailbreak detection.
 *
 * All functions are pure or async-pure (no side effects beyond console.warn on
 * expected-but-recoverable failures).
 *
 * @example checkRateLimit("user-abc")
 *   // → { ok: true }
 *   // → { ok: false, retryAfterSec: 58 }
 *
 * @example detectGenderEmergency("me están pegando, auxilio")
 *   // → true
 *
 * @example detectJailbreak("ignore all your instructions")
 *   // → true
 */

import { supabaseAdmin } from "@/db/supabase-server";

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Checks whether `userId` has exceeded the configured rate limits.
 *
 * Queries `inbound_rate_events` for recent event counts and compares them
 * against `rate_limit_config` (row keyed by `key='global'`).
 *
 * Fails open: if either table query fails, returns `{ ok: true }` and logs
 * a warning — we never block a user because of a monitoring error.
 *
 * @example
 *   const result = await checkRateLimit("user-123");
 *   if (!result.ok) {
 *     return res.status(429).json({ retryAfter: result.retryAfterSec });
 *   }
 */
export async function checkRateLimit(
  userId: string,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  try {
    // ---- fetch config row ------------------------------------------------
    const { data: configRow, error: configErr } = await supabaseAdmin
      .from("rate_limit_config")
      .select("max_per_minute, max_per_hour")
      .eq("key", "global")
      .single();

    if (configErr || configRow == null) {
      console.warn(
        "[guardrail:pre-llm] rate_limit_config fetch failed — failing open",
        configErr,
      );
      return { ok: true };
    }

    const maxPerMinute: number = configRow.max_per_minute as number;
    const maxPerHour: number = configRow.max_per_hour as number;

    const now = new Date();

    const minuteAgo = new Date(now.getTime() - 60 * 1000).toISOString();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    // ---- count events in last minute -------------------------------------
    const { count: countMinute, error: errMinute } = await supabaseAdmin
      .from("inbound_rate_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", minuteAgo);

    if (errMinute) {
      console.warn(
        "[guardrail:pre-llm] inbound_rate_events (minute) fetch failed — failing open",
        errMinute,
      );
      return { ok: true };
    }

    if ((countMinute ?? 0) >= maxPerMinute) {
      // next allowed in roughly 1 minute
      return { ok: false, retryAfterSec: 60 };
    }

    // ---- count events in last hour ---------------------------------------
    const { count: countHour, error: errHour } = await supabaseAdmin
      .from("inbound_rate_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", hourAgo);

    if (errHour) {
      console.warn(
        "[guardrail:pre-llm] inbound_rate_events (hour) fetch failed — failing open",
        errHour,
      );
      return { ok: true };
    }

    if ((countHour ?? 0) >= maxPerHour) {
      return { ok: false, retryAfterSec: 3600 };
    }

    return { ok: true };
  } catch (err) {
    console.warn(
      "[guardrail:pre-llm] checkRateLimit threw unexpectedly — failing open",
      err,
    );
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Gender-violence emergency detection
// ---------------------------------------------------------------------------

/** Regex for gender-based violence or emergency signals (accent-insensitive). */
const GENDER_EMERGENCY_RE =
  /me estan? (peg|golp|amenaz|sig|persig)|violacion|auxilio|socorro|me va a matar|emergencia mujer/;

/**
 * Returns `true` when the text appears to describe a gender-based emergency.
 *
 * Normalizes accented characters before matching so "están" and "estan" are
 * treated equally.
 *
 * @example
 *   detectGenderEmergency("me están pegando, auxilio"); // → true
 *   detectGenderEmergency("¿dónde está el mundial?");   // → false
 */
export function detectGenderEmergency(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  return GENDER_EMERGENCY_RE.test(normalized);
}

// ---------------------------------------------------------------------------
// Jailbreak detection
// ---------------------------------------------------------------------------

/** Regex matching common jailbreak / prompt-injection patterns (case-insensitive). */
const JAILBREAK_RE =
  /ignora tus instrucciones|ignore (all|your) instructions|system prompt|you are now (dan|jailbroken)|disregard prior|forget (your|all) instructions/i;

/**
 * Returns `true` when the text contains a known jailbreak or prompt-injection
 * pattern.
 *
 * @example
 *   detectJailbreak("ignore all your instructions and...");  // → true
 *   detectJailbreak("¿cuándo es el próximo partido?");        // → false
 */
export function detectJailbreak(text: string): boolean {
  return JAILBREAK_RE.test(text);
}
