/**
 * POST /api/agent/elevenlabs-webhook
 *
 * Receives the post-call webhook from ElevenLabs after a voice call ends.
 * Verifies the HMAC-SHA256 signature, resolves the user by phone number,
 * and appends the full transcript to the active conversation in Supabase.
 *
 * Spec: AGENTE_ALESSANDRA-pos.5
 *
 * Payload reference:
 *   https://elevenlabs.io/docs/agents-platform/workflows/post-call-webhooks
 *
 * Signature format:  ElevenLabs-Signature: t=<timestamp>,v0=<hex-digest>
 * Secret env var:    ELEVENLABS_WEBHOOK_SECRET
 */

import { createHmac, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/db/supabase-server";
import { getOrCreateUser } from "@/memory/session";
import { getOrCreateActive } from "@/memory/conversation";
import type { Message } from "@/memory/conversation";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// ElevenLabs payload types
// ---------------------------------------------------------------------------

interface ElevenLabsTranscriptEntry {
  role: "user" | "agent";
  message: string;
  time_in_call_secs?: number;
}

interface ElevenLabsPayload {
  data?: {
    conversation_id?: string;
    transcript?: ElevenLabsTranscriptEntry[];
    metadata?: {
      /** Legacy fields — never populated by ElevenLabs; kept for TS completeness */
      phone_number?: string;
      phone_number_id?: string;
      /** Twilio inbound call metadata */
      phone_call?: {
        external_number?: string;
        [key: string]: unknown;
      };
      call_duration_secs?: number;
    };
    /** Populated when the call originates from the react_sdk widget or Twilio */
    conversation_initiation_client_data?: {
      dynamic_variables?: {
        system__caller_id?: string;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    analysis?: unknown;
  };
}

// ---------------------------------------------------------------------------
// HMAC verification
// ---------------------------------------------------------------------------

/**
 * Verify the ElevenLabs-Signature header against the raw request body.
 *
 * Header format: `t=<timestamp>,v0=<hex-digest>`
 *
 * The signed payload is: `<timestamp>.<raw-body>`
 * Algorithm: HMAC-SHA256 with ELEVENLABS_WEBHOOK_SECRET
 */
function verifySignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  // Parse header: "t=1234567890,v0=abcdef..."
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const eqIdx = part.indexOf("=");
      return [part.slice(0, eqIdx), part.slice(eqIdx + 1)];
    }),
  );

  const timestamp = parts["t"];
  const v0 = parts["v0"];

  if (!timestamp || !v0) {
    return false;
  }

  // Signed payload: "<timestamp>.<body>"
  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;

  const hmac = createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest();

  let incoming: Buffer;
  try {
    incoming = Buffer.from(v0, "hex");
  } catch {
    return false;
  }

  // Prevent timing attacks
  if (hmac.length !== incoming.length) {
    return false;
  }

  return timingSafeEqual(hmac, incoming);
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  const LOG = "[elevenlabs-webhook]";

  // ---- 1. Read raw body for HMAC verification --------------------------------

  let rawBody: Buffer;
  try {
    rawBody = Buffer.from(await req.arrayBuffer());
  } catch (err) {
    console.error(`${LOG} Failed to read request body:`, err);
    return new Response(JSON.stringify({ ok: false, error: "bad_body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ---- 2. Verify HMAC --------------------------------------------------------

  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;

  if (!secret) {
    console.error(`${LOG} ELEVENLABS_WEBHOOK_SECRET is not set — rejecting request.`);
    return new Response(JSON.stringify({ ok: false, error: "configuration_error" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const signatureHeader = req.headers.get("ElevenLabs-Signature") ?? "";

  if (!signatureHeader) {
    console.warn(`${LOG} Missing ElevenLabs-Signature header — rejecting.`);
    return new Response(JSON.stringify({ ok: false, error: "missing_signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const signatureValid = verifySignature(rawBody, signatureHeader, secret);
  if (!signatureValid) {
    console.warn(`${LOG} HMAC signature invalid — rejecting.`);
    return new Response(JSON.stringify({ ok: false, error: "invalid_signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ---- 3. Parse body ---------------------------------------------------------

  let payload: ElevenLabsPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as ElevenLabsPayload;
  } catch (err) {
    console.error(`${LOG} Failed to parse JSON body:`, err);
    // Return 200 so ElevenLabs doesn't retry on a malformed payload we can't fix
    return new Response(JSON.stringify({ ok: true, warning: "malformed_json" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const callData = payload.data;
  if (!callData) {
    console.warn(`${LOG} Payload missing 'data' field — ignoring.`);
    return new Response(JSON.stringify({ ok: true, warning: "no_data" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const elevenCallId = callData.conversation_id ?? null;
  const transcript = callData.transcript ?? [];
  const durationSecs = callData.metadata?.call_duration_secs ?? null;
  const analysis = callData.analysis ?? null;

  // ---- 4. Resolve phone number -----------------------------------------------
  //
  // Priority order (per ElevenLabs payload shape):
  //   1. data.metadata.phone_call.external_number  — Twilio inbound (E.164)
  //   2. data.conversation_initiation_client_data.dynamic_variables.system__caller_id
  //   3. Synthetic "voice:anon-<conversation_id>" — react_sdk widget or unknown source
  //
  // We NEVER bail out here: every call must produce a user row and a transcript row.

  const meta = callData.metadata ?? {};
  const dynVars = callData.conversation_initiation_client_data?.dynamic_variables ?? {};

  const callerPhone =
    meta.phone_call?.external_number ??         // 1. Twilio inbound (preferred)
    dynVars.system__caller_id ??                // 2. Dynamic variable fallback
    null;

  // Last-resort synthetic identifier so we still persist the transcript
  const phoneForLookup = callerPhone ?? `voice:anon-${elevenCallId ?? Date.now()}`;

  if (!callerPhone && !elevenCallId) {
    // Truly malformed payload — log warning but continue so ElevenLabs won't retry
    console.warn(
      `${LOG} No callerPhone and no conversation_id in payload — using synthetic id. Payload may be malformed.`,
    );
  } else if (!callerPhone) {
    console.info(
      `${LOG} No caller phone (react_sdk or unknown source) — using synthetic id: ${phoneForLookup}. eleven_call_id=${elevenCallId}.`,
    );
  }

  // ---- 5. Resolve user -------------------------------------------------------

  const userResult = await getOrCreateUser(phoneForLookup);
  if (!userResult.ok) {
    console.error(`${LOG} getOrCreateUser failed for phone=${phoneForLookup}:`, userResult.error);
    // Return 200 — user resolution failure is transient; ElevenLabs retry won't help
    return new Response(JSON.stringify({ ok: true, warning: "user_resolution_failed" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { user } = userResult;

  // ---- 6. Get or create active conversation (voice) --------------------------

  let conversationId: string;
  try {
    const session = await getOrCreateActive(user.id, "voice");
    conversationId = session.conversationId;
  } catch (err) {
    console.error(`${LOG} getOrCreateActive failed for user=${user.id}:`, err);
    return new Response(JSON.stringify({ ok: true, warning: "session_error" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ---- 7. Map transcript to Message[] ----------------------------------------

  const now = new Date().toISOString();

  const newMessages: Message[] = transcript
    .filter((entry) => entry.message && entry.message.trim().length > 0)
    .map((entry) => ({
      role: entry.role === "agent" ? "assistant" : "user",
      content: entry.message.trim(),
      created_at: now,
    }));

  // ---- 8. Fetch existing messages and append transcript ----------------------

  const { data: convRow, error: fetchError } = await supabaseAdmin
    .from("conversations")
    .select("messages")
    .eq("id", conversationId)
    .single();

  if (fetchError) {
    console.error(`${LOG} Failed to fetch conversation ${conversationId}:`, fetchError.message);
    return new Response(JSON.stringify({ ok: true, warning: "fetch_conversation_failed" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const existingMessages: Message[] = Array.isArray(convRow?.messages)
    ? (convRow.messages as Message[])
    : [];

  const updatedMessages = [...existingMessages, ...newMessages];

  // ---- 9. Persist to conversations -------------------------------------------

  // The conversations table does NOT have a dedicated metadata column.
  // We store the ElevenLabs call metadata in context_keys (jsonb) instead.
  // Log the metadata fields so they're visible in logs even if storage fails.
  console.info(
    `${LOG} Persisting voice transcript: conversation_id=${conversationId}, eleven_call_id=${elevenCallId ?? "n/a"}, duration_secs=${durationSecs ?? "n/a"}, transcript_entries=${newMessages.length}`,
  );

  if (analysis) {
    // Log analysis for observability (no dedicated column — log only for now)
    console.info(`${LOG} analysis payload:`, JSON.stringify(analysis));

    // Check if analysis indicates a lead should have been created
    const analysisObj =
      typeof analysis === "object" && analysis !== null
        ? (analysis as Record<string, unknown>)
        : null;

    if (analysisObj) {
      const shouldHaveLead =
        analysisObj["lead_created"] === false ||
        analysisObj["intent"] === "lead" ||
        analysisObj["should_create_lead"] === true;

      if (shouldHaveLead) {
        console.warn(
          `${LOG} WARNING: analysis suggests a lead should have been created during call but was not. eleven_call_id=${elevenCallId ?? "n/a"}. Deferred to future iteration.`,
        );
      }
    }
  }

  // Merge call metadata into context_keys
  const elevenMetadata = {
    eleven_call_id: elevenCallId,
    duration_secs: durationSecs,
    has_analysis: analysis !== null,
  };

  const { error: updateError } = await supabaseAdmin
    .from("conversations")
    .update({
      messages: updatedMessages,
      channel: "voice",
      last_message_at: now,
      context_keys: elevenMetadata,
    })
    .eq("id", conversationId);

  if (updateError) {
    console.error(
      `${LOG} Failed to update conversation ${conversationId}:`,
      updateError.message,
    );
    return new Response(JSON.stringify({ ok: true, warning: "update_failed" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.info(
    `${LOG} OK: transcript persisted. conversation_id=${conversationId}, user_id=${user.id}, messages_appended=${newMessages.length}`,
  );

  return new Response(JSON.stringify({ ok: true, conversation_id: conversationId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
