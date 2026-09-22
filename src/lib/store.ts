"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  normalizeCustomers,
  normalizeLeads,
  type AppState,
  type Attachment,
  type Customer,
  type Lead,
  type Note,
  type Reminder,
  type RemindersBackend,
} from "./types";

const KEY = "asuka-command-center-v1";
const POLL_MS = 20_000;
/** After a local write, ignore polled server copies for this long so an edge-cached
 *  stale read cannot momentarily "undo" a note the user just typed. */
const WRITE_SETTLE_MS = 10_000;

const seed: AppState = {
  reminders: [],
  notes: [
    {
      id: "n1",
      title: "How this board works",
      body: "Asuka SMS sync is live. Reminders and CRM leads she logs by text show up here automatically.",
      updatedAt: new Date().toISOString(),
      pinned: true,
    },
  ],
  attachments: [],
  leads: [],
  customers: [],
};

/** Where reminders are coming from, as reported by the server. */
export interface RemindersInfo {
  source: RemindersBackend;
  list?: string;
  error?: string;
  /** Pre-Google vault reminders waiting for a one-click move (or discard). */
  pending?: number;
}

type ServerPayload = Partial<AppState> & {
  remindersSource?: RemindersBackend;
  remindersList?: string;
  remindersError?: string;
  remindersPending?: number;
};

function normalize(parsed: Partial<AppState> | null | undefined): AppState {
  return {
    reminders: parsed?.reminders ?? [],
    notes: parsed?.notes ?? [],
    attachments: parsed?.attachments ?? [],
    leads: normalizeLeads(parsed?.leads),
    customers: normalizeCustomers(parsed?.customers),
  };
}

function infoOf(p: ServerPayload): RemindersInfo {
  return {
    source: p.remindersSource === "google" ? "google" : "vault",
    ...(p.remindersList ? { list: p.remindersList } : {}),
    ...(p.remindersError ? { error: p.remindersError } : {}),
    ...(p.remindersPending ? { pending: p.remindersPending } : {}),
  };
}

function loadLocal(): AppState {
  if (typeof window === "undefined") return seed;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return seed;
    return normalize(JSON.parse(raw) as AppState);
  } catch {
    return seed;
  }
}

async function fetchServer(): Promise<{ state: AppState; info: RemindersInfo } | null> {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) return null;
    const p = (await res.json()) as ServerPayload;
    return { state: normalize(p), info: infoOf(p) };
  } catch {
    return null;
  }
}

/** Returns null on success, otherwise a short reason. */
async function persistServer(state: AppState): Promise<string | null> {
  try {
    const res = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
    if (res.ok) return null;
    let reason = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) reason = j.error;
    } catch {
      // non-JSON error body
    }
    return reason;
  } catch {
    return "offline";
  }
}

type ReminderAction =
  | { action: "upsert"; reminder: Reminder }
  | { action: "set_done"; id: string; done: boolean }
  | { action: "remove"; id: string }
  | { action: "migrate_vault" }
  | { action: "discard_vault" };

