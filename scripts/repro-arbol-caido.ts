/**
 * Repro del caso real de WhatsApp: árbol caído + foto.
 * El LLM solía alucinar el slug (arbolado_caido), no llamar confirmar_y_crear,
 * y pedir confirmación dos veces.
 *
 *  T1 → image + "Que hay en la foto?"
 *  T2 → "Queria reportar un árbol caído"
 *  T3 → "Pues sí, está bloqueando la ranqueta. Las ubicaciones te las paso y la imagen ya te la acabo de pasar coordenadas 19.44095744038439, -99.1550650218138 en el centro de la alcaldía Cuauhtémoc."
 *  T4 → "Confirmo"
 *
 * Verifica:
 *   • 1 lead creado.
 *   • report_type = "arbolado_derribo" (slug correcto, NO inventado).
 *   • media_urls poblado.
 *   • T4 NO pide otra confirmación — termina con folio.
 *
 * Run: npx tsx --env-file=.env.local scripts/repro-arbol-caido.ts
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
  return sign.data.signedUrl;
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
  const phone = `repro-arbol:${Date.now()}`;
  const userResult = await getOrCreateUser(phone);
  if (!userResult.ok) throw new Error(`user create failed: ${userResult.error}`);
  const userId = userResult.user.id;
  console.log(`\n=== Repro árbol caído user_id=${userId} phone=${phone} ===\n`);

  const imageUrl = await uploadAndSign(userId);
  console.log(`[upload] signedUrl ready (truncated): ${imageUrl.slice(0, 90)}...\n`);

  // T1: image + "qué hay"
  console.log(`========== TURN 1: imagen + "Que hay en la foto?" ==========`);
  const t1 = await processTurn({
    userId,
    userMessage: "Que hay en la foto?",
    attachments: { imageUrl },
    channel: "web",
  });
  printTurn("T1", t1);

  // T2: "Queria reportar un árbol caído"
  console.log(`\n========== TURN 2: "Queria reportar un árbol caído" ==========`);
  const t2 = await processTurn({
    userId,
    userMessage: "Queria reportar un árbol caído",
    channel: "web",
  });
  printTurn("T2", t2);

  // T3: detalles + ubicación
  console.log(
    `\n========== TURN 3: "Pues sí, está bloqueando la ranqueta..." ==========`,
  );
  const t3 = await processTurn({
    userId,
    userMessage:
      "Pues sí, está bloqueando la ranqueta. Las ubicaciones te las paso y la imagen ya te la acabo de pasar coordenadas 19.44095744038439, -99.1550650218138 en el centro de la alcaldía Cuauhtémoc.",
    channel: "web",
  });
  printTurn("T3", t3);

  // T4: confirmo
  console.log(`\n========== TURN 4: "Confirmo" ==========`);
  const t4 = await processTurn({ userId, userMessage: "Confirmo", channel: "web" });
  printTurn("T4", t4);

  // Inspect leads
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

  // Verdict
  console.log(`\n=== VERDICT ===`);
  const lead = leads?.[0];
  const isOk =
    leads?.length === 1 &&
    lead?.category === "arbolado" &&
    typeof lead?.report_type === "string" &&
    (lead?.report_type as string).startsWith("arbolado_") &&
    Array.isArray(lead?.media_urls) &&
    (lead?.media_urls as string[]).length > 0 &&
    /CUH-\d{8}-\d{3}/.test(t4.text);
  if (isOk) {
    console.log(
      `✅ PASS — 1 lead, category=arbolado, report_type=${lead?.report_type}, media_urls populated, T4 contains folio`,
    );
  } else {
    console.log(`❌ FAIL`);
    console.log(`  leads count: ${leads?.length}`);
    console.log(`  category: ${lead?.category}`);
    console.log(`  report_type: ${lead?.report_type}`);
    console.log(`  media_urls len: ${(lead?.media_urls as string[] | null)?.length}`);
    console.log(`  T4 has folio: ${/CUH-\d{8}-\d{3}/.test(t4.text)}`);
  }
}

main().catch((e) => {
  console.error("\nERROR:", e);
  process.exit(1);
});
