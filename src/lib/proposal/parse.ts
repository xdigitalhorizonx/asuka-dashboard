import { getDocumentProxy } from "unpdf";
import { fmtMoney, round2 } from "@/lib/invoice/types";

/**
 * Reads a Digital Horizon service proposal — the PDF that lib/proposal/pdf.tsx in the
 * digital-horizon repo renders with @react-pdf/renderer — back into data, so an uploaded
 * proposal can pre-fill an invoice.
 *
 * pdf.js returns text in drawing order, not reading order (a price can arrive at the very end of
 * the page), so everything here works from positions: text runs are grouped into lines by
 * baseline, lines into table rows by the vertical gap between rows, and cells into columns by the
 * x-positions of the table header. Nothing throws: a foreign, corrupt or locked file comes back
 * as `ok: false` with a reason, and anything odd in a real proposal becomes a warning.
 */

export interface ParsedService {
  name: string;
  description: string;
  type: string;
  priceText: string;
  priceNote: string;
  /** Dollars; null when there is no price (empty cell) or it couldn't be read. */
  amount: number | null;
  free: boolean;
  recurring: null | "month" | "year";
}

export interface ParsedAddOn {
  name: string;
  pricing: string;
  amount: number | null;
}

export interface ParsedProposal {
  /** false when this doesn't look like a Digital Horizon proposal (no SERVICE/TYPE/PRICE table found). */
  ok: boolean;
  /** Human-readable why-not when !ok. */
  reason?: string;
  /** "" when unknown. */
  client: string;
  proposalDate: string;
  proposalDateISO: string;
  summary: string;
  services: ParsedService[];
  additional: ParsedAddOn[];
  totals: { monthly: number | null; oneTime: number | null; initial: number | null };
  contact: { phone: string; email: string };
  /** PDF metadata title. */
  title: string;
  /** Anything suspicious (unparseable price, totals that don't add up, …). */
  warnings: string[];
}

export type Interval = "month" | "year";

// --- Layout facts (from pdf.tsx) and tolerances -------------------------------------------------

/** A proposal is 2–4 pages; anything far longer is not one, and reading it would only waste time. */
const MAX_PAGES = 20;
const MAX_BYTES = 20 * 1024 * 1024;
/** Runs within this many points of each other vertically share a baseline. */
const BASELINE_TOL = 0.5;
/** Left-aligned cells start exactly at their column's x; allow for rounding. */
const COL_TOL = 2;
/** Prices are right-aligned to the header's right edge (letter-spacing moves the label ~0.6pt). */
const RIGHT_TOL = 3;
/** Table/meta/totals labels are 8pt caps; body text is 8.5pt and up, section titles 13pt. */
const LABEL_MAX_SIZE = 9.25;
const SECTION_MIN_SIZE = 11.5;
/**
 * Rows have 10pt padding top and bottom, so consecutive rows' baselines are ≥ ~30pt apart, while
 * lines inside one row (wrapped name, description, price note) sit ≤ ~14pt apart in either font.
 * Two name-heights (20pt) splits them with room on both sides.
 */
const ROW_GAP_EM = 2;
/** The footer sits in the 36pt bottom padding; content never does. */
const FOOTER_MAX_Y = 32;
/** The page header (logo line + "Prepared for" strip, which wraps for long names) sits in the top ~70pt. */
const HEADER_ZONE = 90;
const PAGE_PADDING_X = 40;

// --- Positioned text ----------------------------------------------------------------------------

/** One text run as pdf.js reports it, in PDF points (origin bottom-left). */
interface Run {
  page: number;
  x: number;
  y: number;
  w: number;
  size: number;
  str: string;
  pageWidth: number;
  pageHeight: number;
}

/** Runs that share a baseline and a font size and sit next to each other. */
interface Line {
  page: number;
  x0: number;
  x1: number;
  y: number;
  size: number;
  text: string;
}

/** A place in the document in reading order (earlier page, or higher on the same page). */
interface Mark {
  page: number;
  y: number;
}

const byReadingOrder = (a: Line, b: Line) => a.page - b.page || b.y - a.y || a.x0 - b.x0;
const isAfter = (l: Mark, m: Mark) => l.page > m.page || (l.page === m.page && l.y < m.y - 1);
const isBefore = (l: Mark, m: Mark) => l.page < m.page || (l.page === m.page && l.y > m.y + 1);

/**
 * Group runs into lines. Runs on one baseline are split wherever the font size changes or a gap
 * wider than 1.5 em opens up. Cells that can sit closer than that in the same size (meta row,
 * table columns) are separated by column first — see columnLines.
 */
