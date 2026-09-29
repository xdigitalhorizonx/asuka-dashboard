/**
 * Invoice model shared by the dashboard (Invoices tab), the public live-invoice page
 * (/i/<id>), the PDF renderer and the Stripe payment flow.
 *
 * Money is in dollars with two decimals everywhere in this module; convert to cents
 * only at the Stripe boundary (`toCents`). Every derived figure goes through `round2`
 * so a total never drifts by a floating-point cent.
 */

export type RecurringInterval = "month" | "year";

export interface InvoiceLine {
  id: string;
  name: string;
  /** Italic subtitle from the proposal; may be "". */
  description: string;
  /** The proposal's TYPE column as printed ("One-Time", "Monthly", "Setup", …). Display only. */
  type: string;
  /** Set when the service repeats; this invoice bills its first period (`amount`). */
  recurring: null | { interval: RecurringInterval; amount: number };
  /** Dollars billed on this invoice for the line. 0 → print `zeroLabel` instead of $0.00. */
  amount: number;
  /** "FREE" or "Included" for zero-priced lines; "" otherwise. */
  zeroLabel: string;
  /** Small print under the name, e.g. "First month · then $94.99/mo". May be "". */
  note: string;
}

/**
 * A discount on this invoice's total: a percent of the lines, or a dollar amount. It lowers
 * what's paid today (and so the card fee); later subscription charges use each line's own
 * recurring price.
 */
export interface InvoiceDiscount {
  kind: "percent" | "amount";
  /** Percent (0–100) or dollars. */
  value: number;
}

export interface InvoiceParty {
  name: string;
  email: string;
  phone: string;
  address: string;
}

/** One immutable version of an invoice as saved (a new version is written on every edit). */
export interface InvoiceDoc {
  /** Public, unguessable id — it is also the share-link token (/i/<id>). */
  id: string;
  /** Human number, e.g. "DH-1001". */
  number: string;
  version: number;
  voided: boolean;
  /** Local "YYYY-MM-DD". */
  issueDate: string;
  /** Local "YYYY-MM-DD", or "" for due on receipt. */
  dueDate: string;
  client: InvoiceParty;
  /** One-paragraph scope (the proposal summary). May be "". */
  project: string;
  lines: InvoiceLine[];
  /** Optional discount, applied to the sum of the lines. */
  discount?: InvoiceDiscount;
  /** What's owed: the sum of the lines, less any discount. */
  total: number;
  /**
   * Surcharge added at payment time when the customer pays with a CREDIT card
   * (never debit/prepaid — card-network rules). 0 = no fee.
   */
  cardFeePercent: number;
  /** Free-form note printed near the totals (e.g. what continues monthly). May be "". */
  notes: string;
  /** The proposal this invoice was generated from, when there was one. */
  source?: {
    fileName: string;
    /** Storage pathname of the uploaded proposal PDF (never exposed publicly). */
    path: string;
    /** As printed on the proposal, e.g. "September 18, 2026". */
    proposalDate: string;
  };
  createdAt: string;
  updatedAt: string;
}

/** A card payment recorded against an invoice (written once per PaymentIntent, never edited). */
export interface InvoicePayment {
  paymentIntentId: string;
  chargeId?: string;
  /** Dollars actually charged, card fee included. */
  amount: number;
  /** The surcharge portion of `amount` (0 for debit / prepaid cards). */
  fee: number;
  brand?: string;
  last4?: string;
  /** "credit" | "debit" | "prepaid" | "unknown" */
  funding?: string;
  paidAt: string;
  receiptUrl?: string;
  livemode?: boolean;
  /** Stripe customer the card was saved to (invoices with monthly/yearly lines). */
  customerId?: string;
}

/**
 * The Stripe subscription that bills an invoice's recurring lines after the first period
 * (the first period is on the invoice itself). Written once when it's created, never edited;
 * Stripe is the source of truth for its later status.
 */
