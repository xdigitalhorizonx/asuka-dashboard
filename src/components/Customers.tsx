"use client";

import { useState, type CSSProperties } from "react";
import { PAYMENT_METHODS, customerTotal, type Customer, type PaymentMethod, type Transaction } from "@/lib/types";
import { uid, useAsukaStore } from "@/lib/store";
import { ago, localToday, tint } from "@/lib/crm";
import { haptic } from "@/lib/haptics";

type Store = ReturnType<typeof useAsukaStore>;

const ellipsis: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

/** Customer list columns: wide screens vs phones (contact + last-paid hidden below 640px). */
const LIST_COLS: CSSProperties = { ["--cols" as string]: "1.3fr 1fr 120px 110px", ["--cols-sm" as string]: "minmax(0, 1fr) 104px" };
/** Transaction rows: date · method · memo · amount · delete (method hidden on phones). */
const TX_COLS: CSSProperties = { ["--cols" as string]: "84px 52px minmax(0, 1fr) auto 24px", ["--cols-sm" as string]: "86px minmax(0, 1fr) auto 24px" };

export function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function methodColor(m: PaymentMethod): string {
  return m === "card" ? "var(--color-accent)" : m === "check" ? "var(--color-amber)" : "var(--color-green)";
}

function fmtDate(d: string): string {
  const dt = new Date(`${d}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function websiteHref(w: string): string {
  return /^https?:\/\//i.test(w) ? w : `https://${w}`;
}

function displayName(c: Customer): string {
  return c.company || c.contact || "Unnamed customer";
}

const EMPTY = { company: "", contact: "", address: "", phone: "", email: "", website: "", notes: "" };
type Fields = typeof EMPTY;

function fieldsOf(c: Customer): Fields {
  return { company: c.company, contact: c.contact, address: c.address, phone: c.phone, email: c.email, website: c.website, notes: c.notes };
}

export function Customers({ store }: { store: Store }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(store.customers[0]?.id ?? null);
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ text: string; error: boolean } | null>(null);
  const active = store.customers.find((c) => c.id === sel) || null;

  const needle = q.trim().toLowerCase();
  const visible = (needle
    ? store.customers.filter((c) =>
        [c.company, c.contact, c.email, c.phone, c.address, c.website, c.notes].join(" ").toLowerCase().includes(needle)
      )
    : store.customers
  ).slice().sort((a, b) => displayName(a).localeCompare(displayName(b)));

  const ym = localToday().slice(0, 7);
  const allTime = store.customers.reduce((s, c) => s + customerTotal(c), 0);
  const thisMonth = store.customers.reduce(
    (s, c) => s + c.transactions.filter((t) => t.date.startsWith(ym)).reduce((a, t) => a + t.amount, 0),
    0
  );

  function select(id: string) {
    if (id === sel) return;
    setSel(id);
    haptic("tap");
  }
  function patch(id: string, fn: (c: Customer) => Partial<Customer>) {
    store.setCustomers((cs) => cs.map((c) => (c.id === id ? { ...c, ...fn(c), updatedAt: new Date().toISOString() } : c)));
  }
  function addCustomer(f: Fields) {
    const now = new Date().toISOString();
    const c: Customer = { id: uid("c"), ...f, transactions: [], createdAt: now, updatedAt: now };
    store.setCustomers((cs) => [c, ...cs]);
    setSel(c.id);
    setQ("");
    setAdding(false);
    haptic("save");
  }
  function remove(id: string) {
    store.setCustomers((cs) => cs.filter((c) => c.id !== id));
    setSel(null);
  }
  async function syncStripe() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/stripe/sync", { method: "POST" });
      const j = (await res.json()) as {
        error?: string;
        state?: Parameters<Store["adoptServerState"]>[0];
        customersAdded?: number;
        customersUpdated?: number;
        paymentsAdded?: number;
        skipped?: number;
      };
      if (!res.ok || !j.state) {
        setSyncMsg({ text: j.error || `Stripe sync failed (HTTP ${res.status})`, error: true });
        return;
      }
      store.adoptServerState(j.state);
      setSyncMsg({
        text: `Stripe synced · ${j.customersAdded ?? 0} new customers · ${j.customersUpdated ?? 0} filled in · ${j.paymentsAdded ?? 0} payments added${j.skipped ? ` · ${j.skipped} skipped` : ""}`,
        error: false,
      });
      haptic("save");
    } catch {
      setSyncMsg({ text: "Stripe sync failed — are you offline?", error: true });
    } finally {
      setSyncing(false);
    }
  }

  const tiles = [
    { l: "Customers", v: String(store.customers.length), d: "on the books", hue: "var(--color-mint)" },
    { l: "Collected · all time", v: money(allTime), d: `${store.customers.reduce((s, c) => s + c.transactions.length, 0)} transactions`, hue: "var(--color-apricot)" },
    { l: "Collected · this month", v: money(thisMonth), d: ym, hue: "var(--color-lilac)" },
  ];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <h1 className="page-title">Customers</h1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn"
            onClick={syncStripe}
            disabled={syncing}
            aria-busy={syncing}
            title="Pull customers and card payments from Stripe (never overwrites your edits)"
            style={{ color: "var(--color-accent)", borderColor: tint("var(--color-accent)", 45) }}
          >
            {syncing ? "Syncing…" : "Sync Stripe"}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
            {adding ? "Close" : "+ New customer"}
          </button>
        </div>
      </div>

      {adding && <CustomerForm title="New customer" initial={EMPTY} onSave={addCustomer} onCancel={() => setAdding(false)} />}

      {syncMsg && (
        <p role="status" style={{ margin: 0, fontSize: 13, fontWeight: 500, color: syncMsg.error ? "var(--color-danger)" : "var(--color-accent)" }}>{syncMsg.text}</p>
      )}

      <div className="tiles-3">
        {tiles.map((t) => (
          <div key={t.l} className="card" style={{ padding: 18, boxShadow: `inset 0 2px 0 0 ${tint(t.hue, 70)}, inset 0 1px 0 rgba(255,255,255,0.06)` }}>
            <div className="total" style={{ color: t.hue }}>{t.v}</div>
            <div className="label" style={{ marginTop: 6 }}>{t.l}</div>
            <div style={{ marginTop: 8, fontSize: 13, color: `color-mix(in srgb, ${t.hue} 80%, var(--color-muted))` }}>{t.d}</div>
          </div>
        ))}
      </div>

      <div className="split" style={{ ["--split-w" as string]: "420px" }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "12px 14px", borderBottom: "1px solid var(--color-border)" }}>
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers — company, contact, phone, email" aria-label="Search customers" style={{ flex: 1, minWidth: 0 }} />
            <span className="label" style={{ flexShrink: 0 }} aria-live="polite">{visible.length}/{store.customers.length}</span>
          </div>
          <div className="rows label" style={{ ...LIST_COLS, padding: "10px 14px", borderBottom: "1px solid var(--color-border)" }}>
            <span>Company</span>
            <span className="hide-sm">Contact</span>
            <span className="money">Collected</span>
            <span className="hide-sm money">Last paid</span>
          </div>
          {store.customers.length === 0 && (
            <p style={{ padding: 16, margin: 0, color: "var(--color-muted)" }}>No customers yet. Add one with + New customer, or pull them in with Sync Stripe.</p>
          )}
          {store.customers.length > 0 && visible.length === 0 && <p style={{ padding: 16, margin: 0, color: "var(--color-muted)" }}>No customers match “{q}”.</p>}
          <div role="listbox" aria-label="Customers" style={{ maxHeight: 620, overflowY: "auto" }}>
            {visible.map((c) => {
              const last = c.transactions[0];
              const selected = c.id === sel;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => select(c.id)}
                  className="row-btn rows"
                  style={LIST_COLS}
                >
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontWeight: 500, ...ellipsis }}>{displayName(c)}</span>
                    {c.stripeCustomerId && <span className="label" style={{ fontSize: 11, color: "var(--color-accent)" }}>Stripe</span>}
                  </span>
                  <span className="hide-sm" style={{ ...ellipsis, color: "var(--color-muted)" }}>{c.company ? c.contact || "—" : c.email || "—"}</span>
                  <span className="money" style={{ fontWeight: 500, color: c.transactions.length ? "var(--color-text)" : "var(--color-muted)" }}>{c.transactions.length ? money(customerTotal(c)) : "—"}</span>
                  <span className="hide-sm money" style={{ fontSize: 13, color: "var(--color-muted)" }}>{last ? fmtDate(last.date) : "—"}</span>
                </button>
              );
            })}
          </div>
        </div>

        <aside className="card" style={{ padding: 18 }} aria-label="Selected customer">
          {!active ? (
            <p style={{ color: "var(--color-muted)", margin: 0 }}>Select a customer.</p>
          ) : (
            <CustomerDetail key={active.id} customer={active} onPatch={(fn) => patch(active.id, fn)} onDelete={() => remove(active.id)} />
          )}
        </aside>
      </div>
    </div>
  );
}

