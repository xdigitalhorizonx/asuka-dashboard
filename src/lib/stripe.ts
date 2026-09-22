import { createHmac, timingSafeEqual } from "crypto";
import { normalizeCustomer, type Customer, type Transaction } from "./types";

/**
 * Shared Stripe → Customers logic used by the bulk sync (/api/stripe/sync) and the
 * real-time webhook (/api/stripe/webhook). Rules:
 *  - customers match by Stripe customer id, then by email (Stripe often holds
 *    duplicate records for one person); existing fields are only FILLED when blank
 *  - payments match by charge id, so replays and re-syncs are idempotent
 *  - failed / fully refunded charges are not revenue; partial refunds net down
 */

export type StripeAddress = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
} | null;

export type StripeCustomer = {
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

export type StripeCharge = {
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

export function fmtAddress(a: StripeAddress): string {
  if (!a) return "";
  const cityLine = [a.city, [a.state, a.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [a.line1, a.line2, cityLine].filter((s) => !!s && String(s).trim()).join("\n");
}

/** Charge timestamps → local Pacific "YYYY-MM-DD" (the board's home time zone). */
export function dateOf(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

export type CustomerIndex = {
  /** stripe customer id → our customer id */
  byStripeId: Map<string, string>;
  /** lowercased email → our customer id */
  byEmail: Map<string, string>;
};

export function buildIndex(customers: Customer[]): CustomerIndex {
  const ix: CustomerIndex = { byStripeId: new Map(), byEmail: new Map() };
  for (const c of customers) indexOne(ix, c);
  return ix;
}

function indexOne(ix: CustomerIndex, c: Customer) {
  if (c.stripeCustomerId) ix.byStripeId.set(c.stripeCustomerId, c.id);
  if (c.email) ix.byEmail.set(c.email.toLowerCase(), c.id);
}

function customerFields(sc: StripeCustomer) {
  return {
    company: sc.name ?? "",
    contact: sc.metadata?.contact ?? "",
    address: fmtAddress(sc.address),
    phone: sc.phone ?? "",
    email: sc.email ?? "",
    website: sc.metadata?.website ?? "",
    notes: sc.description ? `Stripe: ${sc.description}` : "",
  };
}

export type UpsertResult = "added" | "updated" | "unchanged" | "skipped";

export function upsertStripeCustomer(customers: Customer[], ix: CustomerIndex, sc: StripeCustomer, now: string): UpsertResult {
  if (sc.deleted) return "skipped";
  const incoming = customerFields(sc);
  const existingId = ix.byStripeId.get(sc.id) ?? (sc.email ? ix.byEmail.get(sc.email.toLowerCase()) : undefined);
  if (existingId !== undefined) {
    const i = customers.findIndex((c) => c.id === existingId);
    if (i < 0) return "skipped";
    const existing = customers[i];
    const patch: Partial<Customer> = {};
    for (const k of Object.keys(incoming) as (keyof typeof incoming)[]) {
      if (!existing[k] && incoming[k]) patch[k] = incoming[k];
    }
    if (!existing.stripeCustomerId) patch.stripeCustomerId = sc.id;
    let result: UpsertResult = "unchanged";
    if (Object.keys(patch).length) {
      customers[i] = normalizeCustomer({ ...existing, ...patch, updatedAt: now });
      result = "updated";
    }
    indexOne(ix, customers[i]);
    // Duplicate Stripe records for one email merge into one customer; remember
    // every Stripe id so their charges attach to the merged record.
    ix.byStripeId.set(sc.id, customers[i].id);
    return result;
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
  indexOne(ix, created);
  return "added";
}

function chargeMemo(ch: StripeCharge): string {
  const memo = [
    ch.description?.trim(),
    ch.amount_refunded ? `partial refund ${(ch.amount_refunded / 100).toFixed(2)}` : "",
    ch.currency && ch.currency.toLowerCase() !== "usd" ? ch.currency.toUpperCase() : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return memo || `Stripe ${ch.payment_method_details?.type ?? "payment"}`;
}

export type ChargeResult = "added" | "updated" | "removed" | "unchanged" | "ignored" | "skipped";

/**
 * Apply one Stripe charge to the customers list. Idempotent: the same charge id
 * updates in place; a charge that stopped being revenue (refunded) is removed.
 */
export function applyStripeCharge(customers: Customer[], ix: CustomerIndex, ch: StripeCharge, now: string): ChargeResult {
  const txId = `t_${ch.id}`;
  let ci = -1;
  let ti = -1;
  for (let i = 0; i < customers.length && ci < 0; i++) {
    const j = customers[i].transactions.findIndex((t) => t.stripeId === ch.id || t.id === txId);
    if (j >= 0) {
      ci = i;
      ti = j;
    }
  }

  const net = Math.round(ch.amount - (ch.amount_refunded || 0)) / 100;
  const countable = ch.status === "succeeded" && ch.paid && !ch.refunded && net > 0;
  if (!countable) {
    if (ci < 0) return "ignored";
    const c = customers[ci];
    customers[ci] = normalizeCustomer({ ...c, transactions: c.transactions.filter((_, j) => j !== ti), updatedAt: now });
    return "removed";
  }

  const fresh: Transaction = {
    id: txId,
    amount: net,
    method: "card",
    date: dateOf(ch.created),
    memo: chargeMemo(ch),
    createdAt: new Date(ch.created * 1000).toISOString(),
    stripeId: ch.id,
  };

  if (ci >= 0) {
    const c = customers[ci];
    const old = c.transactions[ti];
    if (old.amount === fresh.amount && old.memo === fresh.memo && old.date === fresh.date) return "unchanged";
    const next = [...c.transactions];
    next[ti] = { ...old, amount: fresh.amount, memo: fresh.memo, date: fresh.date, stripeId: ch.id };
    customers[ci] = normalizeCustomer({ ...c, transactions: next, updatedAt: now });
    return "updated";
  }

  const email = (ch.billing_details?.email || ch.receipt_email || "").trim();
  let targetId = ch.customer ? ix.byStripeId.get(ch.customer) : undefined;
  if (targetId === undefined && email) targetId = ix.byEmail.get(email.toLowerCase());
  if (targetId === undefined) {
    const name = ch.billing_details?.name?.trim() ?? "";
    if (!email && !name) return "skipped";
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
    indexOne(ix, created);
    targetId = created.id;
  }

  const i = customers.findIndex((c) => c.id === targetId);
  if (i < 0) return "skipped";
  customers[i] = normalizeCustomer({ ...customers[i], transactions: [fresh, ...customers[i].transactions], updatedAt: now });
  return "added";
}

/**
 * Verify a Stripe-Signature header (t=…,v1=…) against the raw request body.
 * https://docs.stripe.com/webhooks#verify-manually
 */
export function verifyStripeSignature(payload: string, header: string | null, secret: string, toleranceSec = 300): boolean {
  if (!header || !secret) return false;
  let t = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  if (!/^\d+$/.test(t) || v1.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  return v1.some((sig) => {
    const b = Buffer.from(sig, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
