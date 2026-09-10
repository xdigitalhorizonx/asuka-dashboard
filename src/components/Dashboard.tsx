"use client";

import { useMemo, useState } from "react";
import { CRM_STAGES, type CrmStage, type Lead, type ReminderPriority } from "@/lib/types";
import { uid, useAsukaStore } from "@/lib/store";

type Tab = "overview" | "reminders" | "calendar" | "notes" | "files" | "crm";
const PRIORITY: ReminderPriority[] = ["low", "medium", "high"];

export default function Dashboard() {
  const store = useAsukaStore();
  const [tab, setTab] = useState<Tab>("overview");
  const [monthOffset, setMonthOffset] = useState(0);
  const today = new Date().toISOString().slice(0, 10);
  const openReminders = store.reminders.filter((r) => !r.done);
  const dueToday = openReminders.filter((r) => r.dueAt === today);
  const pipeline = store.leads.filter((l) => l.stage !== "lost" && l.stage !== "closed_won");

  return (
    <div className="grid-bg min-h-screen">
      <header className="sticky top-0 z-20 border-b border-[#2a2a32] bg-[#09090b]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="accent-glow flex h-10 w-10 items-center justify-center rounded-lg bg-[#ff4d2e] font-bold text-black">AL</div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.22em] text-[#f5c16c]">Grokbot · Agent</p>
              <h1 className="text-lg font-semibold leading-tight">Asuka Langley Command Center</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={store.exportJson} className="rounded-md border border-[#2a2a32] px-3 py-1.5 text-sm hover:border-[#ff4d2e]">Export</button>
            <label className="cursor-pointer rounded-md border border-[#2a2a32] px-3 py-1.5 text-sm hover:border-[#f5c16c]">
              Import
              <input type="file" accept="application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) store.importJson(f); e.target.value = ""; }} />
            </label>
          </div>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-5 pb-3">
          {([["overview", "Overview"], ["reminders", "Reminders"], ["calendar", "Calendar"], ["notes", "Notes"], ["files", "Attachments"], ["crm", "CRM"]] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} className={`rounded-full px-3.5 py-1.5 text-sm transition ${tab === id ? "bg-[#ff4d2e] text-black font-medium" : "text-[#9a9086] hover:text-[#f4efe8]"}`}>{label}</button>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-5 py-6">
        {!store.hydrated ? <p className="text-[#9a9086]">Loading local vault…</p> : tab === "overview" ? (
          <div className="space-y-6">
            <section className="panel rounded-2xl p-6"><p className="text-sm text-[#9a9086]">Ops board for <span className="text-[#ff4d2e]">@asuka langley</span>. Grokbot reminders do not auto-sync — log them here.</p></section>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {[{ l: "Due today", v: dueToday.length, t: "reminders" as Tab }, { l: "Open reminders", v: openReminders.length, t: "reminders" as Tab }, { l: "Notes", v: store.notes.length, t: "notes" as Tab }, { l: "Attachments", v: store.attachments.length, t: "files" as Tab }, { l: "Active pipeline", v: pipeline.length, t: "crm" as Tab }].map((c) => (
                <button key={c.l} onClick={() => setTab(c.t)} className="panel rounded-xl p-4 text-left hover:border-[#ff4d2e]"><p className="text-xs uppercase tracking-wider text-[#9a9086]">{c.l}</p><p className="mt-2 text-3xl font-semibold">{c.v}</p></button>
              ))}
            </div>
          </div>
        ) : tab === "reminders" ? <Reminders store={store} /> : tab === "calendar" ? <Cal reminders={store.reminders} monthOffset={monthOffset} setMonthOffset={setMonthOffset} onToggle={(id) => store.setReminders((rs) => rs.map((r) => r.id === id ? { ...r, done: !r.done } : r))} /> : tab === "notes" ? <Notes store={store} /> : tab === "files" ? <Files store={store} /> : <Crm store={store} />}
      </main>
    </div>
  );
}

function Reminders({ store }: { store: ReturnType<typeof useAsukaStore> }) {
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState(new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState("");
  const [priority, setPriority] = useState<ReminderPriority>("medium");
  const [notes, setNotes] = useState("");
  const [source, setSource] = useState<"asuka" | "manual">("asuka");
  return (
    <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
      <form className="panel h-fit space-y-3 rounded-2xl p-5" onSubmit={(e) => { e.preventDefault(); if (!title.trim()) return; store.setReminders((rs) => [{ id: uid("r"), title: title.trim(), notes, dueAt, time: time || undefined, priority, done: false, createdAt: new Date().toISOString(), source }, ...rs]); setTitle(""); setNotes(""); }}>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[#f5c16c]">New reminder</h2>
        <input className="w-full rounded-md border border-[#2a2a32] bg-[#09090b] px-3 py-2 text-sm outline-none focus:border-[#ff4d2e]" placeholder="What Asuka told you to do" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="h-20 w-full rounded-md border border-[#2a2a32] bg-[#09090b] px-3 py-2 text-sm outline-none focus:border-[#ff4d2e]" placeholder="Context / exact quote" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <input type="date" className="rounded-md border border-[#2a2a32] bg-[#09090b] px-3 py-2 text-sm" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          <input type="time" className="rounded-md border border-[#2a2a32] bg-[#09090b] px-3 py-2 text-sm" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div className="flex gap-2">{PRIORITY.map((p) => <button type="button" key={p} onClick={() => setPriority(p)} className={`flex-1 rounded-md border px-2 py-1.5 text-xs capitalize ${priority === p ? "border-[#ff4d2e] text-[#ff4d2e]" : "border-[#2a2a32] text-[#9a9086]"}`}>{p}</button>)}</div>
        <div className="flex gap-2 text-xs">
          <button type="button" onClick={() => setSource("asuka")} className={`rounded-full px-3 py-1 ${source === "asuka" ? "bg-[#ff4d2e] text-black" : "bg-[#1c1c22] text-[#9a9086]"}`}>Via Asuka</button>
          <button type="button" onClick={() => setSource("manual")} className={`rounded-full px-3 py-1 ${source === "manual" ? "bg-[#f5c16c] text-black" : "bg-[#1c1c22] text-[#9a9086]"}`}>Manual</button>
        </div>
        <button className="w-full rounded-md bg-[#ff4d2e] py-2 text-sm font-medium text-black">Add reminder</button>
      </form>
      <div className="space-y-2">
        {store.reminders.length === 0 && <p className="text-[#9a9086]">No reminders yet.</p>}
        {store.reminders.map((r) => (
          <div key={r.id} className={`panel flex items-start justify-between gap-3 rounded-xl p-4 ${r.done ? "opacity-50" : ""}`}>
            <div>
              <div className="flex flex-wrap items-center gap-2"><p className="font-medium">{r.title}</p><span className="text-[10px] uppercase text-[#9a9086]">{r.priority} · {r.source}</span></div>
              {r.notes && <p className="mt-1 text-sm text-[#9a9086]">{r.notes}</p>}
              <p className="mt-2 text-xs text-[#9a9086]">{r.dueAt}{r.time ? ` · ${r.time}` : ""}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button onClick={() => store.setReminders((rs) => rs.map((x) => x.id === r.id ? { ...x, done: !x.done } : x))} className="rounded-md border border-[#2a2a32] px-2 py-1 text-xs">{r.done ? "Undo" : "Done"}</button>
              <button onClick={() => store.setReminders((rs) => rs.filter((x) => x.id !== r.id))} className="rounded-md border border-[#2a2a32] px-2 py-1 text-xs text-[#ff4d2e]">Remove</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Cal({ reminders, monthOffset, setMonthOffset, onToggle }: { reminders: ReturnType<typeof useAsukaStore>["reminders"]; monthOffset: number; setMonthOffset: (n: number | ((p: number) => number)) => void; onToggle: (id: string) => void; }) {
  const view = useMemo(() => { const now = new Date(); const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1); return { year: d.getFullYear(), month: d.getMonth(), startDow: new Date(d.getFullYear(), d.getMonth(), 1).getDay(), daysInMonth: new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(), label: d.toLocaleString("en-US", { month: "long", year: "numeric" }) }; }, [monthOffset]);
  const byDay = useMemo(() => { const map: Record<string, typeof reminders> = {}; for (const r of reminders) { (map[r.dueAt] ??= []).push(r); } return map; }, [reminders]);
  const cells: (number | null)[] = [...Array(view.startDow).fill(null), ...Array.from({ length: view.daysInMonth }, (_, i) => i + 1)];
  return (
    <div className="panel rounded-2xl p-5">
      <div className="mb-4 flex items-center justify-between">
        <button onClick={() => setMonthOffset((n) => n - 1)} className="rounded-md border border-[#2a2a32] px-3 py-1 text-sm">←</button>
        <h2 className="font-semibold">{view.label}</h2>
        <button onClick={() => setMonthOffset((n) => n + 1)} className="rounded-md border border-[#2a2a32] px-3 py-1 text-sm">→</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] uppercase tracking-wider text-[#9a9086]">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="py-2">{d}</div>)}</div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((day, i) => {
          if (!day) return <div key={`e${i}`} />;
          const iso = `${view.year}-${String(view.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const items = byDay[iso] ?? [];
          const isToday = iso === new Date().toISOString().slice(0, 10);
          return (
            <div key={iso} className={`min-h-24 rounded-lg border p-1.5 ${isToday ? "border-[#ff4d2e]" : "border-[#2a2a32]"}`}>
              <p className={`text-xs ${isToday ? "text-[#ff4d2e]" : "text-[#9a9086]"}`}>{day}</p>
              {items.map((r) => <button key={r.id} onClick={() => onToggle(r.id)} className={`mt-1 block w-full truncate rounded px-1 py-0.5 text-left text-[11px] ${r.done ? "bg-white/5 text-[#6b6b76] line-through" : "bg-[#ff4d2e]/20 text-[#ffb4a8]"}`}>{r.title}</button>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Notes({ store }: { store: ReturnType<typeof useAsukaStore> }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <div className="panel space-y-3 rounded-2xl p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[#f5c16c]">New note</h2>
        <input className="w-full rounded-md border border-[#2a2a32] bg-[#09090b] px-3 py-2 text-sm" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="h-40 w-full rounded-md border border-[#2a2a32] bg-[#09090b] px-3 py-2 text-sm" placeholder="Conversation excerpt…" value={body} onChange={(e) => setBody(e.target.value)} />
        <button onClick={() => { if (!title.trim() && !body.trim()) return; store.setNotes((ns) => [{ id: uid("n"), title: title || "Untitled", body, updatedAt: new Date().toISOString(), pinned: false }, ...ns]); setTitle(""); setBody(""); }} className="w-full rounded-md bg-[#ff4d2e] py-2 text-sm font-medium text-black">Save note</button>
      </div>
      <div className="space-y-2">
        {store.notes.map((n) => (
          <article key={n.id} className="panel rounded-xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-medium">{n.title}</h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-[#cfc6bb]">{n.body}</p>
              </div>
              <button onClick={() => store.setNotes((ns) => ns.filter((x) => x.id !== n.id))} className="text-xs text-[#ff4d2e]">Delete</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function Files({ store }: { store: ReturnType<typeof useAsukaStore> }) {
  return (
    <div className="space-y-4">
      <label className="panel flex cursor-pointer flex-col items-center justify-center rounded-2xl border-dashed p-10 text-center">
        <p className="font-medium">Drop files or click to upload</p>
        <p className="mt-1 text-sm text-[#9a9086]">Stored locally in this browser.</p>
        <input type="file" multiple className="hidden" onChange={(e) => {
          const list = e.target.files; if (!list) return;
          Array.from(list).forEach((file) => {
            const reader = new FileReader();
            reader.onload = () => store.setAttachments((as) => [{ id: uid("a"), name: file.name, mime: file.type || "application/octet-stream", size: file.size, dataUrl: String(reader.result), createdAt: new Date().toISOString() }, ...as]);
            reader.readAsDataURL(file);
          });
        }} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {store.attachments.map((a) => (
          <div key={a.id} className="panel overflow-hidden rounded-xl">
            {a.mime.startsWith("image/") ? <img src={a.dataUrl} alt={a.name} className="h-36 w-full object-cover" /> : <div className="flex h-36 items-center justify-center bg-[#0b0b0e] text-xs text-[#9a9086]">{a.mime}</div>}
            <div className="flex items-center justify-between gap-2 p-3">
              <p className="truncate text-sm">{a.name}</p>
              <button onClick={() => store.setAttachments((as) => as.filter((x) => x.id !== a.id))} className="text-xs text-[#ff4d2e]">Remove</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Crm({ store }: { store: ReturnType<typeof useAsukaStore> }) {
  const [draft, setDraft] = useState({ name: "", company: "", email: "", phone: "", value: "", notes: "" });
  function move(id: string, stage: CrmStage) {
    store.setLeads((ls) => ls.map((l) => l.id === id ? { ...l, stage, updatedAt: new Date().toISOString() } : l));
  }
  return (
    <div className="space-y-5">
      <form className="panel grid gap-2 rounded-2xl p-4 md:grid-cols-6" onSubmit={(e) => {
        e.preventDefault();
        if (!draft.name.trim()) return;
        const lead: Lead = { id: uid("l"), name: draft.name.trim(), company: draft.company.trim(), email: draft.email.trim(), phone: draft.phone.trim(), value: Number(draft.value) || 0, stage: "new_lead", notes: draft.notes, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        store.setLeads((ls) => [lead, ...ls]);
        setDraft({ name: "", company: "", email: "", phone: "", value: "", notes: "" });
      }}>
        <input className="rounded-md border border-[#2a2a32] bg-[#09090b] px-3 py-2 text-sm" placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input className="rounded-md border border-[#2a2a32] bg-[#09090b] px-3 py-2 text-sm" placeholder="Company" value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} />
        <input className="rounded-md border border-[#2a2a32] bg-[#09090b] px-3 py-2 text-sm" placeholder="Email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
        <input className="rounded-md border border-[#2a2a32] bg-[#09090b] px-3 py-2 text-sm" placeholder="Phone" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
        <input className="rounded-md border border-[#2a2a32] bg-[#09090b] px-3 py-2 text-sm" placeholder="Value $" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
        <button className="rounded-md bg-[#ff4d2e] text-sm font-medium text-black">Add lead</button>
      </form>
      <div className="grid gap-3 lg:grid-cols-4">
        {CRM_STAGES.map((col) => (
          <div key={col.id} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/lead-id"); if (id) move(id, col.id); }} className="panel min-h-[420px] rounded-2xl p-3">
            <div className="mb-3 flex items-baseline justify-between">
              <div><h3 className="text-sm font-semibold">{col.label}</h3><p className="text-[11px] text-[#9a9086]">{col.hint}</p></div>
              <span className="text-xs text-[#9a9086]">{store.leads.filter((l) => l.stage === col.id).length}</span>
            </div>
            {store.leads.filter((l) => l.stage === col.id).map((l) => (
              <article key={l.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/lead-id", l.id)} className="mb-2 cursor-grab rounded-xl border border-[#2a2a32] bg-[#0d0d11] p-3">
                <p className="font-medium">{l.name}</p>
                <p className="text-xs text-[#9a9086]">{l.company || "—"}</p>
                {l.value > 0 && <p className="mt-1 text-sm text-[#f5c16c]">${l.value.toLocaleString()}</p>}
                <div className="mt-2 flex flex-wrap gap-1">
                  {CRM_STAGES.filter((s) => s.id !== l.stage).map((s) => <button key={s.id} onClick={() => move(l.id, s.id)} className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-[#9a9086]">→ {s.label}</button>)}
                  <button onClick={() => store.setLeads((ls) => ls.filter((x) => x.id !== l.id))} className="rounded-full px-2 py-0.5 text-[10px] text-[#ff4d2e]">Delete</button>
                </div>
              </article>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
