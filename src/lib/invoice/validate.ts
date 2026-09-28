import { PROPOSALS_PREFIX, type InvoiceInput } from "./store";
import { round2, type InvoiceLine, type InvoiceParty } from "./types";

/**
 * Everything the dashboard posts to create or edit an invoice passes through here:
 * trimmed, length-capped, numbers rounded to cents and range-checked. Throws with a
 * message fit to show Brandon when the input can't be saved as-is.
 */

export class InvoiceInputError extends Error {}

/** Visa caps credit-card surcharges at 3%; the fee can be lowered or turned off, never raised past it. */
export const MAX_CARD_FEE_PERCENT = 3;

export function defaultCardFeePercent(): number {
  const n = Number(process.env.INVOICE_CARD_FEE_PERCENT ?? 3);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_CARD_FEE_PERCENT) : 3;
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

export function validateInvoiceInput(raw: unknown): InvoiceInput {
  const o = (raw ?? {}) as Record<string, unknown>;
  const lines = Array.isArray(o.lines) ? o.lines.slice(0, 101) : [];
  if (!lines.length) throw new InvoiceInputError("Add at least one line item.");
  if (lines.length > 100) throw new InvoiceInputError("An invoice can have at most 100 lines.");
  const parsedLines = lines.map(line);
  if (!parsedLines.some((l) => l.amount > 0)) throw new InvoiceInputError("The invoice total is $0 — add an amount to at least one line.");
  const issueDate = ymd(o.issueDate);
  if (!issueDate) throw new InvoiceInputError("Issue date is required.");
  const dueDate = ymd(o.dueDate);
  if (dueDate && dueDate < issueDate) throw new InvoiceInputError("The due date is before the issue date.");
  const fee = Number(o.cardFeePercent ?? defaultCardFeePercent());
  if (!Number.isFinite(fee) || fee < 0 || fee > MAX_CARD_FEE_PERCENT) {
    throw new InvoiceInputError(`Card fee must be between 0% and ${MAX_CARD_FEE_PERCENT}%.`);
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
    cardFeePercent: Math.round(fee * 100) / 100,
    notes: str(o.notes, 1000),
    ...(source ? { source } : {}),
  };
}
