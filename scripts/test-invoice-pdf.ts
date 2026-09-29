/**
 * Invoice PDF checks: renders a set of fictional invoices, re-parses every file with unpdf
 * (pdf.js) and asserts on the extracted text, links and metadata.
 *
 *   npx tsx scripts/test-invoice-pdf.ts
 *   INVOICE_PDF_OUT=/some/dir INVOICE_PDF_PNG=1 npx tsx scripts/test-invoice-pdf.ts
 *
 * PDFs go to $INVOICE_PDF_OUT (default: <os tmp>/invoice-pdf-test). With INVOICE_PDF_PNG=1
 * every page is also rasterised at 1.5x with PyMuPDF (python3 + pymupdf) for visual review.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";
import { invoicePdfFileName, paymentMethodLabel, renderInvoicePdf, winAnsiSafe } from "../src/lib/invoice/pdf";
import { seller } from "../src/lib/invoice/seller";
import {
  deriveInvoice,
  sumLines,
  type Invoice,
  type InvoiceDoc,
  type InvoiceLine,
  type InvoicePayment,
} from "../src/lib/invoice/types";

const OUT = process.env.INVOICE_PDF_OUT || join(tmpdir(), "invoice-pdf-test");
// Surcharging on at the 2.9% ceiling (the fixtures' saved 3% is capped to it), as it will be
// once the 30-day Stripe notice has run; unset, no surcharge text is printed at all.
process.env.INVOICE_CARD_FEE_PERCENT = "2.9";
const SELLER = seller();
const PUBLIC_URL = "https://central-dogma.example.com/i/k3j4h5g6f7d8s9a0";
/** Parentheses must be escaped in the PDF link; the length forces wrapping in the pay box. */
const ODD_URL = `https://central-dogma.example.com/i/(weird)/path?with=query&and=more#frag-${"x".repeat(60)}`;

// Invisible / invalid characters are built from code points so the source stays readable.
const ch = (cp: number) => String.fromCharCode(cp);
const NBSP = ch(0xa0);
const ZWSP = ch(0x200b);
const SHY = ch(0xad);
const ACUTE = ch(0x301); // combining acute accent
const LONE_SURROGATE = ch(0xd800);

/* ───────────── fixtures (fictional) ───────────── */

let seq = 0;
function line(name: string, amount: number, extra: Partial<InvoiceLine> = {}): InvoiceLine {
  seq += 1;
  return {
    id: `line_${seq}`,
    name,
    description: "",
    type: "One-Time",
    recurring: null,
    amount,
    zeroLabel: "",
    note: "",
    ...extra,
  };
}

const PROPOSAL_LINES: InvoiceLine[] = [
  line("Domain Transfer", 0, {
    zeroLabel: "FREE",
    description: "Recover examplebakery.com from the previous provider and move it into an account you own.",
  }),
  line("Website Design & Online Ordering Build-Out", 2000, {
    description:
      "Custom mobile-first design, a multi-vendor catalog with pre-orders and pickup scheduling, and a content hand-off session.",
  }),
  line("SEO & GEO Initial Build-Out", 300, {
    description: "Keyword map, on-page SEO, schema markup and AI-search (GEO) readiness for every page.",
  }),
  line("GBP Optimization & NAP Audit", 100, {
    description: "Google Business Profile clean-up plus a name / address / phone consistency audit.",
  }),
  line("Hosting, Technical Maintenance & Security", 94.99, {
    type: "Monthly",
    recurring: { interval: "month", amount: 94.99 },
    description: "Managed hosting, updates, backups, uptime monitoring and security hardening.",
    note: "First month · then $94.99/mo",
  }),
];

const PROJECT =
  "Rebuild Example Bakery Co.’s website as a fast, mobile-first storefront where local vendors can list baked goods " +
  "and take pre-orders for pickup, then lay the SEO and Google Business Profile groundwork so the bakery shows up " +
  "for “bakery near me” searches across Carson City and Reno.";

