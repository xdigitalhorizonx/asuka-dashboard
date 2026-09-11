"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { CRM_STAGES, type CrmStage, type Lead, type Reminder, type ReminderPriority } from "@/lib/types";
import { uid, useAsukaStore } from "@/lib/store";

type Tab = "overview" | "reminders" | "calendar" | "notes" | "files" | "crm";
type Store = ReturnType<typeof useAsukaStore>;

const NAV: { id: Tab; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "▣" },
  { id: "reminders", label: "Reminders", icon: "☑" },
  { id: "calendar", label: "Calendar", icon: "▦" },
  { id: "notes", label: "Notes", icon: "✎" },
  { id: "files", label: "Attachments", icon: "▢" },
  { id: "crm", label: "CRM", icon: "◈" },
];

const PRI: ReminderPriority[] = ["low", "medium", "high"];
const PRI_LABEL: Record<ReminderPriority, string> = { high: "HIGH", medium: "MED", low: "LOW" };

function priColor(p: ReminderPriority) {
  return p === "high" ? "var(--color-primary)" : p === "medium" ? "var(--color-amber)" : "var(--color-muted)";
}

function stageColor(s: CrmStage) {
  if (s === "new_lead") return "var(--color-accent)";
  if (s === "proposal_sent") return "var(--color-amber)";
  if (s === "closed_won") return "var(--color-green)";
  return "var(--color-muted)";
}

function fileKind(name: string, mime: string) {
  const ext = name.split(".").pop()?.toUpperCase() || "FILE";
  const m = mime.toLowerCase();
  if (m.includes("pdf") || ext === "PDF") return { label: "PDF", color: "var(--color-primary)" };
  if (ext === "XLSX" || ext === "XLS" || m.includes("spreadsheet")) return { label: "XLSX", color: "var(--color-green)" };
  if (ext === "CSV") return { label: "CSV", color: "var(--color-accent)" };
  if (ext === "DOCX" || ext === "DOC") return { label: "DOCX", color: "var(--color-accent)" };
  if (ext === "ZIP") return { label: "ZIP", color: "var(--color-amber)" };
  if (ext === "MP4" || m.startsWith("video/")) return { label: "MP4", color: "#a78bfa" };
  if (m.startsWith("image/")) return { label: ext.slice(0, 4) || "IMG", color: "var(--color-accent)" };
  return { label: ext.slice(0, 4) || "FILE", color: "var(--color-muted)" };
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "?";
}

export default function Dashboard() {
  const store = useAsukaStore();
  const [tab, setTab] = useState<Tab>("overview");
  const [collapsed, setCollapsed] = useState(false);
  const [monthOffset, setMonthOffset] = useState(0);

  const today = new Date().toISOString().slice(0, 10);
  const openReminders = store.reminders.filter((r) => !r.done);
  const dueToday = openReminders.filter((r) => r.dueAt === today);
  const pipeline = store.leads.filter((l) => l.stage !== "lost" && l.stage !== "closed_won");

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--color-bg)", color: "var(--color-text)" }}>
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
          <div style={{ width: 28, height: 28, borderRadius: 7, background: "var(--color-primary)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 11, fontWeight: 500, flexShrink: 0 }}>AL</div>
          {!collapsed && (
            <div style={{ overflow: "hidden" }}>
              <div style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--color-primary)", fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>GROKBOT · AGENT</div>
              <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>Command Center</div>
            </div>
          )}
        </div>
        <nav style={{ padding: 10, display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          {NAV.map((item) => (
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
                border: tab === item.id ? "1px solid rgba(255,45,85,0.35)" : "1px solid transparent",
                background: tab === item.id ? "rgba(255,45,85,0.08)" : "transparent",
                color: tab === item.id ? "var(--color-primary)" : "var(--color-muted)",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span style={{ width: 20, textAlign: "center", flexShrink: 0 }}>{item.icon}</span>
              {!collapsed && <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: "0.02em" }}>{item.label}</span>}
            </button>
          ))}
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
            <div style={{ fontSize: 14, fontWeight: 600 }}>Asuka Langley Command Center</div>
            <div style={{ fontSize: 11, fontFamily: "var(--font-geist-mono), var(--font-mono)", color: "var(--color-muted)" }}>v2.4.1 · live SMS sync</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 11 }}>
              <span className="dot-live" />
              {store.syncedAt
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
          </div>
        </header>

        <main style={{ flex: 1, padding: 24, overflow: "auto" }}>
          {!store.hydrated ? (
            <p style={{ color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 12 }}>Loading command center…</p>
          ) : tab === "overview" ? (
            <Overview store={store} dueToday={dueToday} openReminders={openReminders} pipeline={pipeline} setTab={setTab} />
          ) : tab === "reminders" ? (
            <Reminders store={store} />
          ) : tab === "calendar" ? (
            <CalendarView
              reminders={store.reminders}
              monthOffset={monthOffset}
              setMonthOffset={setMonthOffset}
              onToggle={(id) => store.setReminders((rs) => rs.map((r) => (r.id === id ? { ...r, done: !r.done } : r)))}
            />
          ) : tab === "notes" ? (
            <Notes store={store} />
          ) : tab === "files" ? (
            <Attachments store={store} />
          ) : (
            <Crm store={store} />
          )}
        </main>
      </div>
    </div>
  );
}

