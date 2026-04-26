/**
 * elevenlabs-deploy-agent.ts
 *
 * Idempotent deploy script for the Alessandra Voz ElevenLabs agent.
 *
 * Behavior:
 *   - If ELEVENLABS_AGENT_ID is set  → PATCH  (update existing agent)
 *   - If ELEVENLABS_AGENT_ID is unset → POST (create new agent, print ID)
 *
 * Usage:
 *   npm run elevenlabs:deploy
 *
 * Required env vars:
 *   ELEVENLABS_API_KEY     — ElevenLabs API key (Profile → API Keys)
 *   ELEVENLABS_TOOLS_BEARER — Bearer secret for /api/agent/voice-tools/* endpoints
 *   PUBLIC_BASE_URL        — HTTPS base URL of this Next.js backend
 *
 * Optional env vars:
 *   ELEVENLABS_AGENT_ID    — If set, PATCHes the existing agent instead of creating
 *   ELEVENLABS_VOICE_ID    — Voice preset ID. Default: cgSgspJ2msm6clMCkdW9 ("Jessica").
 *                            SWAP THIS for a real Spanish-MX preset or your cloned voice
 *                            from the ElevenLabs voice library.
 *   ELEVENLABS_WEBHOOK_SECRET — Printed at the end; copy it to ElevenLabs dashboard → webhooks
 *   TWILIO_WHATSAPP_FROM   — WhatsApp number for voice prompt substitution.
 *                            Default: whatsapp:+5215596606419
 */

import { SYSTEM_PROMPT_BASE } from "../src/agent/prompts/system";
import { buildVoicePrompt } from "../src/agent/prompts/voice";
import { VOICE_TOOL_SCHEMAS } from "./elevenlabs-tool-schemas";

// ---------------------------------------------------------------------------
// Read env vars
// ---------------------------------------------------------------------------

const API_KEY = process.env["ELEVENLABS_API_KEY"];
const AGENT_ID = process.env["ELEVENLABS_AGENT_ID"] ?? "";
const VOICE_ID =
  process.env["ELEVENLABS_VOICE_ID"] ??
  // Default: "Jessica" — a temporary placeholder.
  // SWAP for a real Spanish-MX preset (browse ElevenLabs Voice Library → filter "Spanish Mexico")
  // or your own cloned voice ID.
  "cgSgspJ2msm6clMCkdW9";
const TOOLS_BEARER = process.env["ELEVENLABS_TOOLS_BEARER"];
const WEBHOOK_SECRET = process.env["ELEVENLABS_WEBHOOK_SECRET"] ?? "";
const PUBLIC_BASE_URL = process.env["PUBLIC_BASE_URL"];
const TWILIO_WHATSAPP_FROM =
  process.env["TWILIO_WHATSAPP_FROM"] ?? "whatsapp:+5215596606419";

// ---------------------------------------------------------------------------
// Validate required vars
// ---------------------------------------------------------------------------

function abort(msg: string): never {
  console.error(`[elevenlabs-deploy] ERROR: ${msg}`);
  process.exit(1);
}

if (!API_KEY) abort("ELEVENLABS_API_KEY is required.");
if (!TOOLS_BEARER) abort("ELEVENLABS_TOOLS_BEARER is required.");
if (!PUBLIC_BASE_URL) abort("PUBLIC_BASE_URL is required.");

// ---------------------------------------------------------------------------
// Build voice prompt — substitute ${TWILIO_WHATSAPP_FROM} literal token
// ---------------------------------------------------------------------------

const rawVoicePrompt = buildVoicePrompt(SYSTEM_PROMPT_BASE);
// The voice.ts template uses a literal "${TWILIO_WHATSAPP_FROM}" string
// (not a runtime interpolation) so the deploy script substitutes it here.
const voicePrompt = rawVoicePrompt.replace(
  /\$\{TWILIO_WHATSAPP_FROM\}/g,
  TWILIO_WHATSAPP_FROM,
);

// ---------------------------------------------------------------------------
// Build server tools config
// ---------------------------------------------------------------------------

interface RequestBodySchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
}

interface ApiSchema {
  url: string;
  method: "POST";
  request_headers: Record<string, string>;
  request_body_schema: RequestBodySchema;
}

interface ServerTool {
  type: "webhook";
  name: string;
  description: string;
  api_schema: ApiSchema;
}