export function useAsukaStore() {
  const [state, setState] = useState<AppState>(seed);
  const [hydrated, setHydrated] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [remindersInfo, setRemindersInfo] = useState<RemindersInfo>({ source: "vault" });
  const [remindersBusy, setRemindersBusy] = useState(false);
  const skipNextPersist = useRef(true);
  const lastLocalWrite = useRef(0);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const local = loadLocal();
      if (!cancelled) setState(local);
      const remote = await fetchServer();
      if (!cancelled && remote) {
        setState(remote.state);
        setRemindersInfo(remote.info);
        setSyncedAt(new Date().toISOString());
        localStorage.setItem(KEY, JSON.stringify(remote.state));
      }
      if (!cancelled) {
        skipNextPersist.current = true;
        setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(KEY, JSON.stringify(state));
    if (skipNextPersist.current) {
      skipNextPersist.current = false;
      return;
    }
    lastLocalWrite.current = Date.now();
    const t = setTimeout(async () => {
      const err = await persistServer(state);
      lastLocalWrite.current = Date.now();
      setSyncError(err);
      if (!err) setSyncedAt(new Date().toISOString());
    }, 400);
    return () => clearTimeout(t);
  }, [state, hydrated]);

  const adoptRemote = useCallback((remote: { state: AppState; info: RemindersInfo }) => {
    skipNextPersist.current = true;
    setState(remote.state);
    setRemindersInfo(remote.info);
    setSyncedAt(new Date().toISOString());
    try {
      localStorage.setItem(KEY, JSON.stringify(remote.state));
    } catch {
      // storage full / unavailable — server copy is authoritative anyway
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const pull = async () => {
      if (Date.now() - lastLocalWrite.current < WRITE_SETTLE_MS) return;
      const remote = await fetchServer();
      if (!remote) return;
      if (Date.now() - lastLocalWrite.current < WRITE_SETTLE_MS) return;
      const local = JSON.stringify(stateRef.current);
      const next = JSON.stringify(remote.state);
      if (local === next) {
        setRemindersInfo(remote.info);
        setSyncedAt(new Date().toISOString());
        return;
      }
      adoptRemote(remote);
    };
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void pull();
    }, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void pull();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [hydrated, adoptRemote]);

  /**
   * Reminders change through /api/reminders (Google Tasks or the vault, server's
   * choice), not by posting the whole board. Optimistic locally, then the server's
   * fresh list replaces ours; on failure we re-pull so the UI never shows a phantom.
   */
  const reminderCall = useCallback(
    async (body: ReminderAction) => {
      setRemindersBusy(true);
      try {
        const res = await fetch("/api/reminders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const p = (await res.json().catch(() => ({}))) as ServerPayload & { error?: string };
        if (!res.ok) {
          setSyncError(p.error || `HTTP ${res.status}`);
          const remote = await fetchServer();
          if (remote) adoptRemote(remote);
          return;
        }
        skipNextPersist.current = true;
        lastLocalWrite.current = Date.now();
        setState((s) => ({ ...s, reminders: p.reminders ?? s.reminders }));
        setRemindersInfo(infoOf(p));
        setSyncError(null);
        setSyncedAt(new Date().toISOString());
      } catch {
        setSyncError("offline");
      } finally {
        setRemindersBusy(false);
      }
    },
    [adoptRemote]
  );

  const optimistic = useCallback((fn: (prev: Reminder[]) => Reminder[]) => {
    skipNextPersist.current = true;
    lastLocalWrite.current = Date.now();
    setState((s) => ({ ...s, reminders: fn(s.reminders) }));
  }, []);

  const addReminder = useCallback(
    (r: Reminder) => {
      optimistic((rs) => [r, ...rs]);
      void reminderCall({ action: "upsert", reminder: r });
    },
    [optimistic, reminderCall]
  );
  const toggleReminder = useCallback(
    (id: string) => {
      const cur = stateRef.current.reminders.find((r) => r.id === id);
      if (!cur) return;
      const done = !cur.done;
      optimistic((rs) => rs.map((r) => (r.id === id ? { ...r, done } : r)));
      void reminderCall({ action: "set_done", id, done });
    },
    [optimistic, reminderCall]
  );
  const removeReminder = useCallback(
    (id: string) => {
      optimistic((rs) => rs.filter((r) => r.id !== id));
      void reminderCall({ action: "remove", id });
    },
    [optimistic, reminderCall]
  );
  /** Move the pre-Google vault reminders into the Google list (server does the work, once). */
  const migrateVaultReminders = useCallback(() => void reminderCall({ action: "migrate_vault" }), [reminderCall]);
  const discardVaultReminders = useCallback(() => void reminderCall({ action: "discard_vault" }), [reminderCall]);

  const setNotes = useCallback(
    (fn: (prev: Note[]) => Note[]) => setState((s) => ({ ...s, notes: fn(s.notes) })),
    []
  );
  const setAttachments = useCallback(
    (fn: (prev: Attachment[]) => Attachment[]) =>
      setState((s) => ({ ...s, attachments: fn(s.attachments) })),
    []
  );
  const setLeads = useCallback(
    (fn: (prev: Lead[]) => Lead[]) => setState((s) => ({ ...s, leads: fn(s.leads) })),
    []
  );
  const setCustomers = useCallback(
    (fn: (prev: Customer[]) => Customer[]) => setState((s) => ({ ...s, customers: fn(s.customers) })),
    []
  );
  /** Adopt a state the server already persisted (e.g. after a Stripe sync) without re-posting it. */
  const adoptServerState = useCallback(
    (next: AppState) => {
      const p = next as ServerPayload;
      adoptRemote({ state: normalize(next), info: p.remindersSource ? infoOf(p) : remindersInfo });
      lastLocalWrite.current = Date.now();
    },
    [adoptRemote, remindersInfo]
  );

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `central-dogma-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [state]);

  const importJson = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = normalize(JSON.parse(String(reader.result)) as AppState);
        setState(parsed);
      } catch {
        alert("Could not parse that JSON backup.");
      }
    };
    reader.readAsText(file);
  }, []);

  return {
    ...state,
    hydrated,
    syncedAt,
    syncError,
    remindersSource: remindersInfo.source,
    remindersList: remindersInfo.list,
    remindersError: remindersInfo.error,
    remindersPending: remindersInfo.pending ?? 0,
    remindersBusy,
    addReminder,
    toggleReminder,
    removeReminder,
    migrateVaultReminders,
    discardVaultReminders,
    setNotes,
    setAttachments,
    setLeads,
    setCustomers,
    adoptServerState,
    exportJson,
    importJson,
  };
}

export function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
