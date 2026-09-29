"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { tint, localToday } from "@/lib/crm";
import { haptic } from "@/lib/haptics";
import type { PaymentsStatus } from "@/lib/invoice/payments";
import type { InvoiceInput } from "@/lib/invoice/store";
import { cardFee, fmtMoney, localYmd, recurringGroups, round2, type Invoice, type InvoiceLine, type RecurringInterval } from "@/lib/invoice/types";
import { Icon } from "./icons";

/**
 * Invoices tab: drop a Digital Horizon proposal PDF → review the draft it becomes →
 * create a live invoice with a public, payable link (/i/<id>). Everything here goes
 * through the session-gated /api/invoices routes; the customer side lives at /i/<id>.
 */

const HUE = "var(--color-teal)";

type Payload = {
  invoices: Invoice[];
  payments: PaymentsStatus;
  cardFeeDefault: number;
  /** The surcharge ceiling in force (0 = surcharging off). */
  cardFeeMax: number;
  origin: string;
  storage: string;
  error?: string;
};

/** `recurringText` is the "then $___ per period" price the subscription bills after this invoice. */
type EditLine = InvoiceLine & { amountText: string; recurringText: string };
type Draft = Omit<InvoiceInput, "lines"> & { lines: EditLine[] };
const PER: Record<RecurringInterval, string> = { month: "mo", year: "yr" };

/** Paid, has recurring lines, but not every interval has its subscription yet. */
function missingSubs(inv: Invoice): boolean {
  return inv.status === "paid" && recurringGroups(inv.lines).some((g) => !inv.subscriptions.some((s) => s.interval === g.interval));
}
function stripeSubUrl(id: string, live?: boolean): string {
  return `https://dashboard.stripe.com/${live ? "" : "test/"}subscriptions/${id}`;
}
type ParseInfo = {
  ok: boolean;
  reason?: string;
  warnings: string[];
  match?: { kind: "customer" | "lead"; label: string } | null;
  proposal?: { client: string; proposalDate: string; services: number; totals: { monthly: number | null; oneTime: number | null; initial: number | null } };
};

const ellipsis: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function toEdit(lines: InvoiceLine[]): EditLine[] {
  return lines.map((l) => ({ ...l, amountText: l.amount ? l.amount.toFixed(2) : "0", recurringText: l.recurring ? l.recurring.amount.toFixed(2) : "" }));
}
function parseAmount(t: string): number {
  const n = Number(String(t).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? round2(n) : NaN;
}
function draftTotal(d: Draft): number {
  return round2(d.lines.reduce((s, l) => s + (Number.isFinite(parseAmount(l.amountText)) ? parseAmount(l.amountText) : 0), 0));
}
/** Keep the proposal-style line note ("First month · then $94.99/mo") in step with the repeat price. */
function syncNote(l: EditLine, interval: RecurringInterval | null, priceText: string): string {
  const auto = !l.note.trim() || /^First (month|year) · then \$[\d,]+(\.\d+)?\/(mo|yr)$/.test(l.note.trim());
  if (!auto) return l.note;
  const price = parseAmount(priceText);
  return interval && Number.isFinite(price) && price > 0 ? `First ${interval} · then ${fmtMoney(price)}/${PER[interval]}` : "";
}
function blankDraft(fee: number): Draft {
  return {
    issueDate: localToday(),
    dueDate: "",
    client: { name: "", email: "", phone: "", address: "" },
    project: "",
    lines: toEdit([{ id: "l1", name: "", description: "", type: "One-Time", recurring: null, amount: 0, zeroLabel: "", note: "" }]),
    cardFeePercent: fee,
    notes: "",
  };
}
function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** "2026-09-28" → "Sep 28, 2026" for the compact list. */
function fmtShortDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function statusView(inv: Invoice): { label: string; color: string } {
  if (inv.status === "paid") return { label: "Paid", color: "var(--color-green)" };
  if (inv.status === "void") return { label: "Void", color: "var(--color-muted)" };
  if (inv.dueDate && inv.dueDate < localToday()) return { label: "Overdue", color: "var(--color-amber)" };
  return { label: "Open", color: "var(--color-sky)" };
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "offline" } as T & { error?: string } };
  }
}

