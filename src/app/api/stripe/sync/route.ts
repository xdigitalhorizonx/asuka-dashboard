import { NextResponse } from "next/server";
import { readState, writeState } from "@/lib/server-state";
import { applyStripeCharge, buildIndex, upsertStripeCustomer, type StripeCharge, type StripeCustomer } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST (or GET, for Vercel Cron) /api/stripe/sync — full reconcile of Stripe customers
 * + charges into the Customers tab. Idempotent; never overwrites manual edits.
 * Protected by the dashboard gate (session cookie, sync bearer, or CRON_SECRET) via proxy.ts.
 * Real-time updates come from /api/stripe/webhook; this is the daily safety net + manual button.
 */

const API = "https://api.stripe.com/v1";

async function stripeList<T extends { id: string }>(path: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (startingAfter) qs.set("starting_after", startingAfter);
    const res = await fetch(`${API}${path}?${qs}`, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(j.error?.message || `Stripe responded ${res.status} on ${path}`);
    }
    const j = (await res.json()) as { data: T[]; has_more: boolean };
    out.push(...j.data);
    if (!j.has_more || j.data.length === 0) break;
    startingAfter = j.data[j.data.length - 1].id;
  }
  return out;
}

async function runSync() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "STRIPE_SECRET_KEY is not set on this deployment — add it in Vercel → Settings → Environment Variables and redeploy." },
      { status: 503 }
    );
  }

  try {
    const [stripeCustomers, charges] = await Promise.all([
      stripeList<StripeCustomer>("/customers", key),
      stripeList<StripeCharge>("/charges", key),
    ]);

    const state = await readState();
    const customers = [...state.customers];
    const ix = buildIndex(customers);
    const now = new Date().toISOString();

    let customersAdded = 0;
    let customersUpdated = 0;
    let paymentsAdded = 0;
    let paymentsUpdated = 0;
    let skipped = 0;

    for (const sc of stripeCustomers) {
      const r = upsertStripeCustomer(customers, ix, sc, now);
      if (r === "added") customersAdded++;
      else if (r === "updated") customersUpdated++;
    }

    for (const ch of [...charges].sort((a, b) => a.created - b.created)) {
      const r = applyStripeCharge(customers, ix, ch, now);
      if (r === "added") paymentsAdded++;
      else if (r === "updated" || r === "removed") paymentsUpdated++;
      else if (r === "skipped") skipped++;
    }

    const changed = customersAdded || customersUpdated || paymentsAdded || paymentsUpdated;
    const next = changed ? await writeState({ ...state, customers }) : state;
    return NextResponse.json({
      ok: true,
      state: next,
      customersAdded,
      customersUpdated,
      paymentsAdded,
      paymentsUpdated,
      skipped,
      stripeCustomers: stripeCustomers.length,
      stripeCharges: charges.length,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Stripe sync failed" }, { status: 502 });
  }
}

export async function POST() {
  return runSync();
}

/** Vercel Cron invokes with GET. */
export async function GET() {
  return runSync();
}
