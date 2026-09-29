/**
 * Invoice → PDF (US Letter), used by the public live-invoice page's "Download PDF" and the
 * dashboard. Pure pdf-lib with the standard Helvetica faces, so there is nothing to bundle or
 * fetch at runtime. The trade-off is WinAnsi-only text, which `winAnsiSafe` enforces on every
 * string before it is measured or drawn — client-typed text must never make a render throw.
 *
 * Top to bottom: brand header → tri-colour stripe → Bill to / From / Details → project →
 * line items (header row repeats on every page, a row never splits) → totals, with the pay box
 * (open invoices) or the notes beside them → payments → notes. Footers ("Page X of Y") are
 * stamped last, once the page count is known.
 */
import {
  LineCapStyle,
  PDFDocument,
  PDFString,
  StandardFonts,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setCharacterSpacing,
  type Color,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import type { Seller } from "./seller";
import { cardFeeAllCards, effectiveCardFeePercent } from "./validate";
import {
  cardFee,
  cardFeeWording,
  discountLabel,
  fmtLongDate,
  fmtMoney,
  invoiceTotals,
  recurringGroups,
  round2,
  type Invoice,
  type InvoiceLine,
  type InvoicePayment,
} from "./types";

export interface InvoicePdfOptions {
  seller: Seller;
  /** Public live-invoice URL printed in the footer/pay box, optional */
  publicUrl?: string;
}

/* ─────────────────────────────── Text safety ─────────────────────────────── */

/** CP1252's 0x80–0x9F block: the only non-Latin-1 characters the standard fonts can encode. */
const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e,
  0x0178,
]);

function isWinAnsi(cp: number): boolean {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRAS.has(cp);
}

/**
 * Checked before encodability: NBSP and the soft hyphen are encodable but would print as a
 * hard space / a visible hyphen mid-word, so they are normalised first.
 */
const SUBSTITUTES: Readonly<Record<string, string>> = {
  "\t": " ", "\n": " ", "\r": " ", "\v": " ", "\f": " ", "\u0085": " ", "\u00a0": " ", "\u00ad": "",
  // arrows
  "\u2192": "->", "\u27f6": "->", "\u2794": "->", "\u279c": "->", "\u279d": "->", "\u279e": "->",
  "\u27a1": "->", "\u2190": "<-", "\u27f5": "<-", "\u2b05": "<-", "\u2194": "<->", "\u27f7": "<->",
  "\u21d2": "=>", "\u27f9": "=>", "\u21d0": "<=", "\u21d4": "<=>",
  // dashes, minus, quotes, primes
  "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2015": "\u2014", "\u2212": "-", "\u2043": "-",
  "\u201b": "'", "\u201f": '"', "\u2032": "'", "\u2033": '"', "\u2035": "'", "\u02bc": "\u2019",
  "\u02bb": "\u2018",
  // bullets, dots, checks, stars
  "\u2023": "\u2022", "\u2219": "\u2022", "\u25cf": "\u2022", "\u25e6": "\u2022", "\u25aa": "\u2022",
  "\u25ab": "\u2022", "\u2027": "\u00b7", "\u22c5": "\u00b7", "\u2713": "\u2022", "\u2714": "\u2022",
  "\u2717": "\u00d7", "\u2718": "\u00d7", "\u2605": "*", "\u2606": "*", "\u2217": "*",
  // math and misc
  "\u2264": "<=", "\u2265": ">=", "\u2260": "!=", "\u2248": "~", "\u2044": "/", "\u2215": "/",
  "\u22ef": "\u2026", "\u03bc": "\u00b5",
  // Latin letters without a Unicode decomposition
  "\u0141": "L", "\u0142": "l", "\u0110": "D", "\u0111": "d", "\u0126": "H", "\u0127": "h", "\u0131": "i",
  "\u0166": "T", "\u0167": "t", "\u0138": "k", "\u014a": "N", "\u014b": "n",
};

const SPACE_RE = /[\p{Zs}\p{Zl}\p{Zp}]/u;
/** Controls, format chars (ZWSP, ZWJ, BOM…), private use, lone surrogates, combining marks. */
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{M}]/u;
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Regional_Indicator}]/u;
const MARKS_RE = /\p{M}/gu;
/** Private-use placeholders, resolved after the per-character pass (see winAnsiSafe). */
const DROPPED = "\ue000";
const UNKNOWN = "\ue001";
const DROPPED_RUN_RE = /[ \ue000]*\ue000[ \ue000]*/g;
const UNKNOWN_RUN_RE = /\ue001+/g;

function safeChar(ch: string): string {
  const sub = SUBSTITUTES[ch];
  if (sub !== undefined) return sub;
  if (isWinAnsi(ch.codePointAt(0) ?? 0)) return ch;
  if (SPACE_RE.test(ch)) return " ";
  if (EMOJI_RE.test(ch)) return DROPPED;
  if (INVISIBLE_RE.test(ch)) return "";
  // Compatibility decomposition rescues most other Latin text: ő → o, ﬁ → fi, Ａ → A, ① → 1.
  const parts = ch.normalize("NFKD").replace(MARKS_RE, "");
  if (parts && parts !== ch) {
    let out = "";
    for (const p of parts) {
      const mapped = SUBSTITUTES[p] ?? (isWinAnsi(p.codePointAt(0) ?? 0) ? p : SPACE_RE.test(p) ? " " : null);
      if (mapped === null) return UNKNOWN;
      out += mapped;
    }
    return out;
  }
  return UNKNOWN;
}

/**
 * Makes any string drawable with the standard (WinAnsi) fonts: keeps what they can encode,
 * maps common look-alikes (→ "->", non-breaking/odd spaces → " "), drops emoji and invisible
 * characters, and turns anything else (CJK, Cyrillic…) into "?" — one per run, so "東京" → "?".
 * Never throws; idempotent.
 */
export function winAnsiSafe(text: string): string {
  let out = "";
  for (const ch of String(text ?? "").normalize("NFC")) out += safeChar(ch);
  if (out.includes(DROPPED)) {
    // Close the gap an emoji leaves: "badge 🏆, next" → "badge, next"; "a ☕ b" → "a b".
    out = out.replace(DROPPED_RUN_RE, (run, at: number, all: string) => {
      const before = all.slice(0, at);
      const next = all.charAt(at + run.length);
      const edge = !before || !next || /[([{\u201c\u2018]$/.test(before) || /[,.;:!?)\]}\u201d\u2019\u2026]/.test(next);
      return edge || !run.includes(" ") ? "" : " ";
    });
  }
  return out.replace(UNKNOWN_RUN_RE, "?");
}