export function Invoices() {
  const [data, setData] = useState<Payload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [parseInfo, setParseInfo] = useState<ParseInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<Invoice | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const apply = useCallback((r: { ok: boolean; status: number; data: Payload & { error?: string } }) => {
    if (r.data.invoices) setData(r.data);
    setLoadError(r.ok ? null : r.data.error || `HTTP ${r.status}`);
  }, []);
  /** Re-read after an action (create, void, delete…). */
  const load = useCallback(async () => apply(await jsonFetch<Payload>("/api/invoices")), [apply]);

  // Poll while the tab is visible so a client's payment shows up without a reload.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const r = await jsonFetch<Payload>("/api/invoices");
      if (!cancelled) apply(r);
    };
    void tick();
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void tick();
    }, 30_000);
    const onVis = () => document.visibilityState === "visible" && void tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [apply]);

  // A PDF dropped outside the zone must not navigate the board away.
  useEffect(() => {
    const stray = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", stray);
    window.addEventListener("drop", stray);
    return () => {
      window.removeEventListener("dragover", stray);
      window.removeEventListener("drop", stray);
    };
  }, []);

  const origin = data?.origin || (typeof window !== "undefined" ? window.location.origin : "");
  const linkFor = (inv: Invoice) => `${origin}/i/${inv.id}`;
  const feeDefault = data?.cardFeeDefault ?? 0;
  const feeMax = data?.cardFeeMax ?? 0;

  async function readProposal(file: File) {
    setFormError(null);
    setCreated(null);
    setEditing(null);
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      setFormError(`${file.name} isn't a PDF — drop the proposal PDF.`);
      return;
    }
    setBusy("parse");
    const r = await jsonFetch<{ ok: boolean; reason?: string; draft: InvoiceInput; warnings: string[]; match?: ParseInfo["match"]; proposal?: ParseInfo["proposal"] }>("/api/invoices/parse", {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "x-file-name": encodeURIComponent(file.name) },
      body: file,
    });
    setBusy(null);
    if (!r.ok || !r.data.draft) {
      setFormError(r.data.error || `Couldn't read that PDF (HTTP ${r.status}).`);
      return;
    }
    const d = r.data.draft;
    setParseInfo({ ok: r.data.ok, reason: r.data.reason, warnings: r.data.warnings || [], match: r.data.match ?? null, proposal: r.data.proposal });
    setDraft({ ...d, lines: d.lines.length ? toEdit(d.lines) : blankDraft(feeDefault).lines });
    haptic("tap");
  }

  function startBlank() {
    setCreated(null);
    setEditing(null);
    setParseInfo(null);
    setFormError(null);
    setDraft(blankDraft(feeDefault));
  }

  function startEdit(inv: Invoice) {
    setCreated(null);
    setParseInfo(null);
    setFormError(null);
    setEditing(inv);
    const { issueDate, dueDate, client, project, lines, cardFeePercent, notes, source } = inv;
    setDraft({ issueDate, dueDate, client, project, lines: toEdit(lines), cardFeePercent: Math.min(cardFeePercent, feeMax), notes, ...(source ? { source } : {}) });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function draftToInput(d: Draft): InvoiceInput | string {
    const lines: InvoiceLine[] = [];
    for (const [i, l] of d.lines.entries()) {
      if (!l.name.trim() && !l.amountText.trim()) continue;
      const amount = parseAmount(l.amountText);
      if (!Number.isFinite(amount)) return `Line ${i + 1}: "${l.amountText}" isn't an amount.`;
      let recurring: InvoiceLine["recurring"] = null;
      if (l.recurring) {
        const price = parseAmount(l.recurringText);
        if (!Number.isFinite(price) || price <= 0) return `Line ${i + 1}: enter the price it repeats at, or set it to one-time.`;
        recurring = { interval: l.recurring.interval, amount: price };
      }
      const rest: Partial<EditLine> = { ...l };
      delete rest.amountText;
      delete rest.recurringText;
      lines.push({ ...(rest as InvoiceLine), amount, recurring, zeroLabel: amount === 0 ? l.zeroLabel || "Included" : "" });
    }
    return { ...d, lines };
  }

  async function save() {
    if (!draft) return;
    const input = draftToInput(draft);
    if (typeof input === "string") {
      setFormError(input);
      return;
    }
    setBusy("save");
    setFormError(null);
    const r = editing
      ? await jsonFetch<{ invoice: Invoice }>(`/api/invoices/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "edit", expectedVersion: editing.version, input }),
        })
      : await jsonFetch<{ invoice: Invoice; url: string }>("/api/invoices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
    setBusy(null);
    if (!r.ok || !r.data.invoice) {
      setFormError(r.data.error || `Couldn't save (HTTP ${r.status}).`);
      return;
    }
    haptic("save");
    setDraft(null);
    setParseInfo(null);
    setEditing(null);
    setCreated(r.data.invoice);
    await load();
  }

  async function act(inv: Invoice, action: "void" | "unvoid" | "delete" | "refresh") {
    if (action === "void" && !window.confirm(`Void ${inv.number}? The link will show it as void and it can't be paid.`)) return;
    if (action === "delete" && !window.confirm(`Delete ${inv.number} for good? Its link stops working.`)) return;
    setBusy(`${action}:${inv.id}`);
    const r =
      action === "delete"
        ? await jsonFetch(`/api/invoices/${inv.id}`, { method: "DELETE" })
        : action === "refresh"
          ? await jsonFetch<{ invoice: Invoice }>(`/api/invoices/${inv.id}/refresh`, { method: "POST" })
          : await jsonFetch<{ invoice: Invoice }>(`/api/invoices/${inv.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action, expectedVersion: inv.version }),
            });
    setBusy(null);
    if (!r.ok) {
      setNotice(r.data.error || `That didn't work (HTTP ${r.status}).`);
      return;
    }
    if (action === "refresh") {
      const after = (r.data as { invoice?: Invoice }).invoice;
      setNotice(after && missingSubs(inv) && !missingSubs(after) ? `${inv.number}: monthly billing set up in Stripe.` : `${inv.number}: checked with Stripe.`);
    }
    if (created?.id === inv.id && action === "delete") setCreated(null);
    await load();
  }

  async function copy(inv: Invoice) {
    try {
      await navigator.clipboard.writeText(linkFor(inv));
      setNotice(`Link for ${inv.number} copied.`);
      haptic("tap");
    } catch {
      window.prompt("Copy this link:", linkFor(inv));
    }
  }

  function mailto(inv: Invoice): string {
    const first = inv.client.name.split(/\s+/)[0] || "there";
    const subject = `Invoice ${inv.number} from Digital Horizon`;
    const body = `Hi ${first},\n\nHere's your invoice ${inv.number} for ${fmtMoney(inv.balance)}. You can view it, save a PDF, and pay by card here:\n\n${linkFor(inv)}\n\nThank you!\nDigital Horizon`;
    return `mailto:${encodeURIComponent(inv.client.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  const invoices = data?.invoices ?? [];
  const outstanding = round2(invoices.filter((i) => i.status === "open").reduce((s, i) => s + i.balance, 0));
  const ym = localToday().slice(0, 7);
  const collected = round2(invoices.flatMap((i) => i.payments).filter((p) => localYmd(p.paidAt).slice(0, 7) === ym).reduce((s, p) => s + p.amount, 0));
  const pay = data?.payments;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <h1 className="page-title">Invoices</h1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn" onClick={startBlank}>
            + Blank invoice
          </button>
        </div>
      </div>

      {pay && !pay.ready && (
        <div role="status" className="card" style={{ padding: "12px 14px", borderColor: tint("var(--color-amber)", 45), background: tint("var(--color-amber)", 8), fontSize: 14 }}>
          <strong style={{ color: "var(--color-amber)" }}>Card payments are off.</strong>{" "}
          {pay.mode === "mismatch"
            ? "STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are from different modes (live vs test) — use a matching pair."
            : !pay.secretKey
              ? "Set STRIPE_SECRET_KEY in Vercel."
              : "Add STRIPE_PUBLISHABLE_KEY (pk_live_…) in Vercel → Settings → Environment Variables, then redeploy."}{" "}
          Invoices and their links still work; the pay box appears once the key is set.
        </div>
      )}
      {pay?.ready && pay.mode === "test" && (
        <div role="status" className="card" style={{ padding: "10px 14px", fontSize: 14, borderColor: tint("var(--color-amber)", 45) }}>
          Stripe is in <strong>test mode</strong> — payments on invoice links are simulated.
        </div>
      )}

      <div className="tiles-3">
        {[
          { l: "Outstanding", v: fmtMoney(outstanding), d: `${invoices.filter((i) => i.status === "open").length} open`, hue: "var(--color-teal)" },
          { l: "Collected · this month", v: fmtMoney(collected), d: "card payments on invoices", hue: "var(--color-mint)" },
          { l: "Invoices", v: String(invoices.length), d: `${invoices.filter((i) => i.status === "paid").length} paid`, hue: "var(--color-sky)" },
        ].map((t) => (
          <div key={t.l} className="card" style={{ padding: 18, boxShadow: `inset 0 2px 0 0 ${tint(t.hue, 70)}` }}>
            <div className="total" style={{ color: t.hue }}>
              {t.v}
            </div>
            <div className="label" style={{ marginTop: 6 }}>
              {t.l}
            </div>
            <div style={{ marginTop: 8, fontSize: 13, color: "var(--color-muted)" }}>{t.d}</div>
          </div>
        ))}
      </div>

      {!draft && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload a proposal PDF to generate an invoice"
          className="card"
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileRef.current?.click();
            }
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (!drag) setDrag(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files[0];
            if (f) void readProposal(f);
          }}
          style={{
            padding: 30,
            display: "grid",
            justifyItems: "center",
            gap: 6,
            textAlign: "center",
            cursor: busy === "parse" ? "progress" : "pointer",
            borderStyle: "dashed",
            borderWidth: 2,
            borderColor: drag ? HUE : "var(--color-border)",
            background: drag ? tint(HUE, 10) : undefined,
          }}
        >
          <Icon name="invoices" size={32} style={{ ["--color-primary" as string]: HUE }} />
          <p style={{ margin: "4px 0 0", fontWeight: 600 }}>{busy === "parse" ? "Reading the proposal…" : drag ? "Drop to build the invoice" : "Drop a proposal PDF — the invoice builds itself"}</p>
          <p className="label" style={{ margin: 0 }}>
            Bills the proposal&rsquo;s initial investment (one-time + first month) · you review before anything is sent
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void readProposal(f);
              e.target.value = "";
            }}
          />
        </div>
      )}

      {formError && !draft && (
        <p role="alert" style={{ margin: 0, color: "var(--color-danger)", fontSize: 14 }}>
          {formError}
        </p>
      )}

      {created && (
        <section className="card" style={{ padding: 18, display: "grid", gap: 10, borderColor: tint("var(--color-green)", 45), background: tint("var(--color-green)", 6) }} aria-live="polite">
          <h2 className="card-title" style={{ margin: 0 }}>
            {created.number} is live{created.client.name ? ` for ${created.client.name}` : ""} · {fmtMoney(created.balance)}
          </h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input className="input" readOnly value={linkFor(created)} onFocus={(e) => e.currentTarget.select()} aria-label="Invoice link" style={{ flex: "1 1 320px", fontSize: 14 }} />
            <button type="button" className="btn btn-primary" onClick={() => copy(created)}>
              Copy link
            </button>
            <a className="btn" href={linkFor(created)} target="_blank" rel="noopener" style={{ textDecoration: "none" }}>
              Open ↗
            </a>
            {created.client.email && (
              <a className="btn" href={mailto(created)} style={{ textDecoration: "none" }}>
                Email it
              </a>
            )}
          </div>
          <p style={{ margin: 0, fontSize: 13, color: "var(--color-muted)" }}>Anyone with this link can view, download and pay the invoice — no login. Send it only to your client.</p>
        </section>
      )}

      {draft && (
        <DraftEditor
          draft={draft}
          setDraft={setDraft}
          info={parseInfo}
          editing={editing}
          feeMax={feeMax}
          busy={busy === "save"}
          error={formError}
          onSave={save}
          onCancel={() => {
            setDraft(null);
            setEditing(null);
            setParseInfo(null);
            setFormError(null);
          }}
        />
      )}

      {notice && (
        <p role="status" style={{ margin: 0, fontSize: 13, fontWeight: 500, color: "var(--color-accent)" }}>
          {notice}{" "}
          <button type="button" className="btn btn-ghost" onClick={() => setNotice(null)} style={{ minHeight: 24, padding: "2px 8px" }} aria-label="Dismiss">
            ×
          </button>
        </p>
      )}
      {loadError && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--color-danger)" }}>
          Couldn&rsquo;t load invoices · {loadError}
        </p>
      )}

      {/* no overflow clipping here: each row's More menu drops out of this card */}
      <div className="card">
        <div className="rows label" style={{ ["--cols" as string]: "96px minmax(0, 1fr) 118px 118px 104px 250px", ["--cols-sm" as string]: "minmax(0, 1fr) 100px", padding: "10px 14px", borderBottom: "1px solid var(--color-border)" }}>
          <span className="hide-sm">Number</span>
          <span>Client</span>
          <span className="hide-sm">Issued</span>
          <span className="money">Total</span>
          <span className="hide-sm" style={{ paddingLeft: 10 }}>
            Status
          </span>
          <span className="hide-sm" />
        </div>
        {!data && !loadError && <p style={{ padding: 16, margin: 0, color: "var(--color-muted)" }}>Loading invoices…</p>}
        {data && invoices.length === 0 && <p style={{ padding: 16, margin: 0, color: "var(--color-muted)" }}>No invoices yet — drop a proposal PDF above.</p>}
        {invoices.map((inv) => {
          const st = statusView(inv);
          const rowBusy = busy?.endsWith(`:${inv.id}`);
          return (
            <div key={inv.id} style={{ borderTop: "1px solid var(--color-border)" }}>
              <div className="rows" style={{ ["--cols" as string]: "96px minmax(0, 1fr) 118px 118px 104px 250px", ["--cols-sm" as string]: "minmax(0, 1fr) 100px", padding: "12px 14px", fontSize: 15 }}>
                <span className="hide-sm" style={{ fontWeight: 600 }}>
                  {inv.number}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 500, ...ellipsis }}>{inv.client.name || "—"}</span>
                  <span style={{ display: "block", fontSize: 12, color: "var(--color-muted)", ...ellipsis }}>
                    <span className="only-sm">
                      {inv.number} · <span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span> ·{" "}
                    </span>
                    {inv.status === "paid" && inv.paidAt ? `Paid ${fmtShortDate(localYmd(inv.paidAt))}` : inv.status === "open" ? (inv.dueDate ? `Due ${fmtShortDate(inv.dueDate)}` : "Due on receipt") : "Voided"}
                    {inv.subscriptions.map((s) => ` · ${fmtMoney(s.amount)}/${PER[s.interval]} from ${fmtShortDate(localYmd(s.startsAt))}`).join("")}
                    {inv.status === "open" && recurringGroups(inv.lines).map((g) => ` · then ${fmtMoney(g.amount)}/${PER[g.interval]}`).join("")}
                  </span>
                  {missingSubs(inv) && (
                    <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--color-amber)" }}>⚠ Monthly billing not set up — use More → Set up monthly billing</span>
                  )}
                </span>
                <span className="hide-sm" style={{ fontSize: 13, color: "var(--color-muted)", whiteSpace: "nowrap" }}>
                  {fmtShortDate(inv.issueDate)}
                </span>
                <span className="money" style={{ fontWeight: 600 }}>
                  {fmtMoney(inv.total)}
                  {inv.status === "open" && inv.paid > 0 && <span style={{ display: "block", fontSize: 12, fontWeight: 400, color: "var(--color-muted)" }}>{fmtMoney(inv.balance)} due</span>}
                </span>
                <span className="hide-sm" style={{ paddingLeft: 10 }}>
                  <span className="label" style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: 999, color: st.color, background: tint(st.color, 12) }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: st.color }} />
                    {st.label}
                  </span>
                </span>
                <span className="hide-sm" style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                  {inv.status !== "void" && (
                    <button type="button" className="btn" onClick={() => copy(inv)} style={{ minHeight: 32, padding: "6px 10px" }}>
                      Copy link
                    </button>
                  )}
                  <a className="btn" href={linkFor(inv)} target="_blank" rel="noopener" style={{ minHeight: 32, padding: "6px 10px", textDecoration: "none" }}>
                    Open ↗
                  </a>
                  <RowMenu
                    inv={inv}
                    busy={!!rowBusy}
                    onEdit={() => startEdit(inv)}
                    onAct={(a) => void act(inv, a)}
                    mailto={inv.client.email && inv.status === "open" ? mailto(inv) : null}
                  />
                </span>
              </div>
              {/* phones: actions on their own line */}
              <div className="show-sm" style={{ display: "none", gap: 6, padding: "0 14px 12px", flexWrap: "wrap" }}>
                {inv.status !== "void" && (
                  <button type="button" className="btn" onClick={() => copy(inv)} style={{ minHeight: 32, padding: "6px 10px" }}>
                    Copy link
                  </button>
                )}
                <a className="btn" href={linkFor(inv)} target="_blank" rel="noopener" style={{ minHeight: 32, padding: "6px 10px", textDecoration: "none" }}>
                  Open ↗
                </a>
                <RowMenu inv={inv} busy={!!rowBusy} onEdit={() => startEdit(inv)} onAct={(a) => void act(inv, a)} mailto={inv.client.email && inv.status === "open" ? mailto(inv) : null} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RowMenu({ inv, busy, onEdit, onAct, mailto }: { inv: Invoice; busy: boolean; onEdit: () => void; onAct: (a: "void" | "unvoid" | "delete" | "refresh") => void; mailto: string | null }) {
  const [open, setOpen] = useState(false);
  /** Open upward when the row sits too close to the bottom of the window for the menu to fit. */
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const item: CSSProperties = { display: "block", width: "100%", textAlign: "left", padding: "8px 12px", background: "transparent", border: 0, color: "inherit", font: "inherit", fontSize: 14, cursor: "pointer", textDecoration: "none", borderRadius: 8 };
  const unpaid = inv.payments.length === 0;
  // Worst case is 7 items at ~37px each plus the menu's padding and gap.
  const MENU_PX = 290;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="btn"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setUp(window.innerHeight - r.bottom < MENU_PX && r.top > MENU_PX);
          setOpen((v) => !v);
        }}
        style={{ minHeight: 32, padding: "6px 10px" }}
      >
        {busy ? "…" : "More"}
      </button>
      {open && (
        <div
          role="menu"
          className="card"
          style={{ position: "absolute", right: 0, ...(up ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }), zIndex: 20, minWidth: 190, padding: 6, boxShadow: "0 12px 30px -12px rgba(58,42,54,0.35)" }}
          onClick={() => setOpen(false)}
        >
          <a role="menuitem" style={item} href={`/api/public/invoices/${inv.id}/pdf`}>
            Download PDF
          </a>
          {mailto && (
            <a role="menuitem" style={item} href={mailto}>
              Email the link
            </a>
          )}
          {inv.status === "open" && unpaid && (
            <button role="menuitem" type="button" style={item} onClick={onEdit}>
              Edit
            </button>
          )}
          {inv.status === "open" && (
            <button role="menuitem" type="button" style={item} onClick={() => onAct("refresh")}>
              Check Stripe for payment
            </button>
          )}
          {missingSubs(inv) && (
            <button role="menuitem" type="button" style={{ ...item, color: "var(--color-amber)" }} onClick={() => onAct("refresh")}>
              Set up monthly billing
            </button>
          )}
          {inv.subscriptions.map((s) => (
            <a key={s.subscriptionId} role="menuitem" style={item} href={stripeSubUrl(s.subscriptionId, s.livemode)} target="_blank" rel="noopener">
              {inv.subscriptions.length > 1 ? `${s.interval === "month" ? "Monthly" : "Yearly"} subscription` : "Subscription"} in Stripe ↗
            </a>
          ))}
          {inv.source?.path && (
            <a role="menuitem" style={item} href={`/api/invoices/${inv.id}/source`} target="_blank" rel="noopener">
              Source proposal
            </a>
          )}
          {inv.status === "open" && (
            <button role="menuitem" type="button" style={{ ...item, color: "var(--color-amber)" }} onClick={() => onAct("void")}>
              Void
            </button>
          )}
          {inv.status === "void" && (
            <button role="menuitem" type="button" style={item} onClick={() => onAct("unvoid")}>
              Restore (un-void)
            </button>
          )}
          {unpaid && (
            <button role="menuitem" type="button" style={{ ...item, color: "var(--color-danger)" }} onClick={() => onAct("delete")}>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DraftEditor({
  draft,
  setDraft,
  info,
  editing,
  feeMax,
  busy,
  error,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  info: ParseInfo | null;
  editing: Invoice | null;
  feeMax: number;
  busy: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const total = draftTotal(draft);
  const fee = cardFee(total, Math.min(draft.cardFeePercent, feeMax));
  const repeats = recurringGroups(draft.lines.map((l) => ({ ...l, recurring: l.recurring ? { interval: l.recurring.interval, amount: parseAmount(l.recurringText) || 0 } : null })));
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setClient = (k: keyof Draft["client"], v: string) => set({ client: { ...draft.client, [k]: v } });
  const setLine = (i: number, patch: Partial<EditLine>) => set({ lines: draft.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const totalsMatch = info?.proposal?.totals.initial != null && round2(info.proposal.totals.initial) === total;

  return (
    <section className="card" style={{ padding: 18, display: "grid", gap: 14, boxShadow: `inset 0 2px 0 0 ${tint(HUE, 70)}` }} aria-label="Invoice draft">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
        <h2 className="card-title" style={{ margin: 0 }}>
          {editing ? `Edit ${editing.number}` : "Review the invoice"}
        </h2>
        {draft.source && (
          <span style={{ fontSize: 13, color: "var(--color-muted)" }}>
            From {draft.source.fileName}
            {draft.source.proposalDate ? ` · proposal dated ${draft.source.proposalDate}` : ""}
          </span>
        )}
      </div>

      {info && (
        <div style={{ display: "grid", gap: 6, fontSize: 14 }}>
          {info.ok ? (
            <span style={{ color: "var(--color-green)" }}>
              ✓ Read {info.proposal?.services ?? draft.lines.length} services
              {info.proposal?.totals.initial != null ? ` · proposal initial investment ${fmtMoney(info.proposal.totals.initial)}` : ""}
              {totalsMatch ? " · matches this draft" : ""}
            </span>
          ) : (
            <span style={{ color: "var(--color-amber)" }}>{info.reason} Fill the invoice in by hand below — the PDF is still attached.</span>
          )}
          {info.match && (
            <span style={{ color: "var(--color-sky)" }}>
              Found “{info.match.label}” in {info.match.kind === "customer" ? "Customers" : "the CRM"} — contact details filled in.
            </span>
          )}
          {info.warnings.map((w, i) => (
            <span key={i} style={{ color: "var(--color-amber)" }}>
              ⚠ {w}
            </span>
          ))}
        </div>
      )}

      <div>
        <div className="label" style={{ marginBottom: 6 }}>
          Bill to
        </div>
        <div className="fields">
          <input className="input" placeholder="Client / company name" value={draft.client.name} onChange={(e) => setClient("name", e.target.value)} aria-label="Client name" />
          <input className="input" type="email" placeholder="Client email (for the receipt)" value={draft.client.email} onChange={(e) => setClient("email", e.target.value)} aria-label="Client email" />
          <input className="input" type="tel" placeholder="Phone" value={draft.client.phone} onChange={(e) => setClient("phone", e.target.value)} aria-label="Client phone" />
          <input className="input" placeholder="Address" value={draft.client.address} onChange={(e) => setClient("address", e.target.value)} aria-label="Client address" />
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="label">Issue date</span>
          <input className="input" type="date" value={draft.issueDate} onChange={(e) => set({ issueDate: e.target.value })} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="label">Due date</span>
          <input className="input" type="date" value={draft.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
        </label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            { l: "On receipt", v: "" },
            { l: "Net 15", v: addDays(draft.issueDate || localToday(), 15) },
            { l: "Net 30", v: addDays(draft.issueDate || localToday(), 30) },
          ].map((o) => (
            <button key={o.l} type="button" className={`btn${draft.dueDate === o.v ? " btn-primary" : ""}`} onClick={() => set({ dueDate: o.v })} aria-pressed={draft.dueDate === o.v}>
              {o.l}
            </button>
          ))}
        </div>
      </div>

      <label style={{ display: "grid", gap: 4 }}>
        <span className="label">Project summary (shown on the invoice)</span>
        <textarea className="input" style={{ minHeight: 70, resize: "vertical" }} value={draft.project} onChange={(e) => set({ project: e.target.value })} />
      </label>

      <div>
        <div className="label" style={{ marginBottom: 6 }}>
          Line items
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {draft.lines.map((l, i) => (
            <div key={l.id + i} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 120px 130px 36px", gap: 8, alignItems: "start", padding: 10, borderRadius: 12, border: "1px solid var(--color-border)" }} className="draft-line">
              <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
                <input className="input" placeholder="Service" value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} aria-label={`Line ${i + 1} service`} style={{ fontWeight: 600 }} />
                <input className="input" placeholder="Description (optional)" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} aria-label={`Line ${i + 1} description`} style={{ fontSize: 14 }} />
                {(l.note || l.recurring) && (
                  <input className="input" placeholder="Note" value={l.note} onChange={(e) => setLine(i, { note: e.target.value })} aria-label={`Line ${i + 1} note`} style={{ fontSize: 13 }} />
                )}
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <input className="input" placeholder="Type" value={l.type} onChange={(e) => setLine(i, { type: e.target.value })} aria-label={`Line ${i + 1} type`} />
                <select
                  className="input"
                  value={l.recurring?.interval ?? ""}
                  onChange={(e) => {
                    const interval = (e.target.value || null) as RecurringInterval | null;
                    const priceText = l.recurringText || (parseAmount(l.amountText) > 0 ? l.amountText : "");
                    setLine(i, {
                      recurring: interval ? { interval, amount: parseAmount(priceText) || 0 } : null,
                      recurringText: interval ? priceText : "",
                      note: syncNote(l, interval, priceText),
                    });
                  }}
                  aria-label={`Line ${i + 1} billing`}
                  title="Repeating lines start a subscription on the client's card when they pay"
                  style={{ fontSize: 13, padding: "6px 8px" }}
                >
                  <option value="">One-time</option>
                  <option value="month">Then monthly</option>
                  <option value="year">Then yearly</option>
                </select>
              </div>
              <div style={{ display: "grid", gap: 4 }}>
                <input
                  className="input money"
                  inputMode="decimal"
                  value={l.amountText}
                  onChange={(e) => setLine(i, { amountText: e.target.value })}
                  onBlur={() => {
                    const n = parseAmount(l.amountText);
                    if (Number.isFinite(n)) setLine(i, { amountText: n.toFixed(2) });
                  }}
                  aria-label={`Line ${i + 1} amount`}
                  style={{ textAlign: "right" }}
                />
                {parseAmount(l.amountText) === 0 && <span style={{ fontSize: 12, color: "var(--color-muted)", textAlign: "right" }}>shows “{l.zeroLabel || "Included"}”</span>}
                {l.recurring && (
                  <label style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, fontSize: 12, color: "var(--color-muted)" }}>
                    then $
                    <input
                      className="input money"
                      inputMode="decimal"
                      value={l.recurringText}
                      onChange={(e) => setLine(i, { recurringText: e.target.value, note: syncNote(l, l.recurring?.interval ?? null, e.target.value) })}
                      onBlur={() => {
                        const n = parseAmount(l.recurringText);
                        if (Number.isFinite(n) && n > 0) setLine(i, { recurringText: n.toFixed(2) });
                      }}
                      aria-label={`Line ${i + 1} price per ${l.recurring.interval}`}
                      style={{ width: 76, textAlign: "right", fontSize: 13, padding: "4px 6px", minHeight: 0 }}
                    />
                    /{PER[l.recurring.interval]}
                  </label>
                )}
              </div>
              <button type="button" className="btn btn-ghost" aria-label={`Remove line ${i + 1}`} onClick={() => set({ lines: draft.lines.filter((_, j) => j !== i) })} style={{ minHeight: 36, padding: 0 }}>
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            style={{ justifySelf: "start" }}
            onClick={() => set({ lines: [...draft.lines, { id: `l${Date.now().toString(36)}`, name: "", description: "", type: "One-Time", recurring: null, amount: 0, zeroLabel: "", note: "", amountText: "", recurringText: "" }] })}
          >
            + Add line
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="label">Credit-card surcharge</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              className="input"
              type="number"
              min={0}
              max={feeMax}
              step={0.1}
              value={Math.min(draft.cardFeePercent, feeMax)}
              disabled={feeMax <= 0}
              onChange={(e) => set({ cardFeePercent: Math.min(feeMax, Math.max(0, Number(e.target.value) || 0)) })}
              style={{ width: 90 }}
              aria-label="Credit card surcharge percent"
            />
            <span style={{ fontSize: 14, color: "var(--color-muted)" }}>
              {feeMax > 0
                ? `% · credit cards only, never debit/prepaid · max ${feeMax}%`
                : "% · off until the 30-day Stripe surcharge notice has run (INVOICE_CARD_FEE_PERCENT)"}
            </span>
          </span>
        </label>
        <div style={{ textAlign: "right" }}>
          <div className="label">Invoice total</div>
          <div className="total" style={{ color: HUE }}>
            {fmtMoney(total)}
          </div>
          {fee > 0 && <div style={{ fontSize: 13, color: "var(--color-muted)" }}>Credit card: {fmtMoney(total + fee)} (incl. {fmtMoney(fee)} surcharge)</div>}
          {repeats.length > 0 && (
            <div style={{ fontSize: 13, color: "var(--color-muted)", maxWidth: 320, marginLeft: "auto" }}>
              Then {repeats.map((g) => `${fmtMoney(g.amount)}/${PER[g.interval]}`).join(" + ")} — a Stripe subscription on the client&rsquo;s card starts when they pay.
            </div>
          )}
          {repeats.length > 0 && !draft.client.email.trim() && (
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-amber)", maxWidth: 320, marginLeft: "auto" }}>
              Add the client&rsquo;s email — Stripe sends their receipts and renewal notices there.
            </div>
          )}
        </div>
      </div>

      <label style={{ display: "grid", gap: 4 }}>
        <span className="label">Notes (shown on the invoice)</span>
        <textarea className="input" style={{ minHeight: 56, resize: "vertical" }} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
      </label>

      {error && (
        <p role="alert" style={{ margin: 0, color: "var(--color-danger)", fontSize: 14 }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          {editing ? "Cancel" : "Discard"}
        </button>
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy || !draft.client.name.trim() || total <= 0} style={{ padding: "10px 18px" }}>
          {busy ? "Saving…" : editing ? "Save changes" : "Create live invoice"}
        </button>
      </div>
    </section>
  );
}
