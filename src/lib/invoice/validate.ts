import { PROPOSALS_PREFIX, type InvoiceInput } from "./store";
import { depositSplit, fmtMoney, invoiceTotals, MIN_CHARGE, round2, sumLines, type InvoiceDiscount, type InvoiceLine, type InvoiceParty } from "./types";

/**
 * Everything the dashboard posts to create or edit an invoice passes through here:
 * trimmed, length-capped, numbers rounded to cents and range-checked. Throws with a
 * message fit to show Brandon when the input can't be saved as-is.
 */

export class InvoiceInputError extends Error {}

/**
 * The most a card fee can ever be here: Visa's hard cap. Digital Horizon's Stripe cost is
 * 2.9% + 30¢ on every card, so only up to 2.9% is at-or-under cost on every charge — the
 * page claims "not more than our cost" only then (see `cardFeeWording`).
 */
export const MAX_CARD_FEE_PERCENT = 3;

/**
 * Which cards pay the fee. Card-network rules allow a surcharge on credit cards only, so that
 * is the default; INVOICE_CARD_FEE_CARDS=all charges every card, debit and prepaid included
 * (Brandon's call, 2026-09-29, knowing it breaks those rules).
 */
export function cardFeeAllCards(): boolean {
  return (process.env.INVOICE_CARD_FEE_CARDS || "").trim().toLowerCase() === "all";
}

/**
 * The card fee in force: INVOICE_CARD_FEE_PERCENT, capped at 3%, and 0 — fee OFF — when
 * unset. (Visa requires 30 days' written notice to Stripe before the first surcharge or its
 * announcement; see README.) It is the default for new invoices, the most an invoice may
 * carry, and a cap on what an existing invoice charges (one saved higher pays this one).
 */
export function cardFeeCeiling(): number {
  const n = Number(process.env.INVOICE_CARD_FEE_PERCENT ?? 0);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_CARD_FEE_PERCENT) : 0;
}

export function defaultCardFeePercent(): number {
  return cardFeeCeiling();
}

/** The fee an invoice actually carries today: its own setting, never above the ceiling. */
export function effectiveCardFeePercent(inv: { cardFeePercent: number }): number {
  const own = Number(inv.cardFeePercent) || 0;
  return Math.min(Math.max(own, 0), cardFeeCeiling());
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const ymd = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : "");

function money(v: unknown, label: string): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new InvoiceInputError(`${label}: enter an amount between $0 and $1,000,000.`);
  return round2(n);
}

function party(v: unknown): InvoiceParty {
  const o = (v ?? {}) as Record<string, unknown>;
  const p = { name: str(o.name, 160), email: str(o.email, 200), phone: str(o.phone, 60), address: str(o.address, 400) };
  if (!p.name) throw new InvoiceInputError("Bill to: the client name is required.");
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) throw new InvoiceInputError("Bill to: that email address doesn't look right.");
  return p;
}

function line(v: unknown, i: number): InvoiceLine {
  const o = (v ?? {}) as Record<string, unknown>;
  const name = str(o.name, 200);
  if (!name) throw new InvoiceInputError(`Line ${i + 1}: a service name is required.`);
  const amount = money(o.amount, `Line ${i + 1} (${name})`);
  const r = o.recurring as { interval?: unknown; amount?: unknown } | null | undefined;
  const recurring =
    r && (r.interval === "month" || r.interval === "year") ? { interval: r.interval as "month" | "year", amount: money(r.amount, `Line ${i + 1} recurring price`) } : null;
  const zero = str(o.zeroLabel, 20);
  return {
    id: str(o.id, 40) || `l${i + 1}`,
    name,
    description: str(o.description, 600),
    type: str(o.type, 40),
    recurring,
    amount,
    zeroLabel: amount === 0 ? zero || "Included" : "",
    note: str(o.note, 200),
  };
}

