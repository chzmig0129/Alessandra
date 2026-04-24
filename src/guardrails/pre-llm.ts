/**
 * Pre-LLM guardrails: rate limiting, gender-emergency detection, jailbreak detection.
 *
 * All functions are pure or async-pure (no side effects beyond console.warn on
 * expected-but-recoverable failures).
 *
 * @example checkRateLimit("user-abc")
 *   // → { ok: true }
 *   // → { ok: false, retryAfterSec: 60, message: "..." }
 *
 * @example detectGenderEmergency("me están pegando, auxilio")
 *   // → true
 *
 * @example detectJailbreak("ignore all your instructions")
 *   // → true
 *
 * Rate limit table: rate_limit_tiers (NOT rate_limit_config)
 * Real columns: tier, daily_limit, window_15min_limit, cooldown_seconds, canned_reply
 * For web channel use tier='chat'.
 *
 * inbound_rate_events.from_phone is NOT NULL — must pass user.phone.
 */

import { supabaseAdmin } from "@/db/supabase-server";

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Checks whether `userId` has exceeded the configured rate limits.
 *
 * Algorithm:
 *   1. SELECT * FROM rate_limit_tiers WHERE tier=channel LIMIT 1.
 *   2. SELECT count(*) from inbound_rate_events WHERE user_id=userId AND created_at > now()-15min.
 *   3. SELECT count(*) from inbound_rate_events WHERE user_id=userId AND created_at > now()-24h.
 *   4. If 15min count >= window_15min_limit OR daily count >= daily_limit
 *      → return { ok: false, retryAfterSec: cooldown_seconds, message: canned_reply }.
 *   5. Else INSERT INTO inbound_rate_events(from_phone, user_id, channel).
 *
 * Fails open: if any query fails, returns { ok: true } and logs a warning
 * so we never block a user because of a monitoring error.
 *
 * @param userId   The user's internal ID.
 * @param channel  Rate-limit tier key (default: 'chat' for web).
 * @param phone    User's phone number — required for inbound_rate_events.from_phone (NOT NULL).
 *                 Defaults to 'unknown' when not available (e.g. web sessions without phone).
 *
 * @example
 *   const result = await checkRateLimit("user-123");
 *   if (!result.ok) {
 *     return res.status(429).json({ retryAfter: result.retryAfterSec });
 *   }
 */
export async function checkRateLimit(
  userId: string,
  channel: string = "chat",
  phone: string = "unknown",
): Promise<{ ok: true } | { ok: false; retryAfterSec: number; message?: string }> {
  try {
    // ---- 1. Fetch tier config from rate_limit_tiers -------------------------
    const { data: tierRow, error: tierErr } = await supabaseAdmin
      .from("rate_limit_tiers")
      .select("daily_limit, window_15min_limit, cooldown_seconds, canned_reply")
      .eq("tier", channel)
      .limit(1)
      .maybeSingle();

    if (tierErr || tierRow == null) {
      console.warn(
        "[guardrail:pre-llm] rate_limit_tiers fetch failed — failing open",
        tierErr,
      );
      return { ok: true };
    }

    const dailyLimit: number = tierRow.daily_limit as number;
    const window15minLimit: number = tierRow.window_15min_limit as number;
    const cooldownSeconds: number = tierRow.cooldown_seconds as number;
    const cannedReply: string | undefined =
      typeof tierRow.canned_reply === "string" ? tierRow.canned_reply : undefined;

    const now = new Date();
    const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    // ---- 2. Count events in last 15 minutes ---------------------------------
    const { count: count15min, error: err15min } = await supabaseAdmin
      .from("inbound_rate_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", fifteenMinAgo);

    if (err15min) {
      console.warn(
        "[guardrail:pre-llm] inbound_rate_events (15min) fetch failed — failing open",
        err15min,
      );
      return { ok: true };
    }

    if ((count15min ?? 0) >= window15minLimit) {
      return { ok: false, retryAfterSec: cooldownSeconds, message: cannedReply };
    }

    // ---- 3. Count events in last 24 hours -----------------------------------
    const { count: countDaily, error: errDaily } = await supabaseAdmin
      .from("inbound_rate_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", twentyFourHoursAgo);

    if (errDaily) {
      console.warn(
        "[guardrail:pre-llm] inbound_rate_events (daily) fetch failed — failing open",
        errDaily,
      );
      return { ok: true };
    }

    if ((countDaily ?? 0) >= dailyLimit) {
      return { ok: false, retryAfterSec: cooldownSeconds, message: cannedReply };
    }

    // ---- 4. Within limits — record the event --------------------------------
    // from_phone is NOT NULL in inbound_rate_events; use phone param.
    const { error: insertErr } = await supabaseAdmin
      .from("inbound_rate_events")
      .insert({
        from_phone: phone,
        user_id: userId,
        channel: channel,
      });

    if (insertErr) {
      // Log but don't fail — rate event insert failure is non-critical.
      console.warn(
        "[guardrail:pre-llm] inbound_rate_events insert failed",
        insertErr,
      );
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
