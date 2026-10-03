import { NextResponse } from "next/server";
import { invoiceErrorResponse } from "@/lib/invoice/http";
import { removeOfflinePayment } from "@/lib/invoice/offline";
import { getInvoice, isInvoiceId } from "@/lib/invoice/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/invoices/<id>/payments/<paymentId> — undo a payment recorded by hand (never a card payment). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; paymentId: string }> }) {
  try {
    const { id, paymentId } = await params;
    const invoice = isInvoiceId(id) ? await getInvoice(id) : null;
    if (!invoice) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!/^off_[A-Za-z0-9]{12,40}$/.test(paymentId)) return NextResponse.json({ error: "Only payments recorded by hand can be removed." }, { status: 400 });
    return NextResponse.json({ invoice: await removeOfflinePayment(invoice, paymentId) });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not remove the payment");
  }
}
