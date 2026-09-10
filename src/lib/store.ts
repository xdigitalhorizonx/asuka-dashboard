"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState, Attachment, Lead, Note, Reminder } from "./types";

const KEY = "asuka-command-center-v1";
const POLL_MS = 20_000;

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
};

function normalize(parsed: Partial<AppState> | null | undefined): AppState {
  return {
    reminders: parsed?.reminders ?? [],
    notes: parsed?.notes ?? [],
    attachments: parsed?.attachments ?? [],
    leads: parsed?.leads ?? [],
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

async function fetchServer(): Promise<AppState | null> {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) return null;
    return normalize(await res.json());
  } catch {
    return null;
  }
}

async function persistServer(state: AppState): Promise<void> {
  try {
    await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
  } catch {
    // offline / blob not configured — localStorage still holds a copy
  }
}

export function useAsukaStore() {
  const [state, setState] = useState<AppState>(seed);
  const [hydrated, setHydrated] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const skipNextPersist = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const local = loadLocal();
      if (!cancelled) setState(local);
      const remote = await fetchServer();
      if (!cancelled && remote) {
        setState(remote);
        setSyncedAt(new Date().toISOString());
        localStorage.setItem(KEY, JSON.stringify(remote));
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
    const t = setTimeout(() => {
      void persistServer(state);
    }, 400);
    return () => clearTimeout(t);
  }, [state, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const pull = async () => {
      const remote = await fetchServer();
      if (!remote) return;
      const local = JSON.stringify(stateRef.current);
      const next = JSON.stringify(remote);
      if (local === next) {
        setSyncedAt(new Date().toISOString());
        return;
      }
      skipNextPersist.current = true;
      setState(remote);
      setSyncedAt(new Date().toISOString());
      localStorage.setItem(KEY, next);
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
  }, [hydrated]);

  const setReminders = useCallback(
    (fn: (prev: Reminder[]) => Reminder[]) =>
      setState((s) => ({ ...s, reminders: fn(s.reminders) })),
    []
  );
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

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `asuka-command-center-${new Date().toISOString().slice(0, 10)}.json`;
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
    setReminders,
    setNotes,
    setAttachments,
    setLeads,
    exportJson,
    importJson,
  };
}

export function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
