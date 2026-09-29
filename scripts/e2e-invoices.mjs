/**
 * Local, TEST-MODE end-to-end run of invoice card payments + subscriptions: proposal upload,
 * credit / debit / prepaid / declined / 3-D Secure cards, the webhook (real Stripe test events,
 * signed like Stripe signs them), the Customers tab and the dashboard.
 * Never points at production: BASE must be localhost and the Stripe key must be sk_test_.
 *
 * 1. Run the board locally with TEST keys and no BLOB_READ_WRITE_TOKEN (local file storage):
 *    .env.local → STRIPE_SECRET_KEY=sk_test_… STRIPE_PUBLISHABLE_KEY=pk_test_…
 *    STRIPE_WEBHOOK_SECRET=<any whsec_…> ASUKA_DASHBOARD_PASSWORD=<pw> ASUKA_SESSION_SECRET=<32+ chars>
 * 2. Playwright isn't a dependency: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i --no-save playwright`
 *    (uses your installed Chrome; set PW_CHROMIUM to its path if it isn't the Windows default).
 * 3. BASE=http://localhost:3000 E2E_PASSWORD=<pw> E2E_STRIPE_SK=sk_test_… E2E_WHSEC=<same whsec> \
 *    E2E_FEE_RULE=none|credit29 node scripts/e2e-invoices.mjs      (E2E_ONLY=B,F runs a subset)
 *    (E2E_FEE_RULE must match INVOICE_CARD_FEE_PERCENT: unset → none, 2.9 → credit29.)
 * The public pay route allows 12 attempts per IP per 10 minutes; restart the dev server between runs.
 */
