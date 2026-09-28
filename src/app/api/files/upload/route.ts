import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { storeMode } from "@/lib/blobstore";
import { FILE_MAX_BYTES, parseFilePathname } from "@/lib/files-shared";
import { errorMessage } from "@/lib/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/files/upload — signs a one-hour client token so the browser can upload a
 * file straight to Vercel Blob (no 4.5 MB function body cap). Session-gated by
 * proxy.ts. Only paths of the form files/<16-char id>/<safe name> are signed, never
 * an overwrite, and no completion callback is registered (the listing is the record).
 */
export async function POST(req: Request) {
  if (storeMode() !== "vercel") {
    return NextResponse.json({ error: "Client uploads need Vercel Blob (BLOB_READ_WRITE_TOKEN)." }, { status: 501 });
  }
  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    const result = await handleUpload({
      body,
      request: req,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async (pathname) => {
        if (!parseFilePathname(pathname)) throw new Error("invalid upload path");
        return {
          maximumSizeInBytes: FILE_MAX_BYTES,
          addRandomSuffix: false,
          allowOverwrite: false,
          validUntil: Date.now() + 60 * 60 * 1000,
        };
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "upload not allowed" }, { status: 400 });
  }
}
