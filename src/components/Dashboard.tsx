"use client";

import { useMemo, useState, type CSSProperties } from "react";
import type { Lead, Reminder, ReminderPriority } from "@/lib/types";
import { uid, useAsukaStore } from "@/lib/store";
import { apptTime, hasAppointment, localToday, tint } from "@/lib/crm";
import { Crm } from "./Crm";
import { Customers, money } from "./Customers";

type Tab = "overview" | "reminders" | "calendar" | "notes" | "files" | "crm" | "customers";
type Store = ReturnType<typeof useAsukaStore>;

/** Every section owns a pastel hue, so the board doesn't collapse into one accent colour. */
const NAV: { id: Tab; label: string; icon: string; hue: string }[] = [
  { id: "overview", label: "Overview", icon: "▣", hue: "var(--color-primary)" },
  { id: "reminders", label: "Reminders", icon: "☑", hue: "var(--color-amber)" },
  { id: "calendar", label: "Calendar", icon: "▦", hue: "var(--color-accent)" },
  { id: "notes", label: "Notes", icon: "✎", hue: "var(--color-lemon)" },
  { id: "files", label: "Attachments", icon: "▢", hue: "var(--color-lilac)" },
  { id: "crm", label: "CRM", icon: "◈", hue: "var(--color-violet)" },
  { id: "customers", label: "Customers", icon: "$", hue: "var(--color-green)" },
];

const PRI: ReminderPriority[] = ["low", "medium", "high"];
const PRI_LABEL: Record<ReminderPriority, string> = { high: "HIGH", medium: "MED", low: "LOW" };

function priColor(p: ReminderPriority) {
  return p === "high" ? "var(--color-primary)" : p === "medium" ? "var(--color-amber)" : "var(--color-muted)";
}

