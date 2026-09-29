import { readState, writeState } from "../server-state";
import { dateOf } from "../stripe";
import { normalizeCustomer, type Customer, type Transaction } from "../types";
import { fmtMoney, type Invoice, type InvoicePayment } from "./types";

/**
 * Put an invoice card payment on the Customers tab, under the invoice's client.
 *
 * The Stripe webhook's generic path would file the same charge under a nameless
 * customer (the Payment Element collects no name), so invoice charges come through
 * here instead. Keyed by charge id exactly like the Stripe sync (`t_<charge id>`),
 * so a later sync or webhook replay finds it and never adds a duplicate.
 */
export function addInvoiceTransaction(customers: Customer[], inv: Invoice, p: InvoicePayment): boolean {
  if (!p.chargeId) return false;
  const txId = `t_${p.chargeId}`;
  if (customers.some((c) => c.transactions.some((t) => t.id === txId || t.stripeId === p.chargeId))) return false;

  const email = inv.client.email.trim().toLowerCase();
  const name = inv.client.name.trim().toLowerCase();
  let i = email ? customers.findIndex((c) => c.email.trim().toLowerCase() === email) : -1;
  if (i < 0 && name) i = customers.findIndex((c) => c.company.trim().toLowerCase() === name || c.contact.trim().toLowerCase() === name);

  const now = new Date().toISOString();
  const tx: Transaction = {
    id: txId,
    amount: p.amount,
    method: "card",
    date: dateOf(Math.floor(Date.parse(p.paidAt) / 1000)),
    memo: `Invoice ${inv.number}${p.part ? ` ${p.part}` : ""}${p.fee > 0 ? ` · incl. ${fmtMoney(p.fee)} card fee` : ""}`,
    createdAt: p.paidAt,
    stripeId: p.chargeId,
  };

  if (i >= 0) {
    const c = customers[i];
    const fill: Partial<Customer> = {};
    if (!c.email && inv.client.email) fill.email = inv.client.email;
    if (!c.phone && inv.client.phone) fill.phone = inv.client.phone;
    if (!c.address && inv.client.address) fill.address = inv.client.address;
    // The card was saved to this Stripe customer: its monthly charges then land here too.
    if (!c.stripeCustomerId && p.customerId) fill.stripeCustomerId = p.customerId;
    customers[i] = normalizeCustomer({ ...c, ...fill, transactions: [tx, ...c.transactions], updatedAt: now });
  } else {
    customers.push(
      normalizeCustomer({
        id: `c_inv_${inv.id.slice(0, 12)}`,
        company: inv.client.name,
        contact: "",
        address: inv.client.address,
        phone: inv.client.phone,
        email: inv.client.email,
        website: "",
        notes: `Added when invoice ${inv.number} was paid.`,
        transactions: [tx],
        ...(p.customerId ? { stripeCustomerId: p.customerId } : {}),
        createdAt: now,
        updatedAt: now,
      })
    );
  }
  return true;
}

/** Read the vault, add the invoice payment to the Customers tab, write it back (once). */
export async function recordInvoiceTransaction(inv: Invoice, p: InvoicePayment): Promise<void> {
  const state = await readState();
  const customers = [...state.customers];
  if (addInvoiceTransaction(customers, inv, p)) await writeState({ ...state, customers });
}