export interface InvoiceSubscription {
  subscriptionId: string;
  customerId: string;
  interval: RecurringInterval;
  /** Dollars per period, all of this interval's lines together. */
  amount: number;
  /** When Stripe first charges the saved card (ISO). */
  startsAt: string;
  createdAt: string;
  livemode?: boolean;
}

export type InvoiceStatus = "open" | "paid" | "void";

/** An invoice as served: latest version + its payments + derived balance. */
export interface Invoice extends InvoiceDoc {
  payments: InvoicePayment[];
  subscriptions: InvoiceSubscription[];
  /** Applied to the invoice balance (payments minus card fees). */
  paid: number;
  balance: number;
  status: InvoiceStatus;
  /** When the balance reached zero. */
  paidAt?: string;
}

export function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function toCents(dollars: number): number {
  return Math.round(round2(dollars) * 100);
}

export function sumLines(lines: Pick<InvoiceLine, "amount">[]): number {
  return round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
}

/** Lines → their sum, the discount in dollars (never more than the sum), and the total due. */
export function invoiceTotals(lines: Pick<InvoiceLine, "amount">[], discount?: InvoiceDiscount | null): { subtotal: number; discount: number; total: number } {
  const subtotal = sumLines(lines);
  let off = 0;
  if (discount && discount.value > 0 && subtotal > 0) {
    off = discount.kind === "percent" ? round2((subtotal * Math.min(discount.value, 100)) / 100) : Math.min(round2(discount.value), subtotal);
  }
  return { subtotal, discount: off, total: round2(Math.max(subtotal - off, 0)) };
}

/** "Discount (10%)" or "Discount". */
export function discountLabel(d: InvoiceDiscount): string {
  return d.kind === "percent" ? `Discount (${round2(d.value)}%)` : "Discount";
}