function CustomerForm({ title, initial, onSave, onCancel }: { title: string; initial: Fields; onSave: (f: Fields) => void; onCancel: () => void }) {
  const [f, setF] = useState<Fields>(initial);
  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const valid = f.company.trim() || f.contact.trim();
  return (
    <form
      className="card"
      style={{ padding: 18, display: "grid", gap: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const trimmed = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim()])) as Fields;
        onSave(trimmed);
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h2 className="card-title" style={{ margin: 0 }}>{title}</h2>
        <span style={{ fontSize: 13, color: "var(--color-muted)" }}>Company or contact required</span>
      </div>
      <div className="fields">
        <input className="input" placeholder="Company name" value={f.company} onChange={set("company")} aria-label="Company name" autoFocus />
        <input className="input" placeholder="Contact (person)" value={f.contact} onChange={set("contact")} aria-label="Contact" />
        <input className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder="Contact phone" value={f.phone} onChange={set("phone")} aria-label="Contact phone" />
        <input className="input" type="email" inputMode="email" autoComplete="email" placeholder="Contact email" value={f.email} onChange={set("email")} aria-label="Contact email" />
        <input className="input" inputMode="url" placeholder="Website" value={f.website} onChange={set("website")} aria-label="Website" />
        <input className="input" placeholder="Address" value={f.address} onChange={set("address")} aria-label="Address" />
      </div>
      <textarea className="input" style={{ height: 72, resize: "vertical" }} placeholder="Notes" value={f.notes} onChange={set("notes")} aria-label="Notes" />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid}>Save customer</button>
      </div>
    </form>
  );
}

