import { createHash } from "crypto";
import Stripe from "stripe";
import { recordInvoiceTransaction } from "./customers";
import { getInvoiceWithIntents, recordPayment, recordPaymentIntent, recordSubscription, type PaymentIntentRecord } from "./store";
import { effectiveCardFeePercent } from "./validate";
import {
  cardFee,
  feeAppliesTo,
  firstChargeAt,
  fmtLongDate,
  recurringGroups,
  round2,
  toCents,
  type Invoice,
  type InvoiceLine,
  type InvoicePayment,
  type InvoiceSubscription,
  type RecurringGroup,
} from "./types";

/**
 * Card payments for the public invoice page, "finalize on the server" style:
 *
 *  1. the browser turns the Payment Element into a ConfirmationToken;
 *  2. `quoteCard` reads the card's funding type from it — only CREDIT cards carry the
 *     invoice's card fee (card-network rules forbid surcharging debit/prepaid) — and the
 *     customer sees the exact total before anything is charged;
 *  3. `payInvoice` recomputes that total here (the browser never sets an amount), puts it
 *     on the invoice's one open PaymentIntent and confirms it with the token;
 *  4. 3-D Secure, if the bank asks for it, finishes in the browser and `finalizePayment`
 *     re-reads the PaymentIntent from Stripe.
 * A payment is recorded only from a PaymentIntent Stripe reports as succeeded.
 *
 * Invoices with monthly (or yearly) lines bill the first period with everything else, and
 * the payment saves the card to the client's Stripe customer. Once the invoice is paid,
 * `ensureSubscriptions` starts a Stripe subscription for those lines whose first charge is
 * one period after the payment — so one-time items are charged once, recurring ones keep
 * billing the card on file.
 */

export class PayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "PayError";
  }
}

/** Stripe's card minimum in USD. */
export const MIN_CHARGE = 0.5;
const REUSABLE: Stripe.PaymentIntent.Status[] = ["requires_payment_method", "requires_confirmation"];

export function stripeSecretKey(): string {
  return process.env.STRIPE_SECRET_KEY || "";
}

export function stripePublishableKey(): string {
  return process.env.STRIPE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "";
}

export interface PaymentsStatus {
  secretKey: boolean;
  publishableKey: boolean;
  /** "live" | "test" from the key prefixes; "mismatch" when they disagree. */
  mode: "live" | "test" | "mismatch" | "unknown";
  ready: boolean;
}

export function paymentsStatus(): PaymentsStatus {
  const sk = stripeSecretKey();
  const pk = stripePublishableKey();
  const modeOf = (k: string) => (/_live_/.test(k) ? "live" : /_test_/.test(k) ? "test" : "unknown");
  const a = sk ? modeOf(sk) : "unknown";
  const b = pk ? modeOf(pk) : "unknown";
  const mode = sk && pk ? (a === b ? a : "mismatch") : a !== "unknown" ? a : b;
  return { secretKey: !!sk, publishableKey: !!pk, mode, ready: !!sk && !!pk && mode !== "mismatch" && pk.startsWith("pk_") };
}

let client: Stripe | null = null;
let clientKey = "";
function stripe(): Stripe {
  const key = stripeSecretKey();
  if (!key) throw new PayError("Card payments aren't set up yet.", 503);
  if (!client || clientKey !== key) {
    client = new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: "Central Dogma invoices" } });
    clientKey = key;
  }
  return client;
}

function assertPayable(inv: Invoice) {
  if (inv.status === "void") throw new PayError("This invoice has been voided.", 409);
  if (inv.status === "paid" || inv.balance <= 0) throw new PayError("This invoice is already paid in full.", 409, { paid: true });
  if (inv.balance < MIN_CHARGE) throw new PayError("The balance is below the card minimum — please contact us to settle it.", 409);
}

export interface CardQuote {
  base: number;
  fee: number;
  total: number;
  /** Percent actually applied (0 for debit/prepaid/unknown cards). */
  feePercent: number;
  funding: string;
  brand: string;
  last4: string;
}

/** Invoices with recurring lines save the card for the subscription that bills them later. */
export function savesCard(inv: Pick<Invoice, "lines">): boolean {
  return recurringGroups(inv.lines).length > 0;
}

