import { NextResponse } from "next/server";
import { invoiceErrorResponse } from "@/lib/invoice/http";
import { reconcileInvoice } from "@/lib/invoice/payments";
import { getInvoiceWithIntents } from "@/lib/invoice/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/invoices/<id>/refresh — ask Stripe about any payment attempts not yet recorded. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const found = await getInvoiceWithIntents(id);
    if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ invoice: await reconcileInvoice(found.invoice, found.pis) });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not check Stripe");
  }
}