/** Single-line value: sanitised, whitespace collapsed. */
function oneLine(text: string | undefined): string {
  return winAnsiSafe(text ?? "").replace(/ {2,}/g, " ").trim();
}

const LINE_BREAK_RE = /\r\n|[\r\n\u2028\u2029]/;

/** Hard line breaks of user text (addresses), empty lines dropped. */
function splitLines(text: string | undefined): string[] {
  return (text ?? "").split(LINE_BREAK_RE).map(oneLine).filter(Boolean);
}

/* ─────────────────────────────── Page geometry ─────────────────────────────── */

const PAGE_SIZE: [number, number] = [612, 792]; // US Letter
const MX = 54; // side margins (0.75")
const W = PAGE_SIZE[0] - 2 * MX; // 504pt content width
const R = MX + W; // right content edge
const TOP = PAGE_SIZE[1] - 42;
/** Content never extends below this; the footer lives underneath. */
const BOTTOM = 58;
const FOOTER_RULE_Y = 46;
const FOOTER_Y = 33;
/** Continuation pages start this far below TOP (mini header + stripe). */
const RUN_HEAD_H = 44;
/** Helvetica metrics (per em): cap height, and the ascent CSS would use to place a baseline. */
const CAP = 0.718;
const ASC = 0.77;
/** Letter-spacing for caps labels. Above ~0.1em pdf.js extracts "S E R V I C E", so stay under. */
const TRACK = 0.095;

/** Line-items table: 12pt cell inset; amounts share one right edge with the totals. */
const PAD = 12;
const SVC_X = MX + PAD;
const AMT_R = R - PAD;
const AMT_W = 76;
const TYPE_W = 70;
const COL_GAP = 14;
const TYPE_X = AMT_R - AMT_W - COL_GAP - TYPE_W;
const SVC_W = TYPE_X - COL_GAP - SVC_X;
const HEAD_H = 20;
const ROW_PAD_TOP = 7;
const ROW_PAD_BOTTOM = 7.5;
const NAME_LEADING = 11.5;
const TYPE_LEADING = 10;
/** Totals: labels line up with the TYPE column; the pay box or notes use the space to their left. */
const TOT_X = TYPE_X - PAD;
const SIDE_W = TOT_X - 22 - MX;

/* ─────────────────────────────── Palette ─────────────────────────────── */

