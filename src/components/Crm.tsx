"use client";

import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { CRM_STAGES, type CrmStage, type Lead, type LeadNote } from "@/lib/types";
import { uid, useAsukaStore } from "@/lib/store";
import { MONO, ago, fmtAppt, fmtStamp, stageColor, stageLabel, tint } from "@/lib/crm";

type Store = ReturnType<typeof useAsukaStore>;

const COLS = "36px 1.2fr 1fr 110px 130px 90px";

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

function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "?";
}

function lastTouch(l: Lead): string {
  if (l.stage === "appointment_set" && l.appointmentAt) return fmtAppt(l.appointmentAt);
  const last = l.noteLog[0];
  if (!last) return "—";
  const n = l.noteLog.length;
  return `${ago(last.createdAt)} · ${n} note${n === 1 ? "" : "s"}`;
}

export function Crm({ store }: { store: Store }) {
  const [draft, setDraft] = useState({ name: "", company: "", email: "", phone: "", value: "" });
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(store.leads[0]?.id ?? null);
  const active = store.leads.find((l) => l.id === sel) || null;

  const needle = q.trim().toLowerCase();
  const visible = needle
    ? store.leads.filter((l) =>
        [l.name, l.company, l.email, l.phone, l.notes, ...l.noteLog.map((n) => n.body)]
          .join(" ")
          .toLowerCase()
          .includes(needle)
      )
    : store.leads;

  function patch(id: string, fn: (l: Lead) => Partial<Lead>) {
    store.setLeads((ls) =>
      ls.map((l) => (l.id === id ? { ...l, ...fn(l), updatedAt: new Date().toISOString() } : l))
    );
  }
  const move = (id: string, stage: CrmStage) => patch(id, () => ({ stage }));
  const remove = (id: string) => {
    store.setLeads((ls) => ls.filter((x) => x.id !== id));
    setSel(null);
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <form
        className="card"
        style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, padding: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.name.trim()) return;
          const now = new Date().toISOString();
          const lead: Lead = {
            id: uid("l"),
            name: draft.name.trim(),
            company: draft.company.trim(),
            email: draft.email.trim(),
            phone: draft.phone.trim(),
            value: Number(draft.value) || 0,
            stage: "new_lead",
            notes: "",
            noteLog: [],
            createdAt: now,
            updatedAt: now,
          };
          store.setLeads((ls) => [lead, ...ls]);
          setSel(lead.id);
          setQ("");
          setDraft({ name: "", company: "", email: "", phone: "", value: "" });
        }}
      >
        <input style={inp} placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input style={inp} placeholder="Company" value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} />
        <input style={inp} placeholder="Email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
        <input style={inp} placeholder="Phone" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
        <input style={inp} placeholder="Value $" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
        <button className="btn btn-primary">ADD LEAD</button>
      </form>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: 16, alignItems: "start" }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--color-border)" }}>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search leads — name, company, phone, notes"
              aria-label="Search leads"
              style={{ ...inp, flex: 1 }}
            />
            <span style={label}>{visible.length}/{store.leads.length}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 8, padding: "10px 14px", ...label, borderBottom: "1px solid var(--color-border)" }}>
            <span />
            <span>NAME</span>
            <span>ORG</span>
            <span>STAGE</span>
            <span>LAST TOUCH</span>
            <span>VALUE</span>
          </div>
          {store.leads.length === 0 && <p style={{ padding: 16, color: "var(--color-muted)" }}>No leads. Text Asuka: Lead: Name, Company, email, phone</p>}
          {store.leads.length > 0 && visible.length === 0 && <p style={{ padding: 16, color: "var(--color-muted)" }}>No leads match “{q}”.</p>}
          <div style={{ maxHeight: 560, overflowY: "auto" }}>
            {visible.map((l) => (
              <button
                key={l.id}
                onClick={() => setSel(l.id)}
                style={{ display: "grid", gridTemplateColumns: COLS, gap: 8, width: "100%", padding: "10px 14px", alignItems: "center", background: l.id === sel ? tint(stageColor(l.stage), 9) : "transparent", border: "none", borderTop: "1px solid var(--color-border)", color: "inherit", cursor: "pointer", textAlign: "left" }}
              >
                <span style={{ width: 28, height: 28, borderRadius: "50%", background: tint(stageColor(l.stage), 18), color: stageColor(l.stage), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontFamily: MONO }}>{initials(l.name)}</span>
                <span style={ellipsis}>{l.name}</span>
                <span style={{ ...ellipsis, color: "var(--color-muted)" }}>{l.company || "—"}</span>
                <span style={{ ...ellipsis, fontFamily: MONO, fontSize: 10, color: stageColor(l.stage) }}>{stageLabel(l.stage).toUpperCase()}</span>
                <span style={{ ...ellipsis, fontFamily: MONO, fontSize: 11, color: l.stage === "appointment_set" && l.appointmentAt ? "var(--color-violet)" : "var(--color-muted)" }}>{lastTouch(l)}</span>
                <span style={{ fontFamily: MONO, fontSize: 12, color: l.value ? "var(--color-amber)" : "var(--color-muted)" }}>{l.value ? `$${l.value.toLocaleString()}` : "—"}</span>
              </button>
            ))}
          </div>
        </div>

        <aside className="card" style={{ padding: 18 }}>
          {!active ? (
            <p style={{ color: "var(--color-muted)" }}>Select a contact.</p>
          ) : (
            <LeadDetail key={active.id} lead={active} onPatch={(fn) => patch(active.id, fn)} onDelete={() => remove(active.id)} />
          )}
        </aside>
      </div>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
        {CRM_STAGES.map((col) => {
          const cards = store.leads.filter((l) => l.stage === col.id);
          if (col.id === "appointment_set") {
            cards.sort((a, b) => (a.appointmentAt || "9999").localeCompare(b.appointmentAt || "9999"));
          }
          return (
            <div
              key={col.id}
              className="card"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/lead-id");
                if (id) {
                  move(id, col.id);
                  setSel(id);
                }
              }}
              style={{ minHeight: 180, padding: 12, display: "flex", flexDirection: "column", boxShadow: `inset 0 2px 0 0 ${tint(stageColor(col.id), 70)}` }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <span style={{ fontSize: 11, letterSpacing: "0.1em", fontFamily: MONO, color: stageColor(col.id) }} title={col.hint}>{col.label.toUpperCase()}</span>
                <span style={{ fontSize: 11, color: "var(--color-muted)" }}>{cards.length}</span>
              </div>
              <div style={{ overflowY: "auto", maxHeight: 560 }}>
                {cards.map((l) => {
                  const last = l.noteLog[0];
                  return (
                    <article
                      key={l.id}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData("text/lead-id", l.id)}
                      onClick={() => setSel(l.id)}
                      style={{ padding: 10, marginBottom: 6, borderRadius: 8, border: `1px solid ${l.id === sel ? tint(stageColor(col.id), 60) : "var(--color-border)"}`, cursor: "grab", background: l.id === sel ? tint(stageColor(col.id), 7) : "var(--color-surface)" }}
                    >
                      <div style={{ fontSize: 13, ...ellipsis }}>{l.name}</div>
                      <div style={{ fontSize: 11, color: "var(--color-muted)", ...ellipsis }}>{l.company || "—"}</div>
                      {col.id === "appointment_set" && (
                        <div style={{ marginTop: 6, fontSize: 10, fontFamily: MONO, letterSpacing: "0.04em", color: l.appointmentAt ? "var(--color-violet)" : "var(--color-amber)" }}>
                          {l.appointmentAt ? fmtAppt(l.appointmentAt) : "NO DATE SET"}
                        </div>
                      )}
                      {last && (
                        <div style={{ marginTop: 6, fontSize: 11, color: "var(--color-muted)", ...ellipsis }}>
                          <span style={{ fontFamily: MONO, fontSize: 10 }}>{ago(last.createdAt)}</span> · {last.body}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LeadDetail({
  lead,
  onPatch,
  onDelete,
}: {
  lead: Lead;
  onPatch: (fn: (l: Lead) => Partial<Lead>) => void;
  onDelete: () => void;
}) {
  const [noteDraft, setNoteDraft] = useState("");
  const [editingBg, setEditingBg] = useState(false);
  const [bgDraft, setBgDraft] = useState(lead.notes);
  const [showAllBg, setShowAllBg] = useState(false);

  const bgLong = lead.notes.split("\n").length > 4 || lead.notes.length > 280;
  const bgShown = bgLong && !showAllBg ? lead.notes.split("\n").slice(0, 4).join("\n") : lead.notes;

  function addNote() {
    const body = noteDraft.trim();
    if (!body) return;
    const note: LeadNote = { id: uid("ln"), body, createdAt: new Date().toISOString() };
    onPatch((l) => ({ noteLog: [note, ...l.noteLog] }));
    setNoteDraft("");
  }
  function onNoteKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      addNote();
    }
  }
  function removeNote(id: string) {
    onPatch((l) => ({ noteLog: l.noteLog.filter((n) => n.id !== id) }));
  }
  function saveBg() {
    onPatch(() => ({ notes: bgDraft }));
    setEditingBg(false);
  }

  return (
    <>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
        <span style={{ width: 40, height: 40, borderRadius: "50%", background: tint(stageColor(lead.stage), 18), color: stageColor(lead.stage), display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, flexShrink: 0 }}>{initials(lead.name)}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, ...ellipsis }}>{lead.name}</div>
          <div style={{ fontSize: 12, color: "var(--color-muted)", ...ellipsis }}>{lead.company || "Independent"}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em", padding: "3px 8px", borderRadius: 999, border: `1px solid ${stageColor(lead.stage)}`, color: stageColor(lead.stage) }}>{stageLabel(lead.stage).toUpperCase()}</span>
        {lead.value > 0 && <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--color-amber)" }}>${lead.value.toLocaleString()}</span>}
      </div>
      <p style={{ fontSize: 12, color: "var(--color-muted)", fontFamily: MONO, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {lead.email ? <a href={`mailto:${lead.email}`} style={{ color: "var(--color-accent)", textDecoration: "none" }}>{lead.email}</a> : <span>no email</span>}
        <span>·</span>
        {lead.phone ? <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`} style={{ color: "var(--color-accent)", textDecoration: "none" }}>{lead.phone}</a> : <span>no phone</span>}
      </p>

      <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 6 }}>
        {CRM_STAGES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPatch(() => ({ stage: s.id }))}
            className="btn"
            title={s.hint}
            style={{ padding: "6px 8px", color: lead.stage === s.id ? "var(--color-ink)" : "var(--color-muted)", background: lead.stage === s.id ? stageColor(s.id) : "transparent", borderColor: lead.stage === s.id ? stageColor(s.id) : "var(--color-border)" }}
          >
            {s.label.toUpperCase()}
          </button>
        ))}
      </div>

      {lead.stage === "appointment_set" && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 8, border: `1px solid ${tint("var(--color-violet)", 40)}`, background: tint("var(--color-violet)", 7) }}>
          <div style={{ ...label, color: "var(--color-violet)", marginBottom: 6 }}>APPOINTMENT</div>
          <input
            type="datetime-local"
            aria-label="Appointment date and time"
            value={lead.appointmentAt ?? ""}
            onChange={(e) => onPatch(() => ({ appointmentAt: e.target.value || undefined }))}
            style={{ ...inp, colorScheme: "dark" }}
          />
          <div style={{ marginTop: 6, fontSize: 11, fontFamily: MONO, color: lead.appointmentAt ? "var(--color-text)" : "var(--color-amber)" }}>
            {lead.appointmentAt ? fmtAppt(lead.appointmentAt) : "Pick a date & time — it shows on the Calendar tab."}
          </div>
        </div>
      )}

      <div style={{ marginTop: 18, borderTop: "1px solid var(--color-border)", paddingTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
          <span style={label}>NOTES</span>
          <span style={{ ...label, letterSpacing: 0 }}>{lead.noteLog.length}</span>
        </div>
        <textarea
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onKeyDown={onNoteKey}
          placeholder="Called, emailed, what they said… (Ctrl+Enter to add)"
          aria-label="New note"
          style={{ ...inp, height: 72, resize: "vertical" }}
        />
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: 8, width: "100%", padding: "8px 10px", opacity: noteDraft.trim() ? 1 : 0.5 }}
          onClick={addNote}
          disabled={!noteDraft.trim()}
        >
          ADD NOTE
        </button>
        <div style={{ marginTop: 12, display: "grid", gap: 8, maxHeight: 320, overflowY: "auto" }}>
          {lead.noteLog.length === 0 && <p style={{ fontSize: 12, color: "var(--color-muted)", margin: 0 }}>No notes yet — log your first touch.</p>}
          {lead.noteLog.map((n) => (
            <article key={n.id} style={{ padding: 10, borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-bg)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--color-muted)", fontFamily: MONO }} title={new Date(n.createdAt).toLocaleString()}>
                  {fmtStamp(n.createdAt)} · {ago(n.createdAt)}
                </span>
                <button
                  type="button"
                  onClick={() => removeNote(n.id)}
                  aria-label="Delete note"
                  title="Delete note"
                  style={{ background: "transparent", border: "none", color: "var(--color-muted)", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 2px" }}
                >
                  ×
                </button>
              </div>
              <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{n.body}</p>
            </article>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 18, borderTop: "1px solid var(--color-border)", paddingTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
          <span style={label}>BACKGROUND</span>
          {!editingBg ? (
            <button type="button" className="btn" style={{ padding: "3px 8px", fontSize: 10 }} onClick={() => { setBgDraft(lead.notes); setEditingBg(true); }}>EDIT</button>
          ) : (
            <span style={{ display: "flex", gap: 4 }}>
              <button type="button" className="btn" style={{ padding: "3px 8px", fontSize: 10, color: "var(--color-muted)" }} onClick={() => setEditingBg(false)}>CANCEL</button>
              <button type="button" className="btn btn-primary" style={{ padding: "3px 8px", fontSize: 10 }} onClick={saveBg}>SAVE</button>
            </span>
          )}
        </div>
        {editingBg ? (
          <textarea value={bgDraft} onChange={(e) => setBgDraft(e.target.value)} aria-label="Background" style={{ ...inp, height: 160, resize: "vertical", fontSize: 12 }} />
        ) : lead.notes ? (
          <>
            <p style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", lineHeight: 1.5, color: "var(--color-text)" }}>{bgShown}</p>
            {bgLong && (
              <button type="button" onClick={() => setShowAllBg((v) => !v)} style={{ background: "transparent", border: "none", padding: 0, marginTop: 4, color: "var(--color-accent)", fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em", cursor: "pointer" }}>
                {showAllBg ? "LESS" : "MORE"}
              </button>
            )}
          </>
        ) : (
          <p style={{ margin: 0, fontSize: 12, color: "var(--color-muted)" }}>No background on file.</p>
        )}
      </div>

      <button
        type="button"
        className="btn"
        style={{ marginTop: 18, padding: "6px 10px", color: "var(--color-primary)" }}
        onClick={() => {
          const n = lead.noteLog.length;
          if (window.confirm(`Delete ${lead.name}${lead.company ? ` (${lead.company})` : ""}? This removes the lead and its ${n} note${n === 1 ? "" : "s"}.`)) onDelete();
        }}
      >
        DELETE LEAD
      </button>
    </>
  );
}
