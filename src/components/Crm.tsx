"use client";

import { useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from "react";
import { CRM_STAGES, type CrmStage, type Lead, type LeadNote } from "@/lib/types";
import { uid, useAsukaStore } from "@/lib/store";
import { ago, fmtAppt, fmtStamp, stageColor, stageLabel, tint } from "@/lib/crm";
import { haptic } from "@/lib/haptics";

type Store = ReturnType<typeof useAsukaStore>;

/** Column tracks for the lead list — wide screens vs. phones (ORG / STAGE / LAST TOUCH hide below 640px). */
const ROW_VARS = {
  ["--cols" as string]: "36px 1.2fr 1fr 110px 130px 90px",
  ["--cols-sm" as string]: "36px 1fr 90px",
};

const ellipsis: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

/** Initials bubble tinted with the lead's pipeline stage, so the list reads by colour at a glance. */
function avatar(stage: CrmStage): CSSProperties {
  return {
    borderRadius: "50%",
    background: tint(stageColor(stage), 18),
    color: stageColor(stage),
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 600,
    flexShrink: 0,
  };
}

const compactBtn: CSSProperties = { minHeight: 28, padding: "4px 10px" };

type AgeGroup = 0 | 3 | 7 | 14;

/**
 * Bucket a lead by whole days since it was created (floored):
 * 0 = under 3 days, 3 = 3–6 days, 7 = 7–13 days, 14 = two weeks and older.
 */
function ageGroup(createdAt: string, now: number): AgeGroup {
  const t = new Date(createdAt).getTime();
  const days = Number.isNaN(t) ? 0 : Math.floor((now - t) / 86_400_000);
  if (days >= 14) return 14;
  if (days >= 7) return 7;
  if (days >= 3) return 3;
  return 0;
}

const AGE_GROUPS: { key: Exclude<AgeGroup, 0>; label: string }[] = [
  { key: 3, label: "3 DAYS OLD" },
  { key: 7, label: "7 DAYS OLD" },
  { key: 14, label: "2 WEEKS OLD" },
];

const groupKey = (stage: CrmStage, group: AgeGroup) => `${stage}:${group}`;

/**
 * Minute-resolution clock exposed as an external store so render stays pure
 * (React forbids Date.now() during render). Ticks only while a component is
 * subscribed, refreshes on subscribe so a remount never reads a stale value.
 */
let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<() => void>();
function subscribeClock(onChange: () => void) {
  clockListeners.add(onChange);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      clockListeners.forEach((l) => l());
    }, 60_000);
  }
  return () => {
    clockListeners.delete(onChange);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}