const NOTES =
  "Hosting, technical maintenance & security continues at $94.99/mo after the first month; cancel anytime with " +
  "30 days’ notice.\n\nThank you for choosing Digital Horizon!";

const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt. ".repeat(60);

function baseDoc(over: Partial<InvoiceDoc> = {}): InvoiceDoc {
  const lines = over.lines ?? PROPOSAL_LINES;
  return {
    id: "k3j4h5g6f7d8s9a0",
    number: "DH-1001",
    version: 1,
    voided: false,
    issueDate: "2026-09-18",
    dueDate: "2026-10-02",
    client: {
      name: "Example Bakery Co.",
      email: "owner@example.com",
      phone: "(775) 555-0142",
      address: "123 Example Street\nCarson City, NV 89701",
    },
    project: PROJECT,
    lines,
    total: sumLines(lines),
    cardFeePercent: 3,
    notes: NOTES,
    createdAt: "2026-09-18T16:00:00.000Z",
    updatedAt: "2026-09-18T16:00:00.000Z",
    ...over,
  };
}

const CREDIT_PAYMENT: InvoicePayment = {
  paymentIntentId: "pi_test_credit",
  chargeId: "ch_test_credit",
  amount: 2569.84,
  fee: 74.85,
  brand: "visa",
  last4: "4242",
  funding: "credit",
  paidAt: "2026-09-20T18:32:00.000Z",
  livemode: false,
};

const DEBIT_PAYMENT: InvoicePayment = {
  paymentIntentId: "pi_test_debit",
  amount: 2494.99,
  fee: 0,
  brand: "mastercard",
  last4: "8210",
  funding: "debit",
  paidAt: "2026-09-21T17:05:00.000Z",
  livemode: false,
};

function manyLines(): InvoiceLine[] {
  const services = [
    "Seasonal landing page with localized copy variants, conversion tracking and an A/B-tested hero section",
    "Blog article",
    "Service-area page for a neighboring town, written from scratch with local references and internal links",
    "Product photography retouching",
    "Quarterly technical SEO audit covering crawlability, Core Web Vitals, structured data and redirects",
  ];
  const lines: InvoiceLine[] = [];
  for (let i = 1; i <= 45; i++) {
    const long = i % 3 === 0;
    lines.push(
      line(`${String(i).padStart(2, "0")} · ${services[i % services.length]}`, i % 11 === 0 ? 0 : 75 + i * 12.5, {
        type: i % 4 === 0 ? "Monthly" : i % 5 === 0 ? "Setup & Onboarding" : "One-Time",
        zeroLabel: i % 11 === 0 ? "Included" : "",
        description: long
          ? `Deliverable ${i}: research, drafting, two revision rounds and publishing. Reference link: ` +
            `https://examplebakery.com/menu/seasonal/pumpkin-spice-croissant-with-maple-glaze-and-toasted-pecans-${i}`
          : `Deliverable ${i}: scoped and approved in the proposal.`,
        note: i % 4 === 0 ? `First month · then $${(75 + i * 12.5).toFixed(2)}/mo` : "",
      }),
    );
  }
  return lines;
}

const UNICODE_LINES: InvoiceLine[] = [
  line("Menu redesign → online ordering 🚀", 450, {
    description: "Coffee ☕️ & pastries 🥐 → more foot traffic ✨ — “quoted” ‘single’ … naïve façade",
  }),
  line("Photo shoot 📸 ≤ 3 hours", 320, {
    description: "½ day on site, 20 edited photos ✓, € pricing shown for reference ⇒ delivered via link",
  }),
  line("Ünïcödé Lïne — Ω test 東京 🇯🇵 👩‍💻", 0, {
    zeroLabel: "Included",
    description:
      `Zero${ZWSP}width${NBSP}space, soft${SHY}hyphen, composed e${ACUTE}, ﬁligree, Ｆｕｌｌ-width, ` +
      `ő / ł / ß, lone ${LONE_SURROGATE}surrogate, tab\tstop`,
    note: "Keycap 1️⃣ · flag 🇨🇭 · skin tone 👍🏽 · ZWJ family 👨‍👩‍👧",
  }),
];