function fileKind(name: string, mime: string) {
  const ext = name.split(".").pop()?.toUpperCase() || "FILE";
  const m = mime.toLowerCase();
  if (m.includes("pdf") || ext === "PDF") return { label: "PDF", color: "var(--color-primary)" };
  if (ext === "XLSX" || ext === "XLS" || m.includes("spreadsheet")) return { label: "XLSX", color: "var(--color-green)" };
  if (ext === "CSV") return { label: "CSV", color: "var(--color-teal)" };
  if (ext === "DOCX" || ext === "DOC") return { label: "DOCX", color: "var(--color-accent)" };
  if (ext === "ZIP") return { label: "ZIP", color: "var(--color-amber)" };
  if (ext === "MP4" || m.startsWith("video/")) return { label: "MP4", color: "var(--color-lilac)" };
  if (m.startsWith("image/")) return { label: ext.slice(0, 4) || "IMG", color: "var(--color-violet)" };
  return { label: ext.slice(0, 4) || "FILE", color: "var(--color-muted)" };
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Dashboard({ lockable = false }: { lockable?: boolean }) {
  const store = useAsukaStore();
  const [tab, setTab] = useState<Tab>("overview");
  const [collapsed, setCollapsed] = useState(false);
  const [monthOffset, setMonthOffset] = useState(0);

  const today = localToday();
  const openReminders = store.reminders.filter((r) => !r.done);
  const dueToday = openReminders.filter((r) => r.dueAt === today);
  const pipeline = store.leads.filter((l) => l.stage !== "lost" && l.stage !== "closed_won");

  return (
    <div className="app-bg" style={{ display: "flex", minHeight: "100vh", color: "var(--color-text)" }}>
      <aside
        style={{
          width: collapsed ? 60 : 220,
          flexShrink: 0,
          background: "var(--color-surface)",
          borderRight: "1px solid var(--color-border)",
          display: "flex",
          flexDirection: "column",
          transition: "width 0.18s ease",
        }}
      >
        <div style={{ height: 56, display: "flex", alignItems: "center", gap: 10, padding: "0 14px", borderBottom: "1px solid var(--color-border)" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- static pixel-art brand mark, no optimisation wanted */}
          <img src="/icons/icon-64.png" alt="" width={32} height={32} className="pixel" style={{ borderRadius: 8, flexShrink: 0, boxShadow: `0 0 0 1px ${tint("var(--color-primary)", 45)}` }} />
          {!collapsed && (
            <div style={{ overflow: "hidden" }}>
              <div style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--color-primary)", fontFamily: "var(--font-geist-mono), var(--font-mono)", whiteSpace: "nowrap" }}>ASUKA · GROKBOT</div>
              <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>Central Dogma</div>
            </div>
          )}
        </div>
        <nav style={{ padding: 10, display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          {NAV.map((item) => {
            const on = tab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                title={item.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 12px",
                  borderRadius: 7,
                  border: `1px solid ${on ? tint(item.hue, 45) : "transparent"}`,
                  background: on ? tint(item.hue, 11) : "transparent",
                  color: on ? item.hue : "var(--color-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span style={{ width: 20, textAlign: "center", flexShrink: 0, color: on ? item.hue : `color-mix(in srgb, ${item.hue} 55%, var(--color-muted))` }}>{item.icon}</span>
                {!collapsed && <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: "0.02em" }}>{item.label}</span>}
              </button>
            );
          })}
        </nav>
        <div style={{ padding: 10, borderTop: "1px solid var(--color-border)" }}>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="btn"
            style={{ width: "100%", padding: "8px 10px", color: "var(--color-muted)" }}
          >
            {collapsed ? "»" : "« collapse"}
          </button>
        </div>
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <header style={{ height: 56, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface)" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Central Dogma</div>
            <div style={{ fontSize: 11, fontFamily: "var(--font-geist-mono), var(--font-mono)", color: "var(--color-muted)" }}>Asuka Langley · v2.4.1 · live SMS sync</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 11 }}>
              <span className="dot-live" style={store.syncError ? { background: "var(--color-primary)", boxShadow: "0 0 8px var(--color-primary)" } : undefined} />
              {store.syncError
                ? `SYNC ERROR · ${store.syncError}`
                : store.syncedAt
                  ? `SYNCED ${new Date(store.syncedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                  : store.hydrated
                    ? "LOCAL"
                    : "LOADING"}
            </div>
            <button onClick={store.exportJson} className="btn" style={{ padding: "7px 12px" }}>EXPORT</button>
            <label className="btn" style={{ padding: "7px 12px", cursor: "pointer" }}>
              IMPORT
              <input type="file" accept="application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) store.importJson(f); e.target.value = ""; }} />
            </label>
            {lockable && (
              <form method="post" action="/api/logout" style={{ display: "contents" }}>
                <button className="btn" style={{ padding: "7px 12px", color: "var(--color-muted)" }} title="Lock this board (sign out)">LOCK</button>
              </form>
            )}
          </div>
        </header>

        <main style={{ flex: 1, padding: 24, overflow: "auto" }}>
          {!store.hydrated ? (
            <p style={{ color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 12 }}>Loading Central Dogma…</p>
          ) : tab === "overview" ? (
            <Overview store={store} dueToday={dueToday} openReminders={openReminders} pipeline={pipeline} setTab={setTab} />
          ) : tab === "reminders" ? (
            <Reminders store={store} />
          ) : tab === "calendar" ? (
            <CalendarView
              reminders={store.reminders}
              leads={store.leads}
              monthOffset={monthOffset}
              setMonthOffset={setMonthOffset}
              onToggle={(id) => store.toggleReminder(id)}
            />
          ) : tab === "notes" ? (
            <Notes store={store} />
          ) : tab === "files" ? (
            <Attachments store={store} />
          ) : tab === "customers" ? (
            <Customers store={store} />
          ) : (
            <Crm store={store} />
          )}
        </main>
      </div>
    </div>
  );
}

function Spark({ n, max = 8, color = "var(--color-accent)" }: { n: number; max?: number; color?: string }) {
  const bars = Array.from({ length: 8 }, (_, i) => i < Math.min(8, Math.max(1, Math.round((n / Math.max(max, 1)) * 8))));
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 18 }}>
      {bars.map((on, i) => (
        <div key={i} style={{ width: 6, height: 6 + (on ? (i + 1) * 1.4 : 4), background: on ? color : tint("var(--color-text)", 7), borderRadius: 1 }} />
      ))}
    </div>
  );
}

function Overview({ store, dueToday, openReminders, pipeline, setTab }: { store: Store; dueToday: Reminder[]; openReminders: Reminder[]; pipeline: Lead[]; setTab: (t: Tab) => void }) {
  const high = openReminders.filter((r) => r.priority === "high");
  const today = localToday();
  const schedule = openReminders.filter((r) => r.dueAt === today).slice(0, 6);
  const apptsToday = store.leads
    .filter((l) => hasAppointment(l) && l.appointmentAt.slice(0, 10) === today)
    .sort((a, b) => (a.appointmentAt || "").localeCompare(b.appointmentAt || ""));
  const apptsSet = store.leads.filter((l) => l.stage === "appointment_set").length;
  const ym = today.slice(0, 7);
  const monthRevenue = store.customers.reduce((s, c) => s + c.transactions.filter((t) => t.date.startsWith(ym)).reduce((a, t) => a + t.amount, 0), 0);
  const activity = useMemo(() => {
    const rows: { t: string; type: string; color: string; label: string }[] = [];
    for (const r of store.reminders) {
      rows.push({ t: r.createdAt, type: r.done ? "DONE" : "TASK", color: r.done ? "var(--color-teal)" : priColor(r.priority), label: r.title });
    }
    for (const l of store.leads) {
      rows.push({ t: l.createdAt, type: "LEAD", color: "var(--color-accent)", label: `${l.name} · ${l.company || "no org"}` });
      for (const n of l.noteLog) {
        rows.push({ t: n.createdAt, type: "NOTE", color: "var(--color-violet)", label: `${l.name} — ${n.body.length > 90 ? n.body.slice(0, 90) + "…" : n.body}` });
      }
    }
    for (const c of store.customers) {
      for (const t of c.transactions) {
        rows.push({ t: t.createdAt, type: "PAID", color: "var(--color-green)", label: `${c.company || c.contact || "Customer"} · ${money(t.amount)} ${t.method}${t.memo ? ` · ${t.memo}` : ""}` });
      }
    }
    return rows.sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 8);
  }, [store.reminders, store.leads, store.customers]);

  const tiles = [
    { l: "DUE TODAY", v: dueToday.length, d: store.remindersSource === "google" ? "Google Tasks" : "SMS + board", t: "reminders" as Tab, hue: "var(--color-primary)" },
    { l: "OPEN TASKS", v: openReminders.length, d: "until resolved", t: "reminders" as Tab, hue: "var(--color-amber)" },
    { l: "PIPELINE", v: pipeline.length, d: "active leads", t: "crm" as Tab, hue: "var(--color-accent)" },
    { l: "APPTS SET", v: apptsSet, d: apptsToday.length ? `${apptsToday.length} today` : "on the calendar", t: "crm" as Tab, hue: "var(--color-violet)" },
    { l: "CUSTOMERS", v: store.customers.length, d: monthRevenue ? `${money(monthRevenue)} this month` : "paying clients", t: "customers" as Tab, hue: "var(--color-green)" },
    { l: "NOTES", v: store.notes.length, d: "pinned + free", t: "notes" as Tab, hue: "var(--color-lemon)" },
    { l: "FILES", v: store.attachments.length, d: "local vault", t: "files" as Tab, hue: "var(--color-lilac)" },
  ];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        {tiles.map((c) => (
          <button key={c.l} onClick={() => setTab(c.t)} className="card" style={{ padding: 16, textAlign: "left", cursor: "pointer", boxShadow: `inset 0 2px 0 0 ${tint(c.hue, 70)}` }}>
            <div style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 28, fontWeight: 500, letterSpacing: "-0.03em", color: c.hue }}>{c.v}</div>
            <div style={{ marginTop: 6, fontSize: 10, letterSpacing: "0.14em", color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>{c.l}</div>
            <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
              <span style={{ fontSize: 11, color: `color-mix(in srgb, ${c.hue} 80%, var(--color-muted))`, fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>{c.d}</span>
              <Spark n={c.v} color={c.hue} />
            </div>
          </button>
        ))}
      </div>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1.2fr 1fr" }}>
        <section className="card" style={{ padding: 18 }}>
          <h2 style={{ fontSize: 11, letterSpacing: "0.16em", color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)", marginBottom: 12 }}>ACTIVITY</h2>
          {activity.length === 0 && <p style={{ color: "var(--color-muted)", fontSize: 13 }}>No activity yet.</p>}
          {activity.map((a, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "72px 64px 1fr", gap: 10, padding: "8px 0", borderTop: i ? "1px solid var(--color-border)" : "none", fontSize: 12 }}>
              <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", color: "var(--color-muted)" }}>{a.t ? new Date(a.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—"}</span>
              <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", color: a.color }}>{a.type}</span>
              <span>{a.label}</span>
            </div>
          ))}
        </section>
        <section className="card" style={{ padding: 18 }}>
          <h2 style={{ fontSize: 11, letterSpacing: "0.16em", color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)", marginBottom: 12 }}>TODAY · SCHEDULE</h2>
          {schedule.length === 0 && apptsToday.length === 0 && <p style={{ color: "var(--color-muted)", fontSize: 13 }}>Nothing due today.</p>}
          {apptsToday.map((l) => (
            <div key={l.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderTop: "1px solid var(--color-border)" }}>
              <div style={{ width: 3, borderRadius: 2, background: "var(--color-violet)" }} />
              <div>
                <div style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 11, color: "var(--color-violet)" }}>{apptTime(l.appointmentAt ?? "")} · APPOINTMENT</div>
                <div style={{ fontSize: 13 }}>{l.name}{l.company ? ` · ${l.company}` : ""}</div>
              </div>
            </div>
          ))}
          {schedule.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderTop: "1px solid var(--color-border)" }}>
              <div style={{ width: 3, borderRadius: 2, background: priColor(r.priority) }} />
              <div>
                <div style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 11, color: "var(--color-accent)" }}>{r.time || "09:30"}</div>
                <div style={{ fontSize: 13 }}>{r.title}</div>
              </div>
            </div>
          ))}
        </section>
      </div>
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 11, letterSpacing: "0.16em", color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)", marginBottom: 12 }}>PRIORITY QUEUE</h2>
        {high.length === 0 && <p style={{ color: "var(--color-muted)", fontSize: 13 }}>No high-priority open items.</p>}
        {high.map((r) => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid var(--color-border)" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--color-primary)" }} />
            <span style={{ flex: 1 }}>{r.title}</span>
            <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 11, color: "var(--color-primary)" }}>HIGH</span>
            <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 11, color: "var(--color-muted)" }}>{r.dueAt}{r.time ? ` ${r.time}` : ""}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function Reminders({ store }: { store: Store }) {
  const [filter, setFilter] = useState<"all" | "active" | "done">("active");
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState(localToday());
  const [time, setTime] = useState("");
  const [priority, setPriority] = useState<ReminderPriority>("medium");
  const [notes, setNotes] = useState("");
  const [source, setSource] = useState<"asuka" | "manual">("manual");
  const list = store.reminders.filter((r) => (filter === "all" ? true : filter === "done" ? r.done : !r.done));
  const google = store.remindersSource === "google";
  const badgeColor = store.remindersError ? "var(--color-primary)" : google ? "var(--color-green)" : "var(--color-muted)";
  const badge = store.remindersError
    ? "GOOGLE TASKS · ERROR"
    : google
      ? `GOOGLE TASKS · ${(store.remindersList || "").toUpperCase()}`
      : "LOCAL VAULT · GOOGLE TASKS NOT CONNECTED";

  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "320px 1fr" }}>
      <form
        className="card"
        style={{ padding: 18, height: "fit-content", display: "grid", gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          store.addReminder({ id: uid("r"), title: title.trim(), notes, dueAt, time: time || undefined, priority, done: false, createdAt: new Date().toISOString(), source });
          setTitle("");
          setNotes("");
        }}
      >
        <h2 style={{ fontSize: 11, letterSpacing: "0.16em", color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>NEW REMINDER</h2>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task" style={inp} />
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Context" style={{ ...inp, height: 80 }} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} style={inp} />
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inp} />
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {PRI.map((p) => (
            <button type="button" key={p} onClick={() => setPriority(p)} className="btn" style={{ flex: 1, padding: "7px 0", color: priColor(p), borderColor: priority === p ? priColor(p) : "var(--color-border)" }}>{PRI_LABEL[p]}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" onClick={() => setSource("asuka")} className="btn" style={{ padding: "6px 10px", background: source === "asuka" ? "var(--color-primary)" : "transparent", borderColor: source === "asuka" ? "var(--color-primary)" : "var(--color-border)", color: source === "asuka" ? "var(--color-ink)" : "var(--color-muted)" }}>ASUKA</button>
          <button type="button" onClick={() => setSource("manual")} className="btn" style={{ padding: "6px 10px", color: source === "manual" ? "var(--color-accent)" : "var(--color-muted)", borderColor: source === "manual" ? "var(--color-accent)" : "var(--color-border)" }}>MANUAL</button>
        </div>
        <button className="btn btn-primary" style={{ padding: 10 }}>ADD</button>
      </form>
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
          {(["all", "active", "done"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className="btn" style={{ padding: "6px 12px", color: filter === f ? "var(--color-ink)" : "var(--color-muted)", background: filter === f ? "var(--color-amber)" : "transparent", borderColor: filter === f ? "var(--color-amber)" : "var(--color-border)" }}>{f.toUpperCase()}</button>
          ))}
          <span title={store.remindersError || (google ? "Reminders are read from and written to this Google Tasks list" : "Set the GOOGLE_* env vars to back reminders with Google Tasks")} style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 10, letterSpacing: "0.12em", color: badgeColor }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: badgeColor, boxShadow: `0 0 6px ${badgeColor}` }} />
            {badge}
          </span>
        </div>
        {store.remindersError && (
          <p style={{ margin: "0 0 12px", fontSize: 11, fontFamily: "var(--font-geist-mono), var(--font-mono)", color: "var(--color-primary)" }}>{store.remindersError}</p>
        )}
        {google && store.remindersPending > 0 && (
          <div className="card" style={{ padding: "12px 14px", marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderColor: tint("var(--color-amber)", 45), background: tint("var(--color-amber)", 6) }}>
            <span style={{ fontSize: 13 }}>
              <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", color: "var(--color-amber)" }}>{store.remindersPending}</span>
              {store.remindersPending === 1 ? " reminder" : " reminders"} from before Google Tasks was connected {store.remindersPending === 1 ? "isn't" : "aren't"} in the list yet.
            </span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button type="button" className="btn" disabled={store.remindersBusy} onClick={store.migrateVaultReminders} style={{ padding: "6px 10px", background: "var(--color-amber)", borderColor: "var(--color-amber)", color: "var(--color-ink)", fontWeight: 500, opacity: store.remindersBusy ? 0.6 : 1 }}>
                {store.remindersBusy ? "MOVING…" : "MOVE TO GOOGLE TASKS"}
              </button>
              <button type="button" className="btn" disabled={store.remindersBusy} onClick={() => { if (window.confirm(`Discard ${store.remindersPending} old vault reminder${store.remindersPending === 1 ? "" : "s"}? They will not be moved to Google Tasks.`)) store.discardVaultReminders(); }} style={{ padding: "6px 10px", color: "var(--color-muted)" }}>
                DISCARD
              </button>
            </span>
          </div>
        )}
        {list.length === 0 && <p style={{ color: "var(--color-muted)" }}>No reminders in this filter.</p>}
        {list.map((r) => (
          <div key={r.id} className="card" style={{ padding: 14, marginBottom: 8, display: "flex", gap: 12, alignItems: "flex-start", opacity: r.done ? 0.5 : 1 }}>
            <button
              onClick={() => store.toggleReminder(r.id)}
              style={{ width: 18, height: 18, marginTop: 2, borderRadius: 4, border: `1.5px solid ${priColor(r.priority)}`, background: r.done ? priColor(r.priority) : "transparent", cursor: "pointer", flexShrink: 0 }}
              aria-label={r.done ? "Undo" : "Done"}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 500 }}>{r.title}</span>
                <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 10, color: priColor(r.priority) }}>{PRI_LABEL[r.priority]}</span>
                <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 10, color: "var(--color-muted)" }}>{r.source.toUpperCase()}</span>
              </div>
              {r.notes && <p style={{ marginTop: 4, fontSize: 13, color: "var(--color-muted)" }}>{r.notes}</p>}
              <p style={{ marginTop: 6, fontSize: 11, fontFamily: "var(--font-geist-mono), var(--font-mono)", color: r.dueAt ? "var(--color-accent)" : "var(--color-muted)" }}>{r.dueAt || "no date"}{r.time ? ` · ${r.time}` : ""}</p>
            </div>
            <button onClick={() => store.removeReminder(r.id)} className="btn" style={{ padding: "5px 8px", color: "var(--color-primary)" }}>REMOVE</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function CalendarView({ reminders, leads, monthOffset, setMonthOffset, onToggle }: { reminders: Reminder[]; leads: Lead[]; monthOffset: number; setMonthOffset: (n: number | ((p: number) => number)) => void; onToggle: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(localToday());
  const view = useMemo(() => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    return { year: d.getFullYear(), month: d.getMonth(), startDow: new Date(d.getFullYear(), d.getMonth(), 1).getDay(), daysInMonth: new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(), label: d.toLocaleString("en-US", { month: "long", year: "numeric" }) };
  }, [monthOffset]);
  const byDay = useMemo(() => {
    const map: Record<string, Reminder[]> = {};
    for (const r of reminders) (map[r.dueAt] ??= []).push(r);
    return map;
  }, [reminders]);
  const apptByDay = useMemo(() => {
    const map: Record<string, Lead[]> = {};
    for (const l of leads) {
      if (!hasAppointment(l)) continue;
      (map[l.appointmentAt.slice(0, 10)] ??= []).push(l);
    }
    for (const k of Object.keys(map)) map[k].sort((a, b) => (a.appointmentAt || "").localeCompare(b.appointmentAt || ""));
    return map;
  }, [leads]);
  const cells: (number | null)[] = [...Array(view.startDow).fill(null), ...Array.from({ length: view.daysInMonth }, (_, i) => i + 1)];
  const detail = selected ? byDay[selected] ?? [] : [];
  const detailAppts = selected ? apptByDay[selected] ?? [] : [];
  const today = localToday();

  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr 280px" }}>
      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <button className="btn" style={{ padding: "6px 10px" }} onClick={() => setMonthOffset((n) => n - 1)}>←</button>
          <h2 style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 13, letterSpacing: "0.08em" }}>{view.label.toUpperCase()}</h2>
          <button className="btn" style={{ padding: "6px 10px" }} onClick={() => setMonthOffset((n) => n + 1)}>→</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, textAlign: "center", fontSize: 10, letterSpacing: "0.12em", color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)", marginBottom: 6 }}>
          {["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((d) => <div key={d} style={{ padding: 6 }}>{d}</div>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
          {cells.map((day, i) => {
            if (!day) return <div key={`e${i}`} />;
            const iso = `${view.year}-${String(view.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const items = byDay[iso] ?? [];
            const appts = apptByDay[iso] ?? [];
            const isToday = iso === today;
            const isSel = iso === selected;
            return (
              <button key={iso} onClick={() => setSelected(iso)} style={{ minHeight: 72, borderRadius: 8, border: `1px solid ${isSel ? "var(--color-accent)" : isToday ? tint("var(--color-accent)", 45) : "var(--color-border)"}`, background: isSel ? tint("var(--color-accent)", 10) : isToday ? tint("var(--color-accent)", 4) : "transparent", padding: 6, textAlign: "left", cursor: "pointer", color: "inherit" }}>
                <div style={{ fontSize: 11, fontFamily: "var(--font-geist-mono), var(--font-mono)", color: isToday ? "var(--color-accent)" : "var(--color-muted)" }}>{day}</div>
                <div style={{ display: "flex", gap: 3, marginTop: 6, flexWrap: "wrap" }}>
                  {appts.slice(0, 4).map((l) => <span key={l.id} title={`${apptTime(l.appointmentAt ?? "")} ${l.name}`} style={{ width: 6, height: 6, borderRadius: 1, background: "var(--color-violet)" }} />)}
                  {items.slice(0, 4).map((r) => <span key={r.id} style={{ width: 6, height: 6, borderRadius: "50%", background: r.done ? "var(--color-muted)" : priColor(r.priority) }} />)}
                </div>
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 10, fontSize: 10, letterSpacing: "0.1em", color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 6, height: 6, borderRadius: 1, background: "var(--color-violet)" }} />APPOINTMENT</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-amber)" }} />REMINDER</span>
        </div>
      </div>
      <aside className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 11, letterSpacing: "0.16em", color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)", marginBottom: 12 }}>{selected || "DAY"}</h2>
        {detail.length === 0 && detailAppts.length === 0 && <p style={{ color: "var(--color-muted)", fontSize: 13 }}>No events this day.</p>}
        {detailAppts.map((l) => (
          <div key={l.id} style={{ padding: "10px 0", borderTop: "1px solid var(--color-border)" }}>
            <div style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 11, color: "var(--color-violet)" }}>{apptTime(l.appointmentAt ?? "")} · APPOINTMENT</div>
            <div>{l.name}</div>
            <div style={{ fontSize: 11, color: "var(--color-muted)" }}>{l.company || "—"}</div>
          </div>
        ))}
        {detail.map((r) => (
          <button key={r.id} onClick={() => onToggle(r.id)} style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: "10px 0", borderTop: "1px solid var(--color-border)" }}>
            <div style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 11, color: "var(--color-accent)" }}>{r.time || "all-day"} · {PRI_LABEL[r.priority]}</div>
            <div style={{ textDecoration: r.done ? "line-through" : "none" }}>{r.title}</div>
          </button>
        ))}
      </aside>
    </div>
  );
}

