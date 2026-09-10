"use client";

import { useCallback, useEffect, useState } from "react";
import type { AppState, Attachment, Lead, Note, Reminder } from "./types";

const KEY = "asuka-command-center-v1";

const seed: AppState = {
  reminders: [],
  notes: [
    {
      id: "n1",
      title: "How this board works",
      body: "Asuka does not expose a public reminder API yet. Log what she sets here. Export JSON as a backup.",
      updatedAt: new Date().toISOString(),
      pinned: true,
    },
  ],
  attachments: [],
  leads: [],
};

function load(): AppState {
  if (typeof window === "undefined") return seed;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return seed;
    const parsed = JSON.parse(raw) as AppState;
    return {
      reminders: parsed.reminders ?? [],
      notes: parsed.notes ?? [],
      attachments: parsed.attachments ?? [],
      leads: parsed.leads ?? [],
    };
  } catch {
    return seed;
  }
}

export function useAsukaStore() {
  const [state, setState] = useState<AppState>(seed);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setState(load());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(KEY, JSON.stringify(state));
  }, [state, hydrated]);

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
        const parsed = JSON.parse(String(reader.result)) as AppState;
        setState({
          reminders: parsed.reminders ?? [],
          notes: parsed.notes ?? [],
          attachments: parsed.attachments ?? [],
          leads: parsed.leads ?? [],
        });
      } catch {
        alert("Could not parse that JSON backup.");
      }
    };
    reader.readAsText(file);
  }, []);

  return { ...state, hydrated, setReminders, setNotes, setAttachments, setLeads, exportJson, importJson };
}

export function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
