/**
 * Multi-turn repro: imita el flujo exacto del usuario en WhatsApp.
 *
 *  T1 → user envía imagen + "Que hay en la foto?"  → bot describe vía vision tool
 *  T2 → user (SIN imagen) escribe "si quiero hacer un reporte. Quiero reportar
 *       un bache, que esta en estas coordenadas X, Y en el centro de la
 *       alcaldía Cuauhtémoc."
 *  T3 → user "confirmo"
 *
 * Verifica:
 *   • T1 invoca reporte_analizar_imagen y produce descripción.
 *   • T3 produce un solo lead con media_urls poblado (la foto de T1 debe
 *     persistir como fotos del reporte aunque T2/T3 no traigan imagen nueva).
 *   • T3 NO produce un segundo "confirma de nuevo" — debe cerrar con folio.
 *
 * Run: npx tsx --env-file=.env.local scripts/repro-multiturn-bache.ts
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
    throw new Error(`sign failed: ${sign.error?.message ?? "no url"}`);
  }
  console.log(`[upload] path=${path}`);
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

function compactArgs(args: Record<string, unknown> | undefined) {
  if (!args) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > 90) out[k] = v.slice(0, 90) + "…";
    else out[k] = v;
  }
  return out;
}

function printTurn(label: string, r: { text: string; debug?: Record<string, unknown> }) {
  console.log(`\n--- ${label} response (${r.text.length} chars) ---`);
  console.log(r.text.slice(0, 500) + (r.text.length > 500 ? "…" : ""));
  const toolCalls = (r.debug?.tool_calls ?? []) as ToolCall[];
  console.log(`\n--- ${label} tool calls (${toolCalls.length}) ---`);
  for (const tc of toolCalls) {
    const name = tc.toolName ?? tc.name ?? "?";
    console.log(`  ${name}(${JSON.stringify(compactArgs(tc.args))})`);
  }
}

async function main() {
  const phone = `repro-mt:${Date.now()}`;
  const userResult = await getOrCreateUser(phone);
  if (!userResult.ok) throw new Error(`user create failed: ${userResult.error}`);
  const userId = userResult.user.id;
  console.log(`\n=== Multi-turn repro user_id=${userId} phone=${phone} ===\n`);

  const imageUrl = await uploadAndSign(userId);

  // T1: image + "Que hay en la foto?"
  console.log(`\n========== TURN 1: imagen + "Que hay en la foto?" ==========`);
  const t1 = await processTurn({
    userId,
    userMessage: "Que hay en la foto?",
    attachments: { imageUrl },
  });
  printTurn("T1", t1);

  const conversationId = await findActiveConversation(userId);
  console.log(`\n[debug] conversationId=${conversationId}`);

  // T2: "si quiero hacer un reporte..." (SIN imagen — esto es clave)
  console.log(`\n========== TURN 2: "si quiero hacer un reporte..." (SIN attachment) ==========`);
  const t2 = await processTurn({
    userId,
    userMessage:
      "si quiero hacer un reporte\n\nQuiero reportar un bache, que esta en estas coordenadas 19.44095744038439, -99.1550650218138 en el centro de la alcaldía Cuauhtémoc.",
    // attachments NO se pasa — simula que el usuario en WhatsApp solo adjuntó
    // la foto en T1 y los siguientes turns son texto plano.
  });
  printTurn("T2", t2);

  const flow2 = await loadFlow(conversationId!);
  console.log(`\n[debug] flow.slots after T2:`, JSON.stringify((flow2 as { slots?: unknown })?.slots ?? null));
  console.log(`[debug] flow.step after T2:`, (flow2 as { step?: unknown })?.step);

  // T3: "confirmo"
  console.log(`\n========== TURN 3: "confirmo" ==========`);
  const t3 = await processTurn({
    userId,
    userMessage: "confirmo",
  });
  printTurn("T3", t3);

  const flow3 = await loadFlow(conversationId!);
  console.log(`\n[debug] flow.slots after T3:`, JSON.stringify((flow3 as { slots?: unknown })?.slots ?? null));
  console.log(`[debug] flow.step after T3:`, (flow3 as { step?: unknown })?.step);

  // 5. Inspect leads
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

  // 6. Verdict
  console.log(`\n=== VERDICT ===`);
  const ok =
    (leads?.length ?? 0) === 1 &&
    Array.isArray(leads?.[0]?.media_urls) &&
    (leads?.[0]?.media_urls as string[]).length > 0;
  if (ok) console.log(`✅ PASS — 1 lead, media_urls populated`);
  else console.log(`❌ FAIL — leads=${leads?.length ?? 0}, media_urls=${JSON.stringify(leads?.[0]?.media_urls)}`);

  console.log("\n=== repro done ===");
}

main().catch((e) => {
  console.error("\nERROR:", e);
  process.exit(1);
});