function toLines(runs: Run[]): Line[] {
  const sorted = [...runs].sort((a, b) => a.page - b.page || b.y - a.y);
  const lines: Line[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].page === sorted[i].page && sorted[i].y - sorted[j].y <= BASELINE_TOL) j++;
    const band = sorted.slice(i, j).sort((a, b) => a.x - b.x);
    const open: { runs: Run[]; x1: number; size: number }[] = [];
    for (const r of band) {
      const seg = open.find((s) => Math.abs(s.size - r.size) <= 0.3 && r.x >= s.x1 - r.size * 0.5 && r.x - s.x1 <= r.size * 1.5);
      if (seg) {
        seg.runs.push(r);
        seg.x1 = Math.max(seg.x1, r.x + r.w);
      } else {
        open.push({ runs: [r], x1: r.x + r.w, size: r.size });
      }
    }
    for (const s of open) lines.push(lineOf(s.runs));
    i = j;
  }
  return lines.sort(byReadingOrder);
}

function lineOf(runs: Run[]): Line {
  let text = "";
  let end = -Infinity;
  for (const r of runs) {
    // pdf.js drops the space between runs it splits (font change, wide gap); a visible gap is one.
    if (text && r.x - end > r.size * 0.15 && !/\s$/.test(text) && !/^\s/.test(r.str)) text += " ";
    text += r.str;
    end = Math.max(end, r.x + r.w);
  }
  return {
    page: runs[0].page,
    x0: runs[0].x,
    x1: end,
    y: Math.max(...runs.map((r) => r.y)),
    size: runs[0].size,
    text: text.replace(/\s+/g, " ").trim(),
  };
}

/**
 * Lines of a table-like region, never merged across column boundaries: runs are split at the
 * given x positions first. Neighbouring cells can sit ~10pt apart in the same font size (the meta
 * row), closer than any gap threshold that still keeps a normal line in one piece.
 */
function columnLines(runs: Run[], splits: number[]): Line[] {
  const cols: Run[][] = [[], ...splits.map((): Run[] => [])];
  for (const r of runs) cols[splits.filter((x) => r.x >= x - COL_TOL).length].push(r);
  return cols.flatMap(toLines).sort(byReadingOrder);
}

/** Page header (logo line, right-aligned "Prepared for" strip) and footer — repeated chrome, not content. */
function isChrome(r: Run): boolean {
  if (r.y < FOOTER_MAX_Y) return true;
  if (r.y < r.pageHeight - HEADER_ZONE) return false;
  const rightEdge = r.pageWidth - PAGE_PADDING_X;
  if (r.size < 9 && Math.abs(r.x + r.w - rightEdge) < COL_TOL) return true;
  return r.size > 11 && r.str.trim() === "Digital Horizon";
}

/** Labels are letter-spaced caps; some fonts make pdf.js see spaces inside them ("TOTAL MO NTHLY"). */
/** Whitespace, and hyphens/dashes of every kind (U+2010–2014): what line wrapping and letter-spacing disturb. */
const SPACE_OR_DASH = /[\s\-\u2010-\u2014]/g;
const labelKey = (text: string) => text.toUpperCase().replace(SPACE_OR_DASH, "");
const isLabel = (l: Line, key: string) => l.size < LABEL_MAX_SIZE && labelKey(l.text) === key;
const isSection = (l: Line) => l.size > SECTION_MIN_SIZE;
/** Where a table stops: the next section title, or the "Ready to move forward?" call to action. */
const isSectionEnd = (l: Line) => isSection(l) || /^ready to move forward\b/i.test(l.text);

// --- Wrapped text -------------------------------------------------------------------------------

const trimPunct = (s: string) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** Every word in the document, lower-cased: the evidence `joinWrappedLines` settles hyphens with. */
export function vocabulary(texts: string[]): Set<string> {
  const words = new Set<string>();
  for (const t of texts) {
    for (const raw of t.split(/\s+/)) {
      const w = trimPunct(raw).toLowerCase();
      if (w) words.add(w);
    }
  }
  return words;
}

function hasCompound(words: Set<string>, form: string): boolean {
  for (const w of words) {
    if (w === form || w.startsWith(`${form}-`) || w.endsWith(`-${form}`) || w.includes(`-${form}-`)) return true;
  }
  return false;
}

/** Prefixes business copy conventionally hyphenates ("multi-vendor", "self-service", "non-profit"). */
const COMPOUND_PREFIXES = new Set(["multi", "self", "non"]);

