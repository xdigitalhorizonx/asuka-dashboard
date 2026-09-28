import { NextResponse } from "next/server";
import { invoiceErrorResponse, invoiceUrl, publicOrigin } from "@/lib/invoice/http";
import { invoicePdfFileName, renderInvoicePdf } from "@/lib/invoice/pdf";
import { clientIp, rateLimited } from "@/lib/invoice/ratelimit";
import { seller } from "@/lib/invoice/seller";
import { getInvoice, isInvoiceId } from "@/lib/invoice/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/public/invoices/<id>/pdf — the invoice as a real PDF file (download by default,
 * `?inline=1` to view in the browser). Public: the unguessable id is the credential.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isInvoiceId(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (rateLimited(`pdf-ip:${clientIp(req)}`, 40, 10 * 60_000)) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  try {
    const inv = await getInvoice(id);
    if (!inv) return NextResponse.json({ error: "not found" }, { status: 404 });
    const bytes = await renderInvoicePdf(inv, { seller: seller(), ...(inv.status === "open" ? { publicUrl: invoiceUrl(publicOrigin(req), inv.id) } : {}) });
    const inline = new URL(req.url).searchParams.get("inline") === "1";
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${invoicePdfFileName(inv)}"`,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not build the PDF");
  }
}