function CustomerDetail({ customer, onPatch, onDelete }: { customer: Customer; onPatch: (fn: (c: Customer) => Partial<Customer>) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [txOpen, setTxOpen] = useState(false);
  const [tx, setTx] = useState<{ amount: string; method: PaymentMethod; date: string; memo: string }>({ amount: "", method: "card", date: localToday(), memo: "" });
  const total = customerTotal(customer);
  const amountNum = Number(tx.amount);
  const txValid = Number.isFinite(amountNum) && amountNum > 0 && !!tx.date;

  function addTx() {
    if (!txValid) return;
    const t: Transaction = {
      id: uid("t"),
      amount: Math.round(amountNum * 100) / 100,
      method: tx.method,
      date: tx.date,
      memo: tx.memo.trim(),
      createdAt: new Date().toISOString(),
    };
    onPatch((c) => ({ transactions: [t, ...c.transactions] }));
    setTx({ amount: "", method: tx.method, date: localToday(), memo: "" });
    setTxOpen(false);
    haptic("save");
  }
  function removeTx(id: string) {
    onPatch((c) => ({ transactions: c.transactions.filter((t) => t.id !== id) }));
  }

  if (editing) {
    return (
      <CustomerForm
        title="Edit customer"
        initial={fieldsOf(customer)}
        onSave={(f) => {
          onPatch(() => f);
          setEditing(false);
          haptic("save");
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const dash = <span style={{ color: "var(--color-muted)" }}>—</span>;
  const link: CSSProperties = { color: "var(--color-accent)", textDecoration: "none" };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="card-title" style={{ margin: 0, ...ellipsis }}>{displayName(customer)}</h2>
          {customer.company && customer.contact && <div style={{ color: "var(--color-muted)", ...ellipsis }}>{customer.contact}</div>}
          {customer.stripeCustomerId && <div className="label" style={{ fontSize: 11, color: "var(--color-accent)", marginTop: 4, ...ellipsis }}>Stripe · {customer.stripeCustomerId}</div>}
        </div>
        <button type="button" className="btn" style={{ flexShrink: 0 }} onClick={() => setEditing(true)}>Edit</button>
      </div>

      <dl style={{ margin: "16px 0 0", display: "grid", gridTemplateColumns: "76px minmax(0, 1fr)", rowGap: 8, columnGap: 10 }}>
        <dt className="label" style={{ paddingTop: 2 }}>Phone</dt>
        <dd style={{ margin: 0, fontSize: 16 }}>{customer.phone ? <a href={`tel:${customer.phone.replace(/[^\d+]/g, "")}`} style={link}>{customer.phone}</a> : dash}</dd>
        <dt className="label" style={{ paddingTop: 2 }}>Email</dt>
        <dd style={{ margin: 0, ...ellipsis }}>{customer.email ? <a href={`mailto:${customer.email}`} style={link}>{customer.email}</a> : dash}</dd>
        <dt className="label" style={{ paddingTop: 2 }}>Website</dt>
        <dd style={{ margin: 0, ...ellipsis }}>{customer.website ? <a href={websiteHref(customer.website)} target="_blank" rel="noreferrer" style={link}>{customer.website}</a> : dash}</dd>
        <dt className="label" style={{ paddingTop: 2 }}>Address</dt>
        <dd style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{customer.address || dash}</dd>
      </dl>

      <div style={{ marginTop: 16, borderTop: "1px solid var(--color-border)", paddingTop: 14 }}>
        <div className="label" style={{ marginBottom: 6 }}>Notes</div>
        {customer.notes ? (
          <p style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.5, overflowWrap: "anywhere" }}>{customer.notes}</p>
        ) : (
          <p style={{ margin: 0, color: "var(--color-muted)" }}>No notes — use Edit to add some.</p>
        )}
      </div>

      <div style={{ marginTop: 18, borderTop: "1px solid var(--color-border)", paddingTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
            <span className="label">Transactions</span>
            <span className="money" style={{ fontWeight: 600 }}>{money(total)}</span>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setTxOpen((v) => !v)}
            aria-expanded={txOpen}
            aria-label={txOpen ? "Close transaction form" : "Add transaction"}
            title={txOpen ? "Close" : "Add a transaction"}
            style={{ width: 36, height: 36, minHeight: 36, padding: 0, fontSize: 20, borderRadius: 999 }}
          >
            {txOpen ? "×" : "+"}
          </button>
        </div>

        {txOpen && (
          <div style={{ padding: 12, borderRadius: 14, border: `1px solid ${tint("var(--color-mint)", 40)}`, background: tint("var(--color-mint)", 7), display: "grid", gap: 8, marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 6 }} role="radiogroup" aria-label="Payment method">
              {PAYMENT_METHODS.map((m) => {
                const on = tx.method === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className="btn"
                    onClick={() => setTx({ ...tx, method: m.id })}
                    style={{ flex: 1, color: on ? "var(--color-on-primary)" : methodColor(m.id), background: on ? methodColor(m.id) : undefined, borderColor: methodColor(m.id) }}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
              <input className="input" type="number" min="0.01" step="0.01" inputMode="decimal" placeholder="Amount $" value={tx.amount} onChange={(e) => setTx({ ...tx, amount: e.target.value })} aria-label="Amount" autoFocus onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTx(); } }} />
              <input className="input" type="date" value={tx.date} onChange={(e) => setTx({ ...tx, date: e.target.value })} aria-label="Date" />
            </div>
            <input className="input" placeholder="Memo — invoice #, what it was for" value={tx.memo} onChange={(e) => setTx({ ...tx, memo: e.target.value })} aria-label="Memo" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTx(); } }} />
            <button type="button" className="btn btn-primary" disabled={!txValid} onClick={addTx}>
              Record {tx.method} payment{txValid ? ` · ${money(amountNum)}` : ""}
            </button>
          </div>
        )}

        <div style={{ display: "grid", gap: 6, maxHeight: 360, overflowY: "auto" }}>
          {customer.transactions.length === 0 && <p style={{ margin: 0, color: "var(--color-muted)" }}>No transactions yet — tap + to record one.</p>}
          {customer.transactions.map((t) => (
            <div key={t.id} className="rows" style={{ ...TX_COLS, padding: "8px 10px", borderRadius: 12, border: "1px solid var(--color-border)", background: "var(--color-surface)", fontSize: 14 }}>
              <span style={{ fontSize: 13, color: "var(--color-muted)", ...ellipsis }} title={ago(t.createdAt)}>{fmtDate(t.date)}</span>
              <span className="hide-sm label" style={{ fontSize: 11, color: methodColor(t.method) }}>{t.method}</span>
              <span style={{ ...ellipsis, color: t.memo ? "var(--color-text)" : "var(--color-muted)" }} title={t.memo}>
                {t.memo || "—"}
                {t.stripeId && <span className="label" style={{ marginLeft: 6, fontSize: 10, color: "var(--color-accent)" }}>Stripe</span>}
              </span>
              <span className="money" style={{ fontWeight: 500 }}>{money(t.amount)}</span>
              <button type="button" onClick={() => { if (!t.stripeId || window.confirm("This payment came from Stripe and will come back on the next sync. Remove it anyway?")) removeTx(t.id); }} aria-label="Delete transaction" title="Delete" style={{ background: "transparent", border: "none", color: "var(--color-muted)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0, width: 24, height: 24, borderRadius: 8 }}>×</button>
            </div>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="btn btn-danger"
        style={{ marginTop: 18 }}
        onClick={() => {
          const n = customer.transactions.length;
          if (window.confirm(`Delete ${displayName(customer)}? This removes the customer and ${n} transaction${n === 1 ? "" : "s"}.`)) onDelete();
        }}
      >
        Delete customer
      </button>
    </>
  );
}