interface Case {
  key: string;
  title: string;
  inv: Invoice;
  publicUrl?: string;
  check: (r: Rendered) => void | Promise<void>;
}

/** A drawn text run's box in PDF points (baseline-derived: descender to cap height). */
interface TextBox {
  str: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface Rendered {
  inv: Invoice;
  bytes: Uint8Array;
  pages: string[];
  /** All pages, whitespace collapsed, for phrase lookups that may wrap. */
  flat: string;
  links: string[];
  boxes: TextBox[][];
  path: string;
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const has = (r: Rendered, needle: string) => assert.ok(r.flat.includes(flat(needle)), `expected text: ${needle}`);
const lacks = (r: Rendered, needle: string | RegExp) =>
  assert.ok(
    typeof needle === "string" ? !r.flat.includes(needle) : !needle.test(r.flat),
    `unexpected text: ${String(needle)}`,
  );

const CASES: Case[] = [
  {
    key: "a-open",
    title: "(a) open invoice mirroring a proposal",
    inv: deriveInvoice(baseDoc(), []),
    publicUrl: PUBLIC_URL,
    check: (r) => {
      assert.equal(r.inv.status, "open");
      assert.equal(r.pages.length, 1, "fits on one page");
      for (const t of ["INVOICE", "BILL TO", "FROM", "DETAILS", "PROJECT", "SERVICE", "TYPE", "AMOUNT", "NOTES"]) has(r, t);
      for (const t of ["owner@example.com", "(775) 555-0142", "123 Example Street", "Carson City, NV 89701"]) has(r, t);
      for (const t of [SELLER.email, SELLER.phone, SELLER.domain]) has(r, t);
      has(r, "Issued September 18, 2026");
      has(r, "Due October 2, 2026");
      has(r, "FREE");
      for (const t of ["$2,000.00", "$300.00", "$100.00", "$94.99", "First month · then $94.99/mo"]) has(r, t);
      has(r, "Subtotal $2,494.99");
      has(r, "Total $2,494.99");
      has(r, "Balance due $2,494.99");
      has(r, "PAY ONLINE");
      has(r, PUBLIC_URL);
      has(r, "Credit cards add our 2.9% surcharge ($72.35), not more than our cost; debit and prepaid cards pay none.");
      has(r, "Then $94.99/mo auto-bills that card.");
      has(r, `Questions? ${SELLER.email} · ${SELLER.phone}`);
      has(r, "“bakery near me”");
      has(r, "Thank you for choosing Digital Horizon!");
      lacks(r, "PAID");
      lacks(r, "VOID");
      lacks(r, "PAYMENTS");
      assert.ok(r.links.includes(PUBLIC_URL), "pay link is clickable");
      assert.ok(r.links.includes(`mailto:${SELLER.email}`), "email is clickable");
    },
  },
  {
    key: "b-paid-credit",
    title: "(b) paid by credit card (fee on top)",
    inv: deriveInvoice(baseDoc(), [CREDIT_PAYMENT]),
    publicUrl: PUBLIC_URL,
    check: (r) => {
      assert.equal(r.inv.status, "paid");
      assert.equal(r.inv.balance, 0);
      has(r, "PAID September 20, 2026");
      has(r, "Total $2,494.99");
      has(r, "Paid -$2,494.99");
      has(r, "Card fee paid: $74.85");
      has(r, "Balance due $0.00");
      has(r, "PAYMENTS");
      has(r, "September 20, 2026 Visa credit ••4242 $2,569.84 $74.85");
      lacks(r, "PAY ONLINE");
      lacks(r, "Paying by credit card");
    },
  },
  {
    key: "c-paid-debit",
    title: "(c) paid by debit card (no fee)",
    inv: deriveInvoice(baseDoc(), [DEBIT_PAYMENT]),
    publicUrl: PUBLIC_URL,
    check: (r) => {
      assert.equal(r.inv.status, "paid");
      has(r, "PAID September 21, 2026");
      has(r, "Paid -$2,494.99");
      has(r, "Balance due $0.00");
      has(r, "September 21, 2026 Mastercard debit ••8210 $2,494.99 —");
      lacks(r, "Card fee paid");
      lacks(r, "PAY ONLINE");
    },
  },
  {
    key: "d-void",
    title: "(d) void",
    inv: deriveInvoice(baseDoc({ voided: true }), []),
    publicUrl: PUBLIC_URL,
    check: (r) => {
      assert.equal(r.inv.status, "void");
      has(r, "VOID");
      has(r, "Balance due $0.00");
      has(r, "This invoice was voided. No payment is due.");
      lacks(r, "PAY ONLINE");
      lacks(r, "PAID");
    },
  },
  {
    key: "e-45-lines",
    title: "(e) 45 wrapped lines → multi-page, repeated table header",
    inv: deriveInvoice(baseDoc({ number: "DH-1005", lines: manyLines() }), []),
    publicUrl: PUBLIC_URL,
    check: (r) => {
      const n = r.pages.length;
      assert.ok(n >= 2, `expected ≥ 2 pages, got ${n}`);
      r.pages.forEach((p, i) => assert.ok(flat(p).includes(`Page ${i + 1} of ${n}`), `footer on page ${i + 1}`));
      // Every page that holds a row repeats the header; rows are never split between pages
      // (compared without whitespace: long URLs in descriptions are hard-broken across lines).
      const squash = (s: string) => s.replace(/\s+/g, "");
      for (const l of r.inv.lines) {
        const page = r.pages.findIndex((p) => flat(p).includes(flat(winAnsiSafe(l.name))));
        assert.ok(page >= 0, `line on some page: ${l.name}`);
        assert.ok(flat(r.pages[page]).includes("SERVICE TYPE AMOUNT"), `table header on page ${page + 1}`);
        assert.ok(squash(r.pages[page]).includes(squash(l.description)), `row kept together: ${l.name}`);
      }
      for (let i = 0; i < n - 1; i++) assert.ok(r.pages[i].includes("SERVICE"), `SERVICE header on page ${i + 1}`);
      has(r, `Balance due ${"$"}${r.inv.balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
      has(r, "Invoice DH-1005 · continued");
    },
  },
  {
    key: "f-unicode",
    title: "(f) unicode stress (emoji, arrows, CJK, invisibles)",
    inv: deriveInvoice(
      baseDoc({
        number: "DH-1006",
        client: {
          name: "José’s Café — ☕ “Best” 東京",
          email: "josé@café.example",
          phone: `+1${NBSP}775‑555‑0199`,
          address: "Königstraße 5\n東京都渋谷区 1-2-3\nZürich 🇨🇭",
        },
        project: `Relaunch → bilingual menu (English/日本語), “Best in Town” badge 🏆, tab\tseparated,${ch(0x2028)}line separator.`,
        notes: `Line one ✓\n\n\nLine two ★ with ≥ 2 options ⋯ and a ${ch(0xfeff)}BOM`,
        lines: UNICODE_LINES,
      }),
      [],
    ),
    publicUrl: PUBLIC_URL,
    check: (r) => {
      has(r, "José’s Café — “Best” ?");
      has(r, "Menu redesign -> online ordering");
      has(r, "Coffee & pastries -> more foot traffic — “quoted” ‘single’ … naïve façade");
      has(r, "½ day on site, 20 edited photos •, € pricing shown for reference => delivered via link");
      has(r, "Zerowidth space, softhyphen, composed é, filigree, Full-width, o / l / ß, lone surrogate, tab stop");
      has(r, "Keycap 1 · flag · skin tone · ZWJ family");
      has(r, "Königstraße 5 ? 1-2-3 Zürich");
      has(r, "Relaunch -> bilingual menu (English/?), “Best in Town” badge, tab separated, line separator.");
      has(r, "Line one • Line two * with >= 2 options … and a BOM");
      has(r, "Included");
      assert.ok(!/[\p{Extended_Pictographic}\u200b\u00ad\ufeff]/u.test(r.pages.join("")), "no emoji or invisibles survive");
      assert.equal(invoicePdfFileName(r.inv), "Digital-Horizon-Invoice-DH-1006-Joses-Cafe-Best.pdf");
    },
  },
  {
    key: "g-no-card-fee",
    title: "(g) cardFeePercent 0, no public URL",
    inv: deriveInvoice(baseDoc({ number: "DH-1007", cardFeePercent: 0 }), []),
    check: (r) => {
      has(r, "PAY ONLINE");
      has(r, "Pay securely by card from your invoice link.");
      lacks(r, /surcharge|card fee/i);
      assert.equal(r.links.filter((l) => l.startsWith("http")).length, 0, "no URL links without a public URL");
    },
  },
  {
    key: "h-minimal",
    title: "(h) empty optional fields",
    inv: deriveInvoice(
      baseDoc({
        number: "DH-1008",
        client: { name: "Minimal Client LLC", email: "", phone: "", address: "" },
        project: "",
        notes: "",
        dueDate: "",
        lines: [line("Strategy session", 150)],
      }),
      [],
    ),
    check: (r) => {
      has(r, "Due On receipt");
      has(r, "Minimal Client LLC");
      has(r, "Balance due $150.00");
      lacks(r, "PROJECT");
      lacks(r, "NOTES");
      lacks(r, "PAYMENTS");
    },
  },
  {
    key: "i-partial",
    title: "(i) partially paid by credit card, still open",
    inv: deriveInvoice(baseDoc({ number: "DH-1009" }), [
      { ...CREDIT_PAYMENT, paymentIntentId: "pi_partial", amount: 1030, fee: 30, brand: "amex", last4: "0005" },
    ]),
    publicUrl: PUBLIC_URL,
    check: (r) => {
      assert.equal(r.inv.status, "open");
      assert.equal(r.inv.balance, 1494.99);
      has(r, "Paid -$1,000.00");
      has(r, "Card fee paid: $30.00");
      has(r, "Balance due $1,494.99");
      has(r, "add our 2.9% surcharge ($43.35)");
      has(r, "American Express credit ••0005 $1,030.00 $30.00");
      lacks(r, "PAID ");
    },
  },
  {
    key: "k-discount",
    title: "(k) 10% discount off the lines",
    inv: deriveInvoice(baseDoc({ number: "DH-1011", discount: { kind: "percent", value: 10 }, total: 2245.49 }), []),
    publicUrl: PUBLIC_URL,
    check: (r) => {
      assert.equal(r.pages.length, 1, "fits on one page");
      has(r, "Subtotal $2,494.99");
      has(r, "Discount (10%) -$249.50");
      has(r, "Total $2,245.49");
      has(r, "Balance due $2,245.49");
      has(r, "Credit cards add our 2.9% surcharge ($65.12), not more than our cost; debit and prepaid cards pay none.");
    },
  },
  {
    key: "j-extremes",
    title: "(j) extremes: giant fields, long number, negative line, 30 payments",
    inv: deriveInvoice(
      baseDoc({
        number: "DH-2026-000123-REISSUED-FOR-ACCOUNTING-PURPOSES",
        cardFeePercent: 2.5,
        client: {
          name: "The Extremely Long Legal Name of a Northern Nevada Bakery, Café & Catering Cooperative LLC",
          email: "accounts.payable.department@extremely-long-client-domain-name.example.com",
          phone: "(775) 555-0100 ext. 12345",
          address: "Suite 100, Building C\n1234 Very Long Street Name Boulevard\nCarson City, NV 89701-1234\nUnited States",
        },
        project: LOREM.slice(0, 1400),
        notes: LOREM,
        lines: [
          line("Enormous description row", 1234.56, { description: LOREM + LOREM }),
          line("x".repeat(200), 1, { type: "A-very-long-type-label-without-any-spaces-at-all" }),
          line("Loyalty discount", -100, { type: "Credit" }),
        ],
      }),
      Array.from({ length: 30 }, (_, i) => ({
        paymentIntentId: `pi_${i}`,
        amount: 10,
        fee: 0.3,
        brand: "visa",
        last4: "4242",
        funding: "credit",
        paidAt: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T12:00:00Z`,
      })),
    ),
    publicUrl: ODD_URL,
    check: (r) => {
      assert.equal(r.inv.status, "open");
      assert.ok(r.pages.length >= 4, `expected several pages, got ${r.pages.length}`);
      has(r, "-$100.00");
      has(r, "add our 2.5% surcharge");
      has(r, "Paid -$291.00");
      has(r, `Balance due ${"$"}844.56`);
      assert.ok(r.pages.filter((p) => flat(p).includes("DATE METHOD CHARGED INCL. CARD FEE")).length >= 2, "payments header repeats");
      assert.ok(r.links.includes(new URL(ODD_URL).href), "odd URL survives as a clickable link");
      assert.ok(r.flat.includes("…"), "an over-tall row is trimmed with an ellipsis");
    },
  },
];