const readClock = () => clockNow;
function useNow(): number {
  return useSyncExternalStore(subscribeClock, readClock, readClock);
}

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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 200ms var(--ease)", flexShrink: 0 }}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function Crm({ store }: { store: Store }) {
  const [draft, setDraft] = useState({ name: "", company: "", email: "", phone: "", value: "" });
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(store.leads[0]?.id ?? null);
  /** Expanded age groups on the board, keyed "stage:group". Everything older than 3 days starts collapsed. */
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const active = store.leads.find((l) => l.id === sel) || null;
  const now = useNow();

  const needle = q.trim().toLowerCase();
  const visible = needle
    ? store.leads.filter((l) =>
        [l.name, l.company, l.email, l.phone, l.notes, ...l.noteLog.map((n) => n.body)]
          .join(" ")
          .toLowerCase()
          .includes(needle)
      )
    : store.leads;

  function toggleGroup(key: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  /** Make sure a lead's card is not hidden inside a collapsed age group of the given column. */
  function reveal(stage: CrmStage, createdAt: string) {
    const g = ageGroup(createdAt, now);
    if (g === 0) return;
    const key = groupKey(stage, g);
    setOpenGroups((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }
  function select(l: Lead) {
    setSel(l.id);
    reveal(l.stage, l.createdAt);
    haptic("tap");
  }

  function patch(id: string, fn: (l: Lead) => Partial<Lead>) {
    store.setLeads((ls) =>
      ls.map((l) => (l.id === id ? { ...l, ...fn(l), updatedAt: new Date().toISOString() } : l))
    );
  }
  function move(id: string, stage: CrmStage) {
    const l = store.leads.find((x) => x.id === id);
    patch(id, () => ({ stage }));
    if (l) reveal(stage, l.createdAt);
  }
  const remove = (id: string) => {
    store.setLeads((ls) => ls.filter((x) => x.id !== id));
    setSel(null);
  };

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <form
        className="card fields"
        style={{ padding: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.name.trim()) return;
          const stamp = new Date().toISOString();
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
            createdAt: stamp,
            updatedAt: stamp,
          };
          store.setLeads((ls) => [lead, ...ls]);
          setSel(lead.id);
          setQ("");
          setDraft({ name: "", company: "", email: "", phone: "", value: "" });
          haptic("save");
        }}
      >
        <input className="input" placeholder="Name" aria-label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input className="input" placeholder="Company" aria-label="Company" value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} />
        <input className="input" type="email" placeholder="Email" aria-label="Email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
        <input className="input" type="tel" placeholder="Phone" aria-label="Phone" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
        <input className="input" inputMode="decimal" placeholder="Value $" aria-label="Value in dollars" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
        <button className="btn btn-primary" style={{ minHeight: 40 }}>ADD LEAD</button>
      </form>

      <div className="split" style={{ ["--split-w" as string]: "360px" }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--color-border)" }}>
            <input
              className="input"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search leads — name, company, phone, notes"
              aria-label="Search leads"
              style={{ flex: 1, minWidth: 0 }}
            />
            <span className="label" style={{ whiteSpace: "nowrap" }}>{visible.length}/{store.leads.length}</span>
          </div>
          <div className="rows label" style={{ ...ROW_VARS, padding: "10px 14px 10px 17px", borderBottom: "1px solid var(--color-border)" }}>
            <span />
            <span>NAME</span>
            <span className="hide-sm">ORG</span>
            <span className="hide-sm">STAGE</span>
            <span className="hide-sm">LAST TOUCH</span>
            <span>VALUE</span>
          </div>
          {store.leads.length === 0 && <p style={{ padding: 16, margin: 0, color: "var(--color-muted)" }}>No leads. Text Asuka: Lead: Name, Company, email, phone</p>}
          {store.leads.length > 0 && visible.length === 0 && <p style={{ padding: 16, margin: 0, color: "var(--color-muted)" }}>No leads match “{q}”.</p>}
          <div role="listbox" aria-label="Leads" style={{ maxHeight: 560, overflowY: "auto" }}>
            {visible.map((l) => (
              <button
                key={l.id}
                type="button"
                role="option"
                className="row-btn rows"
                aria-selected={l.id === sel}
                onClick={() => select(l)}
                style={ROW_VARS}
              >
                <span style={{ ...avatar(l.stage), width: 28, height: 28, fontSize: 11 }}>{initials(l.name)}</span>
                <span style={ellipsis}>{l.name}</span>
                <span className="hide-sm" style={{ ...ellipsis, color: "var(--color-muted)" }}>{l.company || "—"}</span>
                <span className="hide-sm label" style={{ ...ellipsis, color: stageColor(l.stage) }}>{stageLabel(l.stage)}</span>
                <span className="hide-sm" style={{ ...ellipsis, fontSize: 13, color: l.stage === "appointment_set" && l.appointmentAt ? "var(--color-violet)" : "var(--color-muted)" }}>{lastTouch(l)}</span>
                <span style={{ ...ellipsis, color: l.value ? "var(--color-amber)" : "var(--color-muted)" }}>{l.value ? `$${l.value.toLocaleString()}` : "—"}</span>
              </button>
            ))}
          </div>
        </div>

        <aside className="card" style={{ padding: 18 }}>
          {!active ? (
            <p style={{ margin: 0, color: "var(--color-muted)" }}>Select a contact.</p>
          ) : (
            <LeadDetail
              key={active.id}
              lead={active}
              onPatch={(fn) => patch(active.id, fn)}
              onStage={(stage) => move(active.id, stage)}
              onDelete={() => remove(active.id)}
            />
          )}
        </aside>
      </div>

      <div className="kanban">
        {CRM_STAGES.map((col) => {
          const cards = store.leads.filter((l) => l.stage === col.id);
          if (col.id === "appointment_set") {
            cards.sort((a, b) => (a.appointmentAt || "9999").localeCompare(b.appointmentAt || "9999"));
          }
          const buckets: Record<AgeGroup, Lead[]> = { 0: [], 3: [], 7: [], 14: [] };
          for (const l of cards) buckets[ageGroup(l.createdAt, now)].push(l);
          const fresh = buckets[0];
          const groups = AGE_GROUPS.filter((g) => buckets[g.key].length > 0);

          const card = (l: Lead) => {
            const last = l.noteLog[0];
            const on = l.id === sel;
            return (
              <article
                key={l.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/lead-id", l.id)}
                onClick={() => select(l)}
                style={{
                  padding: 10,
                  marginBottom: 6,
                  borderRadius: 12,
                  minWidth: 0,
                  border: `1px solid ${on ? "var(--color-selected-edge)" : "var(--color-border)"}`,
                  background: on ? "var(--color-selected)" : "var(--color-surface)",
                  cursor: "grab",
                  transition: "background-color 200ms, border-color 200ms",
                }}
              >
                <div style={ellipsis}>{l.name}</div>
                <div style={{ ...ellipsis, fontSize: 13, color: "var(--color-muted)" }}>{l.company || "—"}</div>
                {col.id === "appointment_set" && (
                  <div className="label" style={{ marginTop: 6, color: l.appointmentAt ? "var(--color-violet)" : "var(--color-amber)" }}>
                    {l.appointmentAt ? fmtAppt(l.appointmentAt) : "NO DATE SET"}
                  </div>
                )}
                {last && (
                  <div style={{ ...ellipsis, marginTop: 6, fontSize: 13, color: "var(--color-muted)" }}>
                    {ago(last.createdAt)} · {last.body}
                  </div>
                )}
              </article>
            );
          };

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
              style={{ minHeight: 180, padding: 12, display: "flex", flexDirection: "column", minWidth: 0, boxShadow: `inset 0 2px 0 0 ${tint(stageColor(col.id), 70)}, inset 0 1px 0 rgba(255,255,255,0.06)` }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                <span className="label" style={{ ...ellipsis, color: stageColor(col.id) }} title={col.hint}>{col.label}</span>
                <span className="label">{cards.length}</span>
              </div>
              <div style={{ overflowY: "auto", maxHeight: 560 }}>
                {cards.length === 0 && (
                  <p className="label" style={{ margin: "24px 0", textAlign: "center", opacity: 0.6 }}>Empty</p>
                )}
                {fresh.length > 0 && groups.length > 0 && (
                  <div className="label" style={{ padding: "4px 2px 6px" }}>LAST 3 DAYS</div>
                )}
                {fresh.map(card)}
                {groups.map((g) => {
                  const key = groupKey(col.id, g.key);
                  const open = openGroups.has(key);
                  return (
                    <div key={key}>
                      <button
                        type="button"
                        className="label"
                        aria-expanded={open}
                        onClick={() => toggleGroup(key)}
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          margin: "4px 0 6px",
                          padding: "8px 10px",
                          borderRadius: 12,
                          border: "1px solid transparent",
                          background: open ? tint(stageColor(col.id), 10) : "transparent",
                          color: "var(--color-muted)",
                          cursor: "pointer",
                          textAlign: "left",
                          transition: "background-color 200ms, border-color 200ms",
                        }}
                      >
                        <span style={ellipsis}>{g.label}</span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span>{buckets[g.key].length}</span>
                          <Chevron open={open} />
                        </span>
                      </button>
                      {open && buckets[g.key].map(card)}
                    </div>
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
  onStage,
  onDelete,
}: {
  lead: Lead;
  onPatch: (fn: (l: Lead) => Partial<Lead>) => void;
  onStage: (stage: CrmStage) => void;
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
    haptic("save");
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
    haptic("save");
  }

  return (
    <>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10, minWidth: 0 }}>
        <span style={{ ...avatar(lead.stage), width: 40, height: 40, fontSize: 14 }}>{initials(lead.name)}</span>
        <div style={{ minWidth: 0 }}>
          <h2 className="card-title" style={{ ...ellipsis, margin: 0 }}>{lead.name}</h2>
          <div style={{ ...ellipsis, fontSize: 13, color: "var(--color-muted)" }}>{lead.company || "Independent"}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <span className="label" style={{ padding: "3px 10px", borderRadius: 999, border: `1px solid ${stageColor(lead.stage)}`, color: stageColor(lead.stage) }}>{stageLabel(lead.stage)}</span>
        {lead.value > 0 && <span style={{ fontSize: 13, color: "var(--color-amber)" }}>${lead.value.toLocaleString()}</span>}
      </div>
      <p style={{ margin: 0, fontSize: 13, color: "var(--color-muted)", display: "flex", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
        {lead.email ? <a href={`mailto:${lead.email}`} style={{ color: "var(--color-accent)", textDecoration: "none", overflowWrap: "anywhere" }}>{lead.email}</a> : <span>no email</span>}
        <span>·</span>
        {lead.phone ? <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`} style={{ color: "var(--color-accent)", textDecoration: "none", overflowWrap: "anywhere" }}>{lead.phone}</a> : <span>no phone</span>}
      </p>

      <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 6 }}>
        {CRM_STAGES.map((s) => {
          const on = lead.stage === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onStage(s.id)}
              className="btn"
              title={s.hint}
              aria-pressed={on}
              style={{ padding: "6px 10px", minHeight: 32, ...(on ? { background: stageColor(s.id), borderColor: stageColor(s.id), color: "var(--color-on-primary)" } : {}) }}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {lead.stage === "appointment_set" && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 12, border: `1px solid ${tint("var(--color-violet)", 40)}`, background: tint("var(--color-violet)", 8) }}>
          <div className="label" style={{ color: "var(--color-violet)", marginBottom: 6 }}>APPOINTMENT</div>
          <input
            className="input"
            type="datetime-local"
            aria-label="Appointment date and time"
            value={lead.appointmentAt ?? ""}
            onChange={(e) => onPatch(() => ({ appointmentAt: e.target.value || undefined }))}
          />
          <div style={{ marginTop: 6, fontSize: 13, color: lead.appointmentAt ? "var(--color-text)" : "var(--color-amber)" }}>
            {lead.appointmentAt ? fmtAppt(lead.appointmentAt) : "Pick a date & time — it shows on the Calendar tab."}
          </div>
        </div>
      )}

      <div style={{ marginTop: 18, borderTop: "1px solid var(--color-border)", paddingTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
          <span className="label">NOTES</span>
          <span className="label">{lead.noteLog.length}</span>
        </div>
        <textarea
          className="input"
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onKeyDown={onNoteKey}
          placeholder="Called, emailed, what they said… (Ctrl+Enter to add)"
          aria-label="New note"
          style={{ height: 88, resize: "vertical" }}
        />
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: 8, width: "100%" }}
          onClick={addNote}
          disabled={!noteDraft.trim()}
        >
          ADD NOTE
        </button>
        <div style={{ marginTop: 12, display: "grid", gap: 8, maxHeight: 320, overflowY: "auto" }}>
          {lead.noteLog.length === 0 && <p style={{ fontSize: 13, color: "var(--color-muted)", margin: 0 }}>No notes yet — log your first touch.</p>}
          {lead.noteLog.map((n) => (
            <article key={n.id} style={{ padding: 10, borderRadius: 12, border: "1px solid var(--color-border)", background: "var(--color-bg)", minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span className="label" style={{ ...ellipsis, textTransform: "none" }} title={new Date(n.createdAt).toLocaleString()}>
                  {fmtStamp(n.createdAt)} · {ago(n.createdAt)}
                </span>
                <button
                  type="button"
                  className="btn btn-danger btn-ghost"
                  onClick={() => removeNote(n.id)}
                  aria-label="Delete note"
                  title="Delete note"
                  style={{ minHeight: 26, padding: "2px 8px", fontSize: 14, lineHeight: 1 }}
                >
                  ×
                </button>
              </div>
              <p style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.5, overflowWrap: "anywhere" }}>{n.body}</p>
            </article>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 18, borderTop: "1px solid var(--color-border)", paddingTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span className="label">BACKGROUND</span>
          {!editingBg ? (
            <button type="button" className="btn" style={compactBtn} onClick={() => { setBgDraft(lead.notes); setEditingBg(true); }}>EDIT</button>
          ) : (
            <span style={{ display: "flex", gap: 4 }}>
              <button type="button" className="btn" style={compactBtn} onClick={() => setEditingBg(false)}>CANCEL</button>
              <button type="button" className="btn btn-primary" style={compactBtn} onClick={saveBg}>SAVE</button>
            </span>
          )}
        </div>
        {editingBg ? (
          <textarea className="input" value={bgDraft} onChange={(e) => setBgDraft(e.target.value)} aria-label="Background" style={{ height: 160, resize: "vertical" }} />
        ) : lead.notes ? (
          <>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.5, color: "var(--color-text)", overflowWrap: "anywhere" }}>{bgShown}</p>
            {bgLong && (
              <button
                type="button"
                className="label"
                onClick={() => setShowAllBg((v) => !v)}
                style={{ background: "transparent", border: "none", padding: 0, marginTop: 6, color: "var(--color-accent)", cursor: "pointer" }}
              >
                {showAllBg ? "LESS" : "MORE"}
              </button>
            )}
          </>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: "var(--color-muted)" }}>No background on file.</p>
        )}
      </div>

      <button
        type="button"
        className="btn btn-danger"
        style={{ marginTop: 18 }}
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
