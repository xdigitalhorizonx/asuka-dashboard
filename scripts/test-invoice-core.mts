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
const { validateInvoiceInput, InvoiceInputError } = await import("../src/lib/invoice/validate");
const store = await import("../src/lib/invoice/store");
const { quoteFor, paymentFromIntent, paymentsStatus } = await import("../src/lib/invoice/payments");
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
  cardFeePercent: 3,
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

await check("quoteFor: credit adds fee, debit/prepaid/unknown don't, 0% never", () => {
  const inv = types.deriveInvoice({ ...input, id: "x".repeat(24), number: "DH-1", version: 1, voided: false, total: 2494.99, createdAt: "", updatedAt: "" }, []);
  assert.deepEqual(quoteFor(inv, "credit"), { base: 2494.99, fee: 74.85, total: 2569.84, feePercent: 3 });
  for (const f of ["debit", "prepaid", "unknown"]) assert.deepEqual(quoteFor(inv, f), { base: 2494.99, fee: 0, total: 2494.99, feePercent: 0 });
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

await check("validation: rounds, trims, requires name + an amount, caps fee at 3%", () => {
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
  bad({ cardFeePercent: 4 }, /between 0% and 3%/);
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

rmSync(work, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? " — FAILURES above" : ""}`);
