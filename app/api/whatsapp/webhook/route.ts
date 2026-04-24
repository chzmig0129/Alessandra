/**
 * POST /api/whatsapp/webhook
 *
 * Receives inbound WhatsApp messages from Twilio Sandbox, resolves the user
 * and conversation, calls the Alessandra orchestrator, and returns a TwiML
 * response.
 *
 * Spec: AGENTE_ALESSANDRA-4ea
 */

import Twilio from "twilio";
import { env } from "@/env";
import { getOrCreateUser, getOrCreateActiveSession } from "@/memory/session";
import { processTurn } from "@/agent/orchestrator";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape special XML characters to prevent malformed TwiML. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Chunk a message into pieces of at most `maxLen` characters.
 * Prefers splitting on double-newlines, then single newlines, then hard-cuts.
 */
function chunkMessage(text: string, maxLen = 1400): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try paragraph boundary
    let cutAt = remaining.lastIndexOf("\n\n", maxLen);
    if (cutAt <= 0) {
      // Try single newline
      cutAt = remaining.lastIndexOf("\n", maxLen);
    }
    if (cutAt <= 0) {
      // Hard cut
      cutAt = maxLen;
    }
    chunks.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/** Build a TwiML response wrapping one or more message strings. */
function buildTwiml(messages: string[]): string {
  const messageElements = messages
    .map((m) => `<Message>${escapeXml(m)}</Message>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${messageElements}</Response>`;
}

/** Return a 200 TwiML response (Twilio retries non-200, causing duplicates). */
function twimlResponse(text: string): Response {
  const chunks = chunkMessage(text, 1400);
  const body = buildTwiml(chunks);
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  // ---- 1. Parse form-urlencoded body ----------------------------------------

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    console.error("[whatsapp/webhook] Failed to parse formData:", err);
    return twimlResponse("Tuve un problema técnico. Inténtalo de nuevo en unos segundos.");
  }

  const getString = (key: string): string | undefined => {
    const val = formData.get(key);
    return typeof val === "string" ? val : undefined;
  };

  const rawFrom = getString("From");
  const rawBody = getString("Body") ?? "";
  const latitude = getString("Latitude");
  const longitude = getString("Longitude");
  const label = getString("Label");
  const address = getString("Address");
  const numMediaStr = getString("NumMedia");
  const mediaUrl0 = getString("MediaUrl0");
  const mediaContentType0 = getString("MediaContentType0");

  // Validate required field
  if (!rawFrom) {
    console.warn("[whatsapp/webhook] Missing 'From' field");
    return twimlResponse("¿En qué puedo ayudarte?");
  }

  // Build params object for Twilio signature validation
  const params: Record<string, string> = {};
  formData.forEach((value, key) => {
    if (typeof value === "string") {
      params[key] = value;
    }
  });

  // Log media info (not processed in this issue)
  const numMedia = parseInt(numMediaStr ?? "0", 10);
  if (numMedia > 0 && mediaUrl0) {
    console.info(
      `[whatsapp/webhook] Media received: type=${mediaContentType0 ?? "unknown"}, url=${mediaUrl0}`,
    );
  }

  // ---- 2. Twilio signature validation ----------------------------------------

  const authToken = env.TWILIO_AUTH_TOKEN;
  const isDev = env.NODE_ENV === "development";

  if (!authToken) {
    if (isDev) {
      console.warn(
        "[whatsapp/webhook] No TWILIO_AUTH_TOKEN set — skipping signature validation (dev mode).",
      );
    } else {
      console.error("[whatsapp/webhook] No TWILIO_AUTH_TOKEN in production — rejecting request.");
      return new Response("Forbidden", { status: 403 });
    }
  } else {
    const signatureHeader = req.headers.get("x-twilio-signature") ?? "";
    // Reconstruct the exact URL Twilio signed
    const requestUrl = req.url;

    const isValid = Twilio.validateRequest(authToken, signatureHeader, requestUrl, params);
    if (!isValid) {
      if (isDev) {
        console.warn(
          "[whatsapp/webhook] Twilio signature invalid — permitting in dev mode.",
        );
      } else {
        console.warn("[whatsapp/webhook] Twilio signature invalid — rejecting.");
        return new Response("Forbidden", { status: 403 });
      }
    }
  }

  // ---- 3. Normalize phone number ---------------------------------------------

  // Twilio sends From as "whatsapp:+5215512345678"
  const phone = rawFrom.startsWith("whatsapp:")
    ? rawFrom.slice("whatsapp:".length)
    : rawFrom;

  // ---- 4. Resolve user (upsert by phone) -------------------------------------

  const userResult = await getOrCreateUser(phone);
  if (!userResult.ok) {
    console.error("[whatsapp/webhook] getOrCreateUser failed:", userResult.error);
    return twimlResponse("Tuve un problema técnico. Inténtalo de nuevo en unos segundos.");
  }

  const { user } = userResult;

  // Check if user is blocked — need to query the full row for the blocked flag
  // getOrCreateUser doesn't return blocked, so we need to check it separately
  // by querying supabaseAdmin directly.
  // Import supabaseAdmin for this specific check:
  const { supabaseAdmin } = await import("@/db/supabase-server");

  const { data: userRow, error: userFetchError } = await supabaseAdmin
    .from("users")
    .select("blocked")
    .eq("id", user.id)
    .single();

  if (userFetchError) {
    console.error("[whatsapp/webhook] Failed to fetch user blocked status:", userFetchError.message);
    // Non-fatal — proceed without blocked check
  } else if (userRow?.blocked === true) {
    console.info(`[whatsapp/webhook] Blocked user ${user.id} — returning neutral message.`);
    return twimlResponse("No puedo atenderte en este momento.");
  }

  // ---- 5. Resolve conversation -----------------------------------------------

  let conversationId: string;
  try {
    const session = await getOrCreateActiveSession(user.id, "whatsapp");
    conversationId = session.conversationId;
  } catch (err) {
    console.error("[whatsapp/webhook] getOrCreateActiveSession failed:", err);
    return twimlResponse("Tuve un problema técnico. Inténtalo de nuevo en unos segundos.");
  }

  // ---- 6. Build user message with optional location marker -------------------

  let userMessage: string;
  const hasLocation = latitude !== undefined && longitude !== undefined;

  if (hasLocation) {
    const lat = latitude!;
    const lng = longitude!;
    const locationMarker =
      `[UBICACIÓN COMPARTIDA] lat=${lat}, lng=${lng}` +
      (label ? ` — Etiqueta: ${label}` : "") +
      (address ? ` — Dirección aproximada: ${address}` : "") +
      ` — Mapa: https://maps.google.com/?q=${lat},${lng}`;

    userMessage = rawBody
      ? `${locationMarker}\n\n${rawBody}`
      : locationMarker;
  } else if (!rawBody.trim()) {
    // No text and no location
    return twimlResponse("¿En qué puedo ayudarte?");
  } else {
    userMessage = rawBody;
  }

  // ---- 7. Build attachments --------------------------------------------------

  const attachments: { lat?: number; lng?: number; imageUrl?: string } = {};
  if (hasLocation) {
    attachments.lat = Number(latitude);
    attachments.lng = Number(longitude);
  }

  // ---- 8. Call orchestrator --------------------------------------------------

  let responseText: string;
  try {
    const result = await processTurn({
      userId: user.id,
      userMessage,
      attachments: Object.keys(attachments).length > 0 ? attachments : undefined,
    });
    responseText = result.text;
  } catch (err) {
    console.error("[whatsapp/webhook] processTurn threw:", err);
    responseText = "Tuve un problema técnico. Inténtalo de nuevo en unos segundos.";
  }

  // ---- 9. Return TwiML -------------------------------------------------------

  return twimlResponse(responseText);
}