function hex(h: string): Color {
  const n = parseInt(h.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Digital Horizon's light palette. The brand pink/blue/green are too light for small text on
// white (3.3:1 and below), so text uses same-hue "ink" variants that clear 4.5:1; the brand
// hues themselves are kept for fills, rules, the stripe and the logo.
const INK = hex("#3A2A36");
const MUTED = hex("#5C5563");
const HAIRLINE = hex("#EADFE7");
const BLUSH = hex("#FBF1F7");
const ROW_ALT = hex("#FCF8FB");
const PINK = hex("#E85C97");
const PINK_SOFT = hex("#F2A7C6");
const PINK_INK = hex("#BF3672");
const BLUE_SOFT = hex("#A7C9ED");
const BLUE_TINT = hex("#EAF2FB");
const BLUE_PANEL = hex("#F4F8FD");
const BLUE_LINE = hex("#D8E6F6");
const BLUE_INK = hex("#2F6BAD");
const GREEN = hex("#59C07F");
const GREEN_SOFT = hex("#7ECF97");
const GREEN_TINT = hex("#E8F6ED");
const GREEN_INK = hex("#23794A");
const ROSE_TINT = hex("#F6EEF1");
const ROSE_LINE = hex("#E3CFD8");
const ROSE_DOT = hex("#C99AAE");
const ROSE_INK = hex("#8A5A6E");
const NEUTRAL_BAND = hex("#F6F3F5");
const LOGO_BARS: ReadonlyArray<{ y: number; x1: number; x2: number; color: Color }> = [
  { y: 11, x1: 6, x2: 42, color: hex("#F28CB4") },
  { y: 22, x1: 14, x2: 34, color: hex("#5EA9EA") },
  { y: 33, x1: 19, x2: 29, color: hex("#7ECF97") },
];

/* ─────────────────────────────── Text primitives ─────────────────────────────── */

interface Style {
  font: PDFFont;
  size: number;
  color: Color;
  /** Extra space between letters, in points. */
  tracking?: number;
}

type Align = "left" | "right" | "center";

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

function makeStyles(f: Fonts) {
  const caps = (size: number, color: Color): Style => ({ font: f.bold, size, color, tracking: size * TRACK });
  return {
    kicker: caps(8, PINK_INK),
    number: { font: f.bold, size: 22, color: INK },
    wordmark: { font: f.bold, size: 16, color: INK },
    label: caps(7, MUTED),
    th: caps(7, INK),
    partyName: { font: f.bold, size: 10, color: INK },
    partyLine: { font: f.regular, size: 9, color: MUTED },
    detailLabel: { font: f.regular, size: 9, color: MUTED },
    detailValue: { font: f.regular, size: 9, color: INK },
    body: { font: f.regular, size: 9.5, color: INK },
    notes: { font: f.regular, size: 9, color: INK },
    small: { font: f.regular, size: 8.5, color: MUTED },
    rowName: { font: f.bold, size: 9.5, color: INK },
    rowDesc: { font: f.italic, size: 8, color: MUTED },
    rowNote: { font: f.regular, size: 7.5, color: MUTED },
    rowType: { font: f.regular, size: 8, color: MUTED },
    rowAmount: { font: f.regular, size: 9.5, color: INK },
    zeroLabel: { font: f.bold, size: 8.5, color: GREEN_INK },
    cell: { font: f.regular, size: 9, color: INK },
    cellMuted: { font: f.regular, size: 9, color: MUTED },
    totLabel: { font: f.regular, size: 9, color: MUTED },
    totValue: { font: f.regular, size: 9.5, color: INK },
    totalLabel: { font: f.bold, size: 9.5, color: INK },
    totalValue: { font: f.bold, size: 10, color: INK },
    balLabel: { font: f.bold, size: 10, color: INK },
    balValue: { font: f.bold, size: 13, color: PINK_INK },
    fineNote: { font: f.italic, size: 7.5, color: MUTED },
    payLabel: caps(7, BLUE_INK),
    payUrl: { font: f.bold, size: 9.5, color: BLUE_INK },
    payText: { font: f.regular, size: 8.5, color: INK },
    payContact: { font: f.regular, size: 8, color: MUTED },
    footer: { font: f.regular, size: 7.5, color: MUTED },
    footerLink: { font: f.regular, size: 7.5, color: BLUE_INK },
    pillWord: (color: Color) => caps(8, color),
    pillDetail: (color: Color): Style => ({ font: f.regular, size: 8, color }),
    runTitle: { font: f.bold, size: 9, color: INK },
  } satisfies Record<string, Style | ((c: Color) => Style)>;
}

type Styles = ReturnType<typeof makeStyles>;

function measure(text: string, st: Style): number {
  const t = winAnsiSafe(text);
  return t ? st.font.widthOfTextAtSize(t, st.size) + (st.tracking ?? 0) * (t.length - 1) : 0;
}

/** Draws one line (sanitised) and returns its width. */
function drawText(page: PDFPage, text: string, x: number, y: number, st: Style, align: Align = "left"): number {
  const t = winAnsiSafe(text);
  if (!t) return 0;
  const w = measure(t, st);
  const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  // Tc lives in the graphics state, so it is scoped with q/Q around pdf-lib's own text block.
  if (st.tracking) page.pushOperators(pushGraphicsState(), setCharacterSpacing(st.tracking));
  page.drawText(t, { x: left, y, size: st.size, font: st.font, color: st.color });
  if (st.tracking) page.pushOperators(popGraphicsState());
  return w;
}

/** Greedy word wrap by measured width; a word wider than the column is broken inside. */
function wrap(text: string, st: Style, maxW: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of winAnsiSafe(text ?? "").split(" ")) {
    if (!word) continue;
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, st) <= maxW) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    let rest = word;
    while (measure(rest, st) > maxW) {
      const cut = breakPoint(rest, st, maxW);
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

/** Longest prefix that fits, pulled back to just after URL punctuation when that is close. */
function breakPoint(word: string, st: Style, maxW: number): number {
  let n = 1;
  while (n < word.length && measure(word.slice(0, n + 1), st) <= maxW) n++;
  for (let i = n; i > n * 0.6; i--) if ("/-_.?&=#@".includes(word[i - 1])) return i;
  return n;
}

/** Paragraph text: hard line breaks kept, a run of blank lines kept as one empty line. */
function wrapParagraphs(text: string, st: Style, maxW: number): string[] {
  const out: string[] = [];
  for (const para of (text ?? "").split(LINE_BREAK_RE)) {
    const lines = wrap(para, st, maxW);
    if (lines.length) out.push(...lines);
    else if (out.length && out[out.length - 1] !== "") out.push("");
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** Keeps the first `max` lines, ending the last kept one with an ellipsis when text was cut. */
function clampLines(lines: string[], max: number, st: Style, maxW: number): string[] {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, Math.max(0, max));
  if (!kept.length) return kept;
  let last = kept[kept.length - 1];
  while (last && measure(`${last}\u2026`, st) > maxW) last = last.slice(0, -1);
  kept[kept.length - 1] = `${last.trimEnd()}\u2026`;
  return kept;
}

/** Baseline that vertically places a line of `size` text in a box of height `leading`. */
function baselineIn(top: number, leading: number, size: number): number {
  return top - (leading - size) / 2 - ASC * size;
}

/** Stacked runs of wrapped text (e.g. name / description / note) inside one cell. */
interface TextBlock {
  lines: string[];
  style: Style;
  leading: number;
  gapBefore: number;
}

function blocksHeight(blocks: TextBlock[]): number {
  let h = 0;
  let first = true;
  for (const b of blocks) {
    if (!b.lines.length) continue;
    h += (first ? 0 : b.gapBefore) + b.lines.length * b.leading;
    first = false;
  }
  return h;
}

/** Draws the blocks from `top` down; returns the top y of each block (for links). */
function drawBlocks(page: PDFPage, blocks: TextBlock[], x: number, top: number): number[] {
  const tops: number[] = [];
  let y = top;
  let first = true;
  for (const b of blocks) {
    if (!b.lines.length) {
      tops.push(y);
      continue;
    }
    if (!first) y -= b.gapBefore;
    first = false;
    tops.push(y);
    for (const line of b.lines) {
      drawText(page, line, x, baselineIn(y, b.leading, b.style.size), b.style);
      y -= b.leading;
    }
  }
  return tops;
}

/* ─────────────────────────────── Shapes ─────────────────────────────── */

type Corners = [tl: number, tr: number, br: number, bl: number];

/** Rounded rectangle as an SVG path (pdf-lib 1.17 rectangles have no radius). */
function roundRectPath(w: number, h: number, [tl, tr, br, bl]: Corners): string {
  const k = 0.5523; // cubic Bézier circle constant
  return [
    `M ${tl} 0 H ${w - tr}`,
    `C ${w - tr + tr * k} 0 ${w} ${tr - tr * k} ${w} ${tr}`,
    `V ${h - br}`,
    `C ${w} ${h - br + br * k} ${w - br + br * k} ${h} ${w - br} ${h}`,
    `H ${bl}`,
    `C ${bl - bl * k} ${h} 0 ${h - bl + bl * k} 0 ${h - bl}`,
    `V ${tl}`,
    `C 0 ${tl - tl * k} ${tl - tl * k} 0 ${tl} 0 Z`,
  ].join(" ");
}

interface BoxPaint {
  fill?: Color;
  stroke?: Color;
  strokeWidth?: number;
}

/** Box by its bottom-left corner (PDF coordinates), like drawRectangle. */
function box(page: PDFPage, x: number, y: number, w: number, h: number, radius: number | Corners, paint: BoxPaint): void {
  const corners: Corners = typeof radius === "number" ? [radius, radius, radius, radius] : radius;
  const r = Math.min(w, h) / 2;
  const clamped = corners.map((c) => Math.max(0, Math.min(c, r))) as Corners;
  // drawSvgPath's origin is the path's top-left, with y growing downward.
  page.drawSvgPath(roundRectPath(w, h, clamped), {
    x,
    y: y + h,
    ...(paint.fill ? { color: paint.fill } : {}),
    ...(paint.stroke ? { borderColor: paint.stroke, borderWidth: paint.strokeWidth ?? 0.75 } : {}),
  });
}

function hairline(page: PDFPage, x1: number, x2: number, y: number): void {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.75, color: HAIRLINE });
}

/**
 * The logo mark from components/ui/Logo.tsx (viewBox 48×44, bars at y 11/22/33, 7-unit round
 * strokes) drawn with round-capped lines. Its visible extent is x 2.5→45.5, y 7.5→36.5, so it
 * is positioned by that box: `left` is the visible left edge, `midY` the visible centre.
 * Returns the visible width.
 */
function drawMark(page: PDFPage, left: number, midY: number, height: number): number {
  const s = height / 29;
  const ox = left - 2.5 * s;
  for (const bar of LOGO_BARS) {
    const y = midY + (22 - bar.y) * s;
    page.drawLine({
      start: { x: ox + bar.x1 * s, y },
      end: { x: ox + bar.x2 * s, y },
      thickness: 7 * s,
      color: bar.color,
      lineCap: LineCapStyle.Round,
    });
  }
  return 43 * s;
}

/* ─────────────────────────────── Formatting ─────────────────────────────── */

const BRAND_NAMES: Readonly<Record<string, string>> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
};

function titleCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** "Visa credit ••4242", "Debit card ••0005", "Card". */
export function paymentMethodLabel(p: Pick<InvoicePayment, "brand" | "funding" | "last4">): string {
  const key = (p.brand ?? "").trim().toLowerCase();
  const brand = key && key !== "unknown" ? (BRAND_NAMES[key] ?? titleCase(key)) : "";
  const fundingKey = (p.funding ?? "").trim().toLowerCase();
  const funding = ["credit", "debit", "prepaid"].includes(fundingKey) ? fundingKey : "";
  const name = brand ? [brand, funding].filter(Boolean).join(" ") : funding ? `${titleCase(funding)} card` : "Card";
  const last4 = (p.last4 ?? "").replace(/\D/g, "").slice(-4);
  return last4 ? `${name} \u2022\u2022${last4}` : name;
}

/** A payment timestamp as the calendar date in Carson City (Pacific), e.g. "September 20, 2026". */
function fmtPaidDate(iso: string | undefined): string {
  const v = (iso ?? "").trim();
  if (!v || /^\d{4}-\d{2}-\d{2}$/.test(v)) return v ? fmtLongDate(v) : "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return fmtLongDate(`${part("year")}-${part("month")}-${part("day")}`);
}

function fmtDate(ymd: string | undefined): string {
  const v = (ymd ?? "").trim();
  return v ? fmtLongDate(v) : "";
}

function amountText(line: InvoiceLine): { text: string; zero: boolean } {
  const zeroLabel = oneLine(line.zeroLabel);
  if (round2(line.amount) === 0 && zeroLabel) return { text: zeroLabel, zero: true };
  return { text: fmtMoney(line.amount), zero: false };
}

