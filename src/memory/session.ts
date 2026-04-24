import { supabaseAdmin } from "@/db/supabase-server";
import { env } from "@/env";
import type { Message } from "./conversation";

function toMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is Message =>
      typeof m === "object" &&
      m !== null &&
      typeof (m as Record<string, unknown>).role === "string" &&
      typeof (m as Record<string, unknown>).content === "string" &&
      typeof (m as Record<string, unknown>).created_at === "string",
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveSession {
  conversationId: string;
  isNew: boolean;
  messages: Message[];
}

export interface UserRecord {
  id: string;
  phone: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upsert a user row by phone number.
 * For web sessions use phone = `web:<sessionId>`.
 *
 * Returns `{ ok: true, user }` or `{ ok: false, error }`.
 */
export async function getOrCreateUser(
  phone: string,
): Promise<{ ok: true; user: UserRecord } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin
    .from("users")
    .upsert({ phone }, { onConflict: "phone", ignoreDuplicates: false })
    .select("id, phone, created_at")
    .single();

  if (error) {
    return { ok: false, error: error.message };
  }
  if (!data) {
    return { ok: false, error: "upsert returned no data" };
  }

  return {
    ok: true,
    user: {
      id: data.id as string,
      phone: data.phone as string,
      created_at: data.created_at as string,
    },
  };
}

/**
 * Get the most recent non-expired conversation for `userId`, or create a new
 * one.  The session window is controlled by `SESSION_TTL_HOURS` in env.
 */
export async function getOrCreateActiveSession(
  userId: string,
): Promise<ActiveSession> {
  const now = new Date();

  // Try to find an existing live session
  const { data: existing, error: selectError } = await supabaseAdmin
    .from("conversations")
    .select("id, messages")
    .eq("user_id", userId)
    .gt("expires_at", now.toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selectError) {
    throw new Error(`getOrCreateActiveSession select: ${selectError.message}`);
  }

  if (existing) {
    return {
      conversationId: existing.id as string,
      isNew: false,
      messages: toMessages(existing.messages),
    };
  }

  // Create a new conversation
  const expiresAt = addHours(now, env.SESSION_TTL_HOURS);

  const { data: created, error: insertError } = await supabaseAdmin
    .from("conversations")
    .insert({
      user_id: userId,
      messages: [] as Message[],
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();

  if (insertError) {
    throw new Error(`getOrCreateActiveSession insert: ${insertError.message}`);
  }

  return {
    conversationId: created.id as string,
    isNew: true,
    messages: [],
  };
}

/**
 * Bump the `expires_at` of a conversation by `SESSION_TTL_HOURS` from now.
 * Call this after each successful turn to keep the session alive.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, error }` on expected
 * failure.
 */
export async function bumpSessionTtl(
  conversationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const expiresAt = addHours(new Date(), env.SESSION_TTL_HOURS);

  const { error } = await supabaseAdmin
    .from("conversations")
    .update({
      expires_at: expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true };
}

/**
 * Mark a conversation as closed by setting `expires_at` to the past.
 * Optional — sessions also expire naturally.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, error }` on expected
 * failure.
 */
export async function closeSession(
  conversationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabaseAdmin
    .from("conversations")
    .update({
      expires_at: new Date(0).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true };
}