const tools: ServerTool[] = VOICE_TOOL_SCHEMAS.map((t) => ({
  type: "webhook" as const,
  name: t.name,
  description: t.description,
  api_schema: {
    url: `${PUBLIC_BASE_URL}/api/agent/voice-tools/${t.name}`,
    method: "POST" as const,
    request_headers: {
      Authorization: `Bearer ${TOOLS_BEARER}`,
      "Content-Type": "application/json",
      "X-Caller-Phone": "{{system__caller_id}}",
    },
    request_body_schema: {
      type: "object" as const,
      properties: {
        args: t.parameters_schema,
        phone: { type: "string", description: "Caller phone number (E.164). Injected by the voice-tools route." },
        lat: { type: "number", description: "Caller latitude if known." },
        lng: { type: "number", description: "Caller longitude if known." },
      },
      required: ["args"],
    },
  },
}));

// ---------------------------------------------------------------------------
// Build full agent config
// ---------------------------------------------------------------------------

const agentConfig = {
  name: "Amazónica IA Voz",
  conversation_config: {
    agent: {
      prompt: {
        prompt: voicePrompt,
        llm: "gpt-4o-mini",
        reasoning_effort: null,
        tools,
      },
      first_message:
        "Hola, ¡qué gusto saludarte! Soy Amazónica IA, asistente de la Alcaldía Cuauhtémoc. ¿Cómo puedo ayudarte hoy, vecina o vecino?",
      language: "es",
    },
    tts: {
      voice_id: VOICE_ID,
      model_id: "eleven_flash_v2_5",
    },
  },
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.elevenlabs.io/v1/convai/agents";
const HEADERS = {
  "xi-api-key": API_KEY!,
  "Content-Type": "application/json",
};

async function createAgent(): Promise<void> {
  console.log("[elevenlabs-deploy] Creating new agent (POST)...");

  const res = await fetch(`${BASE_URL}/create`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(agentConfig),
  });

  const body = await res.text();

  if (!res.ok) {
    console.error(`[elevenlabs-deploy] POST failed: ${res.status} ${res.statusText}`);
    console.error(body);
    process.exit(1);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    console.error("[elevenlabs-deploy] Failed to parse response JSON:", body);
    process.exit(1);
  }

  const agentId = parsed["agent_id"] as string | undefined;

  console.log("\n=== Agent created successfully ===");
  console.log(`Agent ID: ${agentId}`);
  console.log("\nNext steps:");
  console.log("  1. Copy the Agent ID above and add it to .env.local:");
  console.log(`     ELEVENLABS_AGENT_ID=${agentId ?? "<agent_id>"}`);
  console.log("  2. Re-running this script will now PATCH (update) the agent instead of creating a new one.");
  if (WEBHOOK_SECRET) {
    console.log(`  3. Copy your ELEVENLABS_WEBHOOK_SECRET into ElevenLabs dashboard → Workspace → Webhooks → secret:`);
    console.log(`     ${WEBHOOK_SECRET}`);
  } else {
    console.log("  3. Generate a webhook secret (openssl rand -hex 32) and set ELEVENLABS_WEBHOOK_SECRET in .env.local,");
    console.log("     then add it in ElevenLabs dashboard → Workspace → Webhooks → secret.");
  }
  console.log("  4. Link your Twilio number +52 55 5351 0759 in ElevenLabs dashboard → Phone Numbers → Add → Twilio.");
  console.log("     See docs/voice/setup.md for full step-by-step instructions.");
}

async function updateAgent(agentId: string): Promise<void> {
  console.log(`[elevenlabs-deploy] Updating existing agent (PATCH) id=${agentId}...`);

  const res = await fetch(`${BASE_URL}/${agentId}`, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify(agentConfig),
  });

  const body = await res.text();

  if (!res.ok) {
    console.error(`[elevenlabs-deploy] PATCH failed: ${res.status} ${res.statusText}`);
    console.error(body);
    process.exit(1);
  }

  console.log("\n=== Agent updated successfully ===");
  console.log(`Agent ID: ${agentId}`);
  console.log(`Tools registered: ${tools.length}`);
  console.log("Voice prompt substituted TWILIO_WHATSAPP_FROM:", TWILIO_WHATSAPP_FROM);
  if (WEBHOOK_SECRET) {
    console.log(`Webhook secret (for ElevenLabs dashboard → Webhooks): ${WEBHOOK_SECRET}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[elevenlabs-deploy] Starting...");
  console.log(`  PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
  console.log(`  VOICE_ID:        ${VOICE_ID}`);
  console.log(`  Tools count:     ${tools.length}`);
  console.log(`  AGENT_ID:        ${AGENT_ID || "(not set — will CREATE)"}`);

  if (AGENT_ID) {
    await updateAgent(AGENT_ID);
  } else {
    await createAgent();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[elevenlabs-deploy] Unhandled error:", message);
  process.exit(1);
});
