import { NextResponse } from "next/server";
import { listObjects, openObject } from "@/lib/blobstore";
import { invoiceErrorResponse } from "@/lib/invoice/http";
import { getInvoice, PROPOSALS_PREFIX } from "@/lib/invoice/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/invoices/<id>/source — the proposal PDF the invoice was generated from (session-gated). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const invoice = await getInvoice(id);
    const path = invoice?.source?.path;
    if (!invoice || !path || !path.startsWith(PROPOSALS_PREFIX)) return NextResponse.json({ error: "not found" }, { status: 404 });
    const obj = (await listObjects(path)).find((o) => o.pathname === path);
    const body = obj ? await openObject(obj) : null;
    if (!body) return NextResponse.json({ error: "not found" }, { status: 404 });
    const name = (invoice.source?.fileName || "proposal.pdf").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new Response(body.stream, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${name}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not open the proposal");
  }
}