/** Absolute http(s) URL in its ASCII (punycode / percent-encoded) form, or null. */
function httpUrl(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/* ─────────────────────────────── Layout ─────────────────────────────── */

interface MeasuredRow {
  blocks: TextBlock[];
  type: string[];
  amount: { text: string; zero: boolean };
  height: number;
}

/** A block measured up front so it can be kept together, then drawn at its final position. */
interface Placed {
  height: number;
  draw: (top: number) => void;
}

class InvoiceLayout {
  private page: PDFPage;
  /** Top of the free space on the current page. */
  private y = TOP;
  private readonly s: Styles;
  private readonly url: string | null;

  constructor(
    private readonly doc: PDFDocument,
    fonts: Fonts,
    private readonly inv: Invoice,
    private readonly seller: Seller,
    publicUrl: string | undefined,
  ) {
    this.s = makeStyles(fonts);
    this.url = httpUrl(publicUrl);
    this.page = doc.addPage(PAGE_SIZE);
  }

  render(): void {
    this.header();
    this.parties();
    this.project();
    this.lineItems();
    const notesPlaced = this.summary();
    this.paymentsTable();
    if (!notesPlaced) this.notes();
    this.footers();
  }

  /* ── page flow ── */

  private text(text: string, x: number, y: number, st: Style, align: Align = "left"): number {
    return drawText(this.page, text, x, y, st, align);
  }

  private newPage(): void {
    this.page = this.doc.addPage(PAGE_SIZE);
    this.runningHeader();
  }

  /** Moves to a new page unless `height` still fits above the footer. */
  private ensure(height: number): boolean {
    if (this.y - height >= BOTTOM) return false;
    this.newPage();
    return true;
  }

  private link(x: number, y: number, w: number, h: number, uri: string): void {
    const ctx = this.doc.context;
    const escaped = uri.replace(/[\\()]/g, (c) => `\\${c}`); // PDFString writes the literal as-is
    const annot = ctx.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, y, x + w, y + h],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(escaped) },
    });
    this.page.node.addAnnot(ctx.register(annot));
  }

  /** Small caps label whose cap height starts at `top`. */
  private label(text: string, x: number, top: number, st: Style = this.s.label): void {
    this.text(text, x, top - CAP * st.size, st);
  }

  /* ── header ── */

  private header(): void {
    const { s, inv } = this;
    const kickerBase = TOP - CAP * s.kicker.size;
    this.text("INVOICE", R, kickerBase, s.kicker, "right");
    const numberBase = kickerBase - 24;

    // Wordmark shares the number's baseline; the mark is centred on the wordmark's caps.
    const markW = drawMark(this.page, MX, numberBase + (CAP * s.wordmark.size) / 2, CAP * s.wordmark.size * 1.4);
    const wordX = MX + markW + s.wordmark.size * 0.55;
    const wordEnd = wordX + this.text(oneLine(this.seller.name) || "Digital Horizon", wordX, numberBase, s.wordmark);

    // Shrink an unusually long invoice number rather than let it run into the wordmark.
    const number = oneLine(inv.number) || "\u2014";
    const room = R - (wordEnd + 24);
    const natural = measure(number, s.number);
    const numberStyle = natural > room ? { ...s.number, size: Math.max(12, (s.number.size * room) / natural) } : s.number;
    const numberW = this.text(number, R, numberBase, numberStyle, "right");

    // The status pill sits beside the number (centred on its caps) when there is room,
    // otherwise under it.
    let stripeTop = numberBase - 14;
    const pill = this.statusPill();
    if (pill) {
      const beside = R - numberW - 14 - pill.width;
      if (beside >= wordEnd + 24) {
        pill.draw(beside, numberBase + (CAP * numberStyle.size) / 2 - pill.height / 2);
      } else {
        pill.draw(R - pill.width, numberBase - 12 - pill.height);
        stripeTop = numberBase - 12 - pill.height - 13;
      }
    }
    this.stripe(stripeTop - 3, 3);
    this.y = stripeTop - 3 - 20;
  }

  /** "● PAID  September 20, 2026" (green) or "● VOID" (rose); null for open invoices. */
  private statusPill(): { width: number; height: number; draw: (left: number, bottom: number) => void } | null {
    const status = this.inv.status;
    if (status !== "paid" && status !== "void") return null;
    const paid = status === "paid";
    const tone = paid
      ? { fill: GREEN_TINT, line: GREEN_SOFT, ink: GREEN_INK, dot: GREEN }
      : { fill: ROSE_TINT, line: ROSE_LINE, ink: ROSE_INK, dot: ROSE_DOT };
    const word = paid ? "PAID" : "VOID";
    const detail = paid ? fmtPaidDate(this.inv.paidAt) : "";
    const wordSt = this.s.pillWord(tone.ink);
    const detailSt = this.s.pillDetail(tone.ink);
    const height = 19;
    const padX = 10;
    const dotR = 2.5;
    const gap = 6;
    const wordW = measure(word, wordSt);
    const width = padX + 2 * dotR + gap + wordW + (detail ? gap + measure(detail, detailSt) : 0) + padX;
    return {
      width,
      height,
      draw: (left, bottom) => {
        box(this.page, left, bottom, width, height, height / 2, { fill: tone.fill, stroke: tone.line });
        const mid = bottom + height / 2;
        this.page.drawCircle({ x: left + padX + dotR, y: mid, size: dotR, color: tone.dot });
        const base = mid - (CAP * wordSt.size) / 2;
        const wordX = left + padX + 2 * dotR + gap;
        this.text(word, wordX, base, wordSt);
        if (detail) this.text(detail, wordX + wordW + gap, base, detailSt);
      },
    };
  }

  /** Pink / blue / green thirds with rounded outer ends. */
  private stripe(y: number, h: number): void {
    const third = W / 3;
    const r = h / 2;
    const corners: Corners[] = [
      [r, 0, 0, r],
      [0, 0, 0, 0],
      [0, r, r, 0],
    ];
    [PINK_SOFT, BLUE_SOFT, GREEN_SOFT].forEach((fill, i) => {
      // A hair of overlap so no white seam shows between the thirds when rasterised.
      box(this.page, MX + i * third, y, third + (i < 2 ? 0.4 : 0), h, corners[i], { fill });
    });
  }

  /** Continuation pages: small mark + seller, invoice number, thin stripe. */
  private runningHeader(): void {
    const { s } = this;
    const base = TOP - CAP * s.runTitle.size;
    const markW = drawMark(this.page, MX, base + (CAP * s.runTitle.size) / 2, CAP * s.runTitle.size * 1.45);
    this.text(oneLine(this.seller.name), MX + markW + 6, base, s.runTitle);
    this.text(`Invoice ${oneLine(this.inv.number)} \u00b7 continued`, R, base, s.small, "right");
    this.stripe(base - 12, 1.5);
    this.y = TOP - RUN_HEAD_H;
  }

  /* ── bill to / from / details ── */

  private parties(): void {
    const { s, inv, seller } = this;
    const top = this.y;
    const bill = { x: MX, w: 190 };
    const from = { x: MX + 208, w: 150 };
    const det = { x: MX + 376, w: W - 376 };
    const bodyTop = top - 14.5;

    const partyBlocks = (name: string, details: string[], w: number): TextBlock[] => [
      { lines: wrap(name, s.partyName, w), style: s.partyName, leading: 13, gapBefore: 0 },
      { lines: details.flatMap((d) => wrap(d, s.partyLine, w)), style: s.partyLine, leading: 11.5, gapBefore: 1 },
    ];
    const client = inv.client;
    const billBlocks = partyBlocks(
      oneLine(client?.name),
      [oneLine(client?.email), oneLine(client?.phone), ...splitLines(client?.address)].filter(Boolean),
      bill.w,
    );
    if (!blocksHeight(billBlocks)) billBlocks[1].lines = ["\u2014"];
    const fromBlocks = partyBlocks(
      oneLine(seller.name),
      [seller.city, seller.email, seller.phone, seller.domain].map(oneLine).filter(Boolean),
      from.w,
    );

    this.label("BILL TO", bill.x, top);
    this.label("FROM", from.x, top);
    this.label("DETAILS", det.x, top);
    drawBlocks(this.page, billBlocks, bill.x, bodyTop);
    drawBlocks(this.page, fromBlocks, from.x, bodyTop);

    // Details: label left, value right-aligned to the margin like the number and the totals.
    const rows: [string, string][] = [
      ["Issued", fmtDate(inv.issueDate) || "\u2014"],
      ["Due", fmtDate(inv.dueDate) || "On receipt"],
      ["Invoice #", oneLine(inv.number) || "\u2014"],
    ];
    const leading = 12.5;
    let y = bodyTop;
    for (const [label, value] of rows) {
      const labelW = measure(label, s.detailLabel);
      this.text(label, det.x, baselineIn(y, leading, s.detailLabel.size), s.detailLabel);
      for (const line of wrap(value, s.detailValue, det.w - labelW - 10)) {
        this.text(line, R, baselineIn(y, leading, s.detailValue.size), s.detailValue, "right");
        y -= leading;
      }
    }
    this.y = bodyTop - Math.max(blocksHeight(billBlocks), blocksHeight(fromBlocks), bodyTop - y);
  }

  /** The proposal summary in a blush panel with a pink rule; long text continues on the next page. */
  private project(): void {
    const text = (this.inv.project ?? "").trim();
    if (!text) return;
    const { s } = this;
    const rule = 3;
    const padX = 16;
    const padY = 10;
    const labelH = 13;
    const leading = 13;
    const lines = wrapParagraphs(text, s.body, W - rule - 2 * padX);
    this.y -= 16;
    let i = 0;
    while (i < lines.length) {
      const head = i === 0 ? labelH : 0;
      const fit = Math.floor((this.y - BOTTOM - 2 * padY - head) / leading);
      if (fit < Math.min(2, lines.length - i) && this.y < TOP - RUN_HEAD_H) {
        this.newPage();
        continue;
      }
      const n = Math.max(1, Math.min(fit, lines.length - i));
      const h = 2 * padY + head + n * leading;
      const bottom = this.y - h;
      box(this.page, MX, bottom, W, h, [0, 4, 4, 0], { fill: BLUSH });
      this.page.drawRectangle({ x: MX, y: bottom, width: rule, height: h, color: PINK });
      let y = this.y - padY;
      if (head) {
        this.label("PROJECT", MX + rule + padX, y);
        y -= head;
      }
      const chunk: TextBlock = { lines: lines.slice(i, i + n), style: s.body, leading, gapBefore: 0 };
      drawBlocks(this.page, [chunk], MX + rule + padX, y);
      this.y = bottom;
      i += n;
    }
  }

  /* ── line items ── */

  private tableHead(columns: ReadonlyArray<{ text: string; x: number; align: Align }>): void {
    const top = this.y;
    box(this.page, MX, top - HEAD_H, W, HEAD_H, 4, { fill: BLUE_TINT });
    const base = top - HEAD_H / 2 - (CAP * this.s.th.size) / 2;
    for (const c of columns) this.text(c.text, c.x, base, this.s.th, c.align);
    this.y = top - HEAD_H;
  }

  private itemHead(): void {
    this.tableHead([
      { text: "SERVICE", x: SVC_X, align: "left" },
      { text: "TYPE", x: TYPE_X, align: "left" },
      { text: "AMOUNT", x: AMT_R, align: "right" },
    ]);
  }

  private measureRow(line: InvoiceLine): MeasuredRow {
    const { s } = this;
    const blocks: TextBlock[] = [
      { lines: wrap(line.name, s.rowName, SVC_W), style: s.rowName, leading: NAME_LEADING, gapBefore: 0 },
      { lines: wrapParagraphs(line.description, s.rowDesc, SVC_W), style: s.rowDesc, leading: 10, gapBefore: 1.5 },
      { lines: wrap(line.note, s.rowNote, SVC_W), style: s.rowNote, leading: 9.5, gapBefore: 2 },
    ];
    if (!blocksHeight(blocks)) blocks[0].lines = ["\u2014"];
    const type = clampLines(wrap(line.type, s.rowType, TYPE_W), 3, s.rowType, TYPE_W);
    const row: MeasuredRow = { blocks, type, amount: amountText(line), height: 0 };
    row.height = this.rowHeight(row);
    // A row taller than a whole page cannot be kept together, so its trailing text is trimmed
    // (note first, then description, then name) rather than splitting it across pages.
    const maxHeight = TOP - RUN_HEAD_H - HEAD_H - BOTTOM;
    while (row.height > maxHeight) {
      const block = [...blocks].reverse().find((b) => b.lines.length > (b === blocks[0] ? 1 : 0));
      if (!block) break;
      block.lines = clampLines(block.lines, block.lines.length - 1, block.style, SVC_W);
      row.height = this.rowHeight(row);
    }
    return row;
  }

  private rowHeight(row: MeasuredRow): number {
    const typeH = row.type.length ? NAME_LEADING + (row.type.length - 1) * TYPE_LEADING : 0;
    return ROW_PAD_TOP + Math.max(blocksHeight(row.blocks), typeH) + ROW_PAD_BOTTOM;
  }

  private drawRow(row: MeasuredRow, shaded: boolean): void {
    const { s } = this;
    const top = this.y;
    if (shaded) this.page.drawRectangle({ x: MX, y: top - row.height, width: W, height: row.height, color: ROW_ALT });
    const inner = top - ROW_PAD_TOP;
    drawBlocks(this.page, row.blocks, SVC_X, inner);
    // Type and amount sit on the service name's first baseline.
    const base = baselineIn(inner, NAME_LEADING, s.rowName.size);
    row.type.forEach((t, i) => this.text(t, TYPE_X, base - i * TYPE_LEADING, s.rowType));
    this.text(row.amount.text, AMT_R, base, row.amount.zero ? s.zeroLabel : s.rowAmount, "right");
    this.y = top - row.height;
  }

  private lineItems(): void {
    const rows = (this.inv.lines ?? []).map((l) => this.measureRow(l));
    this.y -= 16;
    this.ensure(HEAD_H + (rows[0]?.height ?? 30));
    this.itemHead();
    if (!rows.length) {
      this.text("No line items", SVC_X, this.y - 18, this.s.cellMuted);
      this.y -= 28;
    }
    rows.forEach((row, i) => {
      if (this.ensure(row.height)) this.itemHead();
      this.drawRow(row, i % 2 === 1);
    });
    hairline(this.page, MX, R, this.y);
  }

  /* ── totals + pay box / notes ── */

  /** Totals on the right; beside them the pay box (open invoices) or short notes. */
  private summary(): boolean {
    const totals = this.totals();
    const pay = this.payBox();
    const notes = pay ? null : this.sideNotes();
    const side = pay ?? notes;
    const height = Math.max(totals.height, side?.height ?? 0);
    this.y -= 12;
    this.ensure(height);
    const top = this.y;
    totals.draw(top);
    side?.draw(top);
    this.y = top - height;
    return notes !== null;
  }

  private totals(): Placed {
    const { s, inv } = this;
    const labelX = TYPE_X;
    const noteW = R - TOT_X;
    const isVoid = inv.status === "void";
    const fees = round2((inv.payments ?? []).reduce((sum, p) => sum + (Number(p.fee) || 0), 0));
    const notes = [
      ...(fees > 0 ? wrap(`Card fee paid: ${fmtMoney(fees)} (in addition to the total)`, s.fineNote, noteW) : []),
      ...(isVoid ? wrap("This invoice was voided. No payment is due.", s.fineNote, noteW) : []),
    ];
    const hasPaid = (inv.payments ?? []).length > 0;
    const sums = invoiceTotals(inv.lines ?? [], inv.discount);
    const hasDiscount = !!inv.discount && sums.discount > 0;
    const rowH = 16.5;
    const bandH = 30;
    const height = 2 * rowH + 7 + (hasDiscount ? rowH : 0) + (hasPaid ? rowH : 0) + 8 + bandH + (notes.length ? 7 + notes.length * 10 : 0);
    return {
      height,
      draw: (top) => {
        let y = top;
        const row = (label: string, value: string, ls: Style, vs: Style) => {
          this.text(label, labelX, baselineIn(y, rowH, ls.size), ls);
          this.text(value, AMT_R, baselineIn(y, rowH, vs.size), vs, "right");
          y -= rowH;
        };
        row("Subtotal", fmtMoney(sums.subtotal), s.totLabel, s.totValue);
        if (hasDiscount && inv.discount) row(discountLabel(inv.discount), fmtMoney(-sums.discount), s.totLabel, s.totValue);
        hairline(this.page, labelX, AMT_R, y - 3.5);
        y -= 7;
        row("Total", fmtMoney(inv.total), s.totalLabel, s.totalValue);
        if (hasPaid) row("Paid", fmtMoney(-inv.paid), s.totLabel, s.totValue);

        // Balance due: the one emphasised figure (pink on blush); muted when the invoice is void.
        y -= 8;
        box(this.page, TOT_X, y - bandH, R - TOT_X, bandH, 5, { fill: isVoid ? NEUTRAL_BAND : BLUSH });
        const balance = inv.status === "open" ? inv.balance : 0;
        const mid = y - bandH / 2;
        const labelSt = isVoid ? { ...s.balLabel, color: MUTED } : s.balLabel;
        const valueSt = isVoid ? { ...s.balValue, color: MUTED } : s.balValue;
        this.text("Balance due", labelX, mid - (CAP * labelSt.size) / 2, labelSt);
        this.text(fmtMoney(balance), AMT_R, mid - (CAP * valueSt.size) / 2, valueSt, "right");
        y -= bandH + 7;
        for (const line of notes) {
          this.text(line, TOT_X, y - 7.5, s.fineNote);
          y -= 10;
        }
      },
    };
  }

  /** "Pay online" box: only while something is still owed. */
  private payBox(): Placed | null {
    const { s, inv, seller } = this;
    if (inv.status !== "open" || !(inv.balance > 0)) return null;
    const padX = 14;
    const padY = 11;
    const labelH = 13;
    const innerW = SIDE_W - 2 * padX;
    const pct = effectiveCardFeePercent(inv);
    const url = this.url;
    // One sentence; when it does not fit on one line it breaks after the semicolon.
    const fee = fmtMoney(cardFee(inv.balance, pct));
    const feeClauses = pct > 0 ? cardFeeWording(pct, cardFeeAllCards()).pdf(fee) : [];
    const feeSentence = feeClauses.join(" ");
    const feeLines =
      measure(feeSentence, s.payText) <= innerW
        ? wrap(feeSentence, s.payText, innerW)
        : feeClauses.flatMap((c) => wrap(c, s.payText, innerW));
    const email = oneLine(seller.email);
    const contact = [email, oneLine(seller.phone)].filter(Boolean);
    const urlLines = url ? wrap(url, s.payUrl, innerW) : [];
    const fallback = url ? "" : "Pay securely by card from your invoice link.";
    const questions = contact.length ? `Questions? ${contact.join(" \u00b7 ")}` : "";
    // Recurring lines: paying by card starts a subscription on that card.
    const groups = recurringGroups(inv.lines ?? []);
    const renewal = groups.length ? `Then ${groups.map((g) => `${fmtMoney(g.amount)}/${g.interval === "month" ? "mo" : "yr"}`).join(" + ")} auto-bills that card.` : "";
    const blocks: TextBlock[] = [
      { lines: urlLines, style: s.payUrl, leading: 13, gapBefore: 0 },
      { lines: wrap(fallback, s.payText, innerW), style: s.payText, leading: 12.5, gapBefore: 0 },
      { lines: feeLines, style: s.payText, leading: 12.5, gapBefore: 3 },
      { lines: wrap(renewal, s.payText, innerW), style: s.payText, leading: 12.5, gapBefore: 3 },
      { lines: wrap(questions, s.payContact, innerW), style: s.payContact, leading: 11.5, gapBefore: 4 },
    ];
    const CONTACT = 4;
    const height = 2 * padY + labelH + blocksHeight(blocks);
    return {
      height,
      draw: (top) => {
        box(this.page, MX, top - height, SIDE_W, height, 6, { fill: BLUE_PANEL, stroke: BLUE_LINE });
        this.label("PAY ONLINE", MX + padX, top - padY, s.payLabel);
        const tops = drawBlocks(this.page, blocks, MX + padX, top - padY - labelH);
        // Clickable: every line of the URL, and the email when the contact line did not wrap.
        if (url) urlLines.forEach((line, i) => this.link(MX + padX, tops[0] - (i + 1) * 13, measure(line, s.payUrl), 13, url));
        const contactLines = blocks[CONTACT].lines;
        if (contactLines.length === 1 && /^[^\s@]+@[^\s@]+$/.test(email)) {
          const x = MX + padX + measure("Questions? ", s.payContact);
          this.link(x, tops[CONTACT] - 11.5, measure(email, s.payContact), 11.5, `mailto:${email}`);
        }
      },
    };
  }

  /** Notes beside the totals when there is no pay box and they are short enough to sit there. */
  private sideNotes(): Placed | null {
    const { s } = this;
    const lines = wrapParagraphs(this.inv.notes ?? "", s.notes, SIDE_W);
    if (!lines.length || lines.length > 9) return null;
    const leading = 12.5;
    return {
      height: 14 + lines.length * leading,
      draw: (top) => {
        this.label("NOTES", MX, top);
        drawBlocks(this.page, [{ lines, style: s.notes, leading, gapBefore: 0 }], MX, top - 14);
      },
    };
  }

  /* ── payments + full-width notes ── */

  private paymentsTable(): void {
    const { s, inv } = this;
    const payments = inv.payments ?? [];
    if (!payments.length) return;
    const dateX = SVC_X;
    const methodX = SVC_X + 118;
    const chargedR = TYPE_X + TYPE_W;
    const rowH = 20;
    this.y -= 18;
    this.ensure(13 + HEAD_H + rowH);
    const head = () =>
      this.tableHead([
        { text: "DATE", x: dateX, align: "left" },
        { text: "METHOD", x: methodX, align: "left" },
        { text: "CHARGED", x: chargedR, align: "right" },
        { text: "INCL. CARD FEE", x: AMT_R, align: "right" },
      ]);
    this.label("PAYMENTS", MX, this.y);
    this.y -= 13;
    head();
    payments.forEach((p, i) => {
      if (this.ensure(rowH)) head();
      const top = this.y;
      if (i % 2 === 1) this.page.drawRectangle({ x: MX, y: top - rowH, width: W, height: rowH, color: ROW_ALT });
      const base = baselineIn(top, rowH, s.cell.size);
      const fee = Number(p.fee) || 0;
      this.text(fmtPaidDate(p.paidAt) || "\u2014", dateX, base, s.cell);
      this.text(paymentMethodLabel(p), methodX, base, s.cell);
      this.text(fmtMoney(p.amount), chargedR, base, s.cell, "right");
      this.text(fee > 0 ? fmtMoney(fee) : "\u2014", AMT_R, base, fee > 0 ? s.cell : s.cellMuted, "right");
      this.y = top - rowH;
    });
    hairline(this.page, MX, R, this.y);
  }

  /** Full-width notes; long notes flow line by line onto following pages. */
  private notes(): void {
    const { s } = this;
    const lines = wrapParagraphs(this.inv.notes ?? "", s.notes, W);
    if (!lines.length) return;
    const leading = 12.5;
    this.y -= 18;
    this.ensure(14 + Math.min(2, lines.length) * leading);
    this.label("NOTES", MX, this.y);
    this.y -= 14;
    for (const line of lines) {
      this.ensure(leading);
      if (line) this.text(line, MX, baselineIn(this.y, leading, s.notes.size), s.notes);
      this.y -= leading;
    }
  }

  /** Stamped after layout so every page knows the page count. */
  private footers(): void {
    const { s, seller } = this;
    const pages = this.doc.getPages();
    const left = [seller.name, seller.city, seller.domain].map(oneLine).filter(Boolean).join(" \u00b7 ");
    const url = this.url;
    const shownUrl = url ? url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
    pages.forEach((page, i) => {
      this.page = page;
      hairline(page, MX, R, FOOTER_RULE_Y);
      const lw = this.text(left, MX, FOOTER_Y, s.footer);
      const rw = this.text(`Page ${i + 1} of ${pages.length}`, R, FOOTER_Y, s.footer, "right");
      if (!url) return;
      // The live-invoice link goes in the middle when it fits between the two ends; for open
      // invoices the pay box carries it in full anyway.
      const w = measure(shownUrl, s.footerLink);
      const minX = MX + lw + 18;
      const maxX = R - rw - 18 - w;
      if (maxX < minX) return;
      const x = Math.min(Math.max(MX + W / 2 - w / 2, minX), maxX);
      this.text(shownUrl, x, FOOTER_Y, s.footerLink);
      this.link(x, FOOTER_Y - 3, w, 11, url);
    });
  }
}

