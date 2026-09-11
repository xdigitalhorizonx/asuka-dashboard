"use client";

import { useState, type CSSProperties } from "react";
import { CRM_STAGES, type CallNote, type CrmStage, type Lead } from "@/lib/types";
import { uid, useAsukaStore } from "@/lib/store";

type Store = ReturnType<typeof useAsukaStore>;

function stageColor(s: CrmStage) {
  if (s === "new_lead") return "var(--color-accent)";
  if (s === "proposal_sent") return "var(--color-amber)";
  if (s === "closed_won") return "var(--color-green)";
  return "var(--color-muted)";
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "?";
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

function formatCallAt(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function Crm({ store }: { store: Store }) {
  const [draft, setDraft] = useState({ name: "", company: "", email: "", phone: "", value: "", notes: "" });
  const [sel, setSel] = useState<string | null>(store.leads[0]?.id ?? null);
  const [callDraft, setCallDraft] = useState("");
  const active = store.leads.find((l) => l.id === sel) || null;
  const callNotes = [...(active?.callNotes ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  function move(id: string, stage: CrmStage) {
    store.setLeads((ls) => ls.map((l) => (l.id === id ? { ...l, stage, updatedAt: new Date().toISOString() } : l)));
  }
  function addCallNote() {
    if (!active || !callDraft.trim()) return;
    const note: CallNote = {
      id: uid("cn"),
      body: callDraft.trim(),
      createdAt: new Date().toISOString(),
    };
    store.setLeads((ls) =>
      ls.map((l) =>
        l.id === active.id
          ? {
              ...l,
              callNotes: [note, ...(l.callNotes ?? [])],
              updatedAt: new Date().toISOString(),
            }
          : l
      )
    );
    setCallDraft("");
  }
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <form
        className="card"
        style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, padding: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.name.trim()) return;
          const lead: Lead = { id: uid("l"), name: draft.name.trim(), company: draft.company.trim(), email: draft.email.trim(), phone: draft.phone.trim(), value: Number(draft.value) || 0, stage: "new_lead", notes: draft.notes, callNotes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          store.setLeads((ls) => [lead, ...ls]);
          setSel(lead.id);
          setCallDraft("");
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
            <button key={l.id} onClick={() => { setSel(l.id); setCallDraft(""); }} style={{ display: "grid", gridTemplateColumns: "36px 1.2fr 1fr 90px 100px", gap: 8, width: "100%", padding: "10px 14px", alignItems: "center", background: l.id === sel ? "rgba(0,212,255,0.06)" : "transparent", border: "none", borderTop: "1px solid var(--color-border)", color: "inherit", cursor: "pointer", textAlign: "left" }}>
              <span style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(255,45,85,0.15)", color: "var(--color-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontFamily: "var(--font-geist-mono), var(--font-mono)" }}>{initials(l.name)}</span>
              <span>{l.name}</span>
              <span style={{ color: "var(--color-muted)" }}>{l.company || "—"}</span>
              <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 10, color: stageColor(l.stage) }}>{l.stage.replace("_", " ").toUpperCase()}</span>
              <span style={{ fontFamily: "var(--font-geist-mono), var(--font-mono)", fontSize: 12, color: l.value ? "var(--color-amber)" : "var(--color-muted)"}}>{l.value ? `$${l.value.toLocaleString()}` : "—"}</span>
            </button>
          ))}
        </div>
        <aside className="card" style={{ padding: 18 }}>
          {!active ? <p style={{ color: "var(--color-muted)" }}>Select a contact.</p> : (
            <>
              <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}>
                <span style={{ width: 40, height: 40, borderRadius: "50%", background: "rgba(255,45,85,0.15)", color: "var(--color-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-geist-mono), var(--font-mono)"}}>{initials(active.name)}</span>
                <div>
                  <div style={{ fontWeight: 600 }}>{active.name}</div>
                  <div style={{ fontSize: 12, color: "var(--color-muted)"}}>{active.company || "Independent"}</div>
                </div>
              </div>
              <p style={{ fontSize: 12, color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)"}}>{active.email || "no email"} · {active.phone || "no phone"}</p>
              {active.notes && <p style={{ marginTop: 10, fontSize: 13 }}>{active.notes}</p>}
              <div style={{ marginTop: 18, borderTop: "1px solid var(--color-border)", paddingTop: 14 }}>
                <div style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--color-muted)", fontFamily: "var(--font-geist-mono), var(--font-mono)", marginBottom: 8 }}>CALL NOTES</div>
                <textarea
                  value={callDraft}
                  onChange={(e) => setCallDraft(e.target.value)}
                  placeholder="What happened on the call…"
                  style={{ ...inp, height: 72, resize: "vertical" }}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ marginTop: 8, width: "100%", padding: "8px 10px" }}
                  onClick={addCallNote}
                  disabled={!callDraft.trim()}
                >
                  ADD CALL NOTE
                </button>
                <div style={{ marginTop: 12, display: "grid", gap: 8, maxHeight: 260, overflowY: "auto" }}>
                  {callNotes.length === 0 && (
                    <p style={{ fontSize: 12, color: "var(--color-muted)", margin: 0 }}>No call notes yet.</p>
                  )}
                  {callNotes.map((n) => (
                    <article
                      key={n.id}
                      style={{
                        padding: 10,
                        borderRadius: 8,
                        border: "1px solid var(--color-border)",
                        background: "var(--color-bg)",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          letterSpacing: "0.08em",
                          color: "var(--color-muted)",
                          fontFamily: "var(--font-geist-mono), var(--font-mono)",
                          marginBottom: 4,
                        }}
                      >
                        {formatCallAt(n.createdAt)}
                      </div>
                      <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap" }}>{n.body}</p>
                    </article>
                  ))}
                </div>
              </div>
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
              <span style={{ fontSize: 11, color: "var(--color-muted)"}}>{store.leads.filter((l) => l.stage === col.id).length}</span>
            </div>
            {store.leads.filter((l) => l.stage === col.id).map((l) => (
              <article key={l.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/lead-id", l.id)} onClick={() => { setSel(l.id); setCallDraft(""); }} style={{ padding: 10, marginBottom: 6, borderRadius: 8, border: "1px solid var(--color-border)", cursor: "grab", background: "var(--color-surface)" }}>
                <div style={{ fontSize: 13 }}>{l.name}</div>
                <div style={{ fontSize: 11, color: "var(--color-muted)"}}>{l.company || "—"}</div>
              </article>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
