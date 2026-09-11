"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { type Reminder, type ReminderPriority } from "@/lib/types";
import { uid, useAsukaStore } from "@/lib/store";

type Store = ReturnType<typeof useAsukaStore>;

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

const inp: CSSProperties = {
  width: "100%",
  borderRadius: 7,
  border: "1px solid var(--color-border)",
  background: "var(--color-bg)",
  padding: "8px 10px",
  fontSize: 13,
  outline: "none",
};

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

export { CalendarView, Notes, Attachments };
