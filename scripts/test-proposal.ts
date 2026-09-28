/**
 * Tests for the proposal-PDF parser (src/lib/proposal/parse.ts) and the invoice draft builder
 * (src/lib/proposal/draft.ts).  Run:  npx tsx scripts/test-proposal.ts
 *
 * Fixtures live in scripts/fixtures/proposals/<name>/ and were rendered by Digital Horizon's real
 * generator in both of its fonts (see the README there). proposal.json is the generator input, so
 * it is the ground truth for every text field; expected.json holds the hand-checked numbers,
 * warnings and invoice draft. Every field of the parse and the draft is compared.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { InvoiceLine } from "@/lib/invoice/types";
import { draftInvoiceLines } from "@/lib/proposal/draft";
import {
  intervalOfType,
  joinWrappedLines,
  parseProposalPdf,
  proposalDateToISO,
  readPrice,
  vocabulary,
  type ParsedProposal,
  type ParsedService,
  type PriceRead,
} from "@/lib/proposal/parse";

const FIXTURES = path.join(__dirname, "fixtures", "proposals");
const FONTS = ["helvetica", "geist"] as const;
/**
 * A real client proposal can be checked without anything from it entering this (public)
 * repo: set PROPOSAL_SAMPLE_PDF to the PDF and PROPOSAL_SAMPLE_EXPECTED to a JSON file
 * `{ "parse": <ParsedProposal>, "draft": <draftInvoiceLines result> }` kept alongside it.
 */
const SAMPLE = process.env.PROPOSAL_SAMPLE_PDF || "";
const SAMPLE_EXPECTED = process.env.PROPOSAL_SAMPLE_EXPECTED || "";

// --- Tiny runner ----------------------------------------------------------------------------------

let passed = 0;
const failed: string[] = [];
const skipped: string[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(String(err instanceof Error ? (err.stack ?? err.message) : err).replace(/^/gm, "        "));
  }
}

function skip(name: string, why: string) {
  skipped.push(name);
  console.log(`  skip  ${name} — ${why}`);
}

const read = (file: string) => new Uint8Array(fs.readFileSync(file));

// --- Fixture expectations -------------------------------------------------------------------------

/** The generator's input JSON (lib/proposal/types.ts in the digital-horizon repo). */
interface SourceProposal {
  client: string;
  proposalDate: string;
  summary: string;
  primaryServices: { name: string; description?: string | null; type: string; price: string; priceNote?: string | null }[];
  additionalServices: { name: string; pricing: string }[];
}

interface Expected {
  title: string;
  proposalDateISO: string;
  contact: ParsedProposal["contact"];
  services: Pick<ParsedService, "amount" | "free" | "recurring">[];
  additionalAmounts: (number | null)[];
  totals: ParsedProposal["totals"];
  warnings: string[];
  draft: {
    lines: Pick<InvoiceLine, "amount" | "zeroLabel" | "note" | "recurring">[];
    total: number;
    notes: string;
    warnings: string[];
  };
}

function loadFixture(name: string): { src: SourceProposal; exp: Expected } {
  const dir = path.join(FIXTURES, name);
  return {
    src: JSON.parse(fs.readFileSync(path.join(dir, "proposal.json"), "utf8")) as SourceProposal,
    exp: JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8")) as Expected,
  };
}

function expectedParse(src: SourceProposal, exp: Expected): ParsedProposal {
  assert.equal(exp.services.length, src.primaryServices.length, "expected.json services ≠ proposal.json services");
  return {
    ok: true,
    client: src.client,
    proposalDate: src.proposalDate,
    proposalDateISO: exp.proposalDateISO,
    summary: src.summary,
    services: src.primaryServices.map((s, i) => ({
      name: s.name,
      description: s.description ?? "",
      type: s.type,
      priceText: s.price,
      priceNote: s.priceNote ?? "",
      ...exp.services[i],
    })),
    additional: src.additionalServices.map((a, i) => ({ name: a.name, pricing: a.pricing, amount: exp.additionalAmounts[i] })),
    totals: exp.totals,
    contact: exp.contact,
    title: exp.title,
    warnings: exp.warnings,
  };
}