import { chromium } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.BASE || "http://localhost:3188";
const PASSWORD = process.env.E2E_PASSWORD || "";
const SK = process.env.E2E_STRIPE_SK || "";
const WHSEC = process.env.E2E_WHSEC || "";
const PROPOSAL = process.env.E2E_PROPOSAL || path.resolve("scripts/fixtures/proposals/base-offer/geist.pdf");
const OUT = process.env.E2E_OUT || path.join(os.tmpdir(), "invoice-e2e");
const ONLY = (process.env.E2E_ONLY || "").split(",").filter(Boolean);
const CHROME = process.env.PW_CHROMIUM || "C:/Program Files/Google/Chrome/Application/chrome.exe";
/** Mirrors the invoice fee rule under test: (base, funding) → fee in dollars. */
const FEE_RULE = process.env.E2E_FEE_RULE || "credit3";

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("BASE must be a localhost URL");
if (!SK.startsWith("sk_test_")) throw new Error("E2E_STRIPE_SK must be a Stripe TEST secret key");
if (!WHSEC || !PASSWORD) throw new Error("E2E_WHSEC and E2E_PASSWORD are required");
fs.mkdirSync(OUT, { recursive: true });

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
function expectedFee(base, funding) {
  if (FEE_RULE === "none") return 0;
  if (FEE_RULE === "credit3") return funding === "credit" ? round2(base * 0.03) : 0;
  if (FEE_RULE === "credit29") return funding === "credit" ? round2(base * 0.029) : 0;
  if (FEE_RULE === "all3") return round2(base * 0.03);
  throw new Error(`unknown E2E_FEE_RULE ${FEE_RULE}`);
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* ── Stripe (test mode, read-only here) ── */
async function stripe(p, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  const r = await fetch(`https://api.stripe.com/v1/${p}${qs}`, { headers: { Authorization: `Bearer ${SK}` } });
  const j = await r.json();
  if (j.error) throw new Error(`${p}: ${j.error.message}`);
  return j;
}
async function eventFor(type, match, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const list = await stripe("events", { type, limit: "30" });
    const e = list.data.find((x) => match(x.data.object));
    if (e) return e;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`no ${type} event found`);
}
/** Deliver a real Stripe event to the local webhook, signed exactly the way Stripe signs it. */
async function deliver(event) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", WHSEC).update(`${t}.${payload}`).digest("hex");
  const r = await fetch(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${sig}` }, body: payload });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/* ── dashboard API (session cookie) ── */
let cookie = "";
async function login() {
  const r = await fetch(`${BASE}/api/login`, { method: "POST", body: new URLSearchParams({ password: PASSWORD, next: "/" }), redirect: "manual" });
  const set = r.headers.get("set-cookie") || "";
  must(/asuka_session=/.test(set), `login failed (HTTP ${r.status})`);
  cookie = set.split(";")[0];
}
async function api(p, init = {}) {
  const r = await fetch(`${BASE}${p}`, { ...init, headers: { ...(init.headers || {}), Cookie: cookie } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status} ${j.error || ""}`);
  return j;
}
const getInvoice = async (id) => (await api("/api/invoices")).invoices.find((i) => i.id === id);
async function createInvoice(name, lines) {
  const input = {
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: "",
    client: { name, email: "e2e-client@example.com", phone: "", address: "" },
    project: "E2E test invoice",
    lines,
    cardFeePercent: FEE_RULE === "none" ? 0 : 2.9,
    notes: "",
  };
  const j = await api("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  return j.invoice;
}
const oneTime = (id, name, amount) => ({ id, name, description: "", type: "One-Time", recurring: null, amount, zeroLabel: "", note: "" });
const monthly = (id, name, amount) => ({ id, name, description: "", type: "Monthly", recurring: { interval: "month", amount }, amount, zeroLabel: "", note: `First month · then $${amount.toFixed(2)}/mo` });

/* ── the public page ── */
const CARD_FRAME = 'iframe[title="Secure payment input frame"]';
async function fillCard(page, number) {
  const f = page.frameLocator(CARD_FRAME).first();
  await f.locator('input[name="number"]').fill(number);
  await f.locator('input[name="expiry"]').fill("12 / 34");
  await f.locator('input[name="cvc"]').fill("123");
  const zip = f.locator('input[name="postalCode"]');
  if (await zip.count()) await zip.fill("89701");
}
async function complete3ds(page) {
  for (let i = 0; i < 80; i++) {
    for (const fr of page.frames()) {
      const b = fr.locator("#test-source-authorize-3ds, button:has-text('Complete')");
      if (await b.count().catch(() => 0)) {
        await b.first().click();
        return;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error("3-D Secure challenge never appeared");
}
async function review(page, card) {
  await fillCard(page, card);
  await page.getByRole("button", { name: "Review payment" }).click();
  await page.getByText("Total today").waitFor({ timeout: 45_000 });
  return page.locator('[aria-live="polite"]').filter({ hasText: "Total today" }).innerText();
}
async function openPage(browser, url, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  if (opts.blockFinalize) await page.route("**/finalize", (r) => r.abort());
  await page.goto(url);
  await page.getByText("TEST MODE · NO REAL CHARGE").waitFor({ timeout: 30_000 });
  await page.locator(CARD_FRAME).first().waitFor({ timeout: 30_000 });
  return { ctx, page };
}

/* ── checks after a payment ── */
async function verifyPaid(label, inv, { funding, recurringCents }) {
  const now = await getInvoice(inv.id);
  must(now.status === "paid", `${label}: invoice status ${now.status}`);
  must(now.payments.length === 1, `${label}: ${now.payments.length} payments recorded`);
  const p = now.payments[0];
  const fee = expectedFee(inv.total, funding);
  must(p.fee === fee, `${label}: fee ${p.fee} ≠ expected ${fee}`);
  must(round2(p.amount) === round2(inv.total + fee), `${label}: charged ${p.amount} ≠ ${round2(inv.total + fee)}`);
  must(p.funding === funding, `${label}: funding ${p.funding} ≠ ${funding}`);
  must(!!p.receiptUrl, `${label}: no receipt URL`);

  const pi = await stripe(`payment_intents/${p.paymentIntentId}`);
  must(pi.status === "succeeded" && pi.amount_received === Math.round((inv.total + fee) * 100), `${label}: Stripe PI ${pi.status} ${pi.amount_received}`);
  must(pi.metadata.invoice_id === inv.id, `${label}: PI metadata`);
  if (recurringCents) {
    must(pi.setup_future_usage === "off_session" && pi.customer, `${label}: card not saved (sfu=${pi.setup_future_usage}, customer=${pi.customer})`);
    must(now.subscriptions.length === 1, `${label}: ${now.subscriptions.length} subscriptions recorded`);
    const subRec = now.subscriptions[0];
    const sub = await stripe(`subscriptions/${subRec.subscriptionId}`);
    const items = sub.items.data.reduce((s, it) => s + it.price.unit_amount * it.quantity, 0);
    must(sub.status === "active", `${label}: subscription ${sub.status}`);
    must(sub.metadata.invoice_id === inv.id, `${label}: subscription metadata`);
    must(sub.customer === pi.customer, `${label}: subscription customer`);
    must(sub.default_payment_method === pi.payment_method, `${label}: subscription card ≠ paid card`);
    must(items === recurringCents, `${label}: subscription bills ${items}c ≠ ${recurringCents}c`);
    const days = (sub.billing_cycle_anchor * 1000 - Date.now()) / 86_400_000;
    must(days > 27 && days < 32, `${label}: first renewal in ${days.toFixed(1)} days`);
    const upcoming = await stripe("invoices", { subscription: sub.id, limit: "5" });
    const charged = upcoming.data.filter((x) => x.amount_paid > 0);
    must(charged.length === 0, `${label}: subscription already charged ${charged.length} time(s) — the first month was on the invoice`);
    const all = await stripe("subscriptions", { customer: pi.customer, status: "all", limit: "100" });
    must(all.data.filter((s) => s.metadata.invoice_id === inv.id).length === 1, `${label}: duplicate subscriptions in Stripe`);
  } else {
    must(!pi.setup_future_usage, `${label}: one-time invoice saved the card`);
    must(now.subscriptions.length === 0, `${label}: unexpected subscription`);
  }
  return { now, p, pi };
}

async function verifyWebhookAndCustomers(label, inv, p, pi) {
  const ev = await eventFor("charge.succeeded", (o) => o.payment_intent === pi.id);
  const a = await deliver(ev);
  must(a.status === 200, `${label}: webhook HTTP ${a.status} ${JSON.stringify(a.body)}`);
  const b = await deliver(ev);
  must(b.status === 200, `${label}: webhook replay HTTP ${b.status}`);
  if (pi.customer) {
    const cev = await eventFor("customer.created", (o) => o.id === pi.customer).catch(() => null);
    if (cev) {
      const c = await deliver(cev);
      must(c.status === 200, `${label}: customer.created HTTP ${c.status}`);
    }
  }
  const after = await getInvoice(inv.id);
  must(after.payments.length === 1, `${label}: ${after.payments.length} payments after webhook replays`);
  must(after.subscriptions.length === (inv.lines.some((l) => l.recurring) ? 1 : 0), `${label}: subscriptions after webhook`);
  const state = (await api("/api/state")).state ?? (await api("/api/state"));
  const txs = (state.customers || []).flatMap((c) => c.transactions.map((t) => ({ c, t }))).filter(({ t }) => t.stripeId === p.chargeId);
  must(txs.length === 1, `${label}: ${txs.length} Customers-tab entries for the charge`);
  if (p.fee > 0) must(/card fee/.test(txs[0].t.memo), `${label}: memo lacks the fee note (“${txs[0].t.memo}”)`);
  if (pi.customer) must(txs[0].c.stripeCustomerId === pi.customer, `${label}: Customers entry not linked to ${pi.customer}`);
  return `webhook 200 ×2 · customers memo “${txs[0].t.memo}”`;
}

/* ── scenarios ── */
async function scenario(name, fn) {
  if (ONLY.length && !ONLY.some((o) => name.startsWith(o))) return;
  try {
    const detail = await fn();
    record(name, true, detail || "");
  } catch (err) {
    record(name, false, err.message);
  }
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--mute-audio"] });
await login();

let uploaded = null;
await scenario("A · proposal PDF upload → draft → live invoice (UI)", async () => {
  must(PROPOSAL && fs.existsSync(PROPOSAL), "E2E_PROPOSAL not found");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/#invoices`);
  await page.locator('input[type="file"][accept*="pdf"]').setInputFiles(PROPOSAL);
  await page.getByText("Review the invoice").waitFor({ timeout: 30_000 });
  await page.getByLabel("Client email").fill("e2e-client@example.com");
  const draftText = await page.locator('section[aria-label="Invoice draft"]').innerText();
  await page.screenshot({ path: path.join(OUT, "A-draft.png"), fullPage: true });
  await page.getByRole("button", { name: "Create live invoice" }).click();
  const link = await page.getByLabel("Invoice link").inputValue({ timeout: 30_000 });
  const id = link.split("/i/")[1];
  uploaded = await getInvoice(id);
  must(uploaded && uploaded.status === "open", "invoice not created");
  must(/a Stripe subscription on the client/.test(draftText) === uploaded.lines.some((l) => l.recurring), "draft subscription note");
  await ctx.close();
  return `${uploaded.number} ${uploaded.total} · ${uploaded.lines.length} lines · recurring ${JSON.stringify(uploaded.lines.filter((l) => l.recurring).map((l) => l.recurring))}`;
});

await scenario("B · Visa credit 4242 on the uploaded invoice → fee + subscription", async () => {
  must(uploaded, "no invoice from A");
  const { ctx, page } = await openPage(browser, `${BASE}/i/${uploaded.id}`);
  const renewal = await page.getByTestId("renewal-note").innerText().catch(() => "");
  const rv = await review(page, "4242424242424242");
  const fee = expectedFee(uploaded.total, "credit");
  must(fee === 0 || /Credit card surcharge \(2\.9%\)/.test(rv), `review shows no surcharge line: ${rv}`);
  await page.screenshot({ path: path.join(OUT, "B-review.png"), fullPage: true });
  await page.getByRole("button", { name: /^Pay \$/ }).click();
  await page.getByText(/Payment received|Paid in full/).first().waitFor({ timeout: 60_000 });
  await page.screenshot({ path: path.join(OUT, "B-done.png"), fullPage: true });
  await ctx.close();
  const recurringCents = Math.round(uploaded.lines.filter((l) => l.recurring).reduce((s, l) => s + l.recurring.amount, 0) * 100);
  const { p, pi } = await verifyPaid("B", uploaded, { funding: "credit", recurringCents });
  const wh = await verifyWebhookAndCustomers("B", uploaded, p, pi);
  const { page: paid, ctx: c2 } = await (async () => {
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const pg = await ctx2.newPage();
    await pg.goto(`${BASE}/i/${uploaded.id}`);
    return { page: pg, ctx: ctx2 };
  })();
  await paid.getByText("Paid in full").waitFor();
  must(await paid.getByRole("link", { name: /Receipt/ }).count(), "paid page has no receipt link");
  const subNote = await paid.getByText(/charged automatically to/).innerText();
  await paid.screenshot({ path: path.join(OUT, "B-paid-page.png"), fullPage: true });
  await c2.close();
  return `renewal note “${renewal}” · ${wh} · paid page “${subNote}”`;
});

async function simple(name, lines, card, funding) {
  await scenario(name, async () => {
    const inv = await createInvoice(`E2E ${name.slice(0, 1)}`, lines);
    const { ctx, page } = await openPage(browser, `${BASE}/i/${inv.id}`);
    const rv = await review(page, card);
    const fee = expectedFee(inv.total, funding);
    must(fee > 0 ? /Credit card surcharge \(2\.9%\)/.test(rv) : !/surcharge \(/i.test(rv), `review fee line wrong for ${funding}: ${rv.replace(/\s+/g, " ")}`);
    await page.getByRole("button", { name: /^Pay \$/ }).click();
    await page.getByText(/Payment received|Paid in full/).first().waitFor({ timeout: 60_000 });
    await ctx.close();
    const recurringCents = Math.round(lines.filter((l) => l.recurring).reduce((s, l) => s + l.recurring.amount, 0) * 100);
    const { p, pi } = await verifyPaid(name, inv, { funding, recurringCents });
    return `${inv.number} charged ${p.amount} (fee ${p.fee}) · ${await verifyWebhookAndCustomers(name, inv, p, pi)}`;
  });
}

await simple("C · Visa debit, one-time only → no fee, card not saved", [oneTime("l1", "Logo refresh", 200)], "4000056655665556", "debit");
await simple("D · Mastercard debit, monthly → no fee + subscription", [oneTime("l1", "Setup", 50), monthly("l2", "Hosting, Technical Maintenance & Security", 94.99)], "5200828282828210", "debit");
await simple("E · Mastercard prepaid, one-time → no fee", [oneTime("l1", "Photo shoot", 120)], "5105105105105100", "prepaid");

await scenario("F · declined card → honest error, retry with 4242 succeeds on the same PaymentIntent", async () => {
  const inv = await createInvoice("E2E F", [oneTime("l1", "Setup", 75), monthly("l2", "Hosting", 49.99)]);
  const { ctx, page } = await openPage(browser, `${BASE}/i/${inv.id}`);
  await review(page, "4000000000000002");
  await page.getByRole("button", { name: /^Pay \$/ }).click();
  const err = page.getByRole("alert").filter({ hasText: /declined|error|try/i }).first();
  await err.waitFor({ timeout: 45_000 });
  const msg = (await err.innerText()).trim();
  must(/declined/i.test(msg), `decline message: ${msg}`);
  await page.screenshot({ path: path.join(OUT, "F-declined.png"), fullPage: true });
  await review(page, "4242424242424242");
  await page.getByRole("button", { name: /^Pay \$/ }).click();
  await page.getByText(/Payment received|Paid in full/).first().waitFor({ timeout: 60_000 });
  await ctx.close();
  const { p, pi } = await verifyPaid("F", inv, { funding: "credit", recurringCents: 4999 });
  const pis = await stripe("payment_intents", { customer: pi.customer, limit: "10" });
  const mine = pis.data.filter((x) => x.metadata.invoice_id === inv.id);
  must(mine.length === 1, `${mine.length} PaymentIntents for one invoice`);
  return `error “${msg}” · then paid ${p.amount} · 1 PaymentIntent · ${await verifyWebhookAndCustomers("F", inv, p, pi)}`;
});

await scenario("G · 3-D Secure challenge → completes → paid + subscription", async () => {
  const inv = await createInvoice("E2E G", [oneTime("l1", "Build", 300), monthly("l2", "SEO", 150)]);
  const { ctx, page } = await openPage(browser, `${BASE}/i/${inv.id}`);
  await review(page, "4000002500003155");
  await page.getByRole("button", { name: /^Pay \$/ }).click();
  await complete3ds(page);
  await page.getByText(/Payment received|Paid in full/).first().waitFor({ timeout: 60_000 });
  await ctx.close();
  const { p, pi } = await verifyPaid("G", inv, { funding: "credit", recurringCents: 15000 });
  return `paid ${p.amount} after 3DS · ${await verifyWebhookAndCustomers("G", inv, p, pi)}`;
});

await scenario("H · 3DS with the page's finalize call lost → webhook records it first → reload shows paid, no duplicates", async () => {
  const inv = await createInvoice("E2E H", [monthly("l1", "Hosting", 94.99)]);
  const { ctx, page } = await openPage(browser, `${BASE}/i/${inv.id}`, { blockFinalize: true });
  await review(page, "4000002500003155");
  await page.getByRole("button", { name: /^Pay \$/ }).click();
  await complete3ds(page);
  await page.waitForTimeout(4000);
  await ctx.close();
  const before = await getInvoice(inv.id);
  must(before.status === "open" && before.payments.length === 0, `finalize should have been lost (status ${before.status})`);
  const pisRec = await stripe("payment_intents", { limit: "20" });
  const pi = pisRec.data.find((x) => x.metadata.invoice_id === inv.id && x.status === "succeeded");
  must(pi, "no succeeded PaymentIntent in Stripe");
  const ev = await eventFor("charge.succeeded", (o) => o.payment_intent === pi.id);
  const d = await deliver(ev);
  must(d.status === 200, `webhook HTTP ${d.status}`);
  const afterHook = await getInvoice(inv.id);
  must(afterHook.status === "paid" && afterHook.subscriptions.length === 1, `after webhook: ${afterHook.status}, ${afterHook.subscriptions.length} subs`);
  const again = await openPage(browser, `${BASE}/i/${inv.id}`).catch(() => null);
  if (again) await again.ctx.close();
  const ctx3 = await browser.newContext();
  const pg = await ctx3.newPage();
  await pg.goto(`${BASE}/i/${inv.id}`);
  await pg.getByText("Paid in full").waitFor();
  await ctx3.close();
  const { p, pi: pi2 } = await verifyPaid("H", inv, { funding: "credit", recurringCents: 9499 });
  return `webhook-first ok · ${await verifyWebhookAndCustomers("H", inv, p, pi2)}`;
});

await scenario("J · refund → charge.refunded webhook starts no second subscription; Customers entry removed", async () => {
  const inv = await createInvoice("E2E J", [oneTime("l1", "Setup", 60), monthly("l2", "Hosting", 39.99)]);
  const { ctx, page } = await openPage(browser, `${BASE}/i/${inv.id}`);
  await review(page, "4242424242424242");
  await page.getByRole("button", { name: /^Pay \$/ }).click();
  await page.getByText(/Payment received|Paid in full/).first().waitFor({ timeout: 60_000 });
  await ctx.close();
  const { p, pi } = await verifyPaid("J", inv, { funding: "credit", recurringCents: 3999 });
  await verifyWebhookAndCustomers("J", inv, p, pi);
  // TEST-mode refund (the key is checked to be sk_test_ at the top), then the real refund event.
  const rf = await (await fetch("https://api.stripe.com/v1/refunds", { method: "POST", headers: { Authorization: `Bearer ${SK}` }, body: new URLSearchParams({ payment_intent: pi.id }) })).json();
  must(rf.status === "succeeded" || rf.status === "pending", `refund: ${rf.status || rf.error?.message}`);
  const ev = await eventFor("charge.refunded", (o) => o.payment_intent === pi.id);
  const d = await deliver(ev);
  must(d.status === 200, `charge.refunded webhook HTTP ${d.status}`);
  const after = await getInvoice(inv.id);
  must(after.subscriptions.length === 1, `${after.subscriptions.length} subscriptions recorded after the refund`);
  const subs = await stripe("subscriptions", { customer: pi.customer, status: "all", limit: "100" });
  must(subs.data.filter((s) => s.metadata.invoice_id === inv.id).length === 1, "a second subscription appeared after the refund");
  const state = (await api("/api/state")).state ?? (await api("/api/state"));
  const left = (state.customers || []).flatMap((c) => c.transactions).filter((t) => t.stripeId === p.chargeId);
  must(left.length === 0, `${left.length} Customers entries still count the refunded charge`);
  return `refund ${rf.status} · webhook 200 · still 1 subscription (cancel it in Stripe) · Customers entry removed`;
});

await scenario("I · dashboard shows the paid rows and the subscription", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  await ctx.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/#invoices`);
  await page.getByText("/mo from ").first().waitFor({ timeout: 60_000 });
  await page.screenshot({ path: path.join(OUT, "I-dashboard.png"), fullPage: true });
  const txt = await page.locator("body").innerText();
  await ctx.close();
  must(/\/mo from /.test(txt), "no subscription line in the list");
  must(!/Monthly billing not set up/.test(txt), "a paid invoice is missing its subscription");
  return "rows show Paid + “$…/mo from …”";
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed${failed.length ? " — FAILURES above" : ""}`);
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
process.exitCode = failed.length ? 1 : 0;
