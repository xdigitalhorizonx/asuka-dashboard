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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/stripe/webhook — Stripe pushes events here the moment they happen.
 * Auth is the Stripe signature (STRIPE_WEBHOOK_SECRET); proxy.ts leaves this path open.
 * Handled: charge.succeeded / charge.updated / charge.refunded, customer.created / customer.updated.
 * Everything else is acknowledged and ignored. Safe to replay (idempotent by charge id).
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
    const state = await readState();
    const customers = [...state.customers];
    const ix = buildIndex(customers);
    const now = new Date().toISOString();

    const action = event.type.startsWith("customer.")
      ? upsertStripeCustomer(customers, ix, object as StripeCustomer, now)
      : applyStripeCharge(customers, ix, object as StripeCharge, now);

    const changed = action === "added" || action === "updated" || action === "removed";
    if (changed) await writeState({ ...state, customers });

    return NextResponse.json({ received: true, event: event.id, type: event.type, action, customers: customers.length });
  } catch (err) {
    // 500 makes Stripe retry (up to 3 days), which is what we want if the vault write failed.
    return NextResponse.json({ error: err instanceof Error ? err.message : "webhook failed" }, { status: 500 });
  }
}