/* ───────────── runner ───────────── */

async function render(c: Case): Promise<Rendered> {
  const bytes = await renderInvoicePdf(c.inv, { seller: SELLER, publicUrl: c.publicUrl });
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString("latin1"), "%PDF-");
  const path = join(OUT, `${c.key}.pdf`);
  writeFileSync(path, bytes);
  // pdf.js may transfer (detach) the buffer it is given, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const links: string[] = [];
  const boxes: TextBox[][] = [];
  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i);
    const annots: Array<{ subtype?: string; url?: string; unsafeUrl?: string }> = await page.getAnnotations();
    for (const a of annots) if (a.subtype === "Link" && (a.url || a.unsafeUrl)) links.push(a.url || a.unsafeUrl || "");
    const content = await page.getTextContent();
    const pageBoxes: TextBox[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const [, , c, d, x, y] = item.transform as number[];
      const size = Math.hypot(c, d);
      pageBoxes.push({ str: item.str, x0: x, x1: x + item.width, y0: y - 0.21 * size, y1: y + 0.72 * size });
    }
    boxes.push(pageBoxes);
  }
  await pdf.loadingTask.destroy();
  assert.equal(text.length, totalPages);
  return { inv: c.inv, bytes, pages: text, flat: flat(text.join("\n")), links, boxes, path };
}

