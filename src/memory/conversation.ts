import { supabaseAdmin } from "@/db/supabase-server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  tool_calls?: unknown[];
  tokens_in?: number;
  tokens_out?: number;
  latency_ms?: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMessageArray(value: unknown): value is Message[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (m) =>
      typeof m === "object" &&
      m !== null &&
      typeof (m as Record<string, unknown>).role === "string" &&
      typeof (m as Record<string, unknown>).content === "string" &&
      typeof (m as Record<string, unknown>).created_at === "string",
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the last `limit` messages from a conversation.
 * Returns an empty array when the conversation does not exist.
 */
export async function loadMessages(
  conversationId: string,
  limit = 20,
): Promise<Message[]> {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("messages")
    .eq("id", conversationId)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      // Row not found — not a programmer error
      return [];
    }
    throw new Error(`loadMessages: ${error.message}`);
  }

  const raw: unknown = data?.messages;
  const messages = isMessageArray(raw) ? raw : [];

  return messages.length <= limit ? messages : messages.slice(-limit);
}

/**
 * Append a single message to a conversation's messages array.
 * Simple read-modify-write (acceptable until RPC atomicity is needed).
 *
 * Returns `{ ok: true }` on success, `{ ok: false, error: string }` on
 * expected failure (conversation not found, etc.).
 */
export async function appendMessage(
  conversationId: string,
  msg: Message,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Fetch current messages
  const { data, error: fetchError } = await supabaseAdmin
    .from("conversations")
    .select("messages")
    .eq("id", conversationId)
    .single();

  if (fetchError) {
    if (fetchError.code === "PGRST116") {
      return { ok: false, error: "conversation not found" };
    }
    throw new Error(`appendMessage fetch: ${fetchError.message}`);
  }

  const raw: unknown = data?.messages;
  const current: Message[] = isMessageArray(raw) ? raw : [];
  const updated = [...current, msg];

  const { error: updateError } = await supabaseAdmin
    .from("conversations")
    .update({ messages: updated, last_message_at: new Date().toISOString() })
    .eq("id", conversationId);

  if (updateError) {
    return { ok: false, error: updateError.message };
  }

  return { ok: true };
}
