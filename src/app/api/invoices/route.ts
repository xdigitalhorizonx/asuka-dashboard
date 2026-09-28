import { NextResponse } from "next/server";
import { storeMode } from "@/lib/blobstore";
import { invoiceErrorResponse, invoiceUrl, publicOrigin } from "@/lib/invoice/http";
import { paymentsStatus } from "@/lib/invoice/payments";
import { createInvoice, listInvoices } from "@/lib/invoice/store";
import { defaultCardFeePercent, validateInvoiceInput } from "@/lib/invoice/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/invoices — every invoice, newest first, plus payment-setup status (session-gated). */
export async function GET(req: Request) {
  const base = { payments: paymentsStatus(), cardFeeDefault: defaultCardFeePercent(), origin: publicOrigin(req), storage: storeMode() };
  if (base.storage === "none") return NextResponse.json({ ...base, invoices: [], error: "BLOB_READ_WRITE_TOKEN is not configured on this deployment" }, { status: 503 });
  try {
    return NextResponse.json({ ...base, invoices: await listInvoices() });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not load invoices");
  }
}

/** POST /api/invoices — create a live invoice from a reviewed draft. */
export async function POST(req: Request) {
  try {
    const input = validateInvoiceInput(await req.json().catch(() => null));
    const invoice = await createInvoice(input);
    return NextResponse.json({ invoice, url: invoiceUrl(publicOrigin(req), invoice.id) }, { status: 201 });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not create the invoice");
  }
}
