/**
 * Twilio WhatsApp outbound client.
 *
 * Used by the webhook background task to send replies via REST API instead of
 * TwiML sync response. This avoids Twilio's ~15s response timeout for complex
 * LLM queries that can take 20-30s.
 *
 * Spec: AGENTE_ALESSANDRA-a4r
 */

import twilio from "twilio";
import { env } from "@/env";

let _client: ReturnType<typeof twilio> | null = null;

function getClient(): ReturnType<typeof twilio> {
  if (!_client) {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
      throw new Error(
        "Twilio outbound requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN",
      );
    }
    _client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return _client;
}

/**
 * Send one or more WhatsApp messages to a user.
 *
 * `to` must be a full `whatsapp:+…` address (matches Twilio "From" format).
 * Sequential send: Twilio guarantees order per conversation when sent serially.
 */
export async function sendWhatsAppMessages(
  to: string,
  bodies: string[],
): Promise<void> {
  const client = getClient();
  for (const body of bodies) {
    if (!body || body.trim().length === 0) continue;
    await client.messages.create({
      from: env.TWILIO_WHATSAPP_FROM,
      to,
      body,
    });
  }
}