/**
 * Join the visual lines of one wrapped text block back into the string that was typeset.
 *
 * react-pdf (textkit v6) breaks a line in only two places: at a space, which it drops, or between
 * two syllables of a word, where it inserts a "-" glyph ("content man-" / "agement"). It never
 * breaks right after a hyphen already in the text ("multi-vendor" splits as "mul-" / "ti-vendor"),
 * so a line ending in "<letter>-" is almost always an inserted hyphen and is removed. It is kept
 * only when:
 *  - the next word is "and" — a suspended hyphen that broke at its space ("pre- and post-launch");
 *  - a digit touches it ("24-" / "hour") — the hyphenation patterns never split numbers;
 *  - the document spells the hyphenated compound elsewhere, unbroken, and never the closed form
 *    (conversely "management" seen elsewhere confirms dropping it);
 *  - with no evidence either way, the fragment is one of COMPOUND_PREFIXES and a real-looking word
 *    (4+ letters) follows, so "multi-" + "vendor" stays "multi-vendor" (a renderer that does break
 *    at hard hyphens would produce exactly that) while "multi-" + "ple" still becomes "multiple".
 * Every other line break was a space.
 */
export function joinWrappedLines(lines: string[], words: Set<string> = new Set()): string {
  let out = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    out = out ? joinPair(out, line, words) : line;
  }
  return out;
}

function joinPair(prev: string, next: string, words: Set<string>): string {
  if (!/[\p{L}\p{N}]-$/u.test(prev) || !/^[\p{L}\p{N}]/u.test(next)) return `${prev} ${next}`;
  const head = prev.slice(0, -1);
  const a = trimPunct(head.slice(head.lastIndexOf(" ") + 1)).toLowerCase();
  const b = trimPunct(next.split(" ", 1)[0]).toLowerCase();
  if (b === "and") return `${prev} ${next}`;
  if (/\d$/.test(a) || /^\d/.test(b)) return prev + next;
  const hyphenated = hasCompound(words, `${a}-${b}`);
  const closed = words.has(a + b);
  if (hyphenated !== closed) return hyphenated ? prev + next : head + next;
  const prefix = a.slice(a.lastIndexOf("-") + 1);
  if (COMPOUND_PREFIXES.has(prefix) && /^\p{L}{4}/u.test(b)) return prev + next;
  return head + next;
}

// --- Money, intervals, dates --------------------------------------------------------------------

export interface PriceRead {
  /** Dollars; null for an empty/"Included" cell or text that isn't a single price. */
  amount: number | null;
  free: boolean;
  /** Interval stated in the price text itself ("/ mo", "per year", "annually"). */
  interval: Interval | null;
  /** false when the text is a price we couldn't read ("$250 + ad spend", "from $500"). */
  readable: boolean;
}

const FREE_RE = /^(?:free|complimentary|no charge|no cost)$/i;
const INCLUDED_RE = /^(?:included|incl\.?|bundled)\b/i;
const PER = String.raw`\s*(?:\/|\bper\b|\ba\b|\beach\b|\bevery\b)\s*`;
const MONTH_SUFFIX = new RegExp(String.raw`(?:${PER}(?:mo|mos|mth|month)\.?|\s+monthly)$`, "i");
const YEAR_SUFFIX = new RegExp(String.raw`(?:${PER}(?:yr|yrs|year|annum)\.?|\s+(?:annually|yearly))$`, "i");
const ONCE_SUFFIX = /\s*(?:\(\s*one[\s-]?time\s*\)|one[\s-]?time|once)$/i;
const AMOUNT_RE = /^([-\u2212\u2013])?\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s*USD)?$/i;

/**
 * Read one PRICE cell: "$1,100" (or "$1,100 one-time") → 1100; "$94.99 / mo" (or "/mo", "/ month",
 * "per month", "monthly") → 94.99 a month; "/ yr", "/ year", "annually" → a year; "FREE" → 0;
 * "" → no price.
 * Anything else ("$250 + ad spend", "from $500", "$75 / hr") is unreadable rather than guessed.
 */
export function readPrice(text: string): PriceRead {
  let t = text.replace(/\s+/g, " ").trim().replace(/[*†]+$/, "").trim();
  if (!t || INCLUDED_RE.test(t)) return { amount: null, free: false, interval: null, readable: true };
  let interval: Interval | null = null;
  if (MONTH_SUFFIX.test(t)) {
    interval = "month";
    t = t.replace(MONTH_SUFFIX, "").trim();
  } else if (YEAR_SUFFIX.test(t)) {
    interval = "year";
    t = t.replace(YEAR_SUFFIX, "").trim();
  } else {
    t = t.replace(ONCE_SUFFIX, "").trim();
  }
  if (FREE_RE.test(t)) return { amount: 0, free: true, interval, readable: true };
  const m = AMOUNT_RE.exec(t);
  if (!m) return { amount: null, free: false, interval: null, readable: false };
  const value = Number(`${m[2].replace(/,/g, "")}.${m[3] ?? "0"}`);
  return { amount: round2(m[1] ? -value : value), free: false, interval, readable: true };
}