/** Nothing outside the 0.75" side margins / footer band, and no two text runs overlapping. */
function layoutChecks(r: Rendered): void {
  r.boxes.forEach((page, p) => {
    for (const b of page) {
      assert.ok(b.x0 >= 54 - 0.75 && b.x1 <= 558 + 1, `page ${p + 1}: "${b.str}" outside side margins (${b.x0.toFixed(1)}–${b.x1.toFixed(1)})`);
      assert.ok(b.y0 >= 26 && b.y1 <= 752, `page ${p + 1}: "${b.str}" outside top/bottom bounds`);
    }
    for (let i = 0; i < page.length; i++) {
      for (let j = i + 1; j < page.length; j++) {
        const a = page[i];
        const b = page[j];
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        assert.ok(ox <= 0.5 || oy <= 0.5, `page ${p + 1}: "${a.str}" overlaps "${b.str}"`);
      }
    }
  });
}

async function commonChecks(r: Rendered): Promise<void> {
  const { inv } = r;
  layoutChecks(r);
  has(r, inv.number);
  has(r, winAnsiSafe(inv.client.name));
  const squashed = r.flat.replace(/\s+/g, "");
  for (const l of inv.lines) assert.ok(squashed.includes(winAnsiSafe(l.name).replace(/\s+/g, "")), `line name: ${l.name}`);
  has(r, `${SELLER.name} · ${SELLER.city} · ${SELLER.domain}`);
  has(r, `Page 1 of ${r.pages.length}`);
  lacks(r, /\b(undefined|null|NaN)\b|\[object/);
  const doc = await PDFDocument.load(r.bytes, { updateMetadata: false });
  const client = inv.client.name.replace(/\s+/g, " ").trim();
  assert.equal(doc.getTitle(), `Invoice ${inv.number} — ${client}`);
  assert.equal(doc.getAuthor(), "Digital Horizon");
  assert.equal(doc.getCreator(), "Central Dogma");
  assert.equal(doc.getProducer(), "Central Dogma");
  assert.ok(doc.getSubject()?.includes(inv.number));
  assert.ok(doc.getCreationDate() instanceof Date);
  assert.equal(doc.getPageCount(), r.pages.length);
  const { width, height } = doc.getPage(0).getSize();
  assert.deepEqual([width, height], [612, 792], "US Letter");
}

async function unitChecks(): Promise<void> {
  const probe = await PDFDocument.create();
  const fonts: PDFFont[] = await Promise.all(
    [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique].map((f) => probe.embedFont(f)),
  );
  const encodable = (s: string) => fonts.every((f) => (f.encodeText(s), true));

  // Every BMP character comes out encodable; printable WinAnsi characters pass through untouched.
  for (let cp = 0; cp <= 0xffff; cp++) {
    const input = String.fromCharCode(cp);
    const out = winAnsiSafe(input);
    assert.ok(encodable(out), `U+${cp.toString(16)} → ${JSON.stringify(out)} must be encodable`);
    let native = false;
    try {
      fonts[0].encodeText(input);
      native = true;
    } catch {
      native = false;
    }
    if (native && cp !== 0xa0 && cp !== 0xad) assert.equal(out, input, `U+${cp.toString(16)} is WinAnsi and kept`);
  }
  // Random strings including astral code points: never throws, always encodable, idempotent.
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 2000; i++) {
    let s = "";
    for (let j = 0; j < 12; j++) {
      const cp = rand() < 0.3 ? 0x1f000 + Math.floor(rand() * 0x1000) : Math.floor(rand() * 0x3000);
      s += String.fromCodePoint(cp);
    }
    const out = winAnsiSafe(s);
    assert.ok(encodable(out));
    assert.equal(winAnsiSafe(out), out, "idempotent");
  }
  assert.equal(winAnsiSafe("a → b ← c"), "a -> b <- c");
  assert.equal(winAnsiSafe("Coffee ☕️ time 🇺🇸 👩‍💻!"), "Coffee time!");
  assert.equal(winAnsiSafe("badge 🏆, next (🎉 party) 🚀 go"), "badge, next (party) go");
  assert.equal(winAnsiSafe("東京 café 東京都"), "? café ?");
  assert.equal(winAnsiSafe("What?? Ω"), "What?? ?");
  assert.equal(winAnsiSafe(`a${NBSP}b${ZWSP}c${SHY}d`), "a bcd");
  assert.equal(winAnsiSafe("“Best” — ‘ok’ • €5 … ™"), "“Best” — ‘ok’ • €5 … ™");
  assert.equal(winAnsiSafe(`Cafe${ACUTE}`), "Café");
  assert.equal(winAnsiSafe("ő ﬁ Ａ ① −5"), "o fi A 1 -5");

  assert.equal(paymentMethodLabel({ brand: "visa", funding: "credit", last4: "4242" }), "Visa credit ••4242");
  assert.equal(paymentMethodLabel({ brand: "mastercard", funding: "debit", last4: "8210" }), "Mastercard debit ••8210");
  assert.equal(paymentMethodLabel({ brand: "amex", funding: "credit", last4: "0005" }), "American Express credit ••0005");
  assert.equal(paymentMethodLabel({ brand: "discover", funding: "prepaid" }), "Discover prepaid");
  assert.equal(paymentMethodLabel({ brand: "cartes_bancaires", funding: "unknown", last4: "1234" }), "Cartes Bancaires ••1234");
  assert.equal(paymentMethodLabel({ funding: "debit", last4: "9999" }), "Debit card ••9999");
  assert.equal(paymentMethodLabel({}), "Card");

  const named = (number: string, name: string) =>
    invoicePdfFileName(deriveInvoice(baseDoc({ number, client: { name, email: "", phone: "", address: "" } }), []));
  assert.equal(named("DH-1001", "Example Antiques"), "Digital-Horizon-Invoice-DH-1001-Example-Antiques.pdf");
  assert.equal(named("DH/2026 #7", "Smith & Sons, LLC."), "Digital-Horizon-Invoice-DH-2026-7-Smith-and-Sons-LLC.pdf");
  assert.equal(named("DH-1010", "東京"), "Digital-Horizon-Invoice-DH-1010.pdf");
  assert.equal(named("DH-1011", "Straße Øster & Łódź Bäckerei"), "Digital-Horizon-Invoice-DH-1011-Strasse-Oster-and-Lodz-Backerei.pdf");
  for (const n of [named("DH-1", "A".repeat(300)), named("", "  "), named("../../etc", "a/b\\c")]) {
    assert.match(n, /^[A-Za-z0-9-]+\.pdf$/, n);
    assert.ok(n.length <= 120, n);
  }
}

