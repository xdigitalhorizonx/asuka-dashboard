import { NextResponse } from "next/server";
import { invoiceErrorResponse } from "@/lib/invoice/http";
import { reconcileInvoice, retrySubscriptions } from "@/lib/invoice/payments";
import { getInvoiceWithIntents } from "@/lib/invoice/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/invoices/<id>/refresh — ask Stripe about any payment attempts not yet recorded,
 * then start the subscription a paid invoice's recurring lines should have but don't.
 * A subscription problem comes back as `warning` next to the (possibly just-paid) invoice,
 * so a payment recorded here is never hidden behind that error.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const found = await getInvoiceWithIntents(id);
    if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });
    const invoice = await reconcileInvoice(found.invoice, found.pis);
    try {
      return NextResponse.json({ invoice: await retrySubscriptions(invoice) });
    } catch (err) {
      console.error(`invoice ${invoice.number}: subscription retry failed`, err);
      return NextResponse.json({ invoice, warning: err instanceof Error ? err.message : "The monthly billing couldn't be started." });
    }
  } catch (err) {
    return invoiceErrorResponse(err, "Could not check Stripe");
  }
}
