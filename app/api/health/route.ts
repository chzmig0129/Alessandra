import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/db/supabase-server";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  let db: "ok" | "fail" = "fail";
  let mundial_views_present = false;

  // Verify basic DB connectivity
  try {
    const { error } = await supabaseAdmin.from("users").select("id").limit(1);
    if (!error) {
      db = "ok";
    }
  } catch {
    db = "fail";
  }

  // Check if mundial views are present
  try {
    const { error } = await supabaseAdmin
      .from("v_mundial_partidos")
      .select("id")
      .limit(1);
    if (!error) {
      mundial_views_present = true;
    }
  } catch {
    mundial_views_present = false;
  }

  const body = {
    ok: db === "ok",
    ts: new Date().toISOString(),
    db,
    mundial_views_present,
  };

  return NextResponse.json(body, { status: db === "ok" ? 200 : 503 });
}
