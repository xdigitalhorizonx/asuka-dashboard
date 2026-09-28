import {
  deleteObjects,
  listObjects,
  ObjectExistsError,
  putObject,
  randomId,
  readObjectJson,
  ROOT,
  type StoredObject,
} from "../blobstore";
import { deriveInvoice, round2, sumLines, type Invoice, type InvoiceDoc, type InvoicePayment } from "./types";

/**
 * Invoice storage. Nothing is ever overwritten:
 *   invoices/<id>/doc-000001.json   one file per version (edits and voids add a version)
 *   invoices/<id>/pay-<pi>.json     one file per successful card payment
 *   invoices/<id>/pi-<pi>.json      PaymentIntents started for the invoice (for reuse / reconciliation)
 *   invoice-numbers/<n>.json        claim for invoice number DH-<n> (unique by construction).
 *                                   It holds no invoice id: these paths are sequential, and the
 *                                   24-char id is the only secret guarding a public invoice link.
 * The current invoice = highest doc version + every payment file. Writing version N+1
 * with overwrite disabled doubles as optimistic locking: two concurrent edits cannot
 * both win.
 */

export const INVOICES_PREFIX = `${ROOT}/invoices/`;
const NUMBERS_PREFIX = `${ROOT}/invoice-numbers/`;
export const PROPOSALS_PREFIX = `${ROOT}/proposals/`;
const FIRST_NUMBER = 1001;
const ID_RE = /^[A-Za-z0-9]{24}$/;

export function isInvoiceId(id: string): boolean {
  return ID_RE.test(id);
}

export class InvoiceConflictError extends Error {
  constructor() {
    super("This invoice changed since you opened it — reload and try again.");
    this.name = "InvoiceConflictError";
  }
}

export interface PaymentIntentRecord {
  paymentIntentId: string;
  createdAt: string;
}

interface InvoiceFiles {
  docs: StoredObject[];
  pays: StoredObject[];
  pis: StoredObject[];
}

/** Immutable JSON never changes once written, so each instance can cache it forever. */
const jsonCache = new Map<string, unknown>();
async function readCached<T>(obj: StoredObject): Promise<T | null> {
  if (jsonCache.has(obj.pathname)) return jsonCache.get(obj.pathname) as T;
  const v = await readObjectJson<T>(obj);
  if (v !== null) {
    if (jsonCache.size > 2000) jsonCache.clear();
    jsonCache.set(obj.pathname, v);
  }
  return v;
}

const docVersion = (pathname: string) => Number(/\/doc-(\d+)\.json$/.exec(pathname)?.[1] ?? 0);
const docPath = (id: string, v: number) => `${INVOICES_PREFIX}${id}/doc-${String(v).padStart(6, "0")}.json`;

function group(objs: StoredObject[]): Map<string, InvoiceFiles> {
  const byId = new Map<string, InvoiceFiles>();
  for (const o of objs) {
    const m = /^asuka-command-center\/invoices\/([A-Za-z0-9]{24})\/(doc|pay|pi)-[^/]+\.json$/.exec(o.pathname);
    if (!m) continue;
    const f = byId.get(m[1]) ?? { docs: [], pays: [], pis: [] };
    (m[2] === "doc" ? f.docs : m[2] === "pay" ? f.pays : f.pis).push(o);
    byId.set(m[1], f);
  }
  return byId;
}

async function assemble(files: InvoiceFiles): Promise<{ invoice: Invoice; pis: PaymentIntentRecord[] } | null> {
  const latest = files.docs.slice().sort((a, b) => docVersion(b.pathname) - docVersion(a.pathname))[0];
  if (!latest) return null;
  const doc = await readCached<InvoiceDoc>(latest);
  if (!doc) return null;
  const payments = (await Promise.all(files.pays.map((p) => readCached<InvoicePayment>(p)))).filter((p): p is InvoicePayment => !!p);
  const pis = (await Promise.all(files.pis.map((p) => readCached<PaymentIntentRecord>(p)))).filter((p): p is PaymentIntentRecord => !!p);
  return { invoice: deriveInvoice(doc, payments), pis: pis.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) };
}

