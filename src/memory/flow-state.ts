import { supabaseAdmin } from "@/db/supabase-server";
import { env } from "@/env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlowDomain = "mundial" | "puntos_violeta" | "reportes" | null;

export interface Flow {
  domain: FlowDomain;
  step: string;
  slots: Record<string, unknown>;
  started_at: string;
  expires_at: string;
  intent_snapshot: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function isFlow(value: unknown): value is Flow {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    ("domain" in v &&
      (v.domain === null ||
        v.domain === "mundial" ||
        v.domain === "puntos_violeta" ||
        v.domain === "reportes")) &&
    typeof v.step === "string" &&
    typeof v.slots === "object" &&
    v.slots !== null &&
    typeof v.started_at === "string" &&
    typeof v.expires_at === "string" &&
    typeof v.intent_snapshot === "string"
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when `flow` is null or its `expires_at` is in the past.
 */
export function isFlowExpired(flow: Flow | null | undefined): boolean {
  if (flow == null) return true;
  return new Date(flow.expires_at) < new Date();
}

/**
 * Get the current flow state for a conversation.
 *
 * Returns `{ ok: true, flow }` where `flow` is null when none is set.
 * Returns `{ ok: false, error }` on expected failure (conversation not found).
 */
export async function getFlowState(
  conversationId: string,
): Promise<
  { ok: true; flow: Flow | null } | { ok: false; error: string }
> {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("current_flow")
    .eq("id", conversationId)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      return { ok: false, error: "conversation not found" };
    }
    throw new Error(`getFlowState: ${error.message}`);
  }

  const raw: unknown = data?.current_flow;
  const flow: Flow | null = isFlow(raw) ? raw : null;

  return { ok: true, flow };
}

/**
 * Persist a flow state for a conversation.  If `flow.expires_at` is not
 * provided or is already expired, a fresh TTL (`FLOW_TTL_MINUTES` from env)
 * is applied automatically.
 *
 * Returns `{ ok: true }` or `{ ok: false, error }`.
 */
export async function setFlowState(
  conversationId: string,
  flow: Omit<Flow, "expires_at"> & { expires_at?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const expiresAt =
    flow.expires_at && new Date(flow.expires_at) > new Date()
      ? flow.expires_at
      : addMinutes(new Date(), env.FLOW_TTL_MINUTES).toISOString();

  const fullFlow: Flow = {
    domain: flow.domain,
    step: flow.step,
    slots: flow.slots,
    started_at: flow.started_at,
    expires_at: expiresAt,
    intent_snapshot: flow.intent_snapshot,
  };

  const { error } = await supabaseAdmin
    .from("conversations")
    .update({
      current_flow: fullFlow,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true };
}

/**
 * Atomically sets a single slot key inside conversations.current_flow.slots
 * via the set_flow_slot RPC. Safe under concurrent calls because Postgres
 * does the jsonb_set atomically per row. Caller must ensure the flow exists
 * (e.g., reporte_iniciar ran first); the RPC is a no-op when current_flow IS NULL.
 */
export async function setFlowSlot(
  conversationId: string,
  slotKey: string,
  slotValue: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabaseAdmin.rpc("set_flow_slot", {
    p_conversation_id: conversationId,
    p_slot_key: slotKey,
    p_slot_value: slotValue,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Clear the flow state for a conversation (set `current_flow` to null).
 *
 * Returns `{ ok: true }` or `{ ok: false, error }`.
 */
export async function clearFlowState(
  conversationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabaseAdmin
    .from("conversations")
    .update({
      current_flow: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true };
}
