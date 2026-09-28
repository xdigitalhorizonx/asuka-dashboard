import { NextResponse } from "next/server";
import { openObject } from "@/lib/blobstore";
import { deleteFile, findFile } from "@/lib/files";
import { isFileId } from "@/lib/files-shared";
import { errorMessage } from "@/lib/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Types a browser may render in the tab; anything else downloads. */
const INLINE = /^(application\/pdf|image\/(png|jpe?g|gif|webp|avif|heic)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|ogg|webm|x-m4a)|text\/plain)(;|$)/i;

function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * GET /api/files/<id> — stream a stored attachment (session-gated by proxy.ts).
 * `?download=1` forces a download. Bytes are proxied rather than redirected so the
 * storage URL never reaches the browser.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isFileId(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const file = await findFile(id);
    const body = file ? await openObject(file.obj) : null;
    if (!file || !body) return NextResponse.json({ error: "not found" }, { status: 404 });
    const wantsDownload = new URL(req.url).searchParams.get("download") === "1";
    const inline = !wantsDownload && INLINE.test(body.contentType);
    const headers: Record<string, string> = {
      "Content-Type": body.contentType,
      "Content-Disposition": disposition(inline ? "inline" : "attachment", file.name),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    };
    if (body.size) headers["Content-Length"] = String(body.size);
    // Chrome won't render PDFs under a sandbox CSP; everything else shown inline is sandboxed.
    if (inline && !/^application\/pdf/i.test(body.contentType)) headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
    return new Response(body.stream, { headers });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "could not read file" }, { status: 502 });
  }
}

/** DELETE /api/files/<id> — remove an attachment for good. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isFileId(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const removed = await deleteFile(id);
    return removed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not found" }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "delete failed" }, { status: 502 });
  }
}