async function readCard(inv: Invoice, confirmationTokenId: string) {
  if (!/^ctoken_[A-Za-z0-9]+$/.test(confirmationTokenId)) throw new PayError("Invalid card details — please re-enter the card.", 400);
  const ct = await stripe().confirmationTokens.retrieve(confirmationTokenId);
  if (ct.payment_intent) throw new PayError("That card entry was already used — please enter the card again.", 409);
  // The page asks to save the card exactly when the invoice has recurring lines; a mismatch
  // means the invoice was edited while the page was open.
  if ((ct.setup_future_usage ?? null) !== (savesCard(inv) ? "off_session" : null)) {
    throw new PayError("This invoice changed while the page was open — please reload it and pay again.", 409);
  }
  const card = ct.payment_method_preview?.card;
  if (!card) throw new PayError("Only card payments are accepted on this page.", 400);
  return { funding: card.funding || "unknown", brand: card.display_brand || card.brand || "card", last4: card.last4 || "" };
}

export function quoteFor(inv: Invoice, funding: string): Pick<CardQuote, "base" | "fee" | "total" | "feePercent"> {
  const base = inv.balance;
  const pct = effectiveCardFeePercent(inv);
  const fee = feeAppliesTo(funding) ? cardFee(base, pct) : 0;
  return { base, fee, total: round2(base + fee), feePercent: fee > 0 ? pct : 0 };
}

/** What this specific card would be charged — shown to the customer before they confirm. */
export async function quoteCard(inv: Invoice, confirmationTokenId: string): Promise<CardQuote> {
  assertPayable(inv);
  const card = await readCard(inv, confirmationTokenId);
  return { ...quoteFor(inv, card.funding), ...card };
}

export function paymentFromIntent(pi: Stripe.PaymentIntent, charge: Stripe.Charge | null): InvoicePayment {
  const card = charge?.payment_method_details?.card ?? null;
  const amount = round2((pi.amount_received || pi.amount) / 100);
  const fee = Math.min(round2(Number(pi.metadata?.fee_cents || 0) / 100), amount);
  const customerId = typeof pi.customer === "string" ? pi.customer : pi.customer?.id;
  return {
    paymentIntentId: pi.id,
    ...(customerId ? { customerId } : {}),
    ...(charge ? { chargeId: charge.id } : {}),
    amount,
    fee,
    ...(card?.brand ? { brand: card.brand } : {}),
    ...(card?.last4 ? { last4: card.last4 } : {}),
    ...(card?.funding ? { funding: card.funding } : {}),
    paidAt: new Date((charge?.created ?? pi.created) * 1000).toISOString(),
    ...(charge?.receipt_url ? { receiptUrl: charge.receipt_url } : {}),
    livemode: pi.livemode,
  };
}

async function latestCharge(pi: Stripe.PaymentIntent): Promise<Stripe.Charge | null> {
  if (!pi.latest_charge) return null;
  return typeof pi.latest_charge === "string" ? stripe().charges.retrieve(pi.latest_charge) : pi.latest_charge;
}

/**
 * Record a succeeded PaymentIntent on its invoice (idempotent) and on the Customers tab,
 * then start the monthly billing if that payment settled an invoice with recurring lines.
 */
async function recordSucceeded(inv: Invoice, pi: Stripe.PaymentIntent): Promise<void> {
  const payment = paymentFromIntent(pi, await latestCharge(pi));
  await recordPayment(inv.id, payment);
  try {
    await recordInvoiceTransaction(inv, payment);
  } catch (err) {
    // The invoice is paid either way; the Customers entry also arrives via the Stripe sync.
    console.error(`invoice ${inv.number}: customers tab update failed`, err);
  }
  await startSubscriptions(inv.id, pi, payment.paidAt);
}

async function refreshed(id: string): Promise<Invoice> {
  const again = await getInvoiceWithIntents(id);
  if (!again) throw new PayError("Invoice not found.", 404);
  return again.invoice;
}

