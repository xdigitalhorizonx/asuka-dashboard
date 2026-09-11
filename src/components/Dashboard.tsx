"use client";

import { useState } from "react";
import { Crm } from "@/components/CrmPanel";
import { Overview, Reminders } from "@/components/DashOverview";
import { CalendarView, Notes, Attachments } from "@/components/DashMore";
import { useAsukaStore } from "@/lib/store";

type Tab = "overview" | "reminders" | "calendar" | "notes" | "files" | "crm";

const NAV: { id: Tab; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "▣" },
  { id: "reminders", label: "Reminders", icon: "☑" },
  { id: "calendar", label: "Calendar", icon: "▦" },
  { id: "notes", label: "Notes", icon: "✎" },
  { id: "files", label: "Attachments", icon: "▢" },
  { id: "crm", label: "CRM", icon: "◈" },
];

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
