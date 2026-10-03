import { NextResponse } from "next/server";
import { invoiceErrorResponse } from "@/lib/invoice/http";
import { recordOfflinePayment } from "@/lib/invoice/offline";
import { getInvoice, isInvoiceId } from "@/lib/invoice/store";
import { localYmd } from "@/lib/invoice/types";
import { validateRecordedPayment } from "@/lib/invoice/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/invoices/<id>/payments — record a check / cash / ACH / other payment:
 * `{ method, amount, date: "YYYY-MM-DD", reference, requestId }`. It counts toward the
 * balance like a card payment (a deposit-sized one leaves the rest due; the full amount
 * marks the invoice paid) and lands on the client's Customers tab.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const invoice = isInvoiceId(id) ? await getInvoice(id) : null;
    if (!invoice) return NextResponse.json({ error: "not found" }, { status: 404 });
    const input = validateRecordedPayment(await req.json().catch(() => ({})), localYmd(new Date().toISOString()));
    return NextResponse.json({ invoice: await recordOfflinePayment(invoice, input) });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not record the payment");
  }
}