/** `{ kind: "percent" | "amount", value }` → a discount, or undefined for none / zero. */
function discount(v: unknown, subtotal: number): InvoiceDiscount | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const kind = o.kind === "percent" || o.kind === "amount" ? o.kind : null;
  if (!kind) return undefined;
  const value = typeof o.value === "number" ? o.value : Number(String(o.value ?? "").replace(/[$%,\s]/g, ""));
  if (!Number.isFinite(value) || value < 0) throw new InvoiceInputError("Discount: enter a number, 0 or more.");
  if (value === 0) return undefined;
  if (kind === "percent" && value > 100) throw new InvoiceInputError("Discount: a percent can't be over 100%.");
  if (kind === "amount" && round2(value) > subtotal) throw new InvoiceInputError(`Discount: it can't be more than the lines' ${fmtMoney(subtotal)}.`);
  return { kind, value: round2(value) };
}

/** A deposit percent (the dashboard's box sends 50), or undefined for none. */
function deposit(v: unknown, lines: InvoiceLine[], disc: InvoiceDiscount | undefined): number | undefined {
  if (v === undefined || v === null || v === "" || v === false || v === 0) return undefined;
  const pct = Number(v);
  if (!Number.isInteger(pct) || pct < 1 || pct > 99) throw new InvoiceInputError("Deposit: use a whole percent from 1 to 99.");
  const split = depositSplit(lines, disc, pct);
  if (!split) throw new InvoiceInputError(`${pct}% deposit: there are no one-time items to split — add one or untick the deposit.`);
  if (split.now < MIN_CHARGE || split.later < MIN_CHARGE) throw new InvoiceInputError(`${pct}% deposit: each payment must be at least ${fmtMoney(MIN_CHARGE)}.`);
  return pct;
}

export function validateInvoiceInput(raw: unknown): InvoiceInput {
  const o = (raw ?? {}) as Record<string, unknown>;
  const lines = Array.isArray(o.lines) ? o.lines.slice(0, 101) : [];
  if (!lines.length) throw new InvoiceInputError("Add at least one line item.");
  if (lines.length > 100) throw new InvoiceInputError("An invoice can have at most 100 lines.");
  const parsedLines = lines.map(line);
  if (!parsedLines.some((l) => l.amount > 0)) throw new InvoiceInputError("The invoice total is $0 — add an amount to at least one line.");
  const disc = discount(o.discount, sumLines(parsedLines));
  if (disc && invoiceTotals(parsedLines, disc).total <= 0) throw new InvoiceInputError("The discount takes the total to $0 — lower it.");
  const issueDate = ymd(o.issueDate);
  if (!issueDate) throw new InvoiceInputError("Issue date is required.");
  const dueDate = ymd(o.dueDate);
  if (dueDate && dueDate < issueDate) throw new InvoiceInputError("The due date is before the issue date.");
  const fee = Number(o.cardFeePercent ?? defaultCardFeePercent());
  const ceiling = cardFeeCeiling();
  if (!Number.isFinite(fee) || fee < 0 || fee > ceiling) {
    throw new InvoiceInputError(
      ceiling > 0 ? `Card fee must be between 0% and ${ceiling}%.` : "Card fees are off (INVOICE_CARD_FEE_PERCENT isn't set) — set the card fee to 0%."
    );
  }
  const src = o.source as { fileName?: unknown; path?: unknown; proposalDate?: unknown } | undefined;
  const source =
    src && typeof src.path === "string" && src.path.startsWith(PROPOSALS_PREFIX) && !src.path.includes("..")
      ? { fileName: str(src.fileName, 160) || "proposal.pdf", path: src.path, proposalDate: str(src.proposalDate, 40) }
      : undefined;
  return {
    issueDate,
    dueDate,
    client: party(o.client),
    project: str(o.project, 2000),
    lines: parsedLines,
    // Always present (undefined = none), so an edit that removes the discount or deposit clears it.
    discount: disc,
    depositPercent: deposit(o.depositPercent, parsedLines, disc),
    cardFeePercent: Math.round(fee * 100) / 100,
    notes: str(o.notes, 1000),
    ...(source ? { source } : {}),
  };
}
