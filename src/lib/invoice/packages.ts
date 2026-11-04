import { deleteObjects, listObjects, putObject, randomId, readObjectJson, ROOT } from "../blobstore";
import { InvoiceInputError, validateInvoiceInput } from "./validate";
import type { InvoiceLine } from "./types";

/**
 * Saved invoice packages: a named set of line items (plus an optional project summary and
 * notes) that one click drops into a new invoice — e.g. the flyer's "$2,495 build + $129/mo".
 * One file per package, never overwritten: invoice-packages/<id>.json. Deleting removes it.
 */

export const PACKAGES_PREFIX = `${ROOT}/invoice-packages/`;

export interface InvoicePackage {
  id: string;
  name: string;
  lines: InvoiceLine[];
  project: string;
  notes: string;
  createdAt: string;
}

const isPackageId = (id: string) => /^[A-Za-z0-9]{16}$/.test(id);
const idOf = (pathname: string) => /\/invoice-packages\/([A-Za-z0-9]{16})\.json$/.exec(pathname)?.[1] ?? "";

/** Every saved package, oldest first (the order Brandon made them). */
export async function listPackages(): Promise<InvoicePackage[]> {
  const objs = (await listObjects(PACKAGES_PREFIX)).filter((o) => idOf(o.pathname));
  const all = await Promise.all(objs.map((o) => readObjectJson<InvoicePackage>(o)));
  return all.filter((p): p is InvoicePackage => !!p && Array.isArray(p.lines)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/** Check a package the same way an invoice's lines are checked, then save it. */
export async function createPackage(raw: unknown): Promise<InvoicePackage> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim().slice(0, 80) : "";
  if (!name) throw new InvoiceInputError("Give the package a name.");
  // Reuse the invoice rules for lines (names, amounts, monthly prices) with a stand-in client.
  const checked = validateInvoiceInput({ client: { name: "package" }, issueDate: "2026-01-01", cardFeePercent: 0, lines: o.lines, project: o.project, notes: o.notes });
  const existing = await listPackages();
  if (existing.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new InvoiceInputError(`A package called “${name}” already exists — pick another name or delete that one first.`);
  if (existing.length >= 50) throw new InvoiceInputError("That's 50 packages — delete one first.");
  const pkg: InvoicePackage = { id: randomId(16), name, lines: checked.lines, project: checked.project, notes: checked.notes, createdAt: new Date().toISOString() };
  await putObject(`${PACKAGES_PREFIX}${pkg.id}.json`, JSON.stringify(pkg), { contentType: "application/json" });
  return pkg;
}

/** Delete one package; false when it was already gone. */
export async function deletePackage(id: string): Promise<boolean> {
  if (!isPackageId(id)) return false;
  const objs = (await listObjects(PACKAGES_PREFIX)).filter((o) => idOf(o.pathname) === id);
  if (!objs.length) return false;
  await deleteObjects(objs);
  return true;
}
