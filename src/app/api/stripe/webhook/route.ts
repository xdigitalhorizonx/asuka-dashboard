import { NextResponse } from "next/server";
import { readState, writeState } from "@/lib/server-state";
import {
  applyStripeCharge,
  buildIndex,
  upsertStripeCustomer,
  verifyStripeSignature,
  type StripeCharge,
  type StripeCustomer,
} from "@/lib/stripe";
import { addInvoiceTransaction } from "@/lib/invoice/customers";
import { invoicePaymentForCharge } from "@/lib/invoice/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/stripe/webhook — Stripe pushes events here the moment they happen.
 * Auth is the Stripe signature (STRIPE_WEBHOOK_SECRET); proxy.ts leaves this path open.
 * Handled: charge.succeeded / charge.updated / charge.refunded, customer.created / customer.updated.
 * Everything else is acknowledged and ignored. Safe to replay (idempotent by charge id).
 * A charge that paid a live invoice is also recorded on that invoice, and filed under the
 * invoice's client on the Customers tab before the generic import sees it (which then
 * finds it by charge id instead of creating a nameless customer).
 */

const HANDLED = new Set(["charge.succeeded", "charge.updated", "charge.refunded", "customer.created", "customer.updated"]);

type StripeEvent = {
  id: string;
  type: string;
  livemode?: boolean;
  data?: { object?: unknown };
};

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "STRIPE_WEBHOOK_SECRET is not configured" }, { status: 503 });
  }

  const payload = await req.text();
  if (!verifyStripeSignature(payload, req.headers.get("stripe-signature"), secret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!event?.type || !HANDLED.has(event.type)) {
    return NextResponse.json({ received: true, ignored: event?.type ?? "unknown" });
  }
  const object = event.data?.object;
  if (!object || typeof object !== "object") {
    return NextResponse.json({ error: "event has no data.object" }, { status: 400 });
  }

  try {
    // Invoice work (Stripe calls, maybe starting a subscription) happens BEFORE the vault is
    // read, so the read-modify-write below stays short and can't drop a concurrent edit.
    let paid: Awaited<ReturnType<typeof invoicePaymentForCharge>> = null;
    if (event.type.startsWith("charge.")) {
      try {
        paid = await invoicePaymentForCharge(object as StripeCharge, { startSubscriptions: event.type === "charge.succeeded" });
      } catch (err) {
        // The invoice page and its finalize step reconcile with Stripe on their own;
        // never let an invoice lookup block the Customers import of this event.
        console.error("webhook: invoice lookup failed", err);
      }
    }

    const state = await readState();
    const customers = [...state.customers];
    const ix = buildIndex(customers);
    const now = new Date().toISOString();
    const invoiceTx = paid ? addInvoiceTransaction(customers, paid.invoice, paid.payment) : false;

    const action = event.type.startsWith("customer.")
      ? upsertStripeCustomer(customers, invoiceTx ? buildIndex(customers) : ix, object as StripeCustomer, now)
      : applyStripeCharge(customers, invoiceTx ? buildIndex(customers) : ix, object as StripeCharge, now);

    const changed = invoiceTx || action === "added" || action === "updated" || action === "removed";
    if (changed) await writeState({ ...state, customers });

    return NextResponse.json({ received: true, event: event.id, type: event.type, action, customers: customers.length });
  } catch (err) {
    // 500 makes Stripe retry (up to 3 days), which is what we want if the vault write failed.
    return NextResponse.json({ error: err instanceof Error ? err.message : "webhook failed" }, { status: 500 });
  }
}