function Spark({ n, max = 8 }: { n: number; max?: number }) {
  const bars = Array.from({ length: 8 }, (_, i) => i < Math.min(8, Math.max(1, Math.round((n / Math.max(max, 1)) * 8))));
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 18 }}>
      {bars.map((on, i) => (
        <div key={i} style={{ width: 6, height: 6 + (on ? (i + 1) * 1.4 : 4), background: on ? "var(--color-accent)" : "rgba(255,255,255,0.06)", borderRadius: 1 }} />
      ))}
    </div>
  );
}

function Overview({ store, dueToday, openReminders, pipeline, setTab }: { store: Store; dueToday: Reminder[]; openReminders: Reminder[]; pipeline: Lead[]; setTab: (t: Tab) => void }) {
  const high = openReminders.filter((r) => r.priority === "high");
  const today = new Date().toISOString().slice(0, 10);
  const schedule = openReminders.filter((r) => r.dueAt === today).slice(0, 6);
  const activity = useMemo(() => {
    const rows: { t: string; type: string; color: string; label: string }[] = [];
    for (const r of store.reminders) {
      rows.push({ t: r.createdAt, type: r.done ? "DONE" : "TASK", color: r.done ? "var(--color-green)" : priColor(r.priority), label: r.title });
    }
    for (const l of store.leads) {
      rows.push({ t: l.updatedAt || l.createdAt, type: "LEAD", color: "var(--color-accent)", label: `${l.name} · ${l.company || "no org"}` });
    }
    return rows.sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 8);
  }, [store.reminders, store.leads]);

  const tiles = [
    { l: "DUE TODAY", v: dueToday.length, d: "SMS + board", t: "reminders" as Tab },
    { l: "OPEN TASKS", v: openReminders.length, d: "until resolved", t: "reminders" as Tab },
    { l: "PIPELINE", v: pipeline.length, d: "active leads", t: "crm" as Tab },
    { l: "NOTES", v: store.notes.length, d: "pinned + free", t: "notes" as Tab },
    { l: "FILES", v: store.attachments.length, d: "local vault", t: "files" as Tab },
  ];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        {tiles.map((c) => (
          <button key={c.l} onClick={() => setTab(c.t)} className="card" style={{ padding: 16, textAlign: "left", cursor: "pointer" }}>
            <div style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 28, fontWeight: 500, letterSpacing: "-0.03em" }}>{c.v}</div>
            <div style={{ marginTop: 6, fontSize: 10, letterSpacing: "0.14em", color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>{c.l}</div>
            <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
              <span style={{ fontSize: 11, color: "var(--color-accent)", fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>{c.d}</span>
              <Spark n={c.v} />
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
          {schedule.length === 0 && <p style={{ color: "var(--color-muted)", fontSize: 13 }}>Nothing due today.</p>}
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
  const [dueAt, setDueAt] = useState(new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState("");
  const [priority, setPriority] = useState<ReminderPriority>("medium");
  const [notes, setNotes] = useState("");
  const [source, setSource] = useState<"asuka" | "manual">("asuka");
  const list = store.reminders.filter((r) => (filter === "all" ? true : filter === "done" ? r.done : !r.done));

  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "320px 1fr" }}>
      <form
        className="card"
        style={{ padding: 18, height: "fit-content", display: "grid", gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          store.setReminders((rs) => [{ id: uid("r"), title: title.trim(), notes, dueAt, time: time || undefined, priority, done: false, createdAt: new Date().toISOString(), source }, ...rs]);
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
          <button type="button" onClick={() => setSource("asuka")} className="btn" style={{ padding: "6px 10px", background: source === "asuka" ? "var(--color-primary)" : "transparent", color: source === "asuka" ? "#fff" : "var(--color-muted)" }}>ASUKA</button>
          <button type="button" onClick={() => setSource("manual")} className="btn" style={{ padding: "6px 10px", color: source === "manual" ? "var(--color-accent)" : "var(--color-muted)", borderColor: source === "manual" ? "var(--color-accent)" : "var(--color-border)" }}>MANUAL</button>
        </div>
        <button className="btn btn-primary" style={{ padding: 10 }}>ADD</button>
      </form>
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {(["all", "active", "done"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className="btn" style={{ padding: "6px 12px", color: filter === f ? "#fff" : "var(--color-muted)", background: filter === f ? "var(--color-primary)" : "transparent" }}>{f.toUpperCase()}</button>
          ))}
        </div>
        {list.length === 0 && <p style={{ color: "var(--color-muted)" }}>No reminders in this filter.</p>}
        {list.map((r) => (
          <div key={r.id} className="card" style={{ padding: 14, marginBottom: 8, display: "flex", gap: 12, alignItems: "flex-start", opacity: r.done ? 0.5 : 1 }}>
            <button
              onClick={() => store.setReminders((rs) => rs.map((x) => (x.id === r.id ? { ...x, done: !x.done } : x)))}
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
              <p style={{ marginTop: 6, fontSize: 11, fontFamily: "var(--font-geist-mono), var(--font-mono)", color: "var(--color-accent)" }}>{r.dueAt}{r.time ? ` · ${r.time}` : ""}</p>
            </div>
            <button onClick={() => store.setReminders((rs) => rs.filter((x) => x.id !== r.id))} className="btn" style={{ padding: "5px 8px", color: "var(--color-primary)" }}>REMOVE</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function CalendarView({ reminders, monthOffset, setMonthOffset, onToggle }: { reminders: Reminder[]; monthOffset: number; setMonthOffset: (n: number | ((p: number) => number)) => void; onToggle: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(new Date().toISOString().slice(0, 10));
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
  const cells: (number | null)[] = [...Array(view.startDow).fill(null), ...Array.from({ length: view.daysInMonth }, (_, i) => i + 1)];
  const detail = selected ? byDay[selected] ?? [] : [];

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
            const isToday = iso === new Date().toISOString().slice(0, 10);
            const isSel = iso === selected;
            return (
              <button key={iso} onClick={() => setSelected(iso)} style={{ minHeight: 72, borderRadius: 8, border: `1px solid ${isSel ? "var(--color-primary)" : isToday ? "rgba(0,212,255,0.4)" : "var(--color-border)"}`, background: isSel ? "rgba(255,45,85,0.08)" : "transparent", padding: 6, textAlign: "left", cursor: "pointer", color: "inherit" }}>
                <div style={{ fontSize: 11, fontFamily: "var(--font-geist-mono), var(--font-mono)", color: isToday ? "var(--color-accent)" : "var(--color-muted)" }}>{day}</div>
                <div style={{ display: "flex", gap: 3, marginTop: 6, flexWrap: "wrap" }}>
                  {items.slice(0, 4).map((r) => <span key={r.id} style={{ width: 6, height: 6, borderRadius: "50%", background: r.done ? "var(--color-muted)" : priColor(r.priority) }} />)}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <aside className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 11, letterSpacing: "0.16em", color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)", marginBottom: 12 }}>{selected || "DAY"}</h2>
        {detail.length === 0 && <p style={{ color: "var(--color-muted)", fontSize: 13 }}>No events this day.</p>}
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
            <button key={n.id} onClick={() => setSel(n.id)} style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 8px", borderRadius: 7, border: n.id === sel ? "1px solid rgba(255,45,85,0.35)" : "1px solid transparent", background: n.id === sel ? "rgba(255,45,85,0.06)" : "transparent", color: "inherit", cursor: "pointer" }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{n.pinned ? "★ " : ""}{n.title}</div>
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
      <label className="card" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, marginBottom: 16, cursor: "pointer", borderStyle: "dashed" }}>
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
              <div style={{ width: 28, height: 28, borderRadius: 6, background: "rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: k.color }}>{k.label.slice(0, 1)}</div>
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

function Crm({ store }: { store: Store }) {
  const [draft, setDraft] = useState({ name: "", company: "", email: "", phone: "", value: "", notes: "" });
  const [sel, setSel] = useState<string | null>(store.leads[0]?.id ?? null);
  const active = store.leads.find((l) => l.id === sel) || null;
  function move(id: string, stage: CrmStage) {
    store.setLeads((ls) => ls.map((l) => (l.id === id ? { ...l, stage, updatedAt: new Date().toISOString() } : l)));
  }
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <form
        className="card"
        style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, padding: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.name.trim()) return;
          const lead: Lead = { id: uid("l"), name: draft.name.trim(), company: draft.company.trim(), email: draft.email.trim(), phone: draft.phone.trim(), value: Number(draft.value) || 0, stage: "new_lead", notes: draft.notes, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          store.setLeads((ls) => [lead, ...ls]);
          setSel(lead.id);
          setDraft({ name: "", company: "", email: "", phone: "", value: "", notes: "" });
        }}
      >
        <input style={inp} placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input style={inp} placeholder="Company" value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} />
        <input style={inp} placeholder="Email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
        <input style={inp} placeholder="Phone" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
        <input style={inp} placeholder="Value $" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
        <button className="btn btn-primary">ADD LEAD</button>
      </form>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 16 }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "36px 1.2fr 1fr 90px 100px", gap: 8, padding: "10px 14px", fontSize: 10, letterSpacing: "0.12em", color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)", borderBottom: "1px solid var(--color-border)" }}>
            <span />
            <span>NAME</span>
            <span>ORG</span>
            <span>STAGE</span>
            <span>VALUE</span>
          </div>
          {store.leads.length === 0 && <p style={{ padding: 16, color: "var(--color-muted)" }}>No leads. Text Asuka: Lead: Name, Company, email, phone</p>}
          {store.leads.map((l) => (
            <button key={l.id} onClick={() => setSel(l.id)} style={{ display: "grid", gridTemplateColumns: "36px 1.2fr 1fr 90px 100px", gap: 8, width: "100%", padding: "10px 14px", alignItems: "center", background: l.id === sel ? "rgba(0,212,255,0.06)" : "transparent", border: "none", borderTop: "1px solid var(--color-border)", color: "inherit", cursor: "pointer", textAlign: "left" }}>
              <span style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(255,45,85,0.15)", color: "var(--color-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>{initials(l.name)}</span>
              <span>{l.name}</span>
              <span style={{ color: "var(--color-muted)" }}>{l.company || "—"}</span>
              <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 10, color: stageColor(l.stage) }}>{l.stage.replace("_", " ").toUpperCase()}</span>
              <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 12, color: l.value ? "var(--color-amber)" : "var(--color-muted)" }}>{l.value ? `$${l.value.toLocaleString()}` : "—"}</span>
            </button>
          ))}
        </div>
        <aside className="card" style={{ padding: 18 }}>
          {!active ? <p style={{ color: "var(--color-muted)" }}>Select a contact.</p> : (
            <>
              <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}>
                <span style={{ width: 40, height: 40, borderRadius: "50%", background: "rgba(255,45,85,0.15)", color: "var(--color-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>{initials(active.name)}</span>
                <div>
                  <div style={{ fontWeight: 600 }}>{active.name}</div>
                  <div style={{ fontSize: 12, color: "var(--color-muted)" }}>{active.company || "Independent"}</div>
                </div>
              </div>
              <p style={{ fontSize: 12, color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>{active.email || "no email"} · {active.phone || "no phone"}</p>
              {active.notes && <p style={{ marginTop: 10, fontSize: 13 }}>{active.notes}</p>}
              <div style={{ marginTop: 16, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {CRM_STAGES.map((s) => (
                  <button key={s.id} onClick={() => move(active.id, s.id)} className="btn" style={{ padding: "6px 8px", color: active.stage === s.id ? "#fff" : "var(--color-muted)", background: active.stage === s.id ? "var(--color-primary)" : "transparent" }}>{s.label.toUpperCase()}</button>
                ))}
              </div>
              <button className="btn" style={{ marginTop: 16, padding: "6px 10px", color: "var(--color-primary)" }} onClick={() => { store.setLeads((ls) => ls.filter((x) => x.id !== active.id)); setSel(null); }}>DELETE</button>
            </>
          )}
        </aside>
      </div>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(4, 1fr)" }}>
        {CRM_STAGES.map((col) => (
          <div key={col.id} className="card" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/lead-id"); if (id) move(id, col.id); }} style={{ minHeight: 180, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 11, letterSpacing: "0.1em", fontFamily: "var(--font-geist-mono), var(--font-mono)", color: stageColor(col.id) }}>{col.label.toUpperCase()}</span>
              <span style={{ fontSize: 11, color: "var(--color-muted)" }}>{store.leads.filter((l) => l.stage === col.id).length}</span>
            </div>
            {store.leads.filter((l) => l.stage === col.id).map((l) => (
              <article key={l.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/lead-id", l.id)} onClick={() => setSel(l.id)} style={{ padding: 10, marginBottom: 6, borderRadius: 8, border: "1px solid var(--color-border)", cursor: "grab", background: "var(--color-surface)" }}>
                <div style={{ fontSize: 13 }}>{l.name}</div>
                <div style={{ fontSize: 11, color: "var(--color-muted)" }}>{l.company || "—"}</div>
              </article>
            ))}
          </div>
        ))}
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