/** After a payment: start the subscriptions. A failure is logged and never fails the payment. */
async function startSubscriptions(invoiceId: string, pi: Stripe.PaymentIntent, paidAt: string): Promise<void> {
  try {
    await ensureSubscriptions(await refreshed(invoiceId), pi, paidAt);
  } catch (err) {
    // The dashboard flags a paid invoice whose recurring lines have no subscription, and
    // its "Set up monthly billing" action retries this with the error shown.
    console.error(`invoice ${invoiceId}: subscription not started`, err);
  }
}

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : v?.id ?? "");

/** Recurring intervals that should have a subscription but don't yet. */
export function missingSubscriptions(inv: Invoice) {
  return recurringGroups(inv.lines).filter((g) => !inv.subscriptions.some((s) => s.interval === g.interval));
}

/**
 * The Stripe customer an invoice's card is saved to: the one an earlier attempt on this
 * invoice already used, else the newest customer with the client's email (Stripe often
 * holds duplicates for one person), else a new one.
 */
async function customerFor(inv: Invoice, pis: PaymentIntentRecord[]): Promise<string> {
  const s = stripe();
  for (const rec of pis.slice(0, 3)) {
    const pi = await s.paymentIntents.retrieve(rec.paymentIntentId);
    // Same invoice version = same client details; after an edit (e.g. a fixed email) look again.
    if (pi.metadata?.invoice_id === inv.id && pi.metadata?.invoice_version === String(inv.version) && idOf(pi.customer)) return idOf(pi.customer);
  }
  const email = inv.client.email.trim();
  for (const e of new Set([email, email.toLowerCase()])) {
    if (!e) continue;
    const found = await s.customers.list({ email: e, limit: 1 });
    if (found.data[0]) return found.data[0].id;
  }
  const c = await s.customers.create(
    {
      name: inv.client.name,
      ...(email ? { email } : {}),
      ...(inv.client.phone ? { phone: inv.client.phone } : {}),
      metadata: { source: "central-dogma-invoice", invoice_number: inv.number, invoice_id: inv.id },
    },
    { idempotencyKey: `cus_inv_${inv.id}_v${inv.version}` }
  );
  return c.id;
}

/**
 * A live subscription on the customer that already bills this group: same interval and
 * amount, started after the payment, not another invoice's — e.g. one Brandon set up by hand
 * after an automatic start failed. It is adopted instead of starting a second one.
 */
export function billsGroup(sub: Stripe.Subscription, g: RecurringGroup, invoiceId: string, paidAtMs: number): boolean {
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return false;
  if (sub.metadata?.invoice_id && sub.metadata.invoice_id !== invoiceId) return false;
  const items = sub.items?.data ?? [];
  if (!items.length || items.some((it) => it.price?.recurring?.interval !== g.interval)) return false;
  const cents = items.reduce((sum, it) => sum + (it.price?.unit_amount ?? 0) * (it.quantity ?? 1), 0);
  return cents === toCents(g.amount) && sub.created * 1000 >= paidAtMs - 24 * 3600_000;
}

/**
 * One Stripe product per service name (a stable id derived from the name), so the monthly
 * Stripe invoices list the same services the proposal did.
 */