function expectedDraft(src: SourceProposal, exp: Expected, prefix = "l") {
  return {
    lines: src.primaryServices.map((s, i) => ({
      id: `${prefix}${i + 1}`,
      name: s.name,
      description: s.description ?? "",
      type: s.type,
      ...exp.draft.lines[i],
    })),
    total: exp.draft.total,
    notes: exp.draft.notes,
    warnings: exp.draft.warnings,
  };
}

// --- Hand-built PDFs (pdf-lib) --------------------------------------------------------------------

interface Draw {
  text: string;
  x: number;
  y: number;
  size: number;
  bold?: boolean;
  /** "right" → x is the right edge; "center" → x is the centre. */
  align?: "right" | "center";
}

async function pdfWith(draws: Draw[], meta: { title?: string; author?: string; subject?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page: PDFPage = doc.addPage([612, 792]);
  for (const d of draws) {
    const font: PDFFont = d.bold ? bold : regular;
    const w = font.widthOfTextAtSize(d.text, d.size);
    const x = d.align === "right" ? d.x - w : d.align === "center" ? d.x - w / 2 : d.x;
    page.drawText(d.text, { x, y: d.y, size: d.size, font });
  }
  if (meta.title) doc.setTitle(meta.title);
  if (meta.author) doc.setAuthor(meta.author);
  if (meta.subject) doc.setSubject(meta.subject);
  return doc.save();
}

interface SyntheticRow {
  name: string;
  description?: string;
  type: string;
  price?: string;
  note?: string;
  /** Font size of the TYPE cell (the generator uses 9.5pt). */
  typeSize?: number;
}

interface SyntheticProposal {
  client: string;
  /** What the CLIENT cell prints, when it should differ from `client`. */
  clientCell?: string;
  rows: SyntheticRow[];
  totals: [monthly: string, oneTime: string, initial: string];
}

/** Page 1 of a proposal laid out with pdf.tsx's coordinates (Helvetica), in reading order. */
function proposalDraws(o: SyntheticProposal): Draw[] {
  const draws: Draw[] = [
    { text: "Digital Horizon", x: 64, y: 744.8, size: 12, bold: true },
    { text: `Service Proposal | Prepared for ${o.client}`, x: 572, y: 746, size: 8.5, align: "right" },
    { text: `Prepared for ${o.client}`, x: 188, y: 679, size: 20, bold: true },
    { text: "A short test engagement, drawn out of", x: 188, y: 658, size: 10 },
    { text: "order on purpose.", x: 188, y: 643, size: 10 },
    { text: "PROPOSAL DATE", x: 40, y: 516.8, size: 8, bold: true },
    { text: "CLIENT", x: 217.33, y: 516.8, size: 8, bold: true },
    { text: "PREPARED BY", x: 394.67, y: 516.8, size: 8, bold: true },
    { text: "April 1, 2027", x: 40, y: 502.75, size: 10.5 },
    { text: o.clientCell ?? o.client, x: 217.33, y: 502.75, size: 10.5 },
    { text: "Digital Horizon", x: 394.67, y: 502.75, size: 10.5 },
    { text: "Primary Proposal", x: 52, y: 441.55, size: 13, bold: true },
    { text: "SERVICE", x: 52, y: 412.9, size: 8, bold: true },
    { text: "TYPE", x: 365.58, y: 412.9, size: 8, bold: true },
    { text: "PRICE", x: 559.4, y: 412.9, size: 8, bold: true, align: "right" },
  ];
  let y = 384.3;
  for (const r of o.rows) {
    draws.push({ text: r.name, x: 52, y, size: 10, bold: true });
    draws.push({ text: r.type, x: 365.58, y: y + 0.45, size: r.typeSize ?? 9.5 });
    if (r.price) draws.push({ text: r.price, x: 560, y: y - 0.45, size: 10.5, bold: true, align: "right" });
    if (r.note) draws.push({ text: r.note, x: 560, y: y - 11.3, size: 8, align: "right" });
    if (r.description) draws.push({ text: r.description, x: 52, y: y - 11.65, size: 8.5 });
    y -= r.description ? 44 : 32;
  }
  const [monthly, oneTime, initial] = o.totals;
  draws.push(
    { text: "TOTAL MONTHLY", x: 140.3, y: 120.2, size: 8, bold: true, align: "center" },
    { text: "TOTAL ONE-TIME", x: 305.6, y: 120.2, size: 8, bold: true, align: "center" },
    { text: "INITIAL INVESTMENT", x: 470.9, y: 120.2, size: 8, bold: true, align: "center" },
    { text: monthly, x: 140.3, y: 94.6, size: 20, bold: true, align: "center" },
    { text: oneTime, x: 305.6, y: 94.6, size: 20, bold: true, align: "center" },
    { text: initial, x: 470.9, y: 94.6, size: 20, bold: true, align: "center" },
    { text: "Digital Horizon | Carson City, NV", x: 40, y: 19.6, size: 8 },
    { text: "Page 1", x: 572, y: 19.6, size: 8, align: "right" },
  );
  return draws;
}

const dhMeta = (client: string) => ({
  title: `Digital Horizon Proposal — ${client}`,
  author: "Digital Horizon",
  subject: `Service Proposal for ${client}`,
});

/** Every 7th item, wrapping: prices and totals land far from their rows, as pdf.js may return them. */
const scramble = (draws: Draw[]) => draws.map((_, i) => draws[(i * 7) % draws.length]);

/** The parse of a synthetic proposal's fixed parts (date, summary, …) around its services. */
function syntheticParse(client: string, services: ParsedService[], totals: ParsedProposal["totals"], warnings: string[] = []): ParsedProposal {
  return {
    ok: true,
    client,
    proposalDate: "April 1, 2027",
    proposalDateISO: "2027-04-01",
    summary: "A short test engagement, drawn out of order on purpose.",
    services,
    additional: [],
    totals,
    contact: { phone: "", email: "" },
    title: `Digital Horizon Proposal — ${client}`,
    warnings,
  };
}

const service = (s: Partial<ParsedService> & Pick<ParsedService, "name" | "type" | "priceText">): ParsedService => ({
  description: "",
  priceNote: "",
  amount: null,
  free: false,
  recurring: null,
  ...s,
});

// --- Tests ----------------------------------------------------------------------------------------

async function main() {
  console.log("Units: prices, cadence, dates, wrapped text");

  await test("readPrice: amounts, cadences, FREE, empty and unreadable text", () => {
    const cases: [string, PriceRead][] = [
      ["$1,100", { amount: 1100, free: false, interval: null, readable: true }],
      ["$12,500.50", { amount: 12500.5, free: false, interval: null, readable: true }],
      ["$1100", { amount: 1100, free: false, interval: null, readable: true }],
      ["$1,100*", { amount: 1100, free: false, interval: null, readable: true }],
      ["$500 one-time", { amount: 500, free: false, interval: null, readable: true }],
      ["$500 (One-Time)", { amount: 500, free: false, interval: null, readable: true }],
      ["$0", { amount: 0, free: false, interval: null, readable: true }],
      ["-$200", { amount: -200, free: false, interval: null, readable: true }],
      ["−$200", { amount: -200, free: false, interval: null, readable: true }],
      ["$94.99 / mo", { amount: 94.99, free: false, interval: "month", readable: true }],
      ["$94.99/mo", { amount: 94.99, free: false, interval: "month", readable: true }],
      ["$94.99 / month", { amount: 94.99, free: false, interval: "month", readable: true }],
      ["$94.99 per month", { amount: 94.99, free: false, interval: "month", readable: true }],
      ["$94.99 monthly", { amount: 94.99, free: false, interval: "month", readable: true }],
      ["$94.99 a month", { amount: 94.99, free: false, interval: "month", readable: true }],
      ["$240 / yr", { amount: 240, free: false, interval: "year", readable: true }],
      ["$240/year", { amount: 240, free: false, interval: "year", readable: true }],
      ["$240 per year", { amount: 240, free: false, interval: "year", readable: true }],
      ["$240 annually", { amount: 240, free: false, interval: "year", readable: true }],
      ["$240 yearly", { amount: 240, free: false, interval: "year", readable: true }],
      ["FREE", { amount: 0, free: true, interval: null, readable: true }],
      ["Free", { amount: 0, free: true, interval: null, readable: true }],
      ["FREE / mo", { amount: 0, free: true, interval: "month", readable: true }],
      ["", { amount: null, free: false, interval: null, readable: true }],
      ["Included", { amount: null, free: false, interval: null, readable: true }],
      ["$250 + ad spend, per campaign", { amount: null, free: false, interval: null, readable: false }],
      ["Quoted upon request", { amount: null, free: false, interval: null, readable: false }],
      ["10% of ad spend", { amount: null, free: false, interval: null, readable: false }],
      ["$75 / hr", { amount: null, free: false, interval: null, readable: false }],
      ["$500–$800", { amount: null, free: false, interval: null, readable: false }],
      ["from $500", { amount: null, free: false, interval: null, readable: false }],
      ["$1,00", { amount: null, free: false, interval: null, readable: false }],
    ];
    for (const [text, want] of cases) assert.deepEqual(readPrice(text), want, `readPrice(${JSON.stringify(text)})`);
  });

  await test("intervalOfType: TYPE column cadences", () => {
    const cases: [string, ReturnType<typeof intervalOfType>][] = [
      ["One-Time", null],
      ["Setup", null],
      ["", null],
      ["Monthly", "month"],
      ["Monthly (6-month minimum term)", "month"],
      ["Annual", "year"],
      ["Yearly", "year"],
      ["Quarterly", "other"],
      ["Bi-monthly", "other"],
      ["Semi-annual", "other"],
      ["Weekly", "other"],
    ];
    for (const [type, want] of cases) assert.equal(intervalOfType(type), want, `intervalOfType(${JSON.stringify(type)})`);
  });

  await test("proposalDateToISO: printed dates → YYYY-MM-DD, invalid → empty", () => {
    const cases: [string, string][] = [
      ["September 18, 2026", "2026-09-18"],
      ["Sept. 18, 2026", "2026-09-18"],
      ["Sep 18 2026", "2026-09-18"],
      ["September 18th, 2026", "2026-09-18"],
      ["18 September 2026", "2026-09-18"],
      ["2026-09-18", "2026-09-18"],
      ["9/18/2026", "2026-09-18"],
      ["Dec 1, 2026", "2026-12-01"],
      ["February 29, 2028", "2028-02-29"],
      ["February 30, 2026", ""],
      ["Smarch 3, 2026", ""],
      ["soon", ""],
      ["", ""],
    ];
    for (const [text, want] of cases) assert.equal(proposalDateToISO(text), want, `proposalDateToISO(${JSON.stringify(text)})`);
  });

  await test("joinWrappedLines: hyphenated breaks, compounds, evidence, plain wraps", () => {
    const none = new Set<string>();
    const cases: [string[], Set<string>, string][] = [
      // react-pdf inserted these hyphens (real sample / fixtures)
      [["and content man-", "agement for each page"], none, "and content management for each page"],
      [["for discover-", "ability across search"], none, "for discoverability across search"],
      [["Supercalifragilisticexpi-", "alidocious Example"], none, "Supercalifragilisticexpialidocious Example"],
      [["the mul-", "ti-vendor portal"], none, "the multi-vendor portal"],
      [["the multi-ven-", "dor portal"], none, "the multi-vendor portal"],
      // compound prefix, no evidence either way
      [["a custom multi-", "vendor platform"], none, "a custom multi-vendor platform"],
      [["Self-", "Service Portal"], none, "Self-Service Portal"],
      [["serves multi-", "ple locations"], none, "serves multiple locations"],
      // evidence elsewhere in the document wins
      [["the Build-", "Out phase"], vocabulary(["Website Build-Out"]), "the Build-Out phase"],
      [["the Build-", "Out phase"], none, "the BuildOut phase"],
      [["a multi-", "vendor platform"], vocabulary(["our multivendor plan"]), "a multivendor platform"],
      [["content man-", "agement"], vocabulary(["Engagement Management"]), "content management"],
      // suspended hyphen and numbers
      [["pre-", "and post-launch checks"], none, "pre- and post-launch checks"],
      [["a 24-", "hour window"], none, "a 24-hour window"],
      // ordinary wraps
      [["Quoted per project", "(scope-dependent)"], none, "Quoted per project (scope-dependent)"],
      [["searching for brunch —", "so diners"], none, "searching for brunch — so diners"],
      [["Example Antiques and Collectibles", "Market"], none, "Example Antiques and Collectibles Market"],
      [["one", "", "two "], none, "one two"],
    ];
    for (const [lines, words, want] of cases) assert.equal(joinWrappedLines(lines, words), want, JSON.stringify(lines));
  });

  console.log("Rendered fixtures (Digital Horizon's generator, Helvetica + Geist)");
  const fixtureNames = fs
    .readdirSync(FIXTURES)
    .filter((n) => fs.existsSync(path.join(FIXTURES, n, "expected.json")))
    .sort();
  assert.ok(fixtureNames.length >= 9, `expected the fixture set, found ${fixtureNames.length}`);
  for (const name of fixtureNames) {
    const { src, exp } = loadFixture(name);
    for (const font of FONTS) {
      const file = path.join(FIXTURES, name, `${font}.pdf`);
      await test(`${name} (${font}): parse and invoice draft`, async () => {
        const parsed = await parseProposalPdf(read(file));
        assert.deepStrictEqual(parsed, expectedParse(src, exp));
        assert.deepStrictEqual(draftInvoiceLines(parsed), expectedDraft(src, exp));
      });
    }
  }

  await test("draft ids use idPrefix and stay deterministic", async () => {
    const { src, exp } = loadFixture("base-offer");
    const parsed = await parseProposalPdf(read(path.join(FIXTURES, "base-offer", "helvetica.pdf")));
    assert.deepStrictEqual(draftInvoiceLines(parsed, { idPrefix: "inv7-" }), expectedDraft(src, exp, "inv7-"));
    assert.deepStrictEqual(draftInvoiceLines(parsed, { idPrefix: "inv7-" }), draftInvoiceLines(parsed, { idPrefix: "inv7-" }));
  });

  await test("the caller's bytes are left untouched (pdf.js gets a copy)", async () => {
    const bytes = read(path.join(FIXTURES, "base-offer", "geist.pdf"));
    const before = Buffer.from(bytes).toString("base64");
    await parseProposalPdf(bytes);
    assert.equal(bytes.byteLength > 0, true);
    assert.equal(Buffer.from(bytes).toString("base64"), before);
  });

  await test("text drawn out of reading order still parses by position", async () => {
    const client = "Example Scramble Co.";
    const draws = proposalDraws({
      client,
      rows: [
        { name: "Brand Strategy Workshop", type: "One-Time", price: "$1,500" },
        { name: "Search Retainer", description: "Ongoing content and reporting", type: "Monthly", price: "$250 / mo", note: "Bundled monthly retainer" },
        { name: "Analytics Setup", type: "Setup", price: "FREE" },
      ],
      totals: ["$250", "$1,500", "$1,750"],
    });
    const p = await parseProposalPdf(await pdfWith(scramble(draws), dhMeta(client)));
    assert.deepStrictEqual(
      p,
      syntheticParse(
        client,
        [
          service({ name: "Brand Strategy Workshop", type: "One-Time", priceText: "$1,500", amount: 1500 }),
          service({
            name: "Search Retainer",
            description: "Ongoing content and reporting",
            type: "Monthly",
            priceText: "$250 / mo",
            priceNote: "Bundled monthly retainer",
            amount: 250,
            recurring: "month",
          }),
          service({ name: "Analytics Setup", type: "Setup", priceText: "FREE", amount: 0, free: true }),
        ],
        { monthly: 250, oneTime: 1500, initial: 1750 },
      ),
    );
  });

  await test("same-size neighbouring cells stay apart (name running up to the TYPE column)", async () => {
    const client = "Example Listings Co.";
    const name = "Reputation Management & Review Replies Across Every Listing"; // ends ~10pt before TYPE
    const draws = proposalDraws({ client, rows: [{ name, type: "Monthly", typeSize: 10, price: "$95 / mo" }], totals: ["$95", "FREE", "$95"] });
    const p = await parseProposalPdf(await pdfWith(draws, dhMeta(client)));
    assert.deepStrictEqual(p.services, [service({ name, type: "Monthly", priceText: "$95 / mo", amount: 95, recurring: "month" })]);
    assert.deepStrictEqual(p.warnings, []);
  });

  await test("client: the PDF title's spelling wins when it differs only in case or spacing", async () => {
    const client = "Example Scramble Co.";
    const draws = proposalDraws({ client, clientCell: "EXAMPLE  SCRAMBLE CO.", rows: [{ name: "Audit", type: "One-Time", price: "$100" }], totals: ["FREE", "$100", "$100"] });
    const p = await parseProposalPdf(await pdfWith(draws, dhMeta(client)));
    assert.equal(p.client, client);
    assert.deepStrictEqual(p.warnings, []);
  });

  await test("client: a real mismatch keeps the CLIENT field and warns", async () => {
    const draws = proposalDraws({ client: "Example Scramble Co.", rows: [{ name: "Audit", type: "One-Time", price: "$100" }], totals: ["FREE", "$100", "$100"] });
    const p = await parseProposalPdf(await pdfWith(draws, { ...dhMeta("Other Example LLC"), subject: "" }));
    assert.equal(p.client, "Example Scramble Co.");
    assert.deepStrictEqual(p.warnings, ["The CLIENT field says “Example Scramble Co.” but the PDF title says “Other Example LLC”."]);
  });

  await test("TYPE vs price cadence: conflicts and unsupported cadences are flagged, never guessed silently", async () => {
    const client = "Example Cadence Co.";
    const draws = proposalDraws({
      client,
      rows: [
        { name: "Hosting", type: "One-Time", price: "$50 / mo" },
        { name: "Quarterly Review", type: "Quarterly", price: "$300" },
        { name: "Domain", type: "Annual", price: "$20" },
      ],
      totals: ["$50", "$300", "$370"],
    });
    const p = await parseProposalPdf(await pdfWith(draws, dhMeta(client)));
    assert.deepStrictEqual(
      p,
      syntheticParse(
        client,
        [
          service({ name: "Hosting", type: "One-Time", priceText: "$50 / mo", amount: 50, recurring: "month" }),
          service({ name: "Quarterly Review", type: "Quarterly", priceText: "$300", amount: 300 }),
          service({ name: "Domain", type: "Annual", priceText: "$20", amount: 20, recurring: "year" }),
        ],
        { monthly: 50, oneTime: 300, initial: 370 },
        [
          "“Hosting”: the price says per month but TYPE is “One-Time” — used the price.",
          "“Quarterly Review”: TYPE “Quarterly” isn't monthly or yearly, so it was read as a one-time charge.",
        ],
      ),
    );
    const d = draftInvoiceLines(p);
    assert.equal(d.total, 370);
    assert.deepStrictEqual(d.warnings, []);
    assert.equal(d.notes, "Hosting continues at $50.00/mo after the first month, and Domain continues at $20.00/yr after the first year.");
  });

  console.log("Locked, foreign and broken files");

  await test("password-protected proposal → ok:false with a reason", async () => {
    const p = await parseProposalPdf(read(path.join(FIXTURES, "encrypted-user-password.pdf")));
    assert.equal(p.ok, false);
    assert.match(p.reason ?? "", /password-protected/);
    assert.deepEqual(p.services, []);
  });

  await test("encrypted with only an owner password (opens without one) → parses normally", async () => {
    const { src, exp } = loadFixture("base-offer");
    const p = await parseProposalPdf(read(path.join(FIXTURES, "encrypted-owner-only.pdf")));
    assert.deepStrictEqual(p, expectedParse(src, exp));
  });

  await test("a plain letter (not a proposal) → ok:false, no table", async () => {
    const bytes = await pdfWith(
      [
        { text: "Example Neighborhood Association", x: 72, y: 720, size: 14, bold: true },
        { text: "Dear neighbor, the spring cleanup is on Saturday.", x: 72, y: 690, size: 11 },
        { text: "SERVICE TYPE PRICE", x: 72, y: 670, size: 11 },
      ],
      { title: "Newsletter" },
    );
    const p = await parseProposalPdf(bytes);
    assert.deepStrictEqual(p, {
      ok: false,
      reason: "No SERVICE / TYPE / PRICE table was found, so this doesn't look like a Digital Horizon proposal.",
      client: "",
      proposalDate: "",
      proposalDateISO: "",
      summary: "",
      services: [],
      additional: [],
      totals: { monthly: null, oneTime: null, initial: null },
      contact: { phone: "", email: "" },
      title: "Newsletter",
      warnings: [],
    } satisfies ParsedProposal);
  });

  await test("a table header with no rows → ok:false", async () => {
    const bytes = await pdfWith([
      { text: "SERVICE", x: 52, y: 412.9, size: 8, bold: true },
      { text: "TYPE", x: 365.58, y: 412.9, size: 8, bold: true },
      { text: "PRICE", x: 559.4, y: 412.9, size: 8, bold: true, align: "right" },
    ]);
    const p = await parseProposalPdf(bytes);
    assert.equal(p.ok, false);
    assert.equal(p.reason, "The SERVICE / TYPE / PRICE table has no rows in it.");
  });

  await test("another company's quote with the same table → parsed, but flagged as not ours", async () => {
    const bytes = await pdfWith(
      [
        { text: "Example Web Co. — Quote", x: 52, y: 740, size: 16, bold: true },
        { text: "SERVICE", x: 52, y: 700, size: 8, bold: true },
        { text: "TYPE", x: 365.58, y: 700, size: 8, bold: true },
        { text: "PRICE", x: 559.4, y: 700, size: 8, bold: true, align: "right" },
        { text: "Landing Page", x: 52, y: 670, size: 10, bold: true },
        { text: "One-Time", x: 365.58, y: 670, size: 9.5 },
        { text: "$900", x: 560, y: 670, size: 10.5, bold: true, align: "right" },
      ],
      { title: "Quote 1142", author: "Example Web Co." },
    );
    const p = await parseProposalPdf(bytes);
    assert.equal(p.ok, true);
    assert.deepStrictEqual(p.services, [
      { name: "Landing Page", description: "", type: "One-Time", priceText: "$900", priceNote: "", amount: 900, free: false, recurring: null },
    ]);
    assert.deepStrictEqual(p.warnings, [
      "Couldn't find TOTAL MONTHLY on the proposal.",
      "Couldn't find TOTAL ONE-TIME on the proposal.",
      "Couldn't find INITIAL INVESTMENT on the proposal.",
      "Couldn't find the PROPOSAL DATE on the proposal.",
      "Couldn't find the client's name on the proposal.",
      "Couldn't find the summary paragraph on the proposal.",
      "This PDF doesn't carry Digital Horizon's name — make sure it is one of our proposals.",
    ]);
    const draft = draftInvoiceLines(p);
    assert.equal(draft.total, 900);
    assert.deepStrictEqual(draft.warnings, [
      "The proposal's INITIAL INVESTMENT couldn't be read, so this total wasn't checked against it.",
      "The proposal's TOTAL ONE-TIME couldn't be read, so the one-time lines weren't checked against it.",
      "The proposal's TOTAL MONTHLY couldn't be read, so the monthly lines weren't checked against it.",
    ]);
  });

  const broken: [string, Uint8Array, RegExp][] = [
    ["empty file", new Uint8Array(0), /^The file is empty\.$/],
    ["random bytes", Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) % 256), /^This file isn't a PDF\.$/],
    ["a text file", new TextEncoder().encode("SERVICE TYPE PRICE\nnot a pdf\n"), /^This file isn't a PDF\.$/],
    ["a PDF header followed by garbage", new TextEncoder().encode(`%PDF-1.7\n${"garbage ".repeat(500)}`), /PDF/],
  ];
  await test("a 21-page PDF → ok:false without reading it", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 21; i++) doc.addPage([612, 792]);
    const p = await parseProposalPdf(await doc.save());
    assert.equal(p.ok, false);
    assert.equal(p.reason, "This doesn't look like a Digital Horizon proposal. It has 21 pages — far longer than a proposal.");
  });

  await test("a file over 20 MB → ok:false before any parsing", async () => {
    const big = new Uint8Array(21 * 1024 * 1024);
    big.set(new TextEncoder().encode("%PDF-1.7\n"));
    const p = await parseProposalPdf(big);
    assert.equal(p.ok, false);
    assert.equal(p.reason, "The file is too large to be a proposal.");
  });

  for (const [what, bytes, reason] of broken) {
    await test(`${what} → ok:false, no throw`, async () => {
      const p = await parseProposalPdf(bytes);
      assert.equal(p.ok, false);
      assert.match(p.reason ?? "", reason);
    });
  }

  await test("a truncated proposal → never throws; any partial read is flagged", async () => {
    const full = read(path.join(FIXTURES, "overflow-14", "helvetica.pdf"));
    for (const cut of [0.2, 0.5, 0.8, 0.95]) {
      const p = await parseProposalPdf(full.slice(0, Math.floor(full.length * cut)));
      assert.ok(!p.ok || p.warnings.length > 0 || p.services.length === 14, `cut at ${cut}: silent partial parse (${p.services.length} services)`);
      if (!p.ok) assert.ok(p.reason, `cut at ${cut}: ok:false without a reason`);
    }
  });

  console.log("Invoice draft rule (hand-built proposals)");

  const base = (services: ParsedService[], totals: ParsedProposal["totals"]): ParsedProposal => ({
    ok: true,
    client: "Example Client",
    proposalDate: "",
    proposalDateISO: "",
    summary: "",
    services,
    additional: [{ name: "Never billed", pricing: "$999", amount: 999 }],
    totals,
    contact: { phone: "", email: "" },
    title: "",
    warnings: [],
  });
  const svc = (name: string, priceText: string, amount: number | null, recurring: ParsedService["recurring"], free = false): ParsedService => ({
    name,
    description: "",
    type: recurring === "month" ? "Monthly" : recurring === "year" ? "Annual" : "One-Time",
    priceText,
    priceNote: "",
    amount,
    free,
    recurring,
  });

  await test("draft: yearly lines may sit inside TOTAL ONE-TIME; notes list every rate", () => {
    const p = base(
      [
        svc("Build", "$1,000", 1000, null),
        svc("SEO, Content & Links", "$435 / mo", 435, "month"),
        svc("Hosting", "$94.99 / mo", 94.99, "month"),
        svc("Domain", "$20 / yr", 20, "year"),
      ],
      { monthly: 529.99, oneTime: 1020, initial: 1549.99 },
    );
    const d = draftInvoiceLines(p);
    assert.equal(d.total, 1549.99);
    assert.deepStrictEqual(d.warnings, []);
    assert.equal(
      d.notes,
      "SEO, Content & Links ($435.00/mo) and Hosting ($94.99/mo) continue after the first month, and Domain continues at $20.00/yr after the first year.",
    );
    assert.deepStrictEqual(d.lines[3].recurring, { interval: "year", amount: 20 });
    assert.equal(d.lines[3].note, "First year · then $20.00/yr");
  });

  await test("draft: a credit line is billed as printed and flagged", () => {
    const p = base([svc("Build", "$1,000", 1000, null), svc("Loyalty credit", "-$100", -100, null)], { monthly: 0, oneTime: 900, initial: 900 });
    const d = draftInvoiceLines(p);
    assert.equal(d.total, 900);
    assert.deepStrictEqual(d.warnings, ["“Loyalty credit” is a credit of -$100.00 — make sure it belongs on this invoice."]);
  });

  await test("draft: wrong one-time total and an unreadable price are both reported", () => {
    const p = base([svc("Build", "$1,000", 1000, null), svc("Ads", "15% of spend", null, null)], { monthly: 0, oneTime: 1200, initial: 1200 });
    const d = draftInvoiceLines(p);
    assert.equal(d.total, 1000);
    assert.deepStrictEqual(d.lines[1], { id: "l2", name: "Ads", description: "", type: "One-Time", recurring: null, amount: 0, zeroLabel: "", note: "" });
    assert.deepStrictEqual(d.warnings, [
      "“Ads”: couldn't read the price “15% of spend” — enter the amount by hand.",
      "One-time lines add up to $1,000.00, but the proposal's TOTAL ONE-TIME says $1,200.00.",
      "This invoice totals $1,000.00, but the proposal's INITIAL INVESTMENT says $1,200.00.",
    ]);
  });

  console.log("Real sample (confidential — stays outside the repo)");
  if (!SAMPLE || !SAMPLE_EXPECTED || !fs.existsSync(SAMPLE) || !fs.existsSync(SAMPLE_EXPECTED)) {
    skip("real proposal sample", "set PROPOSAL_SAMPLE_PDF and PROPOSAL_SAMPLE_EXPECTED to include one");
  } else {
    await test("real proposal sample matches its expected parse and invoice draft", async () => {
      const want = JSON.parse(fs.readFileSync(SAMPLE_EXPECTED, "utf8")) as { parse: unknown; draft: unknown };
      const p = await parseProposalPdf(read(SAMPLE));
      assert.equal(p.ok, true);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(p)), want.parse);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(draftInvoiceLines(p))), want.draft);
    });
  }

  const total = passed + failed.length;
  console.log("");
  if (failed.length) {
    console.log(`FAIL — ${failed.length} of ${total} failed${skipped.length ? `, ${skipped.length} skipped` : ""}:`);
    for (const f of failed) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`PASS — ${passed} of ${total} passed${skipped.length ? `, ${skipped.length} skipped` : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