export async function listInvoices(): Promise<Invoice[]> {
  const byId = group(await listObjects(INVOICES_PREFIX));
  const all = await Promise.all([...byId.values()].map(assemble));
  return all
    .filter((x): x is NonNullable<typeof x> => !!x)
    .map((x) => x.invoice)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function getInvoiceWithIntents(id: string): Promise<{ invoice: Invoice; pis: PaymentIntentRecord[] } | null> {
  if (!isInvoiceId(id)) return null;
  const files = group(await listObjects(`${INVOICES_PREFIX}${id}/`)).get(id);
  return files ? assemble(files) : null;
}

export async function getInvoice(id: string): Promise<Invoice | null> {
  return (await getInvoiceWithIntents(id))?.invoice ?? null;
}

async function claimNumber(): Promise<string> {
  const used = (await listObjects(NUMBERS_PREFIX))
    .map((o) => Number(/\/(\d+)\.json$/.exec(o.pathname)?.[1] ?? 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  let n = Math.max(FIRST_NUMBER - 1, ...used) + 1;
  for (let attempt = 0; attempt < 25; attempt++, n++) {
    try {
      await putObject(`${NUMBERS_PREFIX}${n}.json`, JSON.stringify({ claimedAt: new Date().toISOString() }), { contentType: "application/json" });
      return `DH-${n}`;
    } catch (err) {
      if (!(err instanceof ObjectExistsError)) throw err;
    }
  }
  throw new Error("could not allocate an invoice number");
}

export type InvoiceInput = Omit<InvoiceDoc, "id" | "number" | "version" | "voided" | "total" | "createdAt" | "updatedAt">;

function finalize(input: InvoiceInput): Omit<InvoiceInput, "lines"> & { lines: InvoiceInput["lines"]; total: number } {
  const lines = input.lines.map((l) => ({ ...l, amount: round2(l.amount) }));
  return { ...input, lines, total: sumLines(lines) };
}

export async function createInvoice(input: InvoiceInput): Promise<Invoice> {
  const id = randomId(24);
  const number = await claimNumber();
  const now = new Date().toISOString();
  const doc: InvoiceDoc = { ...finalize(input), id, number, version: 1, voided: false, createdAt: now, updatedAt: now };
  await putObject(docPath(id, 1), JSON.stringify(doc), { contentType: "application/json" });
  jsonCache.set(docPath(id, 1), doc);
  return deriveInvoice(doc, []);
}

/** Write the next version. `expectedVersion` guards against editing a copy someone else already changed. */
export async function saveVersion(current: Invoice, next: Partial<InvoiceInput> & { voided?: boolean }, expectedVersion: number): Promise<Invoice> {
  if (current.version !== expectedVersion) throw new InvoiceConflictError();
  const base: InvoiceInput = {
    issueDate: current.issueDate,
    dueDate: current.dueDate,
    client: current.client,
    project: current.project,
    lines: current.lines,
    cardFeePercent: current.cardFeePercent,
    notes: current.notes,
    ...(current.source ? { source: current.source } : {}),
  };
  const { voided, ...fields } = next;
  const merged = finalize({ ...base, ...fields });
  const doc: InvoiceDoc = {
    ...merged,
    id: current.id,
    number: current.number,
    version: current.version + 1,
    voided: voided ?? current.voided,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  try {
    await putObject(docPath(current.id, doc.version), JSON.stringify(doc), { contentType: "application/json" });
  } catch (err) {
    if (err instanceof ObjectExistsError) throw new InvoiceConflictError();
    throw err;
  }
  jsonCache.set(docPath(current.id, doc.version), doc);
  return deriveInvoice(doc, current.payments);
}

/** Idempotent: the same PaymentIntent is recorded once however many times Stripe or the page reports it. */
export async function recordPayment(invoiceId: string, payment: InvoicePayment): Promise<boolean> {
  const p = `${INVOICES_PREFIX}${invoiceId}/pay-${payment.paymentIntentId}.json`;
  try {
    await putObject(p, JSON.stringify(payment), { contentType: "application/json" });
    jsonCache.set(p, payment);
    return true;
  } catch (err) {
    if (err instanceof ObjectExistsError) return false;
    throw err;
  }
}

export async function recordPaymentIntent(invoiceId: string, paymentIntentId: string): Promise<void> {
  const rec: PaymentIntentRecord = { paymentIntentId, createdAt: new Date().toISOString() };
  const p = `${INVOICES_PREFIX}${invoiceId}/pi-${paymentIntentId}.json`;
  try {
    await putObject(p, JSON.stringify(rec), { contentType: "application/json" });
    jsonCache.set(p, rec);
  } catch (err) {
    if (!(err instanceof ObjectExistsError)) throw err;
  }
}

/** Only an invoice nobody has paid can be deleted; its number is never reused. */
export async function deleteInvoice(inv: Invoice): Promise<void> {
  if (inv.payments.length) throw new Error("This invoice has payments — void it instead of deleting it.");
  const objs = await listObjects(`${INVOICES_PREFIX}${inv.id}/`);
  await deleteObjects(objs);
  for (const o of objs) jsonCache.delete(o.pathname);
}
