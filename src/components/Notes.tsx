"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Note } from "@/lib/types";
import { uid, type useAsukaStore } from "@/lib/store";
import { haptic } from "@/lib/haptics";
import { RichText, RichTextEditor } from "./RichNote";
import { editorHtml, noteHtml, type RichValue } from "@/lib/rich-text";

type Store = ReturnType<typeof useAsukaStore>;

/*
 * Notes tab.
 * - Writing autosaves (debounced) — switching notes, tabs or closing the editor never loses text.
 *   "Discard changes" puts the note back the way it was when editing started.
 * - A new note only reaches the board once it has a title or body, so empty drafts never sync.
 * - Delete is instant with an Undo toast instead of a confirm dialog.
 * - Keys: "/" search · "n" new note · ↑/↓ move through results · Enter edit · Esc close/clear.
 */

const AUTOSAVE_MS = 700;
const UNDO_MS = 8000;

interface Draft {
  id: string;
  title: string;
  body: RichValue;
  /** Not on the board yet (new note that has had no content). */
  isNew: boolean;
  /** The note as it was when editing started — what "Discard changes" restores. Null for a new note. */
  orig: Note | null;
}

export function Notes({ store }: { store: Store }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saved">("idle");
  const [undo, setUndo] = useState<{ note: Note; index: number } | null>(null);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  const notesRef = useRef(store.notes);
  notesRef.current = store.notes;
  const { setNotes } = store;

  const terms = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const sorted = useMemo(
    () => [...store.notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)),
    [store.notes]
  );
  const filtered = useMemo(
    () => (terms.length ? sorted.filter((n) => terms.every((t) => `${n.title}\n${n.body}`.toLowerCase().includes(t))) : sorted),
    [sorted, terms]
  );
  const pinnedCount = filtered.filter((n) => n.pinned).length;

  // Open the most recent note on first load (and after the selected note disappears, e.g. deleted by Asuka).
  const selId = sel && store.notes.some((n) => n.id === sel) ? sel : draft?.isNew ? null : (sorted[0]?.id ?? null);
  const active = store.notes.find((n) => n.id === selId) || null;
  const editing = !!draft && (draft.isNew || draft.id === active?.id);

  /** Write the draft to the board. Returns nothing; safe to call any time. */
  const commit = useCallback((d: Draft | null) => {
    if (!d) return;
    const title = d.title.trim();
    const hasBody = !!d.body.text.trim();
    if (d.isNew) {
      if (!title && !hasBody) return;
      const note: Note = { id: d.id, title: title || "Untitled", body: d.body.text, html: d.body.html, updatedAt: new Date().toISOString(), pinned: false };
      setNotes((ns) => (ns.some((n) => n.id === d.id) ? ns : [note, ...ns]));
      draftRef.current = { ...d, isNew: false };
      setDraft((cur) => (cur && cur.id === d.id ? { ...cur, isNew: false } : cur));
      setSel(d.id);
      return;
    }
    const cur = notesRef.current.find((n) => n.id === d.id);
    if (!cur) return;
    const nextTitle = title || "Untitled";
    if (cur.title === nextTitle && cur.body === d.body.text && (cur.html ?? undefined) === (d.body.html ?? undefined)) return;
    setNotes((ns) => ns.map((x) => (x.id === d.id ? { ...x, title: nextTitle, body: d.body.text, html: d.body.html, updatedAt: new Date().toISOString() } : x)));
  }, [setNotes]);

  // Autosave while typing.
  useEffect(() => {
    if (!draft) return;
    const t = window.setTimeout(() => {
      commit(draftRef.current);
      setSaveState("saved");
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(t);
    // only the text fields should restart the timer, not isNew flipping
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, draft?.title, draft?.body]);

  // Leaving the tab mid-edit still saves.
  useEffect(() => () => commit(draftRef.current), [commit]);

  // Undo toast times out.
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), UNDO_MS);
    return () => window.clearTimeout(t);
  }, [undo]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 1800);
    return () => window.clearTimeout(t);
  }, [copied]);

  /** Close the editor, saving first. An emptied existing note is removed (with Undo). */
  function finishEdit() {
    const d = draftRef.current;
    if (!d) return;
    if (!d.isNew && !d.title.trim() && !d.body.text.trim()) {
      draftRef.current = null;
      setDraft(null);
      setSaveState("idle");
      // Undo brings back the note as it was before it was emptied, not the blank autosave.
      remove(d.id, d.orig ?? undefined);
      return;
    }
    commit(d);
    draftRef.current = null;
    setDraft(null);
    setSaveState("idle");
    if (d.title.trim() || d.body.text.trim()) haptic("save");
  }

  function discard() {
    const d = draftRef.current;
    if (!d) return;
    if (d.orig) {
      const orig = d.orig;
      store.setNotes((ns) => ns.map((x) => (x.id === orig.id ? orig : x)));
    } else {
      store.setNotes((ns) => ns.filter((x) => x.id !== d.id));
    }
    draftRef.current = null;
    setDraft(null);
    setSaveState("idle");
  }

  function startNew() {
    commit(draftRef.current);
    const d: Draft = { id: uid("n"), title: "", body: { text: "" }, isNew: true, orig: null };
    draftRef.current = d;
    setDraft(d);
    setSel(null);
    setSaveState("idle");
    revealDetail();
  }

  function startEdit(n: Note) {
    if (draftRef.current?.id === n.id) return;
    commit(draftRef.current);
    const d: Draft = { id: n.id, title: n.title, body: { text: n.body, html: noteHtml(n.body, n.html) ?? undefined }, isNew: false, orig: n };
    draftRef.current = d;
    setDraft(d);
    setSaveState("idle");
  }

  function select(id: string) {
    if (draftRef.current && draftRef.current.id !== id) {
      finishEdit();
    }
    setSel(id);
    haptic("tap");
    revealDetail();
  }

  function remove(id: string, restoreAs?: Note) {
    const index = notesRef.current.findIndex((n) => n.id === id);
    if (index < 0) return;
    const note = restoreAs ?? notesRef.current[index];
    store.setNotes((ns) => ns.filter((x) => x.id !== id));
    if (draftRef.current?.id === id) {
      draftRef.current = null;
      setDraft(null);
    }
    setSel(null);
    setUndo({ note, index });
  }

  function restore() {
    if (!undo) return;
    const { note, index } = undo;
    store.setNotes((ns) => (ns.some((n) => n.id === note.id) ? ns : [...ns.slice(0, index), note, ...ns.slice(index)]));
    setSel(note.id);
    setUndo(null);
  }

  function togglePin(n: Note) {
    store.setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, pinned: !x.pinned } : x)));
  }

  async function copy(n: Note) {
    const html = noteHtml(n.body, n.html);
    const text = n.title && n.title !== "Untitled" ? `${n.title}

${n.body}` : n.body;
    try {
      if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        const fullHtml = `<b>${escapeHtml(n.title)}</b><br><br>${html}`;
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([fullHtml], { type: "text/html" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      setCopied("ok");
    } catch {
      // Clipboard API refused (no permission / not focused) — fall back to the old copy command.
      setCopied(legacyCopy(text) ? "ok" : "fail");
    }
  }

  /** On a phone the note opens below the list — bring it into view. */
  function revealDetail() {
    if (typeof window === "undefined" || window.matchMedia("(min-width: 1024px)").matches) return;
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  // Board-wide keys while this tab is open: "/" to search, "n" for a new note.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        startNew();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (q) setQ("");
      else searchRef.current?.blur();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!filtered.length) return;
      const i = filtered.findIndex((n) => n.id === selId);
      const next = e.key === "ArrowDown" ? Math.min(filtered.length - 1, i + 1) : Math.max(0, i - 1);
      select(filtered[i < 0 ? 0 : next].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const n = filtered.find((x) => x.id === selId) ?? filtered[0];
      if (n) {
        setSel(n.id);
        startEdit(n);
      }
    }
  }

  function onEditorKey(e: ReactKeyboardEvent) {
    if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) {
      e.preventDefault();
      finishEdit();
    }
  }

  const draftEmpty = !!draft && !draft.title.trim() && !draft.body.text.trim();
  const changed = !!draft && (draft.isNew ? !draftEmpty : !!draft.orig && (draft.orig.title !== (draft.title.trim() || "Untitled") || draft.orig.body !== draft.body.text || (draft.orig.html ?? undefined) !== (draft.body.html ?? undefined)));

  return (
    <div className="split split-left notes" style={{ ["--split-w" as string]: "340px" }}>
      <div className="card notes-list">
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <div className="notes-search">
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onSearchKey}
              placeholder="Search notes"
              className="input"
              aria-label="Search notes"
              aria-keyshortcuts="/"
            />
            {!q && <kbd className="notes-kbd" aria-hidden>/</kbd>}
            {q && (
              <button type="button" className="notes-clear" aria-label="Clear search" onClick={() => { setQ(""); searchRef.current?.focus(); }}>×</button>
            )}
          </div>
          <button type="button" className="btn btn-primary" style={{ padding: "8px 14px", whiteSpace: "nowrap" }} onClick={startNew} title="New note (N)" aria-keyshortcuts="n">+ NEW</button>
        </div>
        <div className="notes-count" aria-live="polite">
          {terms.length ? `${filtered.length} of ${store.notes.length} match` : `${store.notes.length} note${store.notes.length === 1 ? "" : "s"}`}
        </div>
        <div className="notes-rows" role="list">
          {!store.notes.length && !draft && (
            <div className="notes-empty">
              <p>No notes yet.</p>
              <button type="button" className="btn" onClick={startNew}>Write the first one</button>
            </div>
          )}
          {!!store.notes.length && !filtered.length && <p className="notes-empty">Nothing matches “{q}”.</p>}
          {draft?.isNew && (
            <button type="button" className="note-row" aria-current="true" onClick={revealDetail}>
              <span className="note-row-title">{draft.title.trim() || "New note"}</span>
              <span className="note-row-snippet">{draft.body.text.trim().split("\n")[0] || "Unsaved draft"}</span>
            </button>
          )}
          {filtered.map((n, i) => (
            <Fragment key={n.id}>
              {pinnedCount > 0 && (i === 0 || i === pinnedCount) && (
                <div className="notes-group">{i === 0 && n.pinned ? "Pinned" : "Notes"}</div>
              )}
              <button
                type="button"
                role="listitem"
                className="note-row"
                aria-current={n.id === selId && !draft?.isNew ? "true" : undefined}
                onClick={() => select(n.id)}
                onDoubleClick={() => { setSel(n.id); startEdit(n); }}
              >
                <span className="note-row-head">
                  <span className="note-row-title">
                    {n.pinned && <span className="note-pin" aria-label="Pinned">★ </span>}
                    {highlight(n.title, terms)}
                  </span>
                  <time className="note-row-time" dateTime={n.updatedAt} title={new Date(n.updatedAt).toLocaleString()}>{ago(n.updatedAt)}</time>
                </span>
                <span className="note-row-snippet">{highlight(snippet(n.body, terms), terms)}</span>
              </button>
            </Fragment>
          ))}
        </div>
      </div>

      <div className="card notes-detail" ref={detailRef}>
        {editing && draft ? (
          <div style={{ display: "grid", gap: 10 }} onKeyDown={onEditorKey}>
            <input
              value={draft.title}
              onChange={(e) => { const title = e.target.value; setSaveState("pending"); setDraft((d) => d && { ...d, title }); }}
              placeholder="Title"
              className="input notes-title-input"
              aria-label="Note title"
              autoFocus={draft.isNew}
              onKeyDown={(e) => {
                // Enter / Tab / ↓ in the title jumps straight into the body (skipping the toolbar)
                if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || (e.key === "Tab" && !e.shiftKey) || e.key === "ArrowDown") {
                  const body = e.currentTarget.parentElement?.querySelector<HTMLElement>(".rte-area");
                  if (!body) return;
                  e.preventDefault();
                  body.focus();
                }
              }}
            />
            <RichTextEditor
              key={draft.id}
              initialHtml={draft.orig ? editorHtml(draft.orig.body, draft.orig.html) : ""}
              onChange={(v) => { setSaveState("pending"); setDraft((d) => d && { ...d, body: v }); }}
              placeholder={draft.isNew ? "Start writing…" : "Body"}
              ariaLabel="Note body"
              minHeight={300}
              autoFocus={!draft.isNew}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="notes-meta" aria-live="polite">
                {saveState === "pending" && changed ? "Saving…" : draft.isNew && draftEmpty ? "Type to start — it saves as you go" : "Saved"}
                <span className="notes-hint"> · Esc or Ctrl+Enter to close</span>
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                {changed && (
                  <button type="button" className="btn" style={{ padding: "6px 10px" }} onClick={discard} title={draft.isNew ? "Throw this note away" : "Put the note back the way it was"}>
                    {draft.isNew ? "DISCARD" : "DISCARD CHANGES"}
                  </button>
                )}
                {draft.isNew && !changed && (
                  <button type="button" className="btn" style={{ padding: "6px 10px" }} onClick={discard}>CANCEL</button>
                )}
                {(changed || !draft.isNew) && (
                  <button type="button" className="btn btn-primary" style={{ padding: "6px 14px" }} onClick={finishEdit}>DONE</button>
                )}
              </div>
            </div>
          </div>
        ) : !active ? (
          <p style={{ color: "var(--color-muted)" }}>{store.notes.length ? "Select a note." : "Press N or + NEW to write a note."}</p>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
              <h2 className="card-title" style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>{active.title}</h2>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button type="button" className="btn" style={{ padding: "6px 10px" }} onClick={() => startEdit(active)}>EDIT</button>
                <button type="button" className="btn" style={{ padding: "6px 10px" }} onClick={() => togglePin(active)} aria-pressed={active.pinned}>{active.pinned ? "UNPIN" : "PIN"}</button>
                <button type="button" className="btn" style={{ padding: "6px 10px", minWidth: 74 }} onClick={() => void copy(active)}>{copied === "ok" ? "COPIED ✓" : copied === "fail" ? "COPY FAILED" : "COPY"}</button>
                <button type="button" className="btn btn-danger" style={{ padding: "6px 10px" }} onClick={() => remove(active.id)}>DELETE</button>
              </div>
            </div>
            <p className="notes-meta" style={{ marginBottom: 14 }}>
              Edited {ago(active.updatedAt, true)} · {words(active.body)} word{words(active.body) === 1 ? "" : "s"}
            </p>
            <div onDoubleClick={() => startEdit(active)} title="Double-click to edit" style={{ cursor: "text" }}>
              {active.body.trim() ? <RichText body={active.body} html={active.html} /> : <p style={{ color: "var(--color-muted)" }}>Empty note.</p>}
            </div>
          </>
        )}
      </div>

      {undo && (
        <div className="notes-toast" role="status">
          <span>Deleted “{undo.note.title}”</span>
          <button type="button" onClick={restore}>UNDO</button>
        </div>
      )}
    </div>
  );
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  const prev = document.activeElement as HTMLElement | null;
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  prev?.focus?.({ preventScroll: true });
  return ok;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function words(s: string) {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

/** "just now", "5m ago", "3h ago", "Yesterday", "Oct 12", "Oct 12, 2025". `long` spells it for the detail line. */
export function ago(iso: string, long = false, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return long ? `${m} min ago` : `${m}m ago`;
  const h = Math.round(m / 60);
  const d = new Date(t);
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  if (h < 24 && sameDay) return long ? `${h} hr ago` : `${h}h ago`;
  const yest = new Date(now - 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === yest.toDateString()) return long ? `yesterday at ${time}` : "Yesterday";
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === today.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" };
  const date = d.toLocaleDateString(undefined, opts);
  return long ? `${date} at ${time}` : date;
}

/** The preview line: the first line, or — when searching — the text around the first hit in the body. */
export function snippet(body: string, terms: string[]): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!terms.length) return body.trim().split("\n")[0] ?? "";
  const low = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return body.trim().split("\n")[0] ?? "";
  const start = Math.max(0, at - 24);
  return (start > 0 ? "…" : "") + flat.slice(start, start + 120);
}

/** Wrap every search term in <mark>. */
export function highlight(text: string, terms: string[]): ReactNode {
  if (!terms.length || !text) return text;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  const parts = text.split(re);
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="note-hit">{p}</mark> : <Fragment key={i}>{p}</Fragment>));
}
