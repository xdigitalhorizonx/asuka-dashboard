import { NextResponse } from "next/server";
import { invoiceErrorResponse } from "@/lib/invoice/http";
import { deleteInvoice, getInvoice, isInvoiceId, saveVersion } from "@/lib/invoice/store";
import { isCardPayment, type Invoice } from "@/lib/invoice/types";
import { validateInvoiceInput } from "@/lib/invoice/validate";

/** How to get a payment off this invoice: refund a card one in Stripe; remove one recorded by hand. */
function undoHint(inv: Invoice): string {
  return inv.payments.some(isCardPayment) ? "refund the card payment in Stripe first" : "remove the recorded payment first (More → Payments)";
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function load(ctx: Ctx) {
  const { id } = await ctx.params;
  return isInvoiceId(id) ? getInvoice(id) : null;
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const invoice = await load(ctx);
    return invoice ? NextResponse.json({ invoice }) : NextResponse.json({ error: "not found" }, { status: 404 });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not load the invoice");
  }
}

/**
 * PATCH /api/invoices/<id> — `{ expectedVersion, action: "edit", input }` rewrites an
 * unpaid invoice; `"void"` / `"unvoid"` toggle it. Each change is a new saved version.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const invoice = await load(ctx);
    if (!invoice) return NextResponse.json({ error: "not found" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { expectedVersion?: number; action?: string; input?: unknown };
    const expected = Number(body.expectedVersion);
    if (body.action === "edit") {
      if (invoice.payments.length) {
        const fix = invoice.payments.some(isCardPayment) ? "Void it and issue a new one." : "Remove the recorded payment first (More → Payments), or void it and issue a new one.";
        return NextResponse.json({ error: `This invoice already has a payment, so its lines can't change. ${fix}` }, { status: 409 });
      }
      return NextResponse.json({ invoice: await saveVersion(invoice, validateInvoiceInput(body.input), expected) });
    }
    if (body.action === "void") {
      if (invoice.status === "paid") return NextResponse.json({ error: `A paid invoice can't be voided — ${undoHint(invoice)}.` }, { status: 409 });
      return NextResponse.json({ invoice: await saveVersion(invoice, { voided: true }, expected) });
    }
    if (body.action === "unvoid") {
      return NextResponse.json({ invoice: await saveVersion(invoice, { voided: false }, expected) });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not update the invoice");
  }
}

/** DELETE /api/invoices/<id> — only for an invoice nobody has paid (its link stops working). */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const invoice = await load(ctx);
    if (!invoice) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (invoice.payments.length) {
      const fix = invoice.payments.some(isCardPayment) ? "void it instead" : "remove the recorded payment first (More → Payments), or void it instead";
      return NextResponse.json({ error: `This invoice has a payment — ${fix}.` }, { status: 409 });
    }
    await deleteInvoice(invoice);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not delete the invoice");
  }
}
