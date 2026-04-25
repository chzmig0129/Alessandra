/**
 * elevenlabs-finalize-setup.ts
 *
 * Post-deploy script: creates the workspace webhook, attaches it to the agent,
 * imports the Twilio phone number into ElevenLabs, and assigns the agent to it.
 *
 * All four steps are idempotent via env-var guards:
 *   - ELEVENLABS_WEBHOOK_ID set   → skips steps 1 + 2 (webhook already created)
 *   - ELEVENLABS_PHONE_NUMBER_ID set → skips steps 3 + 4 (phone already imported)
 *
 * Usage:
 *   npm run voice:finalize
 *
 * Required env vars:
 *   ELEVENLABS_API_KEY      — ElevenLabs API key
 *   ELEVENLABS_AGENT_ID     — Agent ID (output of elevenlabs:deploy)
 *   PUBLIC_BASE_URL         — HTTPS base URL of this Next.js backend
 *   TWILIO_ACCOUNT_SID      — Twilio account SID
 *   TWILIO_AUTH_TOKEN       — Twilio auth token
 *
 * Optional env vars (set after first run):
 *   ELEVENLABS_WEBHOOK_ID       — If set, skips webhook creation
 *   ELEVENLABS_PHONE_NUMBER_ID  — If set, skips phone import
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PHONE_NUMBER = "+525553510759";
const PHONE_LABEL = "Alessandra Voz CDMX";
const WEBHOOK_NAME = "alessandra-voice-postcall";

// ---------------------------------------------------------------------------
// Read env vars
// ---------------------------------------------------------------------------

const API_KEY = process.env["ELEVENLABS_API_KEY"];
const AGENT_ID = process.env["ELEVENLABS_AGENT_ID"];
const PUBLIC_BASE_URL = process.env["PUBLIC_BASE_URL"];
const TWILIO_ACCOUNT_SID = process.env["TWILIO_ACCOUNT_SID"];
const TWILIO_AUTH_TOKEN = process.env["TWILIO_AUTH_TOKEN"];

// Optional — skip corresponding steps if already set
const EXISTING_WEBHOOK_ID = process.env["ELEVENLABS_WEBHOOK_ID"] ?? "";
const EXISTING_PHONE_NUMBER_ID = process.env["ELEVENLABS_PHONE_NUMBER_ID"] ?? "";

// ---------------------------------------------------------------------------
// Validate required vars
// ---------------------------------------------------------------------------

function abort(msg: string): never {
  console.error(`[voice:finalize] ERROR: ${msg}`);
  process.exit(1);
}

if (!API_KEY) abort("ELEVENLABS_API_KEY is required.");
if (!AGENT_ID) abort("ELEVENLABS_AGENT_ID is required.");
if (!PUBLIC_BASE_URL) abort("PUBLIC_BASE_URL is required.");
if (!TWILIO_ACCOUNT_SID) abort("TWILIO_ACCOUNT_SID is required.");
if (!TWILIO_AUTH_TOKEN) abort("TWILIO_AUTH_TOKEN is required.");

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

const COMMON_HEADERS: Record<string, string> = {
  "xi-api-key": API_KEY!,
  "Content-Type": "application/json",
};

async function apiFetch(
  url: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: COMMON_HEADERS,
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    const preview = text.slice(0, 300);
    console.error(`[voice:finalize] ${method} ${url} → ${res.status}`);
    console.error(`[voice:finalize] Response (truncated): ${preview}`);
    process.exit(1);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    console.error("[voice:finalize] Failed to parse JSON response:", text.slice(0, 300));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// .env.local append helper
// ---------------------------------------------------------------------------

const ENV_LOCAL_PATH = path.resolve(process.cwd(), ".env.local");

function appendEnvLocal(lines: string): void {
  const date = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(
    ENV_LOCAL_PATH,
    `\n# auto-added by voice:finalize on ${date}\n${lines}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Create workspace webhook
// ---------------------------------------------------------------------------

async function createWebhook(): Promise<string> {
  console.log("[voice:finalize] Step 1: Creating workspace webhook...");

  const data = (await apiFetch(
    "https://api.elevenlabs.io/v1/workspace/webhooks",
    "POST",
    {
      settings: {
        auth_type: "hmac",
        name: WEBHOOK_NAME,
        webhook_url: `${PUBLIC_BASE_URL}/api/agent/elevenlabs-webhook`,
      },
    },
  )) as Record<string, unknown>;

  const webhookId = data["webhook_id"] as string;
  const webhookSecret = data["webhook_secret"] as string;

  // Append both to .env.local — do NOT print secret
  appendEnvLocal(
    `ELEVENLABS_WEBHOOK_ID=${webhookId}\nELEVENLABS_WEBHOOK_SECRET=${webhookSecret}`,
  );

  console.log(
    `[voice:finalize] webhook created: ${webhookId} (secret saved, length=${webhookSecret?.length ?? 0})`,
  );

  return webhookId;
}

// ---------------------------------------------------------------------------
// Step 2 — Attach webhook to agent
// ---------------------------------------------------------------------------

async function attachWebhookToAgent(webhookId: string): Promise<void> {
  console.log(`[voice:finalize] Step 2: Attaching webhook ${webhookId} to agent ${AGENT_ID!}...`);

  await apiFetch(
    `https://api.elevenlabs.io/v1/convai/agents/${AGENT_ID!}`,
    "PATCH",
    {
      platform_settings: {
        workspace_overrides: {
          webhooks: {
            post_call_webhook_id: webhookId,
            events: ["transcript"],
          },
        },
      },
    },
  );

  console.log(`[voice:finalize] agent ${AGENT_ID!} webhook bound to ${webhookId}`);
}

// ---------------------------------------------------------------------------
// Step 3 — Import Twilio phone number
// ---------------------------------------------------------------------------

async function importPhoneNumber(): Promise<string> {
  console.log("[voice:finalize] Step 3: Importing Twilio phone number...");

  const data = (await apiFetch(
    "https://api.elevenlabs.io/v1/convai/phone-numbers",
    "POST",
    {
      provider: "twilio",
      phone_number: PHONE_NUMBER,
      label: PHONE_LABEL,
      sid: TWILIO_ACCOUNT_SID!,
      token: TWILIO_AUTH_TOKEN!,
    },
  )) as Record<string, unknown>;

  const phoneNumberId = data["phone_number_id"] as string;

  // Append to .env.local
  appendEnvLocal(`ELEVENLABS_PHONE_NUMBER_ID=${phoneNumberId}`);

  console.log(`[voice:finalize] phone imported: ${phoneNumberId}`);

  return phoneNumberId;
}

// ---------------------------------------------------------------------------
// Step 4 — Assign agent to phone number
// ---------------------------------------------------------------------------

async function assignAgentToPhone(phoneNumberId: string): Promise<void> {
  console.log(
    `[voice:finalize] Step 4: Assigning agent ${AGENT_ID!} to phone ${phoneNumberId}...`,
  );

  await apiFetch(
    `https://api.elevenlabs.io/v1/convai/phone-numbers/${phoneNumberId}`,
    "PATCH",
    {
      agent_id: AGENT_ID!,
    },
  );

  console.log(`[voice:finalize] phone ${phoneNumberId} assigned to agent ${AGENT_ID!}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[voice:finalize] Starting...");
  console.log(`  AGENT_ID:       ${AGENT_ID!}`);
  console.log(`  PUBLIC_BASE_URL: ${PUBLIC_BASE_URL!}`);
  console.log(
    `  WEBHOOK_ID:     ${EXISTING_WEBHOOK_ID || "(not set — will create)"}`,
  );
  console.log(
    `  PHONE_NUMBER_ID: ${EXISTING_PHONE_NUMBER_ID || "(not set — will import)"}`,
  );

  let webhookId = EXISTING_WEBHOOK_ID;
  let phoneNumberId = EXISTING_PHONE_NUMBER_ID;

  // Steps 1+2: webhook setup
  if (!webhookId) {
    try {
      webhookId = await createWebhook();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[voice:finalize] Step 1 failed:", message);
      process.exit(1);
    }
    try {
      await attachWebhookToAgent(webhookId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[voice:finalize] Step 2 failed:", message);
      process.exit(1);
    }
  } else {
    console.log(
      `[voice:finalize] ELEVENLABS_WEBHOOK_ID already set (${webhookId}) — skipping steps 1+2`,
    );
  }

  // Steps 3+4: phone number setup
  if (!phoneNumberId) {
    try {
      phoneNumberId = await importPhoneNumber();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[voice:finalize] Step 3 failed:", message);
      process.exit(1);
    }
    try {
      await assignAgentToPhone(phoneNumberId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[voice:finalize] Step 4 failed:", message);
      process.exit(1);
    }
  } else {
    console.log(
      `[voice:finalize] ELEVENLABS_PHONE_NUMBER_ID already set (${phoneNumberId}) — skipping steps 3+4`,
    );
  }

  // Done
  console.log("\n=== voice:finalize complete ===");
  console.log("Verify in ElevenLabs dashboard or run:");
  console.log(
    `  curl https://api.elevenlabs.io/v1/convai/phone-numbers/${phoneNumberId} \\`,
  );
  console.log(`    -H 'xi-api-key: $ELEVENLABS_API_KEY'`);
  console.log("to confirm assigned_agent.");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[voice:finalize] Unhandled error:", message);
  process.exit(1);
});
