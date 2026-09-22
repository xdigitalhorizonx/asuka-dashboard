"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CalendarEvent, Lead, Reminder, ReminderPriority } from "@/lib/types";
import { uid, useAsukaStore, useCalendarEvents } from "@/lib/store";
import { apptTime, hasAppointment, localToday, tint } from "@/lib/crm";
import { haptic } from "@/lib/haptics";
import { Icon } from "./icons";
import { Crm } from "./Crm";
import { Customers, money } from "./Customers";

type Tab = "overview" | "reminders" | "calendar" | "notes" | "files" | "crm" | "customers";
type Store = ReturnType<typeof useAsukaStore>;

/** Every section owns a pastel hue: the dock glyph, its active state and the matching overview tile use it. */
const NAV: { id: Tab; label: string; hue: string }[] = [
  { id: "overview", label: "Overview", hue: "var(--color-rose)" },
  { id: "reminders", label: "Reminders", hue: "var(--color-apricot)" },
  { id: "calendar", label: "Calendar", hue: "var(--color-sky)" },
  { id: "notes", label: "Notes", hue: "var(--color-lemon)" },
  { id: "files", label: "Attachments", hue: "var(--color-lilac)" },
  { id: "crm", label: "CRM", hue: "var(--color-lavender)" },
  { id: "customers", label: "Customers", hue: "var(--color-mint)" },
];

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}
function setHashTab(t: Tab) {
  window.location.hash = t;
}
function readHashTab(): Tab | null {
  const h = window.location.hash.replace(/^#/, "");
  return NAV.some((n) => n.id === h) ? (h as Tab) : null;
}

const PRI: ReminderPriority[] = ["low", "medium", "high"];
const PRI_LABEL: Record<ReminderPriority, string> = { high: "HIGH", medium: "MED", low: "LOW" };

function priColor(p: ReminderPriority) {
  return p === "high" ? "var(--color-danger)" : p === "medium" ? "var(--color-amber)" : "var(--color-muted)";
}

function fileKind(name: string, mime: string) {
  const ext = name.split(".").pop()?.toUpperCase() || "FILE";
  const m = mime.toLowerCase();
  if (m.includes("pdf") || ext === "PDF") return { label: "PDF", color: "var(--color-danger)" };
  if (ext === "XLSX" || ext === "XLS" || m.includes("spreadsheet")) return { label: "XLSX", color: "var(--color-green)" };
  if (ext === "CSV") return { label: "CSV", color: "var(--color-accent)" };
  if (ext === "DOCX" || ext === "DOC") return { label: "DOCX", color: "var(--color-sky)" };
  if (ext === "ZIP") return { label: "ZIP", color: "var(--color-amber)" };
  if (ext === "MP4" || m.startsWith("video/")) return { label: "MP4", color: "var(--color-violet)" };
  if (m.startsWith("image/")) return { label: ext.slice(0, 4) || "IMG", color: "var(--color-lilac)" };
  return { label: ext.slice(0, 4) || "FILE", color: "var(--color-muted)" };
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Google Calendar helpers ──
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtClock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Local calendar days an event occupies. Google's all-day `end` is exclusive (the day after). */
function eventDays(e: CalendarEvent): string[] {
  if (!e.allDay) return [isoDay(new Date(e.start))];
  const days: string[] = [];
  const end = new Date(`${e.end}T00:00:00`);
  for (let d = new Date(`${e.start}T00:00:00`), i = 0; d < end && i < 62; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), i++) days.push(isoDay(d));
  return days.length ? days : [e.start];
}
function eventTime(e: CalendarEvent): string {
  return e.allDay ? "all-day" : `${fmtClock(e.start)} – ${fmtClock(e.end)}`;
}
function eventsByDay(events: CalendarEvent[]): Record<string, CalendarEvent[]> {
  const map: Record<string, CalendarEvent[]> = {};
  for (const e of events) for (const day of eventDays(e)) (map[day] ??= []).push(e);
  for (const k of Object.keys(map)) map[k].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
  return map;
}

/** Status the Google callback appends to the URL (`/?google=…#reminders`); read once, on the client. */
function readGoogleNotice(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("google");
}
function describeGoogleNotice(status: string, account: string): { ok: boolean; text: string } {
  if (status === "connected") return { ok: true, text: "Google connected — Tasks and Calendar are live on this board." };
  if (status === "state-mismatch") return { ok: false, text: "That Google sign-in expired or was started in another tab. Press Connect again." };
  if (status.startsWith("wrong-account:")) return { ok: false, text: `Signed in as ${status.slice(14)} — only ${account || "the configured account"} can connect. Switch Google accounts and try again.` };
  if (status === "missing-tasks-scope") return { ok: false, text: "Google Tasks access wasn't granted. Connect again and allow every permission." };
  if (status.startsWith("denied:")) return { ok: false, text: `Google sign-in was cancelled (${status.slice(7)}).` };
  if (status === "not-configured") return { ok: false, text: "Google isn't configured on this deployment — GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing." };
  if (status.startsWith("error:")) return { ok: false, text: `Google connect failed: ${status.slice(6)}` };
  return { ok: false, text: `Google connect: ${status}` };
}

export default function Dashboard({ lockable = false }: { lockable?: boolean }) {
  const store = useAsukaStore();
  // Section = URL hash (#customers etc.). Server snapshot is null so hydration always starts on Overview.
  const tab = useSyncExternalStore(subscribeHash, readHashTab, () => null) ?? "overview";
  const [monthOffset, setMonthOffset] = useState(0);
  // Outcome of a Google connect round-trip, carried in the query string by /api/google/callback.
  const [googleNotice, setGoogleNotice] = useState<string | null>(readGoogleNotice);
  useEffect(() => {
    if (readGoogleNotice()) window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  }, []);

  const today = localToday();
  const openReminders = store.reminders.filter((r) => !r.done);
  const dueToday = openReminders.filter((r) => r.dueAt === today);
  const pipeline = store.leads.filter((l) => l.stage !== "lost" && l.stage !== "closed_won");
  const title = NAV.find((n) => n.id === tab)?.label ?? "Overview";

  function go(t: Tab) {
    if (t === tab) return;
    setHashTab(t); // the hash is the section's source of truth (deep-linkable, back button works)
    haptic("tap");
  }

  const syncText = store.syncError
    ? `Sync error · ${store.syncError}`
    : store.syncedAt
      ? `Synced ${new Date(store.syncedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : store.hydrated
        ? "Local only"
        : "Loading";

  return (
    <div className="stage">
      <div className="window">
        <header className="topbar">
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- static pixel-art brand mark, no optimisation wanted */}
            <img src="/icons/icon-64.png" alt="" width={36} height={36} className="pixel brand-mark" aria-hidden="true" />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Central Dogma</div>
              <div style={{ fontSize: 12, color: "var(--color-muted)", whiteSpace: "nowrap" }}>Asuka Langley · v2.4.1 · live SMS sync</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
            <span className="sync-pill" title={syncText} role="status" aria-live="polite">
              <span className={`dot-live${store.syncError ? " error" : ""}`} />
              {syncText}
            </span>
            <button type="button" onClick={store.exportJson} className="btn">Export</button>
            <label className="btn" style={{ cursor: "pointer" }}>
              Import
              <input type="file" accept="application/json" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) store.importJson(f); e.target.value = ""; }} />
            </label>
            {lockable && (
              <form method="post" action="/api/logout" style={{ display: "contents" }}>
                <button className="btn btn-ghost" title="Lock this board (sign out)">Lock</button>
              </form>
            )}
          </div>
        </header>

        <nav className="dock" aria-label="Sections">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className="dock-item"
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => go(item.id)}
              style={{ ["--color-primary" as string]: item.hue }}
            >
              <Icon name={item.id} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <main className="content">
          {!store.hydrated ? (
            <p style={{ color: "var(--color-muted)", margin: 0 }}>Loading Central Dogma…</p>
          ) : (
            <>
              {tab !== "customers" && (
                <div className="page-head">
                  <h1 className="page-title">{title}</h1>
                </div>
              )}
              {tab === "overview" ? (
                <Overview store={store} dueToday={dueToday} openReminders={openReminders} pipeline={pipeline} setTab={go} />
              ) : tab === "reminders" ? (
                <Reminders store={store} notice={googleNotice} dismissNotice={() => setGoogleNotice(null)} />
              ) : tab === "calendar" ? (
                <CalendarView
                  reminders={store.reminders}
                  leads={store.leads}
                  googleCalendar={store.google.calendar}
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
            </>
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
        <div key={i} style={{ width: 6, height: 6 + (on ? (i + 1) * 1.4 : 4), background: on ? color : "rgba(255,255,255,0.08)", borderRadius: 1 }} />
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
  const cal = useCalendarEvents(today, today, store.google.calendar);
  const eventsToday = useMemo(() => eventsByDay(cal.events)[today] ?? [], [cal.events, today]);
  const ym = today.slice(0, 7);
  const monthRevenue = store.customers.reduce((s, c) => s + c.transactions.filter((t) => t.date.startsWith(ym)).reduce((a, t) => a + t.amount, 0), 0);
  const activity = useMemo(() => {
    const rows: { t: string; type: string; color: string; label: string }[] = [];
    for (const r of store.reminders) {
      rows.push({ t: r.createdAt, type: r.done ? "DONE" : "TASK", color: r.done ? "var(--color-teal)" : priColor(r.priority), label: r.title });
    }
    for (const l of store.leads) {
      rows.push({ t: l.createdAt, type: "LEAD", color: "var(--color-sky)", label: `${l.name} · ${l.company || "no org"}` });
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
    { l: "DUE TODAY", v: dueToday.length, d: store.remindersSource === "google" ? "Google Tasks" : "SMS + board", t: "reminders" as Tab, hue: "var(--color-rose)" },
    { l: "OPEN TASKS", v: openReminders.length, d: "until resolved", t: "reminders" as Tab, hue: "var(--color-apricot)" },
    { l: "PIPELINE", v: pipeline.length, d: "active leads", t: "crm" as Tab, hue: "var(--color-sky)" },
    { l: "APPTS SET", v: apptsSet, d: apptsToday.length ? `${apptsToday.length} today` : "on the calendar", t: "crm" as Tab, hue: "var(--color-violet)" },
    { l: "CUSTOMERS", v: store.customers.length, d: monthRevenue ? `${money(monthRevenue)} this month` : "paying clients", t: "customers" as Tab, hue: "var(--color-mint)" },
    { l: "NOTES", v: store.notes.length, d: "pinned + free", t: "notes" as Tab, hue: "var(--color-lemon)" },
    { l: "FILES", v: store.attachments.length, d: "local vault", t: "files" as Tab, hue: "var(--color-lilac)" },
  ];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="tiles">
        {tiles.map((c) => (
          <button key={c.l} type="button" onClick={() => setTab(c.t)} className="card" style={{ padding: 16, textAlign: "left", cursor: "pointer", transition: "border-color 200ms, background-color 200ms", boxShadow: `inset 0 2px 0 0 ${tint(c.hue, 70)}, inset 0 1px 0 rgba(255,255,255,0.06)` }}>
            <div className="total" style={{ color: c.hue }}>{c.v}</div>
            <div className="label" style={{ marginTop: 6 }}>{c.l}</div>
            <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 8 }}>
              <span style={{ fontSize: 13, color: `color-mix(in srgb, ${c.hue} 80%, var(--color-muted))` }}>{c.d}</span>
              <Spark n={c.v} color={c.hue} />
            </div>
          </button>
        ))}
      </div>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(340px, 100%), 1fr))" }}>
        <section className="card" style={{ padding: 18 }}>
          <h2 className="card-title">Activity</h2>
          {activity.length === 0 && <p style={{ color: "var(--color-muted)", fontSize: 13 }}>No activity yet.</p>}
          {activity.map((a, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "72px 56px minmax(0, 1fr)", gap: 10, padding: "8px 0", borderTop: i ? "1px solid var(--color-border)" : "none", fontSize: 14 }}>
              <span style={{ color: "var(--color-muted)" }}>{a.t ? new Date(a.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—"}</span>
              <span style={{ color: a.color }}>{a.type}</span>
              <span>{a.label}</span>
            </div>
          ))}
        </section>
        <section className="card" style={{ padding: 18 }}>
          <h2 className="card-title">Today</h2>
          {schedule.length === 0 && apptsToday.length === 0 && eventsToday.length === 0 && <p style={{ color: "var(--color-muted)", fontSize: 13 }}>Nothing due today.</p>}
          {cal.error && <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--color-danger)" }}>Google Calendar · {cal.error}</p>}
          {eventsToday.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderTop: "1px solid var(--color-border)" }}>
              <div style={{ width: 3, borderRadius: 2, background: "var(--color-sky)" }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "var(--color-sky)" }}>{eventTime(e)} · CALENDAR</div>
                <div style={{ fontSize: 13 }}>{e.title}{e.location ? <span style={{ color: "var(--color-muted)" }}> · {e.location}</span> : null}</div>
              </div>
            </div>
          ))}
          {apptsToday.map((l) => (
            <div key={l.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderTop: "1px solid var(--color-border)" }}>
              <div style={{ width: 3, borderRadius: 2, background: "var(--color-violet)" }} />
              <div>
                <div style={{ fontSize: 13, color: "var(--color-violet)" }}>{apptTime(l.appointmentAt ?? "")} · APPOINTMENT</div>
                <div style={{ fontSize: 13 }}>{l.name}{l.company ? ` · ${l.company}` : ""}</div>
              </div>
            </div>
          ))}
          {schedule.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderTop: "1px solid var(--color-border)" }}>
              <div style={{ width: 3, borderRadius: 2, background: priColor(r.priority) }} />
              <div>
                <div style={{ fontSize: 13, color: "var(--color-accent)" }}>{r.time || "09:30"}</div>
                <div style={{ fontSize: 13 }}>{r.title}</div>
              </div>
            </div>
          ))}
        </section>
      </div>
      <section className="card" style={{ padding: 18 }}>
        <h2 className="card-title">Priority queue</h2>
        {high.length === 0 && <p style={{ color: "var(--color-muted)", fontSize: 13 }}>No high-priority open items.</p>}
        {high.map((r) => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid var(--color-border)" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--color-danger)", flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{r.title}</span>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-danger)" }}>HIGH</span>
            <span style={{ fontSize: 13, color: "var(--color-muted)" }}>{r.dueAt}{r.time ? ` ${r.time}` : ""}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function GoogleCard({ store }: { store: Store }) {
  const g = store.google;
  const dot = g.connected ? "var(--color-mint)" : g.configured ? "var(--color-amber)" : "var(--color-muted)";
  const chip = (label: string, on: boolean, hue: string) => (
    <span className="label" style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: 999, color: on ? hue : "var(--color-muted)", border: `1px solid ${on ? tint(hue, 50) : "var(--color-border)"}`, background: on ? tint(hue, 10) : "transparent" }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: on ? hue : "var(--color-muted)" }} />
      {label} {on ? "✓" : "—"}
    </span>
  );
  return (
    <section className="card" style={{ padding: 18, display: "grid", gap: 10, boxShadow: `inset 0 2px 0 0 ${tint(dot, 70)}` }}>
      <h2 className="card-title" style={{ marginBottom: 0, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: dot, boxShadow: `0 0 6px ${dot}` }} />
        Google account
      </h2>
      {!g.configured ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--color-muted)" }}>
          Not set up on this deployment. Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in Vercel, redeploy, then connect here.
        </p>
      ) : !g.connected ? (
        <>
          <p style={{ margin: 0, fontSize: 13, color: "var(--color-muted)" }}>
            Sign in as <span style={{ color: "var(--color-text)" }}>{g.account}</span> to back reminders with Google Tasks and put Google Calendar on the board.
          </p>
          <a href="/api/google/connect" className="btn btn-primary" style={{ padding: 10, textAlign: "center", textDecoration: "none" }} onClick={() => haptic("tap")}>
            Connect Google
          </a>
        </>
      ) : (
        <>
          <div style={{ fontSize: 14, fontWeight: 500, overflowWrap: "anywhere" }}>{g.email || g.account}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {chip("Tasks", g.tasks, "var(--color-mint)")}
            {chip("Calendar", g.calendar, "var(--color-sky)")}
          </div>
          <p style={{ margin: 0, fontSize: 12, color: "var(--color-muted)" }}>
            {g.via === "env"
              ? "Token comes from GOOGLE_TASKS_REFRESH_TOKEN — remove that env var in Vercel to disconnect."
              : `Connected ${g.connectedAt ? new Date(g.connectedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : ""} · token stored encrypted in the vault.`}
          </p>
          {!g.calendar && (
            <a href="/api/google/connect" className="btn" style={{ textAlign: "center", textDecoration: "none" }}>Reconnect to add Calendar</a>
          )}
          {g.via === "vault" && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={store.remindersBusy}
              onClick={() => {
                if (window.confirm(`Disconnect ${g.email || g.account}? Reminders go back to the local vault and Google Calendar disappears from the board. Nothing in Google is deleted.`)) {
                  haptic("tap");
                  void store.disconnectGoogle();
                }
              }}
            >
              {store.remindersBusy ? "Working…" : "Disconnect"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function Reminders({ store, notice, dismissNotice }: { store: Store; notice: string | null; dismissNotice: () => void }) {
  const [filter, setFilter] = useState<"all" | "active" | "done">("active");
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState(localToday());
  const [time, setTime] = useState("");
  const [priority, setPriority] = useState<ReminderPriority>("medium");
  const [notes, setNotes] = useState("");
  // Manual by default: only reminders tagged "asuka" can be swept by her full sync.
  const [source, setSource] = useState<"asuka" | "manual">("manual");
  const list = store.reminders.filter((r) => (filter === "all" ? true : filter === "done" ? r.done : !r.done));
  const google = store.remindersSource === "google";
  const badgeColor = store.remindersError ? "var(--color-danger)" : google ? "var(--color-mint)" : "var(--color-muted)";
  const badge = store.remindersError
    ? "Google Tasks · error"
    : google
      ? `Google Tasks · ${store.remindersList || ""}`
      : "Local vault · Google Tasks not connected";

  const noticeView = notice ? describeGoogleNotice(notice, store.google.account) : null;
  const noticeHue = noticeView?.ok ? "var(--color-mint)" : "var(--color-danger)";

  return (
    <div className="split split-left" style={{ ["--split-w" as string]: "320px" }}>
      <div style={{ display: "grid", gap: 12, height: "fit-content" }}>
      <form
        className="card"
        style={{ padding: 18, height: "fit-content", display: "grid", gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          store.addReminder({ id: uid("r"), title: title.trim(), notes, dueAt, time: time || undefined, priority, done: false, createdAt: new Date().toISOString(), source });
          setTitle("");
          setNotes("");
          haptic("save");
        }}
      >
        <h2 className="card-title" style={{ marginBottom: 0 }}>New reminder</h2>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task" className="input" />
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Context" className="input" style={{ height: 80 }} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className="input" />
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="input" />
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {PRI.map((p) => (
            <button type="button" key={p} onClick={() => setPriority(p)} className="btn" style={{ flex: 1, padding: "7px 0", color: priColor(p), borderColor: priority === p ? priColor(p) : "var(--color-border)" }}>{PRI_LABEL[p]}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" onClick={() => setSource("asuka")} className={`btn${source === "asuka" ? " btn-primary" : ""}`} aria-pressed={source === "asuka"}>ASUKA</button>
          <button type="button" onClick={() => setSource("manual")} className="btn" style={{ padding: "6px 10px", color: source === "manual" ? "var(--color-accent)" : "var(--color-muted)", borderColor: source === "manual" ? "var(--color-accent)" : "var(--color-border)" }}>MANUAL</button>
        </div>
        <button className="btn btn-primary" style={{ padding: 10 }}>ADD</button>
      </form>
      <GoogleCard store={store} />
      </div>
      <div>
        {noticeView && (
          <div role="status" className="card" style={{ padding: "12px 14px", marginBottom: 12, display: "flex", gap: 10, alignItems: "center", borderColor: tint(noticeHue, 45), background: tint(noticeHue, 8) }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: noticeHue, boxShadow: `0 0 6px ${noticeHue}`, flexShrink: 0 }} />
            <span style={{ fontSize: 14, flex: 1 }}>{noticeView.text}</span>
            <button type="button" className="btn btn-ghost" onClick={dismissNotice} aria-label="Dismiss" style={{ padding: "4px 8px" }}>×</button>
          </div>
        )}
        <div style={{ display: "flex", gap: 6, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
          {(["all", "active", "done"] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={`btn${filter === f ? " btn-primary" : ""}`} aria-pressed={filter === f}>{f.toUpperCase()}</button>
          ))}
          <span className="label" title={store.remindersError || (google ? "Reminders are read from and written to this Google Tasks list" : "Press Connect Google to back reminders with Google Tasks")} style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, color: badgeColor }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: badgeColor, boxShadow: `0 0 6px ${badgeColor}` }} />
            {badge}
          </span>
        </div>
        {store.remindersError && (
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--color-danger)" }}>{store.remindersError}</p>
        )}
        {google && store.remindersPending > 0 && (
          <div className="card" style={{ padding: "12px 14px", marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderColor: tint("var(--color-amber)", 45), background: tint("var(--color-amber)", 8) }}>
            <span style={{ fontSize: 14 }}>
              <span style={{ fontWeight: 600, color: "var(--color-amber)" }}>{store.remindersPending}</span>
              {store.remindersPending === 1 ? " reminder" : " reminders"} from before Google Tasks was connected {store.remindersPending === 1 ? "isn't" : "aren't"} in the list yet.
            </span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button type="button" className="btn" disabled={store.remindersBusy} onClick={store.migrateVaultReminders} style={{ background: "var(--color-amber)", borderColor: "var(--color-amber)", color: "var(--color-on-primary)" }}>
                {store.remindersBusy ? "Moving…" : "Move to Google Tasks"}
              </button>
              <button type="button" className="btn btn-ghost" disabled={store.remindersBusy} onClick={() => { if (window.confirm(`Discard ${store.remindersPending} old vault reminder${store.remindersPending === 1 ? "" : "s"}? They will not be moved to Google Tasks.`)) store.discardVaultReminders(); }}>
                Discard
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
                <span style={{ fontSize: 12, fontWeight: 500, color: priColor(r.priority) }}>{PRI_LABEL[r.priority]}</span>
                <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-muted)" }}>{r.source.toUpperCase()}</span>
              </div>
              {r.notes && <p style={{ marginTop: 4, fontSize: 13, color: "var(--color-muted)" }}>{r.notes}</p>}
              <p style={{ marginTop: 6, fontSize: 13, color: r.dueAt ? "var(--color-accent)" : "var(--color-muted)" }}>{r.dueAt || "no date"}{r.time ? ` · ${r.time}` : ""}</p>
            </div>
            <button type="button" onClick={() => store.removeReminder(r.id)} className="btn btn-danger" style={{ flexShrink: 0 }}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function CalendarView({ reminders, leads, googleCalendar, monthOffset, setMonthOffset, onToggle }: { reminders: Reminder[]; leads: Lead[]; googleCalendar: boolean; monthOffset: number; setMonthOffset: (n: number | ((p: number) => number)) => void; onToggle: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(localToday());
  const view = useMemo(() => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return { year: d.getFullYear(), month: d.getMonth(), startDow: new Date(d.getFullYear(), d.getMonth(), 1).getDay(), daysInMonth, label: d.toLocaleString("en-US", { month: "long", year: "numeric" }), from: `${d.getFullYear()}-${mm}-01`, to: `${d.getFullYear()}-${mm}-${String(daysInMonth).padStart(2, "0")}` };
  }, [monthOffset]);
  const cal = useCalendarEvents(view.from, view.to, googleCalendar);
  const evByDay = useMemo(() => eventsByDay(cal.events), [cal.events]);
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
  const detailEvents = selected ? evByDay[selected] ?? [] : [];
  const today = localToday();

  return (
    <div className="split" style={{ ["--split-w" as string]: "300px" }}>
      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <button className="btn" style={{ padding: "6px 10px" }} onClick={() => setMonthOffset((n) => n - 1)}>←</button>
          <h2 className="card-title" style={{ margin: 0 }}>{view.label}</h2>
          <button className="btn" style={{ padding: "6px 10px" }} onClick={() => setMonthOffset((n) => n + 1)}>→</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, textAlign: "center", fontSize: 12, fontWeight: 500, letterSpacing: "0.06em", color: "var(--color-muted)", marginBottom: 6 }}>
          {["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((d) => <div key={d} style={{ padding: 6 }}>{d}</div>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
          {cells.map((day, i) => {
            if (!day) return <div key={`e${i}`} />;
            const iso = `${view.year}-${String(view.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const items = byDay[iso] ?? [];
            const appts = apptByDay[iso] ?? [];
            const events = evByDay[iso] ?? [];
            const isToday = iso === today;
            const isSel = iso === selected;
            return (
              <button key={iso} type="button" onClick={() => setSelected(iso)} className="cal-cell" aria-pressed={isSel} style={{ borderRadius: 12, border: `1px solid ${isSel ? "var(--color-selected-edge)" : isToday ? "rgba(113,218,202,0.55)" : "var(--color-border)"}`, background: isSel ? "var(--color-selected)" : "transparent", padding: 6, textAlign: "left", cursor: "pointer", color: "inherit", minWidth: 0, transition: "background-color 200ms, border-color 200ms" }}>
                <div style={{ fontSize: 13, color: isToday ? "var(--color-accent)" : "var(--color-muted)" }}>{day}</div>
                <div style={{ display: "flex", gap: 3, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
                  {events.slice(0, 3).map((e) => <span key={e.id} title={`${eventTime(e)} ${e.title}`} style={{ width: 10, height: 4, borderRadius: 2, background: "var(--color-sky)" }} />)}
                  {appts.slice(0, 4).map((l) => <span key={l.id} title={`${apptTime(l.appointmentAt ?? "")} ${l.name}`} style={{ width: 6, height: 6, borderRadius: 1, background: "var(--color-violet)" }} />)}
                  {items.slice(0, 4).map((r) => <span key={r.id} style={{ width: 6, height: 6, borderRadius: "50%", background: r.done ? "var(--color-muted)" : priColor(r.priority) }} />)}
                </div>
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 10, fontSize: 12, fontWeight: 500, letterSpacing: "0.06em", color: "var(--color-muted)", flexWrap: "wrap" }}>
          {googleCalendar && <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 4, borderRadius: 2, background: "var(--color-sky)" }} />GOOGLE CALENDAR</span>}
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 6, height: 6, borderRadius: 1, background: "var(--color-violet)" }} />APPOINTMENT</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-amber)" }} />REMINDER</span>
          {!googleCalendar && <a href="#reminders" style={{ marginLeft: "auto", color: "var(--color-sky)", textDecoration: "none" }}>CONNECT GOOGLE CALENDAR →</a>}
        </div>
        {cal.error && <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--color-danger)" }}>Google Calendar · {cal.error}</p>}
      </div>
      <aside className="card" style={{ padding: 18 }}>
        <h2 className="card-title">{selected || "Day"}</h2>
        {detail.length === 0 && detailAppts.length === 0 && detailEvents.length === 0 && <p style={{ color: "var(--color-muted)", fontSize: 13 }}>No events this day.</p>}
        {detailEvents.map((e) => (
          <div key={e.id} style={{ padding: "10px 0", borderTop: "1px solid var(--color-border)" }}>
            <div style={{ fontSize: 13, color: "var(--color-sky)" }}>{eventTime(e)} · CALENDAR</div>
            <div>{e.title}</div>
            <div style={{ fontSize: 13, color: "var(--color-muted)", display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span>{e.location || "—"}</span>
              {e.link && <a href={e.link} target="_blank" rel="noreferrer" style={{ color: "var(--color-sky)", textDecoration: "none" }}>Open in Google ↗</a>}
            </div>
          </div>
        ))}
        {detailAppts.map((l) => (
          <div key={l.id} style={{ padding: "10px 0", borderTop: "1px solid var(--color-border)" }}>
            <div style={{ fontSize: 13, color: "var(--color-violet)" }}>{apptTime(l.appointmentAt ?? "")} · APPOINTMENT</div>
            <div>{l.name}</div>
            <div style={{ fontSize: 13, color: "var(--color-muted)" }}>{l.company || "—"}</div>
          </div>
        ))}
        {detail.map((r) => (
          <button key={r.id} onClick={() => onToggle(r.id)} style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: "10px 0", borderTop: "1px solid var(--color-border)" }}>
            <div style={{ fontSize: 13, color: "var(--color-accent)" }}>{r.time || "all-day"} · {PRI_LABEL[r.priority]}</div>
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
    <div className="split split-left" style={{ ["--split-w" as string]: "320px" }}>
      <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", minHeight: 320 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes" className="input" style={{ marginBottom: 10 }} />
        <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New title" className="input" />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Body" className="input" style={{ height: 70 }} />
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
            <button key={n.id} type="button" onClick={() => setSel(n.id)} aria-pressed={n.id === sel} style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 10px", borderRadius: 12, border: n.id === sel ? "1px solid var(--color-selected-edge)" : "1px solid transparent", background: n.id === sel ? "var(--color-selected)" : "transparent", color: "inherit", cursor: "pointer", minWidth: 0, transition: "background-color 200ms, border-color 200ms" }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{n.pinned ? "★ " : ""}{n.title}</div>
              <div style={{ fontSize: 13, color: "var(--color-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.body}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="card" style={{ padding: 22 }}>
        {!active ? <p style={{ color: "var(--color-muted)" }}>Select a note.</p> : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
              <h2 className="card-title" style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>{active.title}</h2>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn" style={{ padding: "6px 10px" }} onClick={() => store.setNotes((ns) => ns.map((x) => (x.id === active.id ? { ...x, pinned: !x.pinned, updatedAt: new Date().toISOString() } : x)))}>{active.pinned ? "UNPIN" : "PIN"}</button>
                <button type="button" className="btn btn-danger" onClick={() => { store.setNotes((ns) => ns.filter((x) => x.id !== active.id)); setSel(null); }}>Delete</button>
              </div>
            </div>
            <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, color: "var(--color-text)" }}>{active.body}</p>
            <p style={{ marginTop: 16, fontSize: 13, color: "var(--color-muted)" }}>{new Date(active.updatedAt).toLocaleString()}</p>
          </>
        )}
      </div>
    </div>
  );
}

function Attachments({ store }: { store: Store }) {
  return (
    <div>
      <label className="card" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, marginBottom: 16, cursor: "pointer", borderStyle: "dashed" }}>
        <p style={{ fontWeight: 500 }}>Drop files or click to upload</p>
        <p style={{ marginTop: 4, fontSize: 12, color: "var(--color-muted)" }}>STORED IN THIS BROWSER · SYNCED WITH VAULT JSON</p>
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
        <div className="rows label" style={{ ["--cols" as string]: "40px minmax(0, 1fr) 70px 80px 120px 80px", ["--cols-sm" as string]: "40px minmax(0, 1fr) 60px 72px", padding: "10px 14px", borderBottom: "1px solid var(--color-border)" }}>
          <span />
          <span>Name</span>
          <span>Type</span>
          <span className="hide-sm">Size</span>
          <span className="hide-sm">Date</span>
          <span />
        </div>
        {store.attachments.length === 0 && <p style={{ padding: 16, color: "var(--color-muted)" }}>No files yet.</p>}
        {store.attachments.map((a) => {
          const k = fileKind(a.name, a.mime);
          return (
            <div key={a.id} className="rows" style={{ ["--cols" as string]: "40px minmax(0, 1fr) 70px 80px 120px 80px", ["--cols-sm" as string]: "40px minmax(0, 1fr) 60px 72px", padding: "10px 14px", borderTop: "1px solid var(--color-border)", fontSize: 15 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: tint(k.color, 14), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, color: k.color }}>{k.label.slice(0, 1)}</div>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
              <span style={{ fontSize: 13, color: k.color }}>{k.label}</span>
              <span className="hide-sm" style={{ fontSize: 13, color: "var(--color-muted)" }}>{fmtBytes(a.size)}</span>
              <span className="hide-sm" style={{ fontSize: 13, color: "var(--color-muted)" }}>{a.createdAt.slice(0, 10)}</span>
              <button type="button" onClick={() => store.setAttachments((as) => as.filter((x) => x.id !== a.id))} className="btn btn-danger" style={{ minHeight: 32, padding: "6px 10px" }}>Del</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