/** "$2,494.99" — always two decimals, US grouping. */
export function fmtMoney(n: number): string {
  const v = round2(n);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The fee a CREDIT card adds on top of `base` at `percent` (3 → 3%). */
export function cardFee(base: number, percent: number): number {
  if (!(percent > 0) || !(base > 0)) return 0;
  return round2((base * percent) / 100);
}

/** Only credit cards carry the surcharge; debit, prepaid and unknown never do. */
export function feeAppliesTo(funding: string | null | undefined): boolean {
  return funding === "credit";
}

export interface CardFeeWording {
  /** Line under the amount in the pay box. */
  hint: string;
  /** The fee line in the pay box's review step. */
  label: string;
  /** The invoice page's note, given this invoice's fee in dollars. */
  note: (fee: string) => string;
  /** PDF pay-box clauses (it breaks between them when one line is too narrow). */
  pdf: (fee: string) => string[];
}

/**
 * What the page, pay box and PDF say about the card fee. `allCards` = every card pays it,
 * debit too; otherwise credit cards only. "Not more than our cost" is only claimed at or
 * under 2.9% (DH's Stripe cost is 2.9% + 30¢).
 */
export function cardFeeWording(percent: number, allCards: boolean): CardFeeWording {
  const p = `${round2(percent)}%`;
  if (allCards) {
    return {
      hint: `Card payments add a ${p} card processing fee.`,
      label: `Card processing fee (${p})`,
      note: (fee) => `Paying by card adds a ${p} card processing fee (${fee}). You’ll see the exact total before you confirm.`,
      pdf: (fee) => [`Card payments add a ${p} processing fee (${fee}).`],
    };
  }
  if (percent <= 2.9) {
    return {
      hint: `Credit cards add our ${p} surcharge (not more than our cost). Debit and prepaid cards pay none.`,
      label: `Credit card surcharge (${p})`,
      note: (fee) =>
        `Paying by credit card adds our ${p} credit card surcharge (${fee}), which is not more than our cost of accepting credit cards. Debit and prepaid cards pay no surcharge. You’ll see the exact total before you confirm.`,
      pdf: (fee) => [`Credit cards add our ${p} surcharge (${fee}), not more than our cost;`, "debit and prepaid cards pay none."],
    };
  }
  return {
    hint: `Credit cards add a ${p} card processing fee. Debit and prepaid cards pay none.`,
    label: `Credit card fee (${p})`,
    note: (fee) => `Paying by credit card adds a ${p} card processing fee (${fee}). Debit and prepaid cards pay no fee. You’ll see the exact total before you confirm.`,
    pdf: (fee) => [`Paying by credit card adds a ${p} card fee (${fee});`, "debit and prepaid cards pay none."],
  };
}

export interface RecurringGroup {
  interval: RecurringInterval;
  /** Dollars per period for these lines together. */
  amount: number;
  lines: InvoiceLine[];
}

/**
 * The lines that keep billing after this invoice, one group per interval (a Stripe
 * subscription can't mix monthly and yearly prices). Zero-priced lines never recur.
 */
export function recurringGroups(lines: InvoiceLine[]): RecurringGroup[] {
  const out: RecurringGroup[] = [];
  for (const interval of ["month", "year"] as const) {
    const ls = lines.filter((l) => l.recurring?.interval === interval && l.recurring.amount > 0);
    if (ls.length) out.push({ interval, amount: round2(ls.reduce((s, l) => s + (l.recurring?.amount ?? 0), 0)), lines: ls });
  }
  return out;
}

/**
 * One billing period after `from`, same time of day. A month-end date clamps to the
 * shorter month (Jan 31 → Feb 28), as Stripe does, so the first charge never skips a month.
 */
export function addPeriod(from: Date, interval: RecurringInterval): Date {
  const y = from.getUTCFullYear() + (interval === "year" ? 1 : 0);
  const m = from.getUTCMonth() + (interval === "month" ? 1 : 0);
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = new Date(from.getTime());
  d.setUTCFullYear(y, m, Math.min(from.getUTCDate(), lastDay));
  return d;
}

/**
 * When a subscription's first charge lands: one period after the payment. Stripe refuses an
 * anchor later than its own next natural billing date (now + one period, month ends clamped),
 * which a retry across a month end can hit (paid Oct 30, retried Oct 31) — then just under it.
 */
export function firstChargeAt(paidAt: Date, interval: RecurringInterval, now: Date = new Date()): Date {
  const want = addPeriod(paidAt, interval);
  const latest = addPeriod(now, interval);
  return want.getTime() <= latest.getTime() ? want : new Date(latest.getTime() - 60_000);
}

/** Fold a version + its payments into what the dashboard and public page show. */
export function deriveInvoice(doc: InvoiceDoc, payments: InvoicePayment[], subscriptions: InvoiceSubscription[] = []): Invoice {
  const sorted = payments.slice().sort((a, b) => (a.paidAt < b.paidAt ? -1 : a.paidAt > b.paidAt ? 1 : 0));
  const paid = round2(sorted.reduce((s, p) => s + (p.amount - p.fee), 0));
  const balance = round2(Math.max(doc.total - paid, 0));
  const status: InvoiceStatus = doc.voided ? "void" : balance <= 0 && doc.total > 0 ? "paid" : "open";
  let paidAt: string | undefined;
  if (status === "paid") {
    let running = 0;
    for (const p of sorted) {
      running = round2(running + p.amount - p.fee);
      if (running >= doc.total) {
        paidAt = p.paidAt;
        break;
      }
    }
  }
  const subs = subscriptions.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return { ...doc, payments: sorted, subscriptions: subs, paid, balance, status, ...(paidAt ? { paidAt } : {}) };
}

/**
 * An instant (ISO) → "YYYY-MM-DD" on Digital Horizon's calendar (Carson City, NV), so an
 * evening payment isn't shown as the next day's UTC date. Same zone as the PDF and the
 * Customers tab.
 */
export function localYmd(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** "2026-09-18" → "September 18, 2026" (no time-zone shift: the date is a calendar date). */
export function fmtLongDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