async function productFor(line: InvoiceLine): Promise<string> {
  const name = line.name.trim().slice(0, 250) || "Service";
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "service";
  const id = `dh_svc_${slug}_${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
  const s = stripe();
  try {
    const p = await s.products.retrieve(id);
    if (!p.active) await s.products.update(id, { active: true });
    return id;
  } catch (err) {
    if (!(isStripeError(err) && err.statusCode === 404)) throw err;
  }
  try {
    await s.products.create({ id, name, metadata: { source: "central-dogma-invoice" } });
  } catch (err) {
    if (!(isStripeError(err) && err.code === "resource_already_exists")) throw err;
  }
  return id;
}

/**
 * Start the subscription(s) that bill an invoice's recurring lines from the second period
 * on, charging the card the settling payment saved. The first charge lands one period after
 * `paidAt` (the first period was on the invoice). Idempotent: an interval that already has a
 * subscription — recorded here, or found in Stripe by its invoice metadata — is skipped, so
 * the page, the webhook and the dashboard can all call it. Throws a PayError with a message
 * for Brandon when it can't be done automatically.
 */
export async function ensureSubscriptions(inv: Invoice, pi: Stripe.PaymentIntent, paidAt: string): Promise<InvoiceSubscription[]> {
  const missing = missingSubscriptions(inv);
  if (inv.status !== "paid" || !missing.length) return [];
  const customer = idOf(pi.customer);
  const paymentMethod = idOf(pi.payment_method);
  if (pi.status !== "succeeded" || pi.setup_future_usage !== "off_session" || !customer || !paymentMethod) {
    throw new PayError("The card on this payment wasn't saved, so the monthly billing can't start by itself — set the subscription up in Stripe.", 409);
  }

  const s = stripe();
  // Never start billing on a payment that was refunded or disputed (refunds don't reopen invoices).
  const charge = typeof pi.latest_charge === "string" ? await s.charges.retrieve(pi.latest_charge) : pi.latest_charge;
  if (!charge || charge.refunded || charge.amount_refunded > 0 || charge.disputed) {
    throw new PayError("This payment was refunded or disputed, so the monthly billing wasn't started.", 409);
  }
  const existing = (await s.subscriptions.list({ customer, status: "all", limit: 100 })).data;
  const paidAtMs = Date.parse(paidAt);
  const out: InvoiceSubscription[] = [];
  for (const g of missing) {
    let sub =
      existing.find((x) => x.metadata?.invoice_id === inv.id && x.metadata?.interval === g.interval) ??
      existing.find((x) => billsGroup(x, g, inv.id, paidAtMs));
    if (!sub) {
      const anchor = firstChargeAt(new Date(paidAt), g.interval);
      if (anchor.getTime() < Date.now() + 10 * 60_000) {
        throw new PayError(`The first ${g.interval}ly charge (${fmtLongDate(anchor.toISOString().slice(0, 10))}) is already past — set the subscription up in Stripe by hand.`, 409);
      }
      const items: Stripe.SubscriptionCreateParams.Item[] = [];
      for (const l of g.lines) {
        items.push({ price_data: { currency: "usd", product: await productFor(l), unit_amount: toCents(l.recurring?.amount ?? 0), recurring: { interval: g.interval } }, quantity: 1 });
      }
      sub = await s.subscriptions.create(
        {
          customer,
          default_payment_method: paymentMethod,
          items,
          // The first period was billed on the invoice: no charge until one period later.
          billing_cycle_anchor: Math.floor(anchor.getTime() / 1000),
          proration_behavior: "none",
          description: `${inv.number} · ${inv.client.name}`.slice(0, 500),
          metadata: { invoice_id: inv.id, invoice_number: inv.number, interval: g.interval, source: "central-dogma-invoice" },
        },
        { idempotencyKey: `sub_${inv.id}_${g.interval}` }
      );
    }
    const rec: InvoiceSubscription = {
      subscriptionId: sub.id,
      customerId: customer,
      interval: g.interval,
      amount: g.amount,
      startsAt: new Date(sub.billing_cycle_anchor * 1000).toISOString(),
      createdAt: new Date(sub.created * 1000).toISOString(),
      livemode: sub.livemode,
    };
    await recordSubscription(inv.id, rec);
    out.push(rec);
  }
  return out;
}

/** Dashboard retry: start the subscriptions a paid invoice should have but doesn't. */
export async function retrySubscriptions(inv: Invoice): Promise<Invoice> {
  if (inv.status !== "paid" || !missingSubscriptions(inv).length || !stripeSecretKey()) return inv;
  const last = inv.payments[inv.payments.length - 1];
  if (!last) return inv;
  const pi = await stripe().paymentIntents.retrieve(last.paymentIntentId, { expand: ["latest_charge"] });
  await ensureSubscriptions(inv, pi, last.paidAt);
  return refreshed(inv.id);
}

/**
 * Catch up on payments Stripe completed that were never recorded here (tab closed during
 * 3-D Secure, a missed webhook). Checks the invoice's recent unrecorded PaymentIntents.
 */
export async function reconcileInvoice(inv: Invoice, pis: PaymentIntentRecord[]): Promise<Invoice> {
  if (!stripeSecretKey()) return inv;
  const recorded = new Set(inv.payments.map((p) => p.paymentIntentId));
  const pending = pis.filter((p) => !recorded.has(p.paymentIntentId)).slice(0, 3);
  let changed = false;
  for (const rec of pending) {
    const pi = await stripe().paymentIntents.retrieve(rec.paymentIntentId, { expand: ["latest_charge"] });
    if (pi.metadata?.invoice_id === inv.id && pi.status === "succeeded") {
      await recordSucceeded(inv, pi);
      changed = true;
    }
  }
  return changed ? refreshed(inv.id) : inv;
}

export type PayResult =
  | { status: "succeeded"; invoice: Invoice }
  | { status: "processing"; invoice: Invoice }
  | { status: "requires_action"; clientSecret: string; paymentIntentId: string }
  | { status: "failed"; message: string };

async function settle(inv: Invoice, pi: Stripe.PaymentIntent): Promise<PayResult> {
  switch (pi.status) {
    case "succeeded":
      await recordSucceeded(inv, pi);
      return { status: "succeeded", invoice: await refreshed(inv.id) };
    case "processing":
      return { status: "processing", invoice: inv };
    case "requires_action":
      if (!pi.client_secret) throw new PayError("Stripe asked for verification but sent no client secret.", 502);
      return { status: "requires_action", clientSecret: pi.client_secret, paymentIntentId: pi.id };
    case "requires_payment_method":
      return { status: "failed", message: pi.last_payment_error?.message || "The card was declined. Please try another card." };
    default:
      return { status: "failed", message: `The payment could not be completed (${pi.status}).` };
  }
}

async function openIntent(pis: PaymentIntentRecord[], invoiceId: string, customer: string | null): Promise<Stripe.PaymentIntent | null> {
  for (const rec of pis.slice(0, 3)) {
    const pi = await stripe().paymentIntents.retrieve(rec.paymentIntentId);
    if (pi.metadata?.invoice_id !== invoiceId) continue;
    // Only reuse an intent that saves (or doesn't save) the card the way this payment must.
    const matches = customer ? pi.setup_future_usage === "off_session" && idOf(pi.customer) === customer : !pi.setup_future_usage;
    if (REUSABLE.includes(pi.status) && matches) return pi;
    if (pi.status === "requires_action") {
      // An abandoned 3-D Secure attempt: its amount can't be changed, so retire it.
      await stripe().paymentIntents.cancel(pi.id).catch(() => undefined);
    }
  }
  return null;
}

function isStripeError(err: unknown): err is InstanceType<typeof Stripe.errors.StripeError> {
  return err instanceof Stripe.errors.StripeError;
}

/**
 * Charge the invoice balance (+ the credit-card fee when the card is credit).
 * `expectedTotalCents` is what the customer was shown; if the server's figure differs
 * (the invoice changed, a payment landed), nothing is charged and the page re-quotes.
 */
export async function payInvoice(invoiceId: string, confirmationTokenId: string, expectedTotalCents: number, returnUrl: string): Promise<PayResult> {
  const found = await getInvoiceWithIntents(invoiceId);
  if (!found) throw new PayError("Invoice not found.", 404);
  const inv = await reconcileInvoice(found.invoice, found.pis);
  assertPayable(inv);

  const card = await readCard(inv, confirmationTokenId);
  const q = quoteFor(inv, card.funding);
  if (toCents(q.total) !== expectedTotalCents) {
    throw new PayError("The amount due changed — please review the new total.", 409, { quote: { ...q, ...card } });
  }

  const s = stripe();
  // Recurring lines: the card is saved to the client's Stripe customer for the subscription.
  const customer = savesCard(inv) ? await customerFor(inv, found.pis) : null;
  const description = `Invoice ${inv.number} · ${inv.client.name}`.slice(0, 1000);
  const receipt = inv.client.email ? { receipt_email: inv.client.email } : {};
  const metadata = {
    invoice_id: inv.id,
    invoice_number: inv.number,
    invoice_version: String(inv.version),
    base_cents: String(toCents(q.base)),
    fee_cents: String(toCents(q.fee)),
    fee_percent: String(q.feePercent),
    card_funding: card.funding,
    source: "central-dogma-invoice",
  };

  // One open PaymentIntent per invoice: a retry after a decline, or a second tab, reuses
  // it — a PaymentIntent can only ever succeed once, so the invoice can't be double-charged.
  let pi = await openIntent(found.pis, inv.id, customer);
  if (!pi) {
    // Stable creation params (base amount, fixed metadata) so the idempotency key is safe
    // to repeat; the real amount is set by the update below.
    pi = await s.paymentIntents.create(
      {
        amount: toCents(q.base),
        currency: "usd",
        payment_method_types: ["card"],
        description,
        metadata: { invoice_id: inv.id, invoice_number: inv.number, source: "central-dogma-invoice" },
        ...receipt,
        ...(customer ? { customer, setup_future_usage: "off_session" as const } : {}),
      },
      { idempotencyKey: `inv_${inv.id}_v${inv.version}_pi${found.pis.length}${customer ? `_${customer}` : ""}` }
    );
    await recordPaymentIntent(inv.id, pi.id);
  }
  pi = await s.paymentIntents.update(pi.id, { amount: toCents(q.total), description, metadata, ...receipt });

  try {
    pi = await s.paymentIntents.confirm(
      pi.id,
      { confirmation_token: confirmationTokenId, return_url: returnUrl, expand: ["latest_charge"] },
      { idempotencyKey: `confirm_${confirmationTokenId}` }
    );
  } catch (err) {
    if (isStripeError(err) && err.type === "StripeCardError") return { status: "failed", message: err.message };
    if (isStripeError(err) && err.code === "payment_intent_unexpected_state") {
      // Someone else's attempt finished first — report whatever Stripe now says.
      return settle(inv, await s.paymentIntents.retrieve(pi.id, { expand: ["latest_charge"] }));
    }
    throw err;
  }
  return settle(inv, pi);
}

/** After 3-D Secure (or a reload mid-payment): re-read the PaymentIntent and record it if it succeeded. */
export async function finalizePayment(invoiceId: string, paymentIntentId: string): Promise<PayResult> {
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) throw new PayError("Unknown payment.", 400);
  const found = await getInvoiceWithIntents(invoiceId);
  if (!found) throw new PayError("Invoice not found.", 404);
  const pi = await stripe().paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
  if (pi.metadata?.invoice_id !== invoiceId) throw new PayError("That payment doesn't belong to this invoice.", 404);
  return settle(found.invoice, pi);
}

/**
 * Webhook hook for a Stripe charge event. When the charge paid an invoice, records the
 * payment on the invoice (idempotent) and returns it so the caller can put it on the
 * Customers tab in the same vault write as the rest of the event. Only `charge.succeeded`
 * (`opts.startSubscriptions`) may start the monthly billing — never a refund or an update.
 */
export async function invoicePaymentForCharge(
  ch: { id: string; payment_intent?: string | null; metadata?: Record<string, string> | null },
  opts: { startSubscriptions: boolean } = { startSubscriptions: false }
): Promise<{ invoice: Invoice; payment: InvoicePayment } | null> {
  if (!ch.payment_intent || !stripeSecretKey()) return null;
  let invoiceId = ch.metadata?.invoice_id || "";
  let pi: Stripe.PaymentIntent | null = null;
  if (!invoiceId) {
    pi = await stripe().paymentIntents.retrieve(ch.payment_intent, { expand: ["latest_charge"] });
    invoiceId = pi.metadata?.invoice_id || "";
  }
  if (!invoiceId) return null;
  const found = await getInvoiceWithIntents(invoiceId);
  if (!found) return null;
  pi ??= await stripe().paymentIntents.retrieve(ch.payment_intent, { expand: ["latest_charge"] });
  if (pi.status !== "succeeded" || pi.metadata?.invoice_id !== invoiceId) return null;
  const payment = paymentFromIntent(pi, await latestCharge(pi));
  await recordPayment(invoiceId, payment);
  if (opts.startSubscriptions) await startSubscriptions(invoiceId, pi, payment.paidAt);
  return { invoice: (await getInvoiceWithIntents(invoiceId))?.invoice ?? found.invoice, payment };
}
