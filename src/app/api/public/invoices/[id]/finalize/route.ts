import { NextResponse } from "next/server";
import { invoiceErrorResponse } from "@/lib/invoice/http";
import { finalizePayment } from "@/lib/invoice/payments";
import { clientIp, rateLimited } from "@/lib/invoice/ratelimit";
import { isInvoiceId } from "@/lib/invoice/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/public/invoices/<id>/finalize — `{ paymentIntentId }` after 3-D Secure or a redirect back. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isInvoiceId(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (rateLimited(`fin-ip:${clientIp(req)}`, 30, 10 * 60_000)) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  try {
    const body = (await req.json().catch(() => ({}))) as { paymentIntentId?: string };
    return NextResponse.json(await finalizePayment(id, String(body.paymentIntentId || "")));
  } catch (err) {
    return invoiceErrorResponse(err, "Could not confirm the payment");
  }
}
