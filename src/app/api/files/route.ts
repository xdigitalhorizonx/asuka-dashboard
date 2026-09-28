import { NextResponse } from "next/server";
import { storeMode } from "@/lib/blobstore";
import { listFiles, saveFile } from "@/lib/files";
import { FILE_MAX_BYTES, isFileId, safeFileName } from "@/lib/files-shared";
import { errorMessage } from "@/lib/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/files — the Attachments list (session-gated by proxy.ts).
 * `mode` tells the browser how to upload: "vercel" = direct-to-Blob client upload via
 * /api/files/upload; "local" = POST the bytes here (dev only); "none" = storage missing.
 */
export async function GET() {
  const mode = storeMode();
  if (mode === "none") {
    return NextResponse.json({ mode, maxBytes: FILE_MAX_BYTES, files: [], error: "BLOB_READ_WRITE_TOKEN is not configured on this deployment" }, { status: 503 });
  }
  try {
    const files = (await listFiles()).map(({ id, name, size, uploadedAt }) => ({ id, name, size, uploadedAt }));
    return NextResponse.json({ mode, maxBytes: FILE_MAX_BYTES, files });
  } catch (err) {
    return NextResponse.json({ mode, maxBytes: FILE_MAX_BYTES, files: [], error: errorMessage(err) || "Could not list files" }, { status: 502 });
  }
}

/**
 * POST /api/files — local-dev upload path only (raw body, `x-file-id` + `x-file-name`
 * headers). On Vercel the browser uploads straight to Blob instead, which is what
 * lifts the 4.5 MB request cap that made large attachments fail.
 */
export async function POST(req: Request) {
  if (storeMode() !== "local") {
    return NextResponse.json({ error: "Uploads go directly to storage on this deployment (/api/files/upload)." }, { status: 405 });
  }
  const id = req.headers.get("x-file-id") || "";
  const rawName = decodeURIComponent(req.headers.get("x-file-name") || "");
  if (!isFileId(id) || !rawName) return NextResponse.json({ error: "x-file-id and x-file-name required" }, { status: 400 });
  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.byteLength > FILE_MAX_BYTES) return NextResponse.json({ error: "file too large" }, { status: 413 });
  try {
    const obj = await saveFile(id, rawName, bytes, req.headers.get("content-type") || "application/octet-stream");
    return NextResponse.json({ id, name: safeFileName(rawName), size: obj.size, uploadedAt: obj.uploadedAt });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "upload failed" }, { status: 500 });
  }
}