function Notes({ store }: { store: Store }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(store.notes[0]?.id ?? null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const filtered = store.notes.filter((n) => `${n.title} ${n.body}`.toLowerCase().includes(q.toLowerCase()));
  const active = store.notes.find((n) => n.id === sel) || null;

  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "320px 1fr" }}>
      <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", minHeight: 480 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes" style={{ ...inp, marginBottom: 10 }} />
        <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New title" style={inp} />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Body" style={{ ...inp, height: 70 }} />
          <button
            className="btn btn-primary"
            style={{ padding: 8 }}
            onClick={() => {
              if (!title.trim() && !body.trim()) return;
              const id = uid("n");
              store.setNotes((ns) => [{ id, title: title || "Untitled", body, updatedAt: new Date().toISOString(), pinned: false }, ...ns]);
              setSel(id);
              setTitle("");
              setBody("");
            }}
          >SAVE NOTE</button>
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          {filtered.sort((a, b) => Number(b.pinned) - Number(a.pinned)).map((n) => (
            <button key={n.id} onClick={() => setSel(n.id)} style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 8px", borderRadius: 7, border: `1px solid ${n.id === sel ? tint("var(--color-lemon)", 45) : "transparent"}`, background: n.id === sel ? tint("var(--color-lemon)", 8) : "transparent", color: "inherit", cursor: "pointer" }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{n.pinned ? <span style={{ color: "var(--color-lemon)" }}>★ </span> : ""}{n.title}</div>
              <div style={{ fontSize: 11, color: "var(--color-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.body}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="card" style={{ padding: 22 }}>
        {!active ? <p style={{ color: "var(--color-muted)" }}>Select a note.</p> : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
              <h2 style={{ fontSize: 18, fontWeight: 600 }}>{active.title}</h2>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn" style={{ padding: "6px 10px" }} onClick={() => store.setNotes((ns) => ns.map((x) => (x.id === active.id ? { ...x, pinned: !x.pinned, updatedAt: new Date().toISOString() } : x)))}>{active.pinned ? "UNPIN" : "PIN"}</button>
                <button className="btn" style={{ padding: "6px 10px", color: "var(--color-primary)" }} onClick={() => { store.setNotes((ns) => ns.filter((x) => x.id !== active.id)); setSel(null); }}>DELETE</button>
              </div>
            </div>
            <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, color: "var(--color-text)" }}>{active.body}</p>
            <p style={{ marginTop: 16, fontSize: 11, color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>{new Date(active.updatedAt).toLocaleString()}</p>
          </>
        )}
      </div>
    </div>
  );
}

function Attachments({ store }: { store: Store }) {
  return (
    <div>
      <label className="card" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, marginBottom: 16, cursor: "pointer", borderStyle: "dashed", borderColor: tint("var(--color-lilac)", 35) }}>
        <p style={{ fontWeight: 500 }}>Drop files or click to upload</p>
        <p style={{ marginTop: 4, fontSize: 12, color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>STORED IN THIS BROWSER · SYNCED WITH VAULT JSON</p>
        <input type="file" multiple className="hidden" onChange={(e) => {
          const list = e.target.files; if (!list) return;
          Array.from(list).forEach((file) => {
            const reader = new FileReader();
            reader.onload = () => store.setAttachments((as) => [{ id: uid("a"), name: file.name, mime: file.type || "application/octet-stream", size: file.size, dataUrl: String(reader.result), createdAt: new Date().toISOString() }, ...as]);
            reader.readAsDataURL(file);
          });
        }} />
      </label>
      <div className="card" style={{ overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 70px 80px 120px 70px", gap: 8, padding: "10px 14px", fontSize: 10, letterSpacing: "0.12em", color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)", borderBottom: "1px solid var(--color-border)" }}>
          <span />
          <span>NAME</span>
          <span>TYPE</span>
          <span>SIZE</span>
          <span>DATE</span>
          <span />
        </div>
        {store.attachments.length === 0 && <p style={{ padding: 16, color: "var(--color-muted)" }}>No files yet.</p>}
        {store.attachments.map((a) => {
          const k = fileKind(a.name, a.mime);
          return (
            <div key={a.id} style={{ display: "grid", gridTemplateColumns: "40px 1fr 70px 80px 120px 70px", gap: 8, padding: "10px 14px", alignItems: "center", borderTop: "1px solid var(--color-border)", fontSize: 13 }}>
              <div style={{ width: 28, height: 28, borderRadius: 6, background: tint(k.color, 14), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: k.color, fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>{k.label.slice(0, 1)}</div>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
              <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 11, color: k.color }}>{k.label}</span>
              <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 11, color: "var(--color-muted)" }}>{fmtBytes(a.size)}</span>
              <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 11, color: "var(--color-muted)" }}>{a.createdAt.slice(0, 10)}</span>
              <button onClick={() => store.setAttachments((as) => as.filter((x) => x.id !== a.id))} className="btn" style={{ padding: "4px 8px", color: "var(--color-primary)" }}>DEL</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const inp: CSSProperties = {
  width: "100%",
  borderRadius: 7,
  border: "1px solid var(--color-border)",
  background: "var(--color-bg)",
  padding: "8px 10px",
  fontSize: 13,
  outline: "none",
};
