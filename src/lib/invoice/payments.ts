import Stripe from "stripe";
import { recordInvoiceTransaction } from "./customers";
import { getInvoiceWithIntents, recordPayment, recordPaymentIntent, type PaymentIntentRecord } from "./store";
import { cardFee, feeAppliesTo, round2, toCents, type Invoice, type InvoicePayment } from "./types";

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

async function readCard(confirmationTokenId: string) {
  if (!/^ctoken_[A-Za-z0-9]+$/.test(confirmationTokenId)) throw new PayError("Invalid card details — please re-enter the card.", 400);
  const ct = await stripe().confirmationTokens.retrieve(confirmationTokenId);
  if (ct.payment_intent) throw new PayError("That card entry was already used — please enter the card again.", 409);
  const card = ct.payment_method_preview?.card;
  if (!card) throw new PayError("Only card payments are accepted on this page.", 400);
  return { funding: card.funding || "unknown", brand: card.display_brand || card.brand || "card", last4: card.last4 || "" };
}

export function quoteFor(inv: Invoice, funding: string): Pick<CardQuote, "base" | "fee" | "total" | "feePercent"> {
  const base = inv.balance;
  const fee = feeAppliesTo(funding) ? cardFee(base, inv.cardFeePercent) : 0;
  return { base, fee, total: round2(base + fee), feePercent: fee > 0 ? inv.cardFeePercent : 0 };
}

/** What this specific card would be charged — shown to the customer before they confirm. */
export async function quoteCard(inv: Invoice, confirmationTokenId: string): Promise<CardQuote> {
  assertPayable(inv);
  const card = await readCard(confirmationTokenId);
  return { ...quoteFor(inv, card.funding), ...card };
}

export function paymentFromIntent(pi: Stripe.PaymentIntent, charge: Stripe.Charge | null): InvoicePayment {
  const card = charge?.payment_method_details?.card ?? null;
  const amount = round2((pi.amount_received || pi.amount) / 100);
  const fee = Math.min(round2(Number(pi.metadata?.fee_cents || 0) / 100), amount);
  return {
    paymentIntentId: pi.id,
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

/** Record a succeeded PaymentIntent on its invoice (idempotent) and on the Customers tab. */
async function recordSucceeded(inv: Invoice, pi: Stripe.PaymentIntent): Promise<void> {
  const payment = paymentFromIntent(pi, await latestCharge(pi));
  await recordPayment(inv.id, payment);
  try {
    await recordInvoiceTransaction(inv, payment);
  } catch (err) {
    // The invoice is paid either way; the Customers entry also arrives via the Stripe sync.
    console.error(`invoice ${inv.number}: customers tab update failed`, err);
  }
}

async function refreshed(id: string): Promise<Invoice> {
  const again = await getInvoiceWithIntents(id);
  if (!again) throw new PayError("Invoice not found.", 404);
  return again.invoice;
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

async function openIntent(pis: PaymentIntentRecord[], invoiceId: string): Promise<Stripe.PaymentIntent | null> {
  for (const rec of pis.slice(0, 3)) {
    const pi = await stripe().paymentIntents.retrieve(rec.paymentIntentId);
    if (pi.metadata?.invoice_id !== invoiceId) continue;
    if (REUSABLE.includes(pi.status)) return pi;
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

  const card = await readCard(confirmationTokenId);
  const q = quoteFor(inv, card.funding);
  if (toCents(q.total) !== expectedTotalCents) {
    throw new PayError("The amount due changed — please review the new total.", 409, { quote: { ...q, ...card } });
  }

  const s = stripe();
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
  let pi = await openIntent(found.pis, inv.id);
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
      },
      { idempotencyKey: `inv_${inv.id}_v${inv.version}_pi${found.pis.length}` }
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
 * Customers tab in the same vault write as the rest of the event.
 */
export async function invoicePaymentForCharge(ch: { id: string; payment_intent?: string | null; metadata?: Record<string, string> | null }): Promise<{ invoice: Invoice; payment: InvoicePayment } | null> {
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
  return { invoice: (await getInvoiceWithIntents(invoiceId))?.invoice ?? found.invoice, payment };
}
