import { NextResponse } from "next/server";
import { invoiceErrorResponse, invoiceUrl, publicOrigin } from "@/lib/invoice/http";
import { payInvoice } from "@/lib/invoice/payments";
import { clientIp, rateLimited } from "@/lib/invoice/ratelimit";
import { isInvoiceId } from "@/lib/invoice/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/public/invoices/<id>/pay — `{ confirmationTokenId, expectedTotalCents, part }`.
 * The server recomputes the amount from the invoice; the browser's figure (and the deposit
 * part it showed) is only a check that the customer saw what they're being charged for.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isInvoiceId(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (rateLimited(`pay:${id}`, 8, 10 * 60_000) || rateLimited(`pay-ip:${clientIp(req)}`, 12, 10 * 60_000)) {
    return NextResponse.json({ error: "Too many payment attempts — please wait a few minutes, or contact us to pay." }, { status: 429 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { confirmationTokenId?: string; expectedTotalCents?: number; part?: unknown };
    const expected = Number(body.expectedTotalCents);
    if (!Number.isInteger(expected) || expected <= 0) return NextResponse.json({ error: "Missing the amount you reviewed — please review the payment again." }, { status: 400 });
    const part = typeof body.part === "string" ? body.part : "";
    const result = await payInvoice(id, String(body.confirmationTokenId || ""), expected, invoiceUrl(publicOrigin(req), id), part);
    return NextResponse.json(result);
  } catch (err) {
    return invoiceErrorResponse(err, "The payment could not be started");
  }
}
