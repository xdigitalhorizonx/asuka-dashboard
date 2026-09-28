import { fmtMoney, round2, sumLines, type InvoiceLine, type RecurringInterval } from "@/lib/invoice/types";
import { hasUnreadablePrice, totalsWarnings, unreadablePriceWarning, type ParsedProposal, type ParsedService } from "./parse";

/**
 * Turn a parsed proposal into draft invoice lines.
 *
 * Billing rule (owner's decision): the first invoice bills the proposal's INITIAL INVESTMENT —
 * every one-time line plus the FIRST period of every recurring line. Later periods are not on
 * this invoice; `notes` says what continues and at what rate. Additional services are offered,
 * not sold, so they are never billed here.
 *
 * Nothing is silently "fixed": whenever the lines disagree with the totals printed on the
 * proposal, or a price couldn't be read, the draft still comes back and `warnings` says so.
 */
export interface InvoiceDraft {
  lines: InvoiceLine[];
  total: number;
  notes: string;
  warnings: string[];
}

const PER: Record<RecurringInterval, string> = { month: "mo", year: "yr" };

function toLine(s: ParsedService, id: string): InvoiceLine {
  const base = { id, name: s.name, description: s.description, type: s.type };
  // Zero-priced lines never carry `recurring`: there is nothing to bill later (TYPE still says "Monthly").
  if (s.free) return { ...base, recurring: null, amount: 0, zeroLabel: "FREE", note: "" };
  if (s.amount === null) {
    // An empty PRICE cell means the service is part of the package. An unreadable one gets no
    // label on purpose: it prints as $0.00 until someone enters the amount (see warnings).
    return { ...base, recurring: null, amount: 0, zeroLabel: hasUnreadablePrice(s) ? "" : "Included", note: "" };
  }
  if (s.amount === 0) return { ...base, recurring: null, amount: 0, zeroLabel: "FREE", note: "" }; // "$0" means no charge
  if (s.recurring) {
    return {
      ...base,
      recurring: { interval: s.recurring, amount: s.amount },
      amount: s.amount,
      zeroLabel: "",
      note: `First ${s.recurring} · then ${fmtMoney(s.amount)}/${PER[s.recurring]}`,
    };
  }
  return { ...base, recurring: null, amount: s.amount, zeroLabel: "", note: "" };
}

/** "A", "A and B", "A, B and C". */
function listOf(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** One factual sentence about what keeps billing after this invoice, or "" when nothing does. */
function continuingNote(lines: InvoiceLine[]): string {
  const clauses: string[] = [];
  for (const interval of ["month", "year"] as const) {
    const recurring = lines.filter((l) => l.recurring?.interval === interval && l.recurring.amount > 0);
    if (!recurring.length) continue;
    const rate = (l: InvoiceLine) => `${fmtMoney(l.recurring?.amount ?? 0)}/${PER[interval]}`;
    clauses.push(
      recurring.length === 1
        ? `${recurring[0].name} continues at ${rate(recurring[0])} after the first ${interval}`
        : `${listOf(recurring.map((l) => `${l.name} (${rate(l)})`))} continue after the first ${interval}`,
    );
  }
  return clauses.length ? `${clauses.join(", and ")}.` : "";
}

export function draftInvoiceLines(p: ParsedProposal, opts: { idPrefix?: string } = {}): InvoiceDraft {
  const prefix = opts.idPrefix ?? "l";
  const lines = p.services.map((s, i) => toLine(s, `${prefix}${i + 1}`));
  const total = sumLines(lines);
  const warnings: string[] = [];

  for (const s of p.services) if (hasUnreadablePrice(s)) warnings.push(unreadablePriceWarning(s));
  for (const l of lines) {
    if (l.amount < 0) warnings.push(`“${l.name}” is a credit of ${fmtMoney(l.amount)} — make sure it belongs on this invoice.`);
  }
  warnings.push(...totalsWarnings(p.services, p.totals));
  if (p.totals.initial === null) {
    warnings.push("The proposal's INITIAL INVESTMENT couldn't be read, so this total wasn't checked against it.");
  } else if (total !== round2(p.totals.initial)) {
    warnings.push(`This invoice totals ${fmtMoney(total)}, but the proposal's INITIAL INVESTMENT says ${fmtMoney(p.totals.initial)}.`);
  }
  if (p.totals.oneTime === null) warnings.push("The proposal's TOTAL ONE-TIME couldn't be read, so the one-time lines weren't checked against it.");
  if (p.totals.monthly === null) warnings.push("The proposal's TOTAL MONTHLY couldn't be read, so the monthly lines weren't checked against it.");

  return { lines, total, notes: continuingNote(lines), warnings };
}
