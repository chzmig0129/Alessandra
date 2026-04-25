import { z } from "zod";
import { getOrCreateUser } from "@/memory/session";
import { processTurn } from "@/agent/orchestrator";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// CORS helpers (dev only)
// ---------------------------------------------------------------------------

const isDev = process.env.NODE_ENV === "development";

const corsHeaders: Record<string, string> = isDev
  ? {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    }
  : {};

export async function OPTIONS(): Promise<Response> {
  if (isDev) {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return new Response(null, { status: 405 });
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const attachmentsSchema = z
  .object({
    imageUrl: z.string().url().optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .optional();

const requestSchema = z.object({
  message: z.string().min(1).max(4000),
  attachments: attachmentsSchema,
  sessionId: z.string().min(8).max(128),
});

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  // Parse body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "invalid JSON" },
      { status: 400, headers: corsHeaders },
    );
  }

  // Validate
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", details: parsed.error.flatten() },
      { status: 400, headers: corsHeaders },
    );
  }

  const { message, attachments, sessionId } = parsed.data;

  try {
    // Resolve userId from sessionId
    const userResult = await getOrCreateUser("web:" + sessionId);
    if (!userResult.ok) {
      console.error("[chat] getOrCreateUser failed:", userResult.error);
      return Response.json(
        { error: "internal" },
        { status: 500, headers: corsHeaders },
      );
    }
    const userId = userResult.user.id;

    // Run conversation turn
    const result = await processTurn({
      userMessage: message,
      userId,
      channel: "web",
      sessionId,
      attachments,
    });

    return Response.json(result, { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("[chat] unhandled error:", err);
    return Response.json(
      { error: "internal" },
      { status: 500, headers: corsHeaders },
    );
  }
}
