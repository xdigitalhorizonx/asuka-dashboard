/**
 * Invoice core checks — money math, credit-card fee rules, input validation, versioned
 * storage and idempotent payment records — against the local file-storage backend in a
 * throwaway directory (never the live Blob store).
 *
 *   npx tsx scripts/test-invoice-core.mts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const work = mkdtempSync(path.join(tmpdir(), "invoice-core-"));
process.chdir(work);
delete process.env.BLOB_READ_WRITE_TOKEN;
// Surcharging on (2.9%), as it will be once the 30-day Stripe notice has run; the
// "surcharge switch" check below covers the default (unset = off).
process.env.INVOICE_CARD_FEE_PERCENT = "2.9";

let passed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n`, err);
    process.exitCode = 1;
  }
}

const types = await import("../src/lib/invoice/types");
const { validateInvoiceInput, InvoiceInputError, cardFeeCeiling, defaultCardFeePercent, effectiveCardFeePercent } = await import("../src/lib/invoice/validate");
const store = await import("../src/lib/invoice/store");
const { quoteFor, paymentFromIntent, paymentsStatus, savesCard, missingSubscriptions, billsGroup } = await import("../src/lib/invoice/payments");
const { addInvoiceTransaction } = await import("../src/lib/invoice/customers");
const blob = await import("../src/lib/blobstore");

const lines = [
  { id: "l1", name: "Domain Transfer", description: "", type: "One-Time", recurring: null, amount: 0, zeroLabel: "FREE", note: "" },
  { id: "l2", name: "Website Design & Online Ordering Build-Out", description: "Custom platform", type: "One-Time", recurring: null, amount: 2000, zeroLabel: "", note: "" },
  { id: "l3", name: "SEO & GEO Initial Build-Out", description: "", type: "One-Time", recurring: null, amount: 300, zeroLabel: "", note: "" },
  { id: "l4", name: "GBP Optimization & NAP Audit", description: "", type: "One-Time", recurring: null, amount: 100, zeroLabel: "", note: "" },
  { id: "l5", name: "Hosting, Technical Maintenance & Security", description: "", type: "Monthly", recurring: { interval: "month" as const, amount: 94.99 }, amount: 94.99, zeroLabel: "", note: "First month · then $94.99/mo" },
];
const input = {
  issueDate: "2026-09-28",
  dueDate: "",
  client: { name: "Example Bakery Co.", email: "owner@example.com", phone: "", address: "" },
  project: "Rebuild the site.",
  lines,
  cardFeePercent: 2.9,
  notes: "",
};

await check("money: rounding, cents, sums, formatting", () => {
  assert.equal(types.round2(0.1 + 0.2), 0.3);
  assert.equal(types.round2(1.005), 1.01);
  assert.equal(types.toCents(2494.99), 249499);
  assert.equal(types.toCents(2569.84), 256984);
  assert.equal(types.sumLines(lines), 2494.99);
  assert.equal(types.fmtMoney(2494.99), "$2,494.99");
  assert.equal(types.fmtMoney(0), "$0.00");
  assert.equal(types.fmtLongDate("2026-09-18"), "September 18, 2026");
});

await check("card fee: 3% of $2,494.99 is $74.85, credit only", () => {
  assert.equal(types.cardFee(2494.99, 3), 74.85);
  assert.equal(types.cardFee(2494.99, 0), 0);
  assert.equal(types.cardFee(0, 3), 0);
  assert.equal(types.feeAppliesTo("credit"), true);
  for (const f of ["debit", "prepaid", "unknown", "", null, undefined]) assert.equal(types.feeAppliesTo(f as string), false);
});

await check("quoteFor: credit adds the 2.9% surcharge, debit/prepaid/unknown don't, 0% never", () => {
  const inv = types.deriveInvoice({ ...input, id: "x".repeat(24), number: "DH-1", version: 1, voided: false, total: 2494.99, createdAt: "", updatedAt: "" }, []);
  assert.deepEqual(quoteFor(inv, "credit"), { base: 2494.99, fee: 72.35, total: 2567.34, feePercent: 2.9 });
  for (const f of ["debit", "prepaid", "unknown"]) assert.deepEqual(quoteFor(inv, f), { base: 2494.99, fee: 0, total: 2494.99, feePercent: 0 });
  const saved3 = { ...inv, cardFeePercent: 3 };
  assert.deepEqual(quoteFor(saved3, "credit"), { base: 2494.99, fee: 72.35, total: 2567.34, feePercent: 2.9 }, "an invoice saved at 3% pays the 2.9% ceiling");
  const noFee = { ...inv, cardFeePercent: 0 };
  assert.deepEqual(quoteFor(noFee, "credit"), { base: 2494.99, fee: 0, total: 2494.99, feePercent: 0 });
});

await check("deriveInvoice: fee never counts toward the balance; paid/void/paidAt", () => {
  const doc = { ...input, id: "y".repeat(24), number: "DH-2", version: 1, voided: false, total: 2494.99, createdAt: "", updatedAt: "" };
  const open = types.deriveInvoice(doc, []);
  assert.equal(open.status, "open");
  assert.equal(open.balance, 2494.99);
  const paid = types.deriveInvoice(doc, [{ paymentIntentId: "pi_1", amount: 2569.84, fee: 74.85, paidAt: "2026-09-29T10:00:00.000Z" }]);
  assert.equal(paid.paid, 2494.99);
  assert.equal(paid.balance, 0);
  assert.equal(paid.status, "paid");
  assert.equal(paid.paidAt, "2026-09-29T10:00:00.000Z");
  const partial = types.deriveInvoice(doc, [{ paymentIntentId: "pi_2", amount: 1000, fee: 0, paidAt: "2026-09-29T10:00:00.000Z" }]);
  assert.equal(partial.status, "open");
  assert.equal(partial.balance, 1494.99);
  assert.equal(types.deriveInvoice({ ...doc, voided: true }, []).status, "void");
});

await check("validation: rounds, trims, requires name + an amount, caps the surcharge at 2.9%", () => {
  const v = validateInvoiceInput({ ...input, lines: [...lines, { ...lines[2], id: "l9", amount: "1,234.567" }], client: { name: "  Example  ", email: "" } });
  assert.equal(v.client.name, "Example");
  assert.equal(v.lines.at(-1)!.amount, 1234.57);
  assert.equal(v.lines[0].zeroLabel, "FREE");
  const bad = (patch: Record<string, unknown>, re: RegExp) =>
    assert.throws(() => validateInvoiceInput({ ...input, ...patch }), (e: unknown) => e instanceof InvoiceInputError && re.test((e as Error).message));
  bad({ client: { name: "" } }, /client name/);
  bad({ client: { name: "A", email: "nope" } }, /email/);
  bad({ lines: [] }, /at least one line/);
  bad({ lines: [{ ...lines[0] }] }, /total is \$0/);
  bad({ lines: [{ ...lines[1], amount: -5 }] }, /between \$0/);
  bad({ cardFeePercent: 4 }, /between 0% and 2.9%/);
  bad({ cardFeePercent: 3 }, /between 0% and 2.9%/);
  bad({ issueDate: "09/28/2026" }, /Issue date/);
  bad({ dueDate: "2026-01-01" }, /before the issue date/);
  const noSource = validateInvoiceInput({ ...input, source: { fileName: "x.pdf", path: "../../etc/passwd", proposalDate: "" } });
  assert.equal(noSource.source, undefined, "a source outside the proposals prefix is dropped");
  const withSource = validateInvoiceInput({ ...input, source: { fileName: "p.pdf", path: `${store.PROPOSALS_PREFIX}abc/p.pdf`, proposalDate: "September 18, 2026" } });
  assert.equal(withSource.source?.path, `${store.PROPOSALS_PREFIX}abc/p.pdf`);
});

let firstId = "";
await check("store: create numbers DH-1001, DH-1002; ids are 24-char random", async () => {
  const a = await store.createInvoice(validateInvoiceInput(input));
  const b = await store.createInvoice(validateInvoiceInput({ ...input, client: { name: "Second Client" } }));
  assert.equal(a.number, "DH-1001");
  assert.equal(b.number, "DH-1002");
  assert.ok(store.isInvoiceId(a.id) && store.isInvoiceId(b.id) && a.id !== b.id);
  assert.equal(a.total, 2494.99);
  const listed = await store.listInvoices();
  assert.deepEqual(listed.map((i) => i.number).sort(), ["DH-1001", "DH-1002"]);
  firstId = a.id;
});

await check("store: edits add versions; a stale edit is refused (optimistic lock)", async () => {
  const cur = (await store.getInvoice(firstId))!;
  const v2 = await store.saveVersion(cur, { notes: "updated" }, 1);
  assert.equal(v2.version, 2);
  assert.equal(v2.notes, "updated");
  await assert.rejects(() => store.saveVersion(cur, { notes: "stale" }, 1), store.InvoiceConflictError);
  const again = (await store.getInvoice(firstId))!;
  assert.equal(again.version, 2);
  assert.equal(again.notes, "updated");
  assert.equal(again.number, "DH-1001", "number survives edits");
});

await check("store: payment recorded once (idempotent), invoice flips to paid, delete refused", async () => {
  const pay = { paymentIntentId: "pi_test_123", chargeId: "ch_test_123", amount: 2569.84, fee: 74.85, brand: "visa", last4: "4242", funding: "credit", paidAt: "2026-09-29T17:00:00.000Z" };
  assert.equal(await store.recordPayment(firstId, pay), true);
  assert.equal(await store.recordPayment(firstId, pay), false);
  const inv = (await store.getInvoice(firstId))!;
  assert.equal(inv.payments.length, 1);
  assert.equal(inv.status, "paid");
  assert.equal(inv.balance, 0);
  await assert.rejects(() => store.deleteInvoice(inv), /void it instead/);
});

await check("store: unpaid invoice deletes cleanly; unknown ids are not found", async () => {
  const b = (await store.listInvoices()).find((i) => i.number === "DH-1002")!;
  await store.deleteInvoice(b);
  assert.equal(await store.getInvoice(b.id), null);
  assert.equal(await store.getInvoice("not-a-valid-id"), null);
  const c = await store.createInvoice(validateInvoiceInput({ ...input, client: { name: "Third" } }));
  assert.equal(c.number, "DH-1003", "numbers are never reused, even after a delete");
});

await check("blobstore: create-only writes refuse overwrite; unsafe paths refused", async () => {
  const p = `${blob.ROOT}/test/once.json`;
  await blob.putObject(p, "{}", { contentType: "application/json" });
  await assert.rejects(() => blob.putObject(p, "{}", { contentType: "application/json" }), blob.ObjectExistsError);
  await assert.rejects(() => blob.putObject(`${blob.ROOT}/../escape.txt`, "x", { contentType: "text/plain" }), /unsafe/);
  await assert.rejects(() => blob.putObject(`elsewhere/x.txt`, "x", { contentType: "text/plain" }), /unsafe/);
  const id = blob.randomId(24);
  assert.match(id, /^[A-Za-z0-9]{24}$/);
});

await check("paymentFromIntent: amount, fee from metadata, card details, receipt", () => {
  const pi = { id: "pi_1", amount: 256984, amount_received: 256984, created: 1790700000, livemode: false, metadata: { fee_cents: "7485" } };
  const ch = { id: "ch_1", created: 1790700005, receipt_url: "https://pay.stripe.com/receipts/x", payment_method_details: { card: { brand: "visa", last4: "4242", funding: "credit" } } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = paymentFromIntent(pi as any, ch as any);
  assert.equal(p.amount, 2569.84);
  assert.equal(p.fee, 74.85);
  assert.equal(p.chargeId, "ch_1");
  assert.equal(p.brand, "visa");
  assert.equal(p.funding, "credit");
  assert.equal(p.receiptUrl, "https://pay.stripe.com/receipts/x");
  assert.equal(p.paidAt, new Date(1790700005 * 1000).toISOString());
});

await check("customers tab: invoice payment filed under the client once, by charge id", () => {
  const inv = types.deriveInvoice({ ...input, id: "z".repeat(24), number: "DH-7", version: 1, voided: false, total: 2494.99, createdAt: "", updatedAt: "" }, []);
  const pay = { paymentIntentId: "pi_9", chargeId: "ch_9", amount: 2569.84, fee: 74.85, paidAt: "2026-09-29T17:00:00.000Z" };
  const customers: Parameters<typeof addInvoiceTransaction>[0] = [];
  assert.equal(addInvoiceTransaction(customers, inv, pay), true);
  assert.equal(customers.length, 1);
  assert.equal(customers[0].company, "Example Bakery Co.");
  assert.equal(customers[0].transactions[0].id, "t_ch_9");
  assert.match(customers[0].transactions[0].memo, /Invoice DH-7 · incl\. \$74\.85 card fee/);
  assert.equal(addInvoiceTransaction(customers, inv, pay), false, "replay adds nothing");
  const existing = [{ ...customers[0], id: "c_existing", transactions: [] }];
  assert.equal(addInvoiceTransaction(existing, inv, { ...pay, chargeId: "ch_10", paymentIntentId: "pi_10" }), true);
  assert.equal(existing.length, 1, "matched the existing customer by email instead of creating one");
});

await check("customers tab: the Stripe feed keeps an invoice payment's memo (and its fee note)", async () => {
  const { applyStripeCharge, buildIndex } = await import("../src/lib/stripe");
  const inv = types.deriveInvoice({ ...input, id: "m".repeat(24), number: "DH-11", version: 1, voided: false, total: 2494.99, createdAt: "", updatedAt: "" }, []);
  const customers: Parameters<typeof addInvoiceTransaction>[0] = [];
  addInvoiceTransaction(customers, inv, { paymentIntentId: "pi_m", chargeId: "ch_m", amount: 2567.34, fee: 72.35, paidAt: "2026-09-29T17:00:00.000Z" });
  const ch = {
    id: "ch_m", amount: 256734, amount_refunded: 0, currency: "usd", created: Date.parse("2026-09-29T17:00:00.000Z") / 1000,
    status: "succeeded", paid: true, refunded: false, description: "Invoice DH-11 · Example Bakery Co.", customer: null, receipt_email: null, billing_details: null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(applyStripeCharge(customers, buildIndex(customers), ch as any, "2026-09-29T17:01:00.000Z"), "unchanged");
  assert.equal(customers[0].transactions[0].memo, "Invoice DH-11 · incl. $72.35 card fee");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(applyStripeCharge(customers, buildIndex(customers), { ...ch, amount_refunded: 1000 } as any, "2026-09-30T17:01:00.000Z"), "updated");
  assert.equal(customers[0].transactions[0].memo, "Invoice DH-11 · incl. $72.35 card fee · partial refund 10.00");
  assert.equal(customers[0].transactions[0].amount, 2557.34);

  // A deposit's memo names the part, and the Stripe feed keeps that too.
  addInvoiceTransaction(customers, inv, { paymentIntentId: "pi_m2", chargeId: "ch_m2", amount: 1332.54, fee: 37.55, paidAt: "2026-09-29T18:00:00.000Z", part: "deposit" });
  const memo2 = () => customers[0].transactions.find((t) => t.stripeId === "ch_m2")?.memo;
  assert.equal(memo2(), "Invoice DH-11 deposit · incl. $37.55 card fee");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(applyStripeCharge(customers, buildIndex(customers), { ...ch, id: "ch_m2", amount: 133254, amount_refunded: 1000 } as any, "2026-09-30T18:01:00.000Z"), "updated");
  assert.equal(memo2(), "Invoice DH-11 deposit · incl. $37.55 card fee · partial refund 10.00");
});

await check("recurring: one group per interval, zero prices never recur; addPeriod clamps month ends", () => {
  assert.deepEqual(
    types.recurringGroups(lines).map((g) => [g.interval, g.amount, g.lines.map((l) => l.id)]),
    [["month", 94.99, ["l5"]]]
  );
  const yearly = { ...lines[2], id: "y1", type: "Yearly", recurring: { interval: "year" as const, amount: 120 }, amount: 120 };
  const zero = { ...lines[4], id: "z1", recurring: { interval: "month" as const, amount: 0 } };
  const second = { ...lines[4], id: "l6", recurring: { interval: "month" as const, amount: 25 }, amount: 25 };
  assert.deepEqual(
    types.recurringGroups([...lines, yearly, zero, second]).map((g) => [g.interval, g.amount, g.lines.length]),
    [["month", 119.99, 2], ["year", 120, 1]]
  );
  assert.deepEqual(types.recurringGroups(lines.filter((l) => !l.recurring)), []);
  const at = (iso: string, i: "month" | "year") => types.addPeriod(new Date(iso), i).toISOString();
  assert.equal(at("2026-09-28T23:02:05.000Z", "month"), "2026-10-28T23:02:05.000Z");
  assert.equal(at("2026-01-31T15:00:00.000Z", "month"), "2026-02-28T15:00:00.000Z");
  assert.equal(at("2026-03-31T10:00:00.000Z", "month"), "2026-04-30T10:00:00.000Z");
  assert.equal(at("2026-12-15T00:00:00.000Z", "month"), "2027-01-15T00:00:00.000Z");
  assert.equal(at("2028-02-29T12:00:00.000Z", "year"), "2029-02-28T12:00:00.000Z");
});

await check("subscriptions: only a paid invoice with recurring lines needs one, one per interval", () => {
  assert.equal(savesCard({ lines, payments: [] }), true);
  assert.equal(savesCard({ lines: lines.filter((l) => !l.recurring), payments: [] }), false);
  const doc = { ...input, id: "s".repeat(24), number: "DH-8", version: 1, voided: false, total: 2494.99, createdAt: "", updatedAt: "" };
  const pay = { paymentIntentId: "pi_s", amount: 2494.99, fee: 0, paidAt: "2026-09-29T17:00:00.000Z" };
  assert.equal(missingSubscriptions(types.deriveInvoice(doc, [])).length, 1, "open invoices report what they will need");
  const paid = types.deriveInvoice(doc, [pay]);
  assert.deepEqual(missingSubscriptions(paid).map((g) => g.interval), ["month"]);
  const sub = { subscriptionId: "sub_1", customerId: "cus_1", interval: "month" as const, amount: 94.99, startsAt: "2026-10-29T17:00:00.000Z", createdAt: "2026-09-29T17:00:01.000Z" };
  assert.deepEqual(missingSubscriptions(types.deriveInvoice(doc, [pay], [sub])), []);
});

await check("subscriptions: first charge one period after payment (pulled in only past Stripe's limit); a hand-made match is adopted", () => {
  const at = (paid: string, now: string, i: "month" | "year" = "month") => types.firstChargeAt(new Date(paid), i, new Date(now)).toISOString();
  assert.equal(at("2026-09-28T23:02:05.000Z", "2026-09-28T23:02:09.000Z"), "2026-10-28T23:02:05.000Z");
  assert.equal(at("2026-09-28T23:02:05.000Z", "2026-09-29T10:00:00.000Z"), "2026-10-28T23:02:05.000Z", "a later retry keeps the payment's date");
  assert.equal(at("2026-10-30T18:00:00.000Z", "2026-10-31T09:00:00.000Z"), "2026-11-30T08:59:00.000Z", "paid Oct 30, retried Oct 31: just under Stripe's Nov 30 09:00 limit");
  assert.equal(at("2028-02-29T12:00:00.000Z", "2028-02-29T12:00:03.000Z", "year"), "2029-02-28T12:00:00.000Z");

  const g = types.recurringGroups(lines)[0];
  const paidMs = Date.parse("2026-09-29T17:00:00.000Z");
  const item = (cents: number, interval = "month") => ({ price: { unit_amount: cents, recurring: { interval } }, quantity: 1 });
  const sub = (o: Record<string, unknown> = {}) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ status: "active", created: Date.parse("2026-09-30T00:00:00.000Z") / 1000, metadata: {}, items: { data: [item(9499)] }, ...o }) as any;
  assert.equal(billsGroup(sub(), g, "inv1", paidMs), true, "same interval + amount, started after the payment");
  assert.equal(billsGroup(sub({ metadata: { invoice_id: "inv1" } }), g, "inv1", paidMs), true);
  assert.equal(billsGroup(sub({ status: "canceled" }), g, "inv1", paidMs), false);
  assert.equal(billsGroup(sub({ metadata: { invoice_id: "other" } }), g, "inv1", paidMs), false, "another invoice's subscription");
  assert.equal(billsGroup(sub({ created: Date.parse("2026-01-01T00:00:00.000Z") / 1000 }), g, "inv1", paidMs), false, "an older retainer isn't adopted");
  assert.equal(billsGroup(sub({ items: { data: [item(5000)] } }), g, "inv1", paidMs), false);
  assert.equal(billsGroup(sub({ items: { data: [item(9499, "year")] } }), g, "inv1", paidMs), false);
});

await check("store: subscription recorded once and served with the invoice, across versions", async () => {
  const sub = { subscriptionId: "sub_test_1", customerId: "cus_test_1", interval: "month" as const, amount: 94.99, startsAt: "2026-10-29T17:00:00.000Z", createdAt: "2026-09-29T17:00:01.000Z", livemode: false };
  assert.equal(await store.recordSubscription(firstId, sub), true);
  assert.equal(await store.recordSubscription(firstId, sub), false, "a replay records nothing");
  const inv = (await store.getInvoice(firstId))!;
  assert.deepEqual(inv.subscriptions, [sub]);
  const voided = await store.saveVersion(inv, { voided: true }, inv.version);
  assert.deepEqual(voided.subscriptions, [sub], "a new version keeps the subscription");
  assert.deepEqual((await store.getInvoice(firstId))!.subscriptions, [sub]);
});

await check("saved card: the Stripe customer id is kept on the payment and linked on the Customers tab", () => {
  const pi = { id: "pi_c", amount: 1000, amount_received: 1000, created: 1790700000, livemode: false, metadata: {}, customer: "cus_saved" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = paymentFromIntent(pi as any, null);
  assert.equal(p.customerId, "cus_saved");
  const inv = types.deriveInvoice({ ...input, id: "c".repeat(24), number: "DH-9", version: 1, voided: false, total: 2494.99, createdAt: "", updatedAt: "" }, []);
  const fresh: Parameters<typeof addInvoiceTransaction>[0] = [];
  addInvoiceTransaction(fresh, inv, { ...p, chargeId: "ch_c1" });
  assert.equal(fresh[0].stripeCustomerId, "cus_saved");
  const known = [{ ...fresh[0], id: "c_known", stripeCustomerId: undefined, transactions: [] }];
  addInvoiceTransaction(known, inv, { ...p, chargeId: "ch_c2" });
  assert.equal(known[0].stripeCustomerId, "cus_saved", "filled in when the match had none");
});

await check("surcharge switch: unset = off (nothing charged or allowed), never above 3%", () => {
  const keep = process.env.INVOICE_CARD_FEE_PERCENT;
  try {
    delete process.env.INVOICE_CARD_FEE_PERCENT;
    assert.equal(cardFeeCeiling(), 0);
    assert.equal(defaultCardFeePercent(), 0);
    const inv = types.deriveInvoice({ ...input, cardFeePercent: 3, id: "o".repeat(24), number: "DH-10", version: 1, voided: false, total: 2494.99, createdAt: "", updatedAt: "" }, []);
    assert.equal(effectiveCardFeePercent(inv), 0);
    assert.deepEqual(quoteFor(inv, "credit"), { base: 2494.99, fee: 0, total: 2494.99, feePercent: 0 }, "a saved fee is not charged while surcharging is off");
    assert.throws(() => validateInvoiceInput({ ...input, cardFeePercent: 1 }), /Card fees are off/);
    assert.equal(validateInvoiceInput({ ...input, cardFeePercent: 0 }).cardFeePercent, 0);
    for (const [env, want] of [["3", 3], ["4", 3], ["2.5", 2.5], ["-1", 0], ["abc", 0]] as const) {
      process.env.INVOICE_CARD_FEE_PERCENT = env;
      assert.equal(cardFeeCeiling(), want, `INVOICE_CARD_FEE_PERCENT=${env}`);
    }
  } finally {
    process.env.INVOICE_CARD_FEE_PERCENT = keep;
  }
});

await check("discount: percent or dollars off the lines, validated, saved, cleared by an edit, fee on the discounted total", async () => {
  assert.deepEqual(types.invoiceTotals(lines, { kind: "percent", value: 10 }), { subtotal: 2494.99, discount: 249.5, total: 2245.49 });
  assert.deepEqual(types.invoiceTotals(lines, { kind: "amount", value: 500 }), { subtotal: 2494.99, discount: 500, total: 1994.99 });
  assert.deepEqual(types.invoiceTotals(lines, { kind: "amount", value: 9999 }), { subtotal: 2494.99, discount: 2494.99, total: 0 });
  assert.deepEqual(types.invoiceTotals(lines), { subtotal: 2494.99, discount: 0, total: 2494.99 });
  assert.equal(types.discountLabel({ kind: "percent", value: 12.5 }), "Discount (12.5%)");

  const v = (d: unknown) => validateInvoiceInput({ ...input, discount: d });
  assert.deepEqual(v({ kind: "percent", value: "10%" }).discount, { kind: "percent", value: 10 });
  assert.deepEqual(v({ kind: "amount", value: "$1,000" }).discount, { kind: "amount", value: 1000 });
  assert.equal(v({ kind: "amount", value: 0 }).discount, undefined, "0 = no discount");
  assert.equal(v(null).discount, undefined);
  const bad = (d: unknown, re: RegExp) => assert.throws(() => v(d), (e: unknown) => e instanceof InvoiceInputError && re.test((e as Error).message));
  bad({ kind: "percent", value: 150 }, /over 100%/);
  bad({ kind: "amount", value: 3000 }, /more than the lines' \$2,494\.99/);
  bad({ kind: "percent", value: -5 }, /0 or more/);
  bad({ kind: "percent", value: 100 }, /takes the total to \$0/);

  const made = await store.createInvoice(v({ kind: "percent", value: 10 }));
  assert.equal(made.total, 2245.49);
  assert.equal(made.balance, 2245.49);
  assert.deepEqual(made.discount, { kind: "percent", value: 10 });
  assert.deepEqual(quoteFor(made, "credit"), { base: 2245.49, fee: 65.12, total: 2310.61, feePercent: 2.9 }, "fee on the discounted total");
  const voided = await store.saveVersion(made, { voided: true }, made.version);
  assert.deepEqual(voided.discount, { kind: "percent", value: 10 }, "void keeps the discount");
  const edited = await store.saveVersion(voided, validateInvoiceInput(input), voided.version);
  assert.equal(edited.discount, undefined, "an edit without a discount clears it");
  assert.equal(edited.total, 2494.99);
});

await check("deposit: 50% of the one-time items + the first month now, the rest later; discount spread; validation; store", async () => {
  // One-time: 0 + 2,000 + 300 + 100 = 2,400. Monthly first month: 94.99.
  assert.deepEqual(types.depositSplit(lines, undefined, 50), { now: 1294.99, later: 1200 });
  assert.deepEqual(types.depositSplit(lines, { kind: "percent", value: 10 }, 50), { now: 1165.49, later: 1080 }, "10% off both parts: half of $2,160 later");
  const amt = types.depositSplit(lines, { kind: "amount", value: 100 }, 50)!;
  assert.equal(types.round2(amt.now + amt.later), 2394.99, "$100 off: the parts still add up to the total");
  assert.deepEqual(types.depositSplit(lines.filter((l) => !l.recurring), undefined, 50), { now: 1200, later: 1200 });
  const odd = types.depositSplit([{ amount: 100.01, recurring: null }], undefined, 50)!;
  assert.ok(types.round2(odd.now + odd.later) === 100.01 && Math.abs(odd.now - odd.later) <= 0.011, `odd cent: ${JSON.stringify(odd)}`);
  assert.equal(types.depositSplit(lines.filter((l) => l.recurring), undefined, 50), null, "nothing one-time to split");
  assert.equal(types.depositSplit(lines, undefined, undefined), null);
  assert.equal(types.depositSplit(lines, undefined, 100), null);
  assert.equal(types.depositWording({ percent: 50, later: 1200 }, lines), "50% deposit on the one-time items, plus the first month. The other $1,200.00 is due later.");
  assert.equal(types.depositWording({ percent: 50, later: 1200 }, lines.filter((l) => !l.recurring)), "50% deposit on the one-time items. The other $1,200.00 is due later.");
  const freeMonth = lines.map((l) => (l.recurring ? { ...l, amount: 0 } : l));
  assert.deepEqual(types.firstPeriods(freeMonth), [], "a free first month isn't billed now");
  assert.equal(types.depositWording({ percent: 50, later: 1200 }, freeMonth), "50% deposit on the one-time items. The other $1,200.00 is due later.");
  const yearly = lines.map((l) => (l.recurring ? { ...l, recurring: { interval: "year" as const, amount: 900 }, amount: 900 } : l));
  assert.deepEqual(types.firstPeriods(yearly), ["year"]);
  assert.match(types.depositWording({ percent: 50, later: 1200 }, yearly), /plus the first year\./);

  const v = (o: Record<string, unknown>) => validateInvoiceInput({ ...input, ...o });
  assert.equal(v({ depositPercent: 50 }).depositPercent, 50);
  assert.equal(v({}).depositPercent, undefined);
  assert.equal(v({ depositPercent: null }).depositPercent, undefined);
  const bad = (o: Record<string, unknown>, re: RegExp) => assert.throws(() => v(o), (e: unknown) => e instanceof InvoiceInputError && re.test((e as Error).message));
  bad({ depositPercent: 50, lines: lines.filter((l) => l.recurring) }, /no one-time items/);
  bad({ depositPercent: 150 }, /1 to 99/);
  bad({ depositPercent: 12.5 }, /whole percent/);
  bad({ depositPercent: 50, lines: [{ ...lines[1], amount: 0.9 }] }, /at least \$0\.50/);

  const made = await store.createInvoice(v({ depositPercent: 50 }));
  assert.equal(made.depositPercent, 50);
  assert.equal(made.total, 2494.99);
  assert.deepEqual({ dueNow: made.dueNow, deposit: made.deposit }, { dueNow: 1294.99, deposit: { percent: 50, now: 1294.99, later: 1200 } });
  const voided = await store.saveVersion(made, { voided: true }, made.version);
  assert.equal(voided.depositPercent, 50, "void keeps the deposit");
  const cleared = await store.saveVersion(voided, validateInvoiceInput(input), voided.version);
  assert.equal(cleared.depositPercent, undefined, "an edit without it clears it");
  assert.equal(cleared.deposit, undefined);
  assert.equal(cleared.dueNow, 0, "still void, so nothing is due");
});

await check("deposit: the deposit saves the card and starts billing; the balance is a plain charge", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asPi = (o: object) => o as any;
  const doc = { ...input, depositPercent: 50, id: "d".repeat(24), number: "DH-13", version: 1, voided: false, total: 2494.99, createdAt: "", updatedAt: "" };
  const open = types.deriveInvoice(doc, []);
  assert.equal(open.dueNow, 1294.99);
  assert.equal(open.balance, 2494.99);
  assert.equal(types.paymentPart(open), "deposit");
  assert.equal(types.paymentPart(types.deriveInvoice({ ...doc, depositPercent: undefined }, [])), "", "plain invoices have no part");
  assert.equal(savesCard(open), true, "the deposit saves the card");
  assert.equal(types.subscriptionsDue(open), false);
  assert.deepEqual(quoteFor(open, "credit"), { base: 1294.99, fee: 37.55, total: 1332.54, feePercent: 2.9 }, "fee on the deposit only");

  const dep = { paymentIntentId: "pi_d", amount: 1332.54, fee: 37.55, paidAt: "2026-09-29T17:00:00.000Z", customerId: "cus_d", part: "deposit" as const };
  const half = types.deriveInvoice(doc, [dep]);
  assert.equal(half.status, "open");
  assert.equal(half.deposit?.paidAt, dep.paidAt);
  assert.equal(half.dueNow, 1200);
  assert.equal(half.balance, 1200);
  assert.equal(types.paymentPart(half), "balance", "the page must now show (and send) the balance");
  assert.equal(types.subscriptionsDue(half), true, "monthly billing starts with the deposit");
  assert.deepEqual(missingSubscriptions(half).map((g) => g.interval), ["month"]);
  assert.equal(savesCard(half), false, "the balance payment doesn't save the card again");
  assert.deepEqual(quoteFor(half, "credit"), { base: 1200, fee: 34.8, total: 1234.8, feePercent: 2.9 });

  const bal = { paymentIntentId: "pi_b", amount: 1234.8, fee: 34.8, paidAt: "2026-10-15T17:00:00.000Z", part: "balance" as const };
  const done = types.deriveInvoice(doc, [dep, bal]);
  assert.equal(done.status, "paid");
  assert.equal(done.paidAt, bal.paidAt);
  assert.equal(done.dueNow, 0);
  assert.equal(done.deposit?.paidAt, dep.paidAt);

  assert.equal(types.subscriptionsDue(types.deriveInvoice({ ...doc, voided: true }, [dep])), false, "a voided invoice never starts billing");
  const plain = types.deriveInvoice({ ...doc, depositPercent: undefined }, []);
  assert.equal(plain.dueNow, 2494.99);
  assert.equal(plain.deposit, undefined);

  const pi = { id: "pi_p", amount: 1000, amount_received: 1000, created: 1790700000, livemode: false, metadata: { invoice_part: "deposit" } };
  assert.equal(paymentFromIntent(asPi(pi), null).part, "deposit");
  assert.equal(paymentFromIntent(asPi({ ...pi, metadata: { invoice_part: "" } }), null).part, undefined);
});

await check("card fee on every card (INVOICE_CARD_FEE_CARDS=all): debit/prepaid/unknown pay it too; wording follows", () => {
  const keep = { pct: process.env.INVOICE_CARD_FEE_PERCENT, cards: process.env.INVOICE_CARD_FEE_CARDS };
  try {
    process.env.INVOICE_CARD_FEE_PERCENT = "3";
    const inv = types.deriveInvoice({ ...input, cardFeePercent: 3, id: "a".repeat(24), number: "DH-12", version: 1, voided: false, total: 2494.99, createdAt: "", updatedAt: "" }, []);
    assert.deepEqual(quoteFor(inv, "debit"), { base: 2494.99, fee: 0, total: 2494.99, feePercent: 0 }, "credit-only by default");
    process.env.INVOICE_CARD_FEE_CARDS = "all";
    for (const f of ["credit", "debit", "prepaid", "unknown"]) {
      assert.deepEqual(quoteFor(inv, f), { base: 2494.99, fee: 74.85, total: 2569.84, feePercent: 3 }, f);
    }
    const all = types.cardFeeWording(3, true);
    assert.equal(all.label, "Card processing fee (3%)");
    assert.match(all.note("$74.85"), /^Paying by card adds a 3% card processing fee \(\$74\.85\)/);
    assert.doesNotMatch(all.hint + all.note("$1"), /debit|not more than our cost/i);
    assert.match(types.cardFeeWording(2.9, false).hint, /not more than our cost/, "at cost: claimed");
    assert.doesNotMatch(types.cardFeeWording(3, false).hint, /not more than our cost/, "3% is over cost on large invoices: never claimed");
  } finally {
    process.env.INVOICE_CARD_FEE_PERCENT = keep.pct;
    if (keep.cards === undefined) delete process.env.INVOICE_CARD_FEE_CARDS;
    else process.env.INVOICE_CARD_FEE_CARDS = keep.cards;
  }
});

await check("payments status: key presence + live/test mismatch detection", () => {
  const keep = { sk: process.env.STRIPE_SECRET_KEY, pk: process.env.STRIPE_PUBLISHABLE_KEY };
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_x";
  assert.equal(paymentsStatus().mode, "mismatch");
  assert.equal(paymentsStatus().ready, false);
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_x";
  assert.deepEqual(paymentsStatus(), { secretKey: true, publishableKey: true, mode: "test", ready: true });
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  assert.equal(paymentsStatus().ready, false);
  if (keep.sk) process.env.STRIPE_SECRET_KEY = keep.sk;
  else delete process.env.STRIPE_SECRET_KEY;
  if (keep.pk) process.env.STRIPE_PUBLISHABLE_KEY = keep.pk;
});

process.chdir(tmpdir()); // Windows can't remove the working directory
rmSync(work, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? " — FAILURES above" : ""}`);
