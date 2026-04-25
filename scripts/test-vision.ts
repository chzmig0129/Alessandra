/**
 * Direct test of the vision tool against a freshly-uploaded signed URL.
 * Run: npx tsx --env-file=.env.local scripts/test-vision.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { supabaseAdmin } from "@/db/supabase-server";
import { analyzeImage } from "@/tools/shared/vision";

const BUCKET = "citizen-report-media";
const IMG_PATH = resolve(process.cwd(), "Bache.jpeg");

async function main() {
  // 1. Upload + sign
  const buf = readFileSync(IMG_PATH);
  const path = `vision-test/${randomUUID()}.jpg`;
  const up = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, buf, { contentType: "image/jpeg", upsert: false });
  if (up.error) throw new Error(`upload failed: ${up.error.message}`);
  const sign = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (sign.error || !sign.data?.signedUrl) {
    throw new Error(`sign failed: ${sign.error?.message ?? "no url"}`);
  }
  const url = sign.data.signedUrl;
  console.log(`[vision-test] signed URL (truncated): ${url.slice(0, 120)}...`);

  // 2. Try analyzeImage
  console.log(`\n[vision-test] calling analyzeImage…`);
  try {
    const result = await analyzeImage(url);
    console.log(`[vision-test] OK`);
    console.log(`  description: ${result.description}`);
    console.log(`  suggested_category: ${result.suggested_category ?? "(none)"}`);
    console.log(`  raw: ${JSON.stringify(result.raw)}`);
  } catch (err) {
    console.error(`[vision-test] FAILED:`, err);
    if (err instanceof Error) {
      console.error(`  name: ${err.name}`);
      console.error(`  message: ${err.message}`);
      console.error(`  stack: ${err.stack?.split("\n").slice(0, 5).join("\n")}`);
      // Anthropic AI SDK errors sometimes have .response or .cause
      const anyErr = err as { response?: unknown; cause?: unknown; statusCode?: number };
      if (anyErr.cause) console.error(`  cause:`, anyErr.cause);
      if (anyErr.response) console.error(`  response:`, anyErr.response);
      if (anyErr.statusCode) console.error(`  statusCode: ${anyErr.statusCode}`);
    }
  }

  // 3. Cleanup
  await supabaseAdmin.storage.from(BUCKET).remove([path]);
}

main().catch((e) => {
  console.error(`\nFATAL:`, e);
  process.exit(1);
});
