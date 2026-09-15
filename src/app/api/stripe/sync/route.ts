import { NextResponse } from "next/server";
import { readState, writeState } from "@/lib/server-state";
import { normalizeCustomer, type Customer, type Transaction } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/stripe/sync — pull Stripe customers + succeeded charges into the Customers tab.
 * Idempotent: customers are matched by Stripe id (then email), payments by charge id.
 * Existing customer fields are only FILLED when blank — manual corrections always win.
 * Protected by the dashboard gate (session cookie or the sync bearer) via proxy.ts.
 */

const API = "https://api.stripe.com/v1";

type StripeAddress = { line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; postal_code?: string | null } | null;
type StripeCustomer = {
  id: string;
  deleted?: boolean;
  name: string | null;
  email: string | null;
  phone: string | null;
  description: string | null;
  created: number;
  address: StripeAddress;
  metadata: Record<string, string>;
};
type StripeCharge = {
  id: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  created: number;
  status: string;
  paid: boolean;
  refunded: boolean;
  customer: string | null;
  description: string | null;
  receipt_email: string | null;
  billing_details: { name: string | null; email: string | null; phone: string | null; address: StripeAddress } | null;
  payment_method_details: { type: string } | null;
};

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

function fmtAddress(a: StripeAddress): string {
  if (!a) return "";
  const cityLine = [a.city, [a.state, a.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [a.line1, a.line2, cityLine].filter((s) => !!s && String(s).trim()).join("\n");
}

/** Charge timestamps → local Pacific "YYYY-MM-DD" (the board's home time zone). */
function dateOf(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

export async function POST() {
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
    const customers: Customer[] = [...state.customers];
    const now = new Date().toISOString();
    const byStripeId = new Map<string, string>(); // stripe customer id → our customer id
    const byEmail = new Map<string, string>(); // lowercased email → our customer id
    for (const c of customers) {
      if (c.stripeCustomerId) byStripeId.set(c.stripeCustomerId, c.id);
      if (c.email) byEmail.set(c.email.toLowerCase(), c.id);
    }
    const idx = (id: string) => customers.findIndex((c) => c.id === id);
    const index = (c: Customer) => {
      if (c.stripeCustomerId) byStripeId.set(c.stripeCustomerId, c.id);
      if (c.email) byEmail.set(c.email.toLowerCase(), c.id);
    };

    let customersAdded = 0;
    let customersUpdated = 0;
    let paymentsAdded = 0;
    let skipped = 0;

    for (const sc of stripeCustomers) {
      if (sc.deleted) continue;
      const incoming = {
        company: sc.name ?? "",
        contact: sc.metadata?.contact ?? "",
        address: fmtAddress(sc.address),
        phone: sc.phone ?? "",
        email: sc.email ?? "",
        website: sc.metadata?.website ?? "",
        notes: sc.description ? `Stripe: ${sc.description}` : "",
      };
      const existingId = byStripeId.get(sc.id) ?? (sc.email ? byEmail.get(sc.email.toLowerCase()) : undefined);
      if (existingId !== undefined) {
        const i = idx(existingId);
        if (i < 0) continue;
        const existing = customers[i];
        const patch: Partial<Customer> = {};
        for (const k of Object.keys(incoming) as (keyof typeof incoming)[]) {
          if (!existing[k] && incoming[k]) patch[k] = incoming[k];
        }
        if (!existing.stripeCustomerId) patch.stripeCustomerId = sc.id;
        if (Object.keys(patch).length) {
          customers[i] = normalizeCustomer({ ...existing, ...patch, updatedAt: now });
          customersUpdated++;
        }
        index(customers[i]);
        // Duplicate Stripe records for the same email merge into one customer;
        // remember every Stripe id so their charges attach to the merged record.
        byStripeId.set(sc.id, customers[i].id);
        continue;
      }
      const created = normalizeCustomer({
        id: `c_${sc.id}`,
        ...incoming,
        transactions: [],
        stripeCustomerId: sc.id,
        createdAt: new Date(sc.created * 1000).toISOString(),
        updatedAt: now,
      });
      customers.push(created);
      index(created);
      customersAdded++;
    }

    const knownCharges = new Set(customers.flatMap((c) => c.transactions.map((t) => t.stripeId).filter(Boolean)));
    const sortedCharges = [...charges].sort((a, b) => a.created - b.created);
    for (const ch of sortedCharges) {
      if (ch.status !== "succeeded" || !ch.paid || ch.refunded) continue;
      if (knownCharges.has(ch.id)) continue;

      const email = (ch.billing_details?.email || ch.receipt_email || "").trim();
      let targetId = ch.customer ? byStripeId.get(ch.customer) : undefined;
      if (targetId === undefined && email) targetId = byEmail.get(email.toLowerCase());
      if (targetId === undefined) {
        const name = ch.billing_details?.name?.trim() ?? "";
        if (!email && !name) {
          skipped++;
          continue;
        }
        const created = normalizeCustomer({
          id: `c_${ch.customer || ch.id}`,
          company: name,
          contact: "",
          address: fmtAddress(ch.billing_details?.address ?? null),
          phone: ch.billing_details?.phone ?? "",
          email,
          website: "",
          notes: "Created from a Stripe payment that had no customer record — fill in the details.",
          transactions: [],
          ...(ch.customer ? { stripeCustomerId: ch.customer } : {}),
          createdAt: new Date(ch.created * 1000).toISOString(),
          updatedAt: now,
        });
        customers.push(created);
        index(created);
        customersAdded++;
        targetId = created.id;
      }

      const i = idx(targetId);
      if (i < 0) {
        skipped++;
        continue;
      }
      const net = Math.round((ch.amount - (ch.amount_refunded || 0))) / 100;
      const memo = [
        ch.description?.trim(),
        ch.amount_refunded ? `partial refund ${(ch.amount_refunded / 100).toFixed(2)}` : "",
        ch.currency && ch.currency.toLowerCase() !== "usd" ? ch.currency.toUpperCase() : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const t: Transaction = {
        id: `t_${ch.id}`,
        amount: net,
        method: "card",
        date: dateOf(ch.created),
        memo: memo || `Stripe ${ch.payment_method_details?.type ?? "payment"}`,
        createdAt: new Date(ch.created * 1000).toISOString(),
        stripeId: ch.id,
      };
      customers[i] = normalizeCustomer({ ...customers[i], transactions: [t, ...customers[i].transactions], updatedAt: now });
      knownCharges.add(ch.id);
      paymentsAdded++;
    }

    const next = await writeState({ ...state, customers });
    return NextResponse.json({
      ok: true,
      state: next,
      customersAdded,
      customersUpdated,
      paymentsAdded,
      skipped,
      stripeCustomers: stripeCustomers.length,
      stripeCharges: charges.length,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Stripe sync failed" }, { status: 502 });
  }
}
