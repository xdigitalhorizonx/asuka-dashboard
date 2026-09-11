"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { type Lead, type Reminder, type ReminderPriority } from "@/lib/types";
import { uid, useAsukaStore } from "@/lib/store";

type Tab = "overview" | "reminders" | "calendar" | "notes" | "files" | "crm";
type Store = ReturnType<typeof useAsukaStore>;

const PRI: ReminderPriority[] = ["low", "medium", "high"];
const PRI_LABEL: Record<ReminderPriority, string> = { high: "HIGH", medium: "MED", low: "LOW" };

function priColor(p: ReminderPriority) {
  return p === "high" ? "var(--color-primary)" : p === "medium" ? "var(--color-amber)" : "var(--color-muted)";
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

export { Spark, Overview, Reminders };