/** "Monthly" → month, "Annual"/"Yearly" → year, one-time/setup → null; other cadences → "other". */
export function intervalOfType(type: string): Interval | "other" | null {
  const t = type.toLowerCase();
  if (/one[\s-]?time|set[\s-]?up|\bonce\b|project/.test(t)) return null;
  if (/quarter|week|daily|\bday\b|hour|bi-?month|semi-?annual|bi-?annual|every\s+\d/.test(t)) return "other";
  if (/month/.test(t)) return "month";
  if (/year|annual/.test(t)) return "year";
  return null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthNumber(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  return w.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(w)) + 1 : 0;
}

function isoDate(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return "";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "September 18, 2026" (also "Sept. 18, 2026", "18 September 2026", "2026-09-18", "9/18/2026") → "2026-09-18"; "" if unreadable. */
export function proposalDateToISO(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  let m = /^(\p{L}+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/u.exec(t);
  if (m) return isoDate(Number(m[3]), monthNumber(m[1]), Number(m[2]));
  m = /^(\d{1,2})(?:st|nd|rd|th)? (\p{L}+)\.?,? (\d{4})$/u.exec(t);
  if (m) return isoDate(Number(m[3]), monthNumber(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return isoDate(Number(m[3]), Number(m[1]), Number(m[2]));
  return "";
}

/** A service whose price cell had text we couldn't turn into an amount (it needs a manual price). */
export function hasUnreadablePrice(s: ParsedService): boolean {
  return s.amount === null && !s.free && !readPrice(s.priceText).readable;
}

export function unreadablePriceWarning(s: ParsedService): string {
  return `“${s.name}”: couldn't read the price “${s.priceText}” — enter the amount by hand.`;
}

/** What the proposal's lines add up to, by billing kind (first period for recurring lines). */
export function lineSums(services: ParsedService[]): { oneTime: number; monthly: number; yearly: number } {
  const sum = (pick: (s: ParsedService) => boolean) => round2(services.filter(pick).reduce((t, s) => t + (s.amount ?? 0), 0));
  return {
    oneTime: sum((s) => s.recurring === null),
    monthly: sum((s) => s.recurring === "month"),
    yearly: sum((s) => s.recurring === "year"),
  };
}

/**
 * Line sums against the TOTAL ONE-TIME / TOTAL MONTHLY printed on the proposal. Shared with the
 * invoice draft so the same mismatch reads the same in both lists. A proposal has no "yearly"
 * total, so yearly lines may or may not be counted in TOTAL ONE-TIME; either reading passes.
 */
export function totalsWarnings(services: ParsedService[], totals: ParsedProposal["totals"]): string[] {
  const sums = lineSums(services);
  const out: string[] = [];
  if (totals.oneTime !== null && sums.oneTime !== round2(totals.oneTime) && round2(sums.oneTime + sums.yearly) !== round2(totals.oneTime)) {
    out.push(`One-time lines add up to ${fmtMoney(sums.oneTime)}, but the proposal's TOTAL ONE-TIME says ${fmtMoney(totals.oneTime)}.`);
  }
  if (totals.monthly !== null && sums.monthly !== round2(totals.monthly)) {
    out.push(`Monthly lines add up to ${fmtMoney(sums.monthly)}, but the proposal's TOTAL MONTHLY says ${fmtMoney(totals.monthly)}.`);
  }
  return out;
}

/** A totals figure: "$2,494.99" → 2494.99, "FREE" → 0 (a stray "/ mo" is ignored). */
function readTotal(text: string): number | null {
  const p = readPrice(text);
  return p.readable ? p.amount : null;
}

// --- Document parsing ---------------------------------------------------------------------------

interface Meta {
  title: string;
  subject: string;
  author: string;
}

interface Extracted {
  runs: Run[];
  meta: Meta;
}

function emptyProposal(): ParsedProposal {
  return {
    ok: false,
    client: "",
    proposalDate: "",
    proposalDateISO: "",
    summary: "",
    services: [],
    additional: [],
    totals: { monthly: null, oneTime: null, initial: null },
    contact: { phone: "", email: "" },
    title: "",
    warnings: [],
  };
}

const failure = (reason: string, title = ""): ParsedProposal => ({ ...emptyProposal(), reason, title });

class NotAProposal extends Error {}

/** A PDF starts with "%PDF-" (pdf.js tolerates a little junk before it, so look a short way in). */
function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

async function extract(bytes: Uint8Array): Promise<Extracted> {
  // Copy: pdf.js may take ownership of (detach) the buffer it is handed, and the caller usually
  // still needs the bytes (to store the upload). No font loading — we only want text.
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0, disableFontFace: true, useSystemFonts: false });
  try {
    if (pdf.numPages > MAX_PAGES) throw new NotAProposal(`It has ${pdf.numPages} pages — far longer than a proposal.`);
    const { info } = await pdf.getMetadata();
    const field = (k: string) => {
      const v = (info as Record<string, unknown> | null)?.[k];
      return typeof v === "string" ? v.trim() : "";
    };
    const runs: Run[] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const { width, height } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const str = item.str.replace(/\u00a0/g, " ");
        if (!str.trim()) continue;
        const [a, b, , , e, f] = item.transform.map(Number);
        runs.push({ page: p, x: e, y: f, w: item.width, size: Math.hypot(a, b), str, pageWidth: width, pageHeight: height });
      }
      page.cleanup();
    }
    return { runs, meta: { title: field("Title"), subject: field("Subject"), author: field("Author") } };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

function readFailure(err: unknown): string {
  if (err instanceof NotAProposal) return `This doesn't look like a Digital Horizon proposal. ${err.message}`;
  const name = err instanceof Error ? err.name : "";
  if (name === "PasswordException") return "This PDF is password-protected. Save an unlocked copy and upload that.";
  if (name === "InvalidPDFException") return "This file isn't a readable PDF (it may be damaged or incomplete).";
  const msg = err instanceof Error ? err.message : String(err);
  return `This PDF couldn't be read (${msg || "unknown error"}).`;
}

export async function parseProposalPdf(bytes: Uint8Array): Promise<ParsedProposal> {
  if (!bytes || bytes.length === 0) return failure("The file is empty.");
  if (bytes.length > MAX_BYTES) return failure("The file is too large to be a proposal.");
  if (!looksLikePdf(bytes)) return failure("This file isn't a PDF.");
  let doc: Extracted;
  try {
    doc = await extract(bytes);
  } catch (err) {
    return failure(readFailure(err));
  }
  try {
    return readProposal(doc);
  } catch (err) {
    // Layout reading is pure code over plain data; this is a last-resort guard, not a code path.
    return failure(`The proposal couldn't be read (${err instanceof Error ? err.message : String(err)}).`, doc.meta.title);
  }
}

interface TableCols {
  serviceX: number;
  typeX: number;
  priceRight: number;
}

function readProposal({ runs, meta }: Extracted): ParsedProposal {
  const body = runs.filter((r) => !isChrome(r));
  const lines = toLines(body);
  const chromeLines = toLines(runs.filter(isChrome));
  // Page 1's header strip: "Service Proposal | Prepared for <client>" (right-aligned, may wrap).
  const headerStrip = toLines(runs.filter((r) => r.page === 1 && isChrome(r) && r.y >= r.pageHeight - HEADER_ZONE && r.size < 9));
  const words = vocabulary([...lines, ...chromeLines].map((l) => l.text).concat(meta.title, meta.subject));
  const join = (ls: Line[]) => joinWrappedLines(ls.map((l) => l.text), words);
  const warnings: string[] = [];

  const header = findHeaderRow(lines, ["SERVICE", "TYPE", "PRICE"], null);
  if (!header) {
    return failure("No SERVICE / TYPE / PRICE table was found, so this doesn't look like a Digital Horizon proposal.", meta.title);
  }
  const [svcLabel, typeLabel, priceLabel] = header;
  const cols: TableCols = { serviceX: svcLabel.x0, typeX: typeLabel.x0, priceRight: priceLabel.x1 };

  // The table runs until the navy totals strip, or failing that the next section / CTA title.
  const TOTAL_KEYS = ["TOTALMONTHLY", "TOTALONETIME", "INITIALINVESTMENT"] as const;
  const afterHeader = lines.filter((l) => isAfter(l, svcLabel));
  const tableEnd = afterHeader.find((l) => isSectionEnd(l) || TOTAL_KEYS.some((k) => isLabel(l, k))) ?? null;
  const tableRuns = body.filter((r) => isAfter(r, svcLabel) && (!tableEnd || isBefore(r, tableEnd)));
  const services = readServiceRows(columnLines(tableRuns, [cols.typeX]), cols, join, warnings);
  if (services.length === 0) {
    return failure("The SERVICE / TYPE / PRICE table has no rows in it.", meta.title);
  }

  // Totals: each figure sits centred under its label.
  const totals: ParsedProposal["totals"] = { monthly: null, oneTime: null, initial: null };
  const totalNames: Record<(typeof TOTAL_KEYS)[number], [keyof typeof totals, string]> = {
    TOTALMONTHLY: ["monthly", "TOTAL MONTHLY"],
    TOTALONETIME: ["oneTime", "TOTAL ONE-TIME"],
    INITIALINVESTMENT: ["initial", "INITIAL INVESTMENT"],
  };
  for (const key of TOTAL_KEYS) {
    const [field, printed] = totalNames[key];
    const label = afterHeader.find((l) => isLabel(l, key));
    const value = label ? totalValue(lines, label) : null;
    if (!label) warnings.push(`Couldn't find ${printed} on the proposal.`);
    else if (!value) warnings.push(`Couldn't find the ${printed} amount on the proposal.`);
    else {
      totals[field] = readTotal(value.text);
      if (totals[field] === null) warnings.push(`Couldn't read ${printed} (“${value.text}”).`);
    }
  }

  // Meta row (page 1): PROPOSAL DATE / CLIENT / PREPARED BY, each value under its label.
  const metaLabels = ["PROPOSALDATE", "CLIENT", "PREPAREDBY"].map((key) => lines.find((l) => isLabel(l, key) && isBefore(l, svcLabel)));
  const [dateLabel, clientLabel] = metaLabels;
  const metaValue = (label: Line | undefined) => join(valueLines(body, label, metaLabels));
  const proposalDate = metaValue(dateLabel);
  const proposalDateISO = proposalDate ? proposalDateToISO(proposalDate) : "";
  if (!proposalDate) warnings.push("Couldn't find the PROPOSAL DATE on the proposal.");
  else if (!proposalDateISO) warnings.push(`Couldn't read the proposal date “${proposalDate}”.`);

  const hero = readHero(lines, dateLabel ?? null, join);
  const client = resolveClient(metaValue(clientLabel), meta, hero.client, join(headerStrip), warnings);
  if (!hero.summary) warnings.push("Couldn't find the summary paragraph on the proposal.");

  const additional = readAddOns(lines, body, svcLabel, join);
  const contact = readContact(lines);

  // Per-line price problems, then whether the proposal's own numbers add up.
  for (const s of services) if (hasUnreadablePrice(s)) warnings.push(unreadablePriceWarning(s));
  warnings.push(...totalsWarnings(services, totals));
  const { monthly, oneTime, initial } = totals;
  if (monthly !== null && oneTime !== null && initial !== null) {
    const stated = round2(monthly + oneTime);
    const yearly = lineSums(services).yearly;
    if (stated !== round2(initial) && round2(stated + yearly) !== round2(initial)) {
      warnings.push(
        `The proposal's TOTAL MONTHLY (${fmtMoney(monthly)}) plus TOTAL ONE-TIME (${fmtMoney(oneTime)}) is ${fmtMoney(stated)}, but its INITIAL INVESTMENT says ${fmtMoney(initial)}.`,
      );
    }
  }
  const branded = [meta.title, meta.author, ...chromeLines.map((l) => l.text)].some((t) => /digital horizon/i.test(t));
  if (!branded) warnings.push("This PDF doesn't carry Digital Horizon's name — make sure it is one of our proposals.");

  return {
    ok: true,
    client,
    proposalDate,
    proposalDateISO,
    summary: hero.summary,
    services,
    additional,
    totals,
    contact,
    title: meta.title,
    warnings,
  };
}

/** The first line of labels matching `keys` left to right on one baseline (optionally after `from`). */
function findHeaderRow(lines: Line[], keys: string[], from: Mark | null): Line[] | null {
  for (const first of lines) {
    if (!isLabel(first, keys[0]) || (from && !isAfter(first, from))) continue;
    const row = [first];
    for (const key of keys.slice(1)) {
      const prev = row[row.length - 1];
      const next = lines.find((l) => l.page === first.page && Math.abs(l.y - first.y) <= 1 && l.x0 > prev.x0 && isLabel(l, key));
      if (!next) break;
      row.push(next);
    }
    if (row.length === keys.length) return row;
  }
  return null;
}

/**
 * Split table lines (reading order) into rows. A row can't straddle pages (rows are
 * wrap={false}), and a baseline gap of more than two name-heights is the padding between rows.
 */
function splitRows(lines: Line[], gap: number): Line[][] {
  const rows: Line[][] = [];
  let prev: Line | null = null;
  for (const l of lines) {
    if (!prev || l.page !== prev.page || prev.y - l.y > gap) rows.push([]);
    rows[rows.length - 1].push(l);
    prev = l;
  }
  return rows;
}

function readServiceRows(lines: Line[], cols: TableCols, join: (ls: Line[]) => string, warnings: string[]): ParsedService[] {
  // Service names set the scale: descriptions and price notes are smaller, prices a bit larger.
  const nameSize = lines.find((l) => Math.abs(l.x0 - cols.serviceX) <= COL_TOL)?.size ?? 10;
  const services: ParsedService[] = [];
  for (const row of splitRows(lines, nameSize * ROW_GAP_EM)) {
    const name: Line[] = [];
    const desc: Line[] = [];
    const type: Line[] = [];
    const price: Line[] = [];
    const note: Line[] = [];
    for (const l of row) {
      if (l.x0 < cols.typeX - COL_TOL) (l.size >= nameSize - 0.3 ? name : desc).push(l);
      else if (Math.abs(l.x0 - cols.typeX) <= COL_TOL) type.push(l);
      else if (Math.abs(l.x1 - cols.priceRight) <= RIGHT_TOL) (l.size >= nameSize * 0.9 ? price : note).push(l);
      else warnings.push(`Ignored unexpected text in the service table: “${l.text}”.`);
    }
    if (!name.length && !desc.length && !type.length && !price.length && !note.length) continue;
    services.push(toService(join(name), join(desc), join(type), join(price), join(note), warnings));
  }
  return services;
}

function toService(name: string, description: string, type: string, priceText: string, priceNote: string, warnings: string[]): ParsedService {
  if (!name) warnings.push(`A service row has no name (TYPE “${type}”, PRICE “${priceText}”).`);
  const price = readPrice(priceText);
  const typeInterval = intervalOfType(type);
  const label = name || "Unnamed service";
  let recurring: Interval | null = price.interval;
  if (price.interval) {
    const onceType = /one[\s-]?time|\bonce\b/i.test(type);
    if ((typeInterval && typeInterval !== price.interval) || onceType) {
      warnings.push(`“${label}”: the price says per ${price.interval} but TYPE is “${type}” — used the price.`);
    }
  } else if (typeInterval === "month" || typeInterval === "year") {
    recurring = typeInterval;
  } else if (typeInterval === "other" && (price.amount ?? 0) !== 0) {
    warnings.push(`“${label}”: TYPE “${type}” isn't monthly or yearly, so it was read as a one-time charge.`);
  }
  return { name, description, type, priceText, priceNote, amount: price.amount, free: price.free, recurring };
}

/**
 * The value lines stacked under a meta label: left-aligned with it, larger type, no big gap, and
 * clipped to its cell (up to the next label on the row) so a full-width value can't run into the
 * neighbouring cell's text.
 */
function valueLines(runs: Run[], label: Line | undefined, row: (Line | undefined)[]): Line[] {
  if (!label) return [];
  const right = Math.min(...row.filter((l): l is Line => !!l && l.page === label.page && Math.abs(l.y - label.y) <= 1 && l.x0 > label.x0 + COL_TOL).map((l) => l.x0), Infinity);
  const cell = runs.filter((r) => r.page === label.page && r.x >= label.x0 - COL_TOL && r.x < right - COL_TOL && r.y < label.y - 1);
  const below = toLines(cell)
    .filter((l) => Math.abs(l.x0 - label.x0) <= COL_TOL && l.size > label.size + 1)
    .sort((a, b) => b.y - a.y);
  const out: Line[] = [];
  let prevY = label.y;
  for (const l of below) {
    if (prevY - l.y > l.size * 2.5) break;
    out.push(l);
    prevY = l.y;
  }
  return out;
}

/**
 * A totals figure: the big line centred under its label. react-pdf may split the navy strip at a
 * page break, leaving the labels at the foot of one page and the figures atop the next.
 */
function totalValue(lines: Line[], label: Line): Line | null {
  const cx = (label.x0 + label.x1) / 2;
  const fits = (l: Line) => l.size >= label.size * 2 && Math.abs((l.x0 + l.x1) / 2 - cx) < 40;
  const topmost = (ls: Line[]) => (ls.length ? ls.reduce((a, b) => (b.y > a.y ? b : a)) : null);
  const below = lines.filter((l) => l.page === label.page && l.y < label.y - 1 && l.y > label.y - 60 && fits(l));
  return topmost(below) ?? topmost(lines.filter((l) => l.page === label.page + 1 && fits(l)));
}

/** Hero panel on page 1: "Prepared for <client>" (large, may wrap) over the summary paragraph. */
function readHero(lines: Line[], metaTop: Line | null, join: (ls: Line[]) => string): { client: string; summary: string } {
  const page1 = lines.filter((l) => l.page === 1);
  const first = page1.find((l) => /^prepared for\b/i.test(l.text) && l.size >= 14);
  if (!first) return { client: "", summary: "" };
  const title = [first];
  for (const l of page1) {
    const last = title[title.length - 1];
    if (l.y < last.y && Math.abs(l.x0 - first.x0) <= 1 && Math.abs(l.size - first.size) <= 0.3 && last.y - l.y <= l.size * 1.6) title.push(l);
  }
  const bottom = title[title.length - 1].y;
  const summary = page1.filter(
    (l) => l.y < bottom - 1 && (!metaTop || l.y > metaTop.y + 1) && Math.abs(l.x0 - first.x0) <= 1 && l.size < first.size - 2,
  );
  return { client: join(title).replace(/^prepared for\s+/i, ""), summary: join(summary) };
}

const nameKey = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(SPACE_OR_DASH, "");

/**
 * The client is the CLIENT meta value (wrapped lines joined). The PDF metadata title carries the
 * same name unwrapped, so when the two agree apart from spaces/hyphens the title's spelling wins
 * — that settles any line-break ambiguity. A real disagreement is a warning, not a guess.
 */
function resolveClient(fromMeta: string, meta: Meta, fromHero: string, fromHeader: string, warnings: string[]): string {
  const fromTitle = /^Digital Horizon Proposal\s*[\u2014\u2013-]\s*(.+)$/.exec(meta.title)?.[1].trim() ?? "";
  const fromSubject = /^Service Proposal for\s+(.+)$/.exec(meta.subject)?.[1].trim() ?? "";
  const fromDoc = fromTitle || fromSubject;
  const fromPage = fromHero || /Prepared for\s+(.+)$/i.exec(fromHeader)?.[1].trim() || "";
  if (!fromMeta) {
    const fallback = fromDoc || fromPage;
    warnings.push(fallback ? `Couldn't find the CLIENT field; used “${fallback}” from the ${fromDoc ? "PDF title" : "“Prepared for” line"}.` : "Couldn't find the client's name on the proposal.");
    return fallback;
  }
  const client = fromDoc && nameKey(fromDoc) === nameKey(fromMeta) ? fromDoc : fromMeta;
  if (fromDoc && nameKey(fromDoc) !== nameKey(client)) warnings.push(`The CLIENT field says “${client}” but the PDF title says “${fromDoc}”.`);
  if (fromPage && nameKey(fromPage) !== nameKey(client)) warnings.push(`The CLIENT field says “${client}” but the page says “Prepared for ${fromPage}”.`);
  return client;
}

/** "Additional Services Offered" (page 2): SERVICE | PRICING rows until the next section title. */
function readAddOns(lines: Line[], runs: Run[], after: Mark, join: (ls: Line[]) => string): ParsedAddOn[] {
  const title = lines.find((l) => isSection(l) && isAfter(l, after) && labelKey(l.text) === "ADDITIONALSERVICESOFFERED");
  if (!title) return [];
  const header = findHeaderRow(lines, ["SERVICE", "PRICING"], title);
  if (!header) return [];
  const [nameLabel, pricingLabel] = header;
  const end = lines.find((l) => isAfter(l, nameLabel) && isSectionEnd(l));
  const rowLines = columnLines(runs.filter((r) => isAfter(r, nameLabel) && (!end || isBefore(r, end))), [pricingLabel.x0]);
  const nameSize = rowLines.find((l) => Math.abs(l.x0 - nameLabel.x0) <= COL_TOL)?.size ?? 10;
  const out: ParsedAddOn[] = [];
  for (const row of splitRows(rowLines, nameSize * ROW_GAP_EM)) {
    const name = join(row.filter((l) => l.x0 < pricingLabel.x0 - COL_TOL));
    const pricing = join(row.filter((l) => l.x0 >= pricingLabel.x0 - COL_TOL));
    if (!name && !pricing) continue;
    const p = readPrice(pricing);
    out.push({ name, pricing, amount: p.readable ? p.amount : null });
  }
  return out;
}

/** CTA line: "Call: 775.443.3880   Email: brandon@digitalhorizon.dev". */
function readContact(lines: Line[]): { phone: string; email: string } {
  const line = [...lines].reverse().find((l) => /\bCall:/i.test(l.text) || /\bEmail:/i.test(l.text));
  if (!line) return { phone: "", email: "" };
  const phone = /\bCall:\s*(\+?[\d(][\d\s().-]{5,}\d)/i.exec(line.text)?.[1].trim() ?? "";
  const email = /\bEmail:\s*([^\s@]+@[^\s@]+\.[^\s@]+)/i.exec(line.text)?.[1].replace(/[.,;]+$/, "") ?? "";
  return { phone, email };
}