/* ─────────────────────────────── Public API ─────────────────────────────── */

export async function renderInvoicePdf(inv: Invoice, opts: InvoicePdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
  new InvoiceLayout(doc, fonts, inv, opts.seller, opts.publicUrl).render();

  // Metadata is UTF-16 in the file, so it keeps the client's name exactly as typed.
  const plain = (t: string | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
  const number = plain(inv.number);
  const client = plain(inv.client?.name);
  const seller = plain(opts.seller.name) || "Digital Horizon";
  const status =
    inv.status === "paid" ? "paid" : inv.status === "void" ? "void" : `balance due ${fmtMoney(inv.balance)}`;
  const now = new Date();
  const title = [number ? `Invoice ${number}` : "Invoice", client].filter(Boolean).join(" \u2014 ");
  doc.setTitle(title, { showInWindowTitleBar: true });
  doc.setAuthor(seller);
  doc.setSubject(`${title} \u00b7 from ${seller} \u00b7 total ${fmtMoney(inv.total)} \u00b7 ${status}`);
  doc.setKeywords(["invoice", number, seller].filter(Boolean));
  doc.setCreator("Central Dogma");
  doc.setProducer("Central Dogma");
  doc.setLanguage("en-US");
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  return doc.save();
}

/** Letters that NFKD leaves alone, spelled out for file names. */
const FILE_FOLD: Readonly<Record<string, string>> = {
  "\u00df": "ss", "\u00e6": "ae", "\u00c6": "AE", "\u0153": "oe", "\u0152": "OE", "\u00f8": "o", "\u00d8": "O",
  "\u00fe": "th", "\u00de": "Th", "\u00f0": "d", "\u00d0": "D", "\u0142": "l", "\u0141": "L", "\u0111": "d", "\u0110": "D",
};

/** Plain-ASCII slug: accents folded, apostrophes joined ("José’s" → "Joses"), the rest → "-". */
function fileSlug(text: string, max: number): string {
  const folded = (text ?? "")
    .normalize("NFKD")
    .replace(MARKS_RE, "")
    .replace(/[\u0080-\uffff]/g, (c) => FILE_FOLD[c] ?? c)
    .replace(/['\u2019\u2018`\u00b4\u02bc]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (folded.length <= max) return folded;
  const cut = folded.slice(0, max);
  const dash = cut.lastIndexOf("-");
  return (dash > max / 2 ? cut.slice(0, dash) : cut).replace(/-+$/, "");
}

/** e.g. "Digital-Horizon-Invoice-DH-1001-Carson-Antiques.pdf" — ASCII only, no spaces or slashes. */
export function invoicePdfFileName(inv: Invoice): string {
  const parts = ["Digital-Horizon-Invoice", fileSlug(inv.number, 40), fileSlug(inv.client?.name ?? "", 48)];
  return `${parts.filter(Boolean).join("-")}.pdf`;
}
