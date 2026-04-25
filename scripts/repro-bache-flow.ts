/**
 * Repro script: simulates the full WhatsApp bache reporting flow end-to-end
 * directly hitting processTurn (skipping Twilio webhook).
 *
 * Steps:
 *   1. Upload Bache.jpeg from repo root to citizen-report-media bucket.
 *   2. Get a signed URL (mimicking what uploadTwilioMediaToBucket returns).
 *   3. processTurn turn 1: "Quiero reportar un bache..." + imageUrl attachment.
 *   4. processTurn turn 2: "si"
 *   5. processTurn turn 3: "confirmo"
 *   6. Inspect flow state and the resulting lead in the DB.
 *
 * Run: npx tsx scripts/repro-bache-flow.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { processTurn } from "@/agent/orchestrator";
import { getOrCreateUser } from "@/memory/session";
import { supabaseAdmin } from "@/db/supabase-server";

const BUCKET = "citizen-report-media";
const IMG_PATH = resolve(process.cwd(), "Bache.jpeg");

async function uploadAndSign(userId: string): Promise<string> {
  const buf = readFileSync(IMG_PATH);
  const path = `whatsapp/${userId}/${randomUUID()}.jpg`;
  const up = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, buf, { contentType: "image/jpeg", upsert: false });
  if (up.error) throw new Error(`upload failed: ${up.error.message}`);
  const sign = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (sign.error || !sign.data?.signedUrl) {
    throw new Error(`signed url failed: ${sign.error?.message ?? "no url"}`);
  }
  console.log(`[upload] path=${path}`);
  console.log(`[upload] signedUrl=${sign.data.signedUrl.slice(0, 100)}...`);
  return sign.data.signedUrl;
}

async function loadFlow(conversationId: string) {
  const { data } = await supabaseAdmin
    .from("conversations")
    .select("current_flow")
    .eq("id", conversationId)
    .maybeSingle();
  return data?.current_flow ?? null;
}

async function findActiveConversation(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

interface ToolCall {
  toolName?: string;
  name?: string;
  args?: Record<string, unknown>;
}

function printTurn(label: string, r: { text: string; debug?: Record<string, unknown> }) {
  console.log(`\n--- ${label} response ---`);
  console.log(r.text.slice(0, 400) + (r.text.length > 400 ? "…" : ""));
  const toolCalls = (r.debug?.tool_calls ?? []) as ToolCall[];
  if (toolCalls.length) {
    console.log(`\n--- ${label} tool calls (${toolCalls.length}) ---`);
    for (const tc of toolCalls) {
      const name = tc.toolName ?? tc.name ?? "?";
      const args = tc.args ?? {};
      const compact: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === "string" && v.length > 80) {
          compact[k] = v.slice(0, 80) + "…";
        } else {
          compact[k] = v;
        }
      }
      console.log(`  ${name}(${JSON.stringify(compact)})`);
    }
  }
}

async function main() {
  // Use a stable phone-like id so we can spot the convo afterward.
  const phone = `repro:${Date.now()}`;
  const userResult = await getOrCreateUser(phone);
  if (!userResult.ok) throw new Error(`user create failed: ${userResult.error}`);
  const userId = userResult.user.id;
  console.log(`\n=== Repro user_id=${userId} phone=${phone} ===\n`);

  // 1. Upload image and get signed URL
  const imageUrl = await uploadAndSign(userId);

  // 2. Turn 1: initial message with image + coords in text
  console.log(`\n========== TURN 1: bache + foto ==========`);
  const t1 = await processTurn({
    userId,
    userMessage:
      "Quiero reportar un bache, que esta en estas coordenadas 19.44095744038439, -99.1550650218138 en el centro de la alcaldía Cuauhtémoc.",
    attachments: { imageUrl },
  });
  printTurn("T1", t1);

  const conversationId = await findActiveConversation(userId);
  console.log(`\n[debug] conversationId=${conversationId}`);
  const flow1 = await loadFlow(conversationId!);
  console.log(`[debug] flow after T1 slots=${JSON.stringify((flow1 as any)?.slots ?? null)}`);
  console.log(`[debug] flow after T1 step=${(flow1 as any)?.step}`);

  // 3. Turn 2: "si"
  console.log(`\n========== TURN 2: si ==========`);
  const t2 = await processTurn({
    userId,
    userMessage: "si",
    attachments: { imageUrl }, // simulating subsequent webhook turn (no new image)
  });
  printTurn("T2", t2);

  const flow2 = await loadFlow(conversationId!);
  console.log(`\n[debug] flow after T2 slots=${JSON.stringify((flow2 as any)?.slots ?? null)}`);
  console.log(`[debug] flow after T2 step=${(flow2 as any)?.step}`);

  // 4. Turn 3: "confirmo"
  console.log(`\n========== TURN 3: confirmo ==========`);
  const t3 = await processTurn({
    userId,
    userMessage: "confirmo",
    attachments: { imageUrl },
  });
  printTurn("T3", t3);

  const flow3 = await loadFlow(conversationId!);
  console.log(`\n[debug] flow after T3 slots=${JSON.stringify((flow3 as any)?.slots ?? null)}`);
  console.log(`[debug] flow after T3 step=${(flow3 as any)?.step}`);

  // 5. Inspect leads created for this user
  const { data: leads } = await supabaseAdmin
    .from("leads")
    .select("folio, category, report_type, media_urls, lat, lng, report, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(5);
  console.log(`\n=== leads for this user (${leads?.length ?? 0}) ===`);
  for (const l of leads ?? []) {
    console.log(JSON.stringify(l));
  }

  console.log("\n=== repro complete ===");
}

main().catch((e) => {
  console.error("\nERROR:", e);
  process.exit(1);
});
