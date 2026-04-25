/**
 * POST /api/agent/voice-tools/[tool]
 *
 * HTTP endpoint that exposes bot tools for ElevenLabs Agents server-tool
 * webhooks.  Each tool is a separate URL segment so ElevenLabs can register
 * them individually, but all share this single route handler.
 *
 * Auth: Authorization: Bearer <ELEVENLABS_TOOLS_BEARER>
 * Body (JSON):
 *   {
 *     conversation_id?: string   // prefer over auto-resolve
 *     user_id?:         string   // prefer over phone lookup
 *     phone?:           string   // fallback to resolve user_id
 *     lat?:             number
 *     lng?:             number
 *     language?:        string   // default "es"
 *     args:             unknown  // forwarded verbatim to dispatchTool
 *   }
 *
 * Spec: AGENTE_ALESSANDRA-pos.4
 */

import { NextRequest, NextResponse } from "next/server";
import { dispatchTool } from "@/agent/tool-dispatcher";
import { getOrCreateUser, getOrCreateActiveSession } from "@/memory/session";
import { VOICE_TOOL_ALLOWLIST } from "@/agent/voice-tools-allowlist";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Bearer auth
// ---------------------------------------------------------------------------

/**
 * Simple string equality bearer check.
 * Constant-time comparison is ideal but acceptable as simple equality given
 * this is a bearer secret (not an HMAC signature).
 */
function checkBearer(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${process.env.ELEVENLABS_TOOLS_BEARER ?? ""}`;
  return authHeader === expected;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ tool: string }> },
): Promise<NextResponse> {
  // ---- 1. Bearer auth -------------------------------------------------------

  if (!checkBearer(req)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  // ---- 2. Resolve tool name -------------------------------------------------

  const { tool } = await params;

  if (!VOICE_TOOL_ALLOWLIST.includes(tool)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Tool "${tool}" is not available on the voice channel. Permitted tools: ${VOICE_TOOL_ALLOWLIST.join(", ")}`,
      },
      { status: 400 },
    );
  }

  // ---- 3. Parse body --------------------------------------------------------

  let body: {
    conversation_id?: string;
    user_id?: string;
    phone?: string;
    lat?: number;
    lng?: number;
    language?: string;
    args?: unknown;
  };

  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { args = {} } = body;

  // ---- 4. Guard: reporte_slot_llenar + slot=fotos ---------------------------

  if (tool === "reporte_slot_llenar") {
    const slotArgs = args as Record<string, unknown>;
    if (slotArgs.slot === "fotos") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Para anexar foto, mande WhatsApp con su folio. La carga de imágenes no está disponible por voz.",
        },
        { status: 400 },
      );
    }
  }

  // ---- 5. Resolve user_id ---------------------------------------------------

  let userId: string;

  if (body.user_id) {
    userId = body.user_id;
  } else if (body.phone) {
    const userResult = await getOrCreateUser(body.phone);
    if (!userResult.ok) {
      return NextResponse.json(
        { ok: false, error: `Failed to resolve user: ${userResult.error}` },
        { status: 500 },
      );
    }
    userId = userResult.user.id;
  } else {
    return NextResponse.json(
      { ok: false, error: "Body must include user_id or phone" },
      { status: 400 },
    );
  }

  // ---- 6. Resolve conversation_id -------------------------------------------

  let conversationId: string;

  if (body.conversation_id) {
    conversationId = body.conversation_id;
  } else {
    try {
      const session = await getOrCreateActiveSession(userId, "voice");
      conversationId = session.conversationId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { ok: false, error: `Failed to resolve session: ${msg}` },
        { status: 500 },
      );
    }
  }

  // ---- 7. Dispatch tool -----------------------------------------------------

  const result = await dispatchTool({
    tool,
    args,
    context: {
      conversation_id: conversationId,
      user_id: userId,
      lat: body.lat,
      lng: body.lng,
      language: body.language ?? "es",
    },
  });

  // ---- 8. Return result -----------------------------------------------------

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
