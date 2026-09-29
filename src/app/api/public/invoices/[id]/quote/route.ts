import { NextResponse } from "next/server";
import { invoiceErrorResponse } from "@/lib/invoice/http";
import { quoteCard } from "@/lib/invoice/payments";
import { clientIp, rateLimited } from "@/lib/invoice/ratelimit";
import { getInvoice, isInvoiceId } from "@/lib/invoice/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/public/invoices/<id>/quote — `{ confirmationTokenId, part }` → the exact amount this
 * card would pay (credit cards carry the invoice's card fee; debit/prepaid don't). `part` is the
 * deposit-invoice payment the page shows ("deposit" / "balance" / ""); 409 if that changed.
 * Public: the unguessable invoice id in the path is the credential.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isInvoiceId(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (rateLimited(`quote:${id}`, 30, 10 * 60_000) || rateLimited(`quote-ip:${clientIp(req)}`, 60, 10 * 60_000)) {
    return NextResponse.json({ error: "Too many attempts — please wait a few minutes and try again." }, { status: 429 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { confirmationTokenId?: string; part?: unknown };
    const invoice = await getInvoice(id);
    if (!invoice) return NextResponse.json({ error: "not found" }, { status: 404 });
    // Pages from before deposits existed send no part: those are plain invoices ("").
    const part = typeof body.part === "string" ? body.part : "";
    return NextResponse.json({ quote: await quoteCard(invoice, String(body.confirmationTokenId || ""), part) });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not price this card");
  }
}