function renderPngs(paths: string[]): string[] {
  const py = [
    "import sys",
    "try:",
    "    import pymupdf as fitz",
    "except ImportError:",
    "    import fitz",
    "for path in sys.argv[1:]:",
    "    doc = fitz.open(path)",
    "    for i, page in enumerate(doc):",
    "        out = path[:-4] + f'-p{i + 1}.png'",
    "        page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5)).save(out)",
    "        print(out)",
  ].join("\n");
  const res = spawnSync("python3", ["-c", py, ...paths], { encoding: "utf8" });
  if (res.status !== 0) {
    console.log(`PNG render skipped: ${res.error?.message ?? res.stderr.trim()}`);
    return [];
  }
  return res.stdout.trim().split("\n").filter(Boolean);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  let failed = 0;
  const run = async (title: string, fn: () => Promise<string | void>) => {
    try {
      const info = await fn();
      console.log(`PASS  ${title}${info ? `  ${info}` : ""}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${title}\n      ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await run("unit: winAnsiSafe / paymentMethodLabel / invoicePdfFileName", unitChecks);
  const paths: string[] = [];
  for (const c of CASES) {
    await run(c.title, async () => {
      const r = await render(c);
      paths.push(r.path);
      await commonChecks(r);
      await c.check(r);
      return `${r.pages.length} page${r.pages.length === 1 ? "" : "s"} · ${r.bytes.length.toLocaleString()} bytes · ${r.path}`;
    });
  }
  if (process.env.INVOICE_PDF_PNG === "1" && paths.length) {
    const pngs = renderPngs(paths);
    if (pngs.length) console.log(`PNG   ${pngs.length} page images:\n      ${pngs.join("\n      ")}`);
  }
  console.log(failed ? `\n${failed} check group(s) failed` : `\nAll ${CASES.length + 1} check groups passed`);
  process.exitCode = failed ? 1 : 0;
}

void main();
