"use client";

import { useState, type CSSProperties } from "react";
import { PAYMENT_METHODS, customerTotal, type Customer, type PaymentMethod, type Transaction } from "@/lib/types";
import { uid, useAsukaStore } from "@/lib/store";
import { MONO, ago, localToday, tint } from "@/lib/crm";

type Store = ReturnType<typeof useAsukaStore>;

const inp: CSSProperties = {
  width: "100%",
  borderRadius: 7,
  border: "1px solid var(--color-border)",
  background: "var(--color-bg)",
  padding: "8px 10px",
  fontSize: 13,
  outline: "none",
};

const label: CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.12em",
  color: "var(--color-muted)",
  fontFamily: MONO,
};

const ellipsis: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

const COLS = "1.3fr 1fr 110px 110px";

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
        text: `STRIPE SYNCED · ${j.customersAdded ?? 0} new customers · ${j.customersUpdated ?? 0} filled in · ${j.paymentsAdded ?? 0} payments added${j.skipped ? ` · ${j.skipped} skipped` : ""}`,
        error: false,
      });
    } catch {
      setSyncMsg({ text: "Stripe sync failed — are you offline?", error: true });
    } finally {
      setSyncing(false);
    }
  }

  const tiles = [
    { l: "CUSTOMERS", v: String(store.customers.length), d: "on the books", hue: "var(--color-green)" },
    { l: "COLLECTED · ALL TIME", v: money(allTime), d: `${store.customers.reduce((s, c) => s + c.transactions.length, 0)} transactions`, hue: "var(--color-amber)" },
    { l: "COLLECTED · THIS MONTH", v: money(thisMonth), d: ym, hue: "var(--color-lilac)" },
  ];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr)) auto", gap: 12, alignItems: "stretch" }}>
        {tiles.map((t) => (
          <div key={t.l} className="card" style={{ padding: 16, boxShadow: `inset 0 2px 0 0 ${tint(t.hue, 70)}` }}>
            <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 500, letterSpacing: "-0.03em", color: t.hue, ...ellipsis }}>{t.v}</div>
            <div style={{ marginTop: 6, ...label, letterSpacing: "0.14em" }}>{t.l}</div>
            <div style={{ marginTop: 8, fontSize: 11, color: `color-mix(in srgb, ${t.hue} 80%, var(--color-muted))`, fontFamily: MONO }}>{t.d}</div>
          </div>
        ))}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, justifyContent: "center" }}>
          <button type="button" className="btn" style={{ padding: "9px 14px", background: "var(--color-green)", borderColor: "var(--color-green)", color: "var(--color-ink)", fontWeight: 500 }} onClick={() => setAdding((v) => !v)}>
            {adding ? "CLOSE" : "+ NEW CUSTOMER"}
          </button>
          <button type="button" className="btn" style={{ padding: "9px 14px", color: "var(--color-accent)", borderColor: tint("var(--color-accent)", 45), background: tint("var(--color-accent)", 6), opacity: syncing ? 0.6 : 1 }} onClick={syncStripe} disabled={syncing} title="Pull customers and card payments from Stripe (never overwrites your edits)">
            {syncing ? "SYNCING…" : "⟳ SYNC STRIPE"}
          </button>
        </div>
      </div>

      {syncMsg && (
        <p style={{ margin: 0, fontSize: 11, letterSpacing: "0.06em", fontFamily: MONO, color: syncMsg.error ? "var(--color-primary)" : "var(--color-green)" }}>{syncMsg.text}</p>
      )}

      {adding && <CustomerForm title="NEW CUSTOMER" initial={EMPTY} onSave={addCustomer} onCancel={() => setAdding(false)} />}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 420px", gap: 16, alignItems: "start" }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--color-border)" }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers — company, contact, phone, email" aria-label="Search customers" style={{ ...inp, flex: 1 }} />
            <span style={label}>{visible.length}/{store.customers.length}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 8, padding: "10px 14px", ...label, borderBottom: "1px solid var(--color-border)" }}>
            <span>COMPANY</span>
            <span>CONTACT</span>
            <span>COLLECTED</span>
            <span>LAST PAID</span>
          </div>
          {store.customers.length === 0 && (
            <p style={{ padding: 16, color: "var(--color-muted)", fontSize: 13 }}>No customers yet. Add one with + NEW CUSTOMER, or pull them in with ⟳ SYNC STRIPE.</p>
          )}
          {store.customers.length > 0 && visible.length === 0 && <p style={{ padding: 16, color: "var(--color-muted)" }}>No customers match “{q}”.</p>}
          <div style={{ maxHeight: 620, overflowY: "auto" }}>
            {visible.map((c) => {
              const last = c.transactions[0];
              return (
                <button
                  key={c.id}
                  onClick={() => setSel(c.id)}
                  style={{ display: "grid", gridTemplateColumns: COLS, gap: 8, width: "100%", padding: "10px 14px", alignItems: "center", background: c.id === sel ? tint("var(--color-green)", 8) : "transparent", border: "none", borderTop: "1px solid var(--color-border)", color: "inherit", cursor: "pointer", textAlign: "left" }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", ...ellipsis }}>{displayName(c)}</span>
                    {c.stripeCustomerId && <span style={{ ...label, fontSize: 9, color: "var(--color-accent)" }}>STRIPE</span>}
                  </span>
                  <span style={{ ...ellipsis, color: "var(--color-muted)" }}>{c.company ? c.contact || "—" : c.email || "—"}</span>
                  <span style={{ fontFamily: MONO, fontSize: 12, color: c.transactions.length ? "var(--color-amber)" : "var(--color-muted)" }}>{c.transactions.length ? money(customerTotal(c)) : "—"}</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--color-muted)", ...ellipsis }}>{last ? fmtDate(last.date) : "—"}</span>
                </button>
              );
            })}
          </div>
        </div>

        <aside className="card" style={{ padding: 18 }}>
          {!active ? (
            <p style={{ color: "var(--color-muted)" }}>Select a customer.</p>
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
      style={{ padding: 16, display: "grid", gap: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const trimmed = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim()])) as Fields;
        onSave(trimmed);
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={label}>{title}</span>
        <span style={{ ...label, letterSpacing: 0 }}>company or contact required</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        <input style={inp} placeholder="Company name" value={f.company} onChange={set("company")} aria-label="Company name" />
        <input style={inp} placeholder="Contact (person)" value={f.contact} onChange={set("contact")} aria-label="Contact" />
        <input style={inp} placeholder="Contact phone" value={f.phone} onChange={set("phone")} aria-label="Contact phone" />
        <input style={inp} placeholder="Contact email" type="email" value={f.email} onChange={set("email")} aria-label="Contact email" />
        <input style={inp} placeholder="Website" value={f.website} onChange={set("website")} aria-label="Website" />
        <input style={inp} placeholder="Address" value={f.address} onChange={set("address")} aria-label="Address" />
      </div>
      <textarea style={{ ...inp, height: 64, resize: "vertical" }} placeholder="Notes" value={f.notes} onChange={set("notes")} aria-label="Notes" />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn" style={{ padding: "8px 12px", color: "var(--color-muted)" }} onClick={onCancel}>CANCEL</button>
        <button className="btn btn-primary" style={{ padding: "8px 14px", opacity: valid ? 1 : 0.5 }} disabled={!valid}>SAVE CUSTOMER</button>
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
  }
  function removeTx(id: string) {
    onPatch((c) => ({ transactions: c.transactions.filter((t) => t.id !== id) }));
  }

  if (editing) {
    return (
      <CustomerForm
        title="EDIT CUSTOMER"
        initial={fieldsOf(customer)}
        onSave={(f) => {
          onPatch(() => f);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15, ...ellipsis }}>{displayName(customer)}</div>
          {customer.company && customer.contact && <div style={{ fontSize: 12, color: "var(--color-muted)", ...ellipsis }}>{customer.contact}</div>}
          {customer.stripeCustomerId && <div style={{ ...label, fontSize: 9, color: "var(--color-accent)", marginTop: 2 }}>STRIPE · {customer.stripeCustomerId}</div>}
        </div>
        <button type="button" className="btn" style={{ padding: "5px 10px", flexShrink: 0 }} onClick={() => setEditing(true)}>EDIT</button>
      </div>

      <dl style={{ margin: "14px 0 0", display: "grid", gridTemplateColumns: "72px 1fr", rowGap: 6, columnGap: 10, fontSize: 12 }}>
        <dt style={label}>PHONE</dt>
        <dd style={{ margin: 0, fontFamily: MONO }}>{customer.phone ? <a href={`tel:${customer.phone.replace(/[^\d+]/g, "")}`} style={{ color: "var(--color-accent)", textDecoration: "none" }}>{customer.phone}</a> : <span style={{ color: "var(--color-muted)" }}>—</span>}</dd>
        <dt style={label}>EMAIL</dt>
        <dd style={{ margin: 0, fontFamily: MONO, ...ellipsis }}>{customer.email ? <a href={`mailto:${customer.email}`} style={{ color: "var(--color-accent)", textDecoration: "none" }}>{customer.email}</a> : <span style={{ color: "var(--color-muted)" }}>—</span>}</dd>
        <dt style={label}>WEBSITE</dt>
        <dd style={{ margin: 0, fontFamily: MONO, ...ellipsis }}>{customer.website ? <a href={websiteHref(customer.website)} target="_blank" rel="noreferrer" style={{ color: "var(--color-accent)", textDecoration: "none" }}>{customer.website}</a> : <span style={{ color: "var(--color-muted)" }}>—</span>}</dd>
        <dt style={label}>ADDRESS</dt>
        <dd style={{ margin: 0, whiteSpace: "pre-wrap" }}>{customer.address || <span style={{ color: "var(--color-muted)" }}>—</span>}</dd>
      </dl>

      <div style={{ marginTop: 14, borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
        <div style={{ ...label, marginBottom: 6 }}>NOTES</div>
        {customer.notes ? (
          <p style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{customer.notes}</p>
        ) : (
          <p style={{ margin: 0, fontSize: 12, color: "var(--color-muted)" }}>No notes — use EDIT to add some.</p>
        )}
      </div>

      <div style={{ marginTop: 18, borderTop: "1px solid var(--color-border)", paddingTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div>
            <span style={label}>TRANSACTIONS</span>
            <span style={{ marginLeft: 10, fontFamily: MONO, fontSize: 12, color: "var(--color-amber)" }}>{money(total)}</span>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setTxOpen((v) => !v)}
            aria-label={txOpen ? "Close transaction form" : "Add transaction"}
            title={txOpen ? "Close" : "Add a transaction"}
            style={{ width: 30, height: 30, padding: 0, fontSize: 18, lineHeight: 1, borderRadius: 999, background: "var(--color-green)", borderColor: "var(--color-green)" }}
          >
            {txOpen ? "×" : "+"}
          </button>
        </div>

        {txOpen && (
          <div style={{ padding: 12, borderRadius: 8, border: `1px solid ${tint("var(--color-green)", 40)}`, background: tint("var(--color-green)", 6), display: "grid", gap: 8, marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 6 }}>
              {PAYMENT_METHODS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="btn"
                  onClick={() => setTx({ ...tx, method: m.id })}
                  style={{ flex: 1, padding: "7px 0", color: tx.method === m.id ? "var(--color-ink)" : methodColor(m.id), background: tx.method === m.id ? methodColor(m.id) : "transparent", borderColor: tx.method === m.id ? methodColor(m.id) : tint(methodColor(m.id), 45) }}
                >
                  {m.label.toUpperCase()}
                </button>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <input style={inp} type="number" min="0.01" step="0.01" inputMode="decimal" placeholder="Amount $" value={tx.amount} onChange={(e) => setTx({ ...tx, amount: e.target.value })} aria-label="Amount" autoFocus onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTx(); } }} />
              <input style={{ ...inp, colorScheme: "dark" }} type="date" value={tx.date} onChange={(e) => setTx({ ...tx, date: e.target.value })} aria-label="Date" />
            </div>
            <input style={inp} placeholder="Memo — invoice #, what it was for" value={tx.memo} onChange={(e) => setTx({ ...tx, memo: e.target.value })} aria-label="Memo" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTx(); } }} />
            <button type="button" className="btn btn-primary" style={{ padding: "8px 10px", opacity: txValid ? 1 : 0.5 }} disabled={!txValid} onClick={addTx}>
              RECORD {tx.method.toUpperCase()} PAYMENT{txValid ? ` · ${money(amountNum)}` : ""}
            </button>
          </div>
        )}

        <div style={{ display: "grid", gap: 6, maxHeight: 360, overflowY: "auto" }}>
          {customer.transactions.length === 0 && <p style={{ margin: 0, fontSize: 12, color: "var(--color-muted)" }}>No transactions yet — tap + to record one.</p>}
          {customer.transactions.map((t) => (
            <div key={t.id} style={{ display: "grid", gridTemplateColumns: "84px 52px 1fr auto 18px", gap: 8, alignItems: "center", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-bg)", fontSize: 12 }}>
              <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--color-muted)" }} title={ago(t.createdAt)}>{fmtDate(t.date)}</span>
              <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em", color: methodColor(t.method) }}>{t.method.toUpperCase()}</span>
              <span style={{ ...ellipsis, color: t.memo ? "var(--color-text)" : "var(--color-muted)" }} title={t.memo}>
                {t.memo || "—"}
                {t.stripeId && <span style={{ marginLeft: 6, fontFamily: MONO, fontSize: 9, letterSpacing: "0.08em", color: "var(--color-accent)" }}>STRIPE</span>}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--color-amber)" }}>{money(t.amount)}</span>
              <button type="button" onClick={() => { if (!t.stripeId || window.confirm("This payment came from Stripe and will come back on the next sync. Remove it anyway?")) removeTx(t.id); }} aria-label="Delete transaction" title="Delete" style={{ background: "transparent", border: "none", color: "var(--color-muted)", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
            </div>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="btn"
        style={{ marginTop: 18, padding: "6px 10px", color: "var(--color-primary)" }}
        onClick={() => {
          const n = customer.transactions.length;
          if (window.confirm(`Delete ${displayName(customer)}? This removes the customer and ${n} transaction${n === 1 ? "" : "s"}.`)) onDelete();
        }}
      >
        DELETE CUSTOMER
      </button>
    </>
  );
}
