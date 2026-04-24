import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/db/supabase-server";

export const runtime = "nodejs";

const BUCKET = process.env.STORAGE_BUCKET ?? "citizen-report-media";
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const SIGNED_URL_TTL = 3600; // 1 hour in seconds

const ALLOWED_MIMES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

export async function POST(req: Request): Promise<NextResponse> {
  // --- Parse multipart form data ---
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart/form-data body" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const sessionId = formData.get("sessionId") as string | null;

  // --- Validate sessionId ---
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
    return NextResponse.json(
      { error: "sessionId is required and must match /^[a-zA-Z0-9_-]{8,128}$/" },
      { status: 400 },
    );
  }

  // --- Validate file presence ---
  if (!file) {
    return NextResponse.json({ error: "file field is required" }, { status: 400 });
  }

  // --- Validate MIME type ---
  const mimeType = file.type;
  const ext = ALLOWED_MIMES[mimeType];
  if (!mimeType.startsWith("image/") || ext === undefined) {
    return NextResponse.json(
      {
        error: `Unsupported file type: ${mimeType}. Allowed: jpeg, jpg, png, webp, heic, heif`,
      },
      { status: 415 },
    );
  }

  // --- Validate size ---
  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { error: `File too large: ${file.size} bytes. Maximum is ${MAX_SIZE} bytes (10 MB)` },
      { status: 413 },
    );
  }

  // --- Read file bytes once ---
  const buffer = Buffer.from(await file.arrayBuffer());

  // --- Build storage path ---
  // web/ prefix distinguishes web uploads from twilio-uploaded media in the same bucket
  const uniqueId = crypto.randomUUID();
  const path = `web/${sessionId}/${uniqueId}.${ext}`;

  // --- Upload ---
  const { error: uploadError } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: false });

  if (uploadError) {
    return NextResponse.json(
      { error: "Upload failed", details: uploadError.message },
      { status: 500 },
    );
  }

  // --- Signed URL (bucket is private; valid for 1 hour) ---
  const { data: signedData, error: signedError } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);

  if (signedError || !signedData?.signedUrl) {
    return NextResponse.json(
      { error: "Signed URL generation failed", details: signedError?.message },
      { status: 500 },
    );
  }

  // --- SHA-256 hash ---
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  return NextResponse.json(
    { url: signedData.signedUrl, sha256, path, expiresInSec: SIGNED_URL_TTL },
    { status: 200 },
  );
}
