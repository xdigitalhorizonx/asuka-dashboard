import { dropInvoiceTransaction, recordInvoiceTransaction } from "./customers";
import { PayError } from "./payments";
import { deleteRecordedPayment, getInvoice, recordPayment } from "./store";
import { fmtMoney, isCardPayment, localYmd, paymentPart, round2, type Invoice, type InvoicePayment } from "./types";
import type { RecordedPaymentInput } from "./validate";

/**
 * Check, cash, ACH and other payments Brandon keys in on the Invoices tab. They are stored
 * like card payments (`pay-off_<id>.json`, fee 0), so the balance, a deposit invoice's
 * deposit/balance split, "paid in full", the public page, the PDF and the Customers tab
 * all count them without special cases. Unlike a card payment, one can be removed again.
 *
 * A payment that arrives outside Stripe saves no card: an invoice whose first payment was
 * recorded here doesn't start its monthly billing by itself (see `savesCard`).
 */

/**
 * The instant stored for a payment received on `date`: now when that's today on Digital
 * Horizon's calendar (so it sorts after earlier payments today), else midday Pacific that
 * day — 20:00 UTC is noon or 1 pm in Carson City, so it never shows as the day before.
 */
export function receivedAt(date: string, now: Date = new Date()): string {
  return date === localYmd(now.toISOString()) ? now.toISOString() : `${date}T20:00:00.000Z`;
}

/** Deposit invoices: label the payment the way card payments are labelled, when it completes a part. */
function partOf(inv: Invoice, amount: number): InvoicePayment["part"] {
  const part = paymentPart(inv);
  if (part === "deposit" && amount >= inv.dueNow && amount < inv.balance) return "deposit";
  if (part === "balance" && amount >= inv.balance) return "balance";
  return undefined;
}

/** Applied to the balance by every payment on the invoice (card fees excluded). */
function appliedTotal(inv: Invoice): number {
  return round2(inv.payments.reduce((s, p) => s + p.amount - p.fee, 0));
}

export async function recordOfflinePayment(inv: Invoice, input: RecordedPaymentInput): Promise<Invoice> {
  const id = `off_${input.requestId}`;
  // The same submission again (double-click, a retry after a lost response): it's already in.
  if (inv.payments.some((p) => p.paymentIntentId === id)) return inv;
  if (inv.status === "void") throw new PayError("This invoice is void — restore it before recording a payment.", 409);
  if (inv.status === "paid" || inv.balance <= 0) throw new PayError(`${inv.number} is already paid in full.`, 409);
  if (input.amount > inv.balance) throw new PayError(`That's more than the ${fmtMoney(inv.balance)} still owed on ${inv.number}.`, 400);

  const part = partOf(inv, input.amount);
  const payment: InvoicePayment = {
    paymentIntentId: id,
    method: input.method,
    ...(input.reference ? { reference: input.reference } : {}),
    amount: input.amount,
    fee: 0,
    paidAt: receivedAt(input.date),
    recordedAt: new Date().toISOString(),
    ...(part ? { part } : {}),
  };
  const fresh = await recordPayment(inv.id, payment);
  const after = (await getInvoice(inv.id)) ?? inv;
  if (!fresh) return after;

  // Two payments recorded at the same moment can each fit the balance on their own.
  if (appliedTotal(after) > after.total) {
    await deleteRecordedPayment(inv.id, id);
    throw new PayError("Another payment landed at the same moment, and together they'd be more than the invoice total. Check the balance and try again.", 409);
  }
  try {
    await recordInvoiceTransaction(after, payment);
  } catch (err) {
    // The invoice has the payment either way; the Customers entry is a convenience.
    console.error(`invoice ${inv.number}: customers tab update failed`, err);
  }
  return after;
}

export async function removeOfflinePayment(inv: Invoice, paymentId: string): Promise<Invoice> {
  const p = inv.payments.find((x) => x.paymentIntentId === paymentId);
  if (!p) throw new PayError("That payment isn't on this invoice any more.", 404);
  if (isCardPayment(p)) throw new PayError("Card payments can't be removed — refund it in Stripe instead.", 409);
  await deleteRecordedPayment(inv.id, paymentId);
  try {
    await dropInvoiceTransaction(p);
  } catch (err) {
    console.error(`invoice ${inv.number}: customers tab update failed`, err);
  }
  return (await getInvoice(inv.id)) ?? inv;
}
