import { put, list } from "@vercel/blob";
import { promises as fs } from "fs";
import path from "path";
import { normalizeCustomers, normalizeLeads, type AppState, type Reminder } from "./types";

export const BLOB_PATHNAME = "asuka-command-center/state.json";

/**
 * Dev-only fallback: when BLOB_READ_WRITE_TOKEN is absent and this is not a
 * production build, persist to a JSON file in the project root (gitignored) so
 * the board works end-to-end on localhost without touching the live vault.
 */
const LOCAL_VAULT = path.join(process.cwd(), ".asuka-local-state.json");
const blobToken = () => process.env.BLOB_READ_WRITE_TOKEN;
const localVaultEnabled = () => !blobToken() && process.env.NODE_ENV !== "production";

const SEED_REMINDERS: Reminder[] = [
  {
    id: "r6",
    title: "Setup Bev with document access",
    notes: "",
    dueAt: "2026-09-11",
    time: "09:30",
    priority: "medium",
    done: false,
    createdAt: "2026-09-10T19:10:18Z",
    source: "asuka",
  },
  {
    id: "r7",
    title: "Finish hero",
    notes: "",
    dueAt: "2026-09-11",
    time: "09:30",
    priority: "medium",
    done: false,
    createdAt: "2026-09-10T19:10:18Z",
    source: "asuka",
  },
  {
    id: "r8",
    title: "Contact groups",
    notes: "",
    dueAt: "2026-09-11",
    time: "09:30",
    priority: "medium",
    done: false,
    createdAt: "2026-09-10T19:10:18Z",
    source: "asuka",
  },
  {
    id: "r9",
    title: "Open todos: Setup Bev / Finish hero / Contact groups",
    notes: "Same-day ping",
    dueAt: "2026-09-10",
    time: "16:00",
    priority: "high",
    done: false,
    createdAt: "2026-09-10T19:12:46Z",
    source: "asuka",
  },
  {
    id: "r10",
    title: "Give Bev admin access on workspace and have them set up payment",
    notes: "",
    dueAt: "2026-09-11",
    time: "09:30",
    priority: "high",
    done: false,
    createdAt: "2026-09-10T19:15:03Z",
    source: "asuka",
  },
];

export function emptyState(): AppState {
  return {
    reminders: [],
    notes: [
      {
        id: "n1",
        title: "How this board works",
        body: "Asuka SMS sync is live. Reminders and CRM leads she logs by text show up here automatically. Export JSON anytime as a backup.",
        updatedAt: new Date().toISOString(),
        pinned: true,
      },
    ],
    attachments: [],
    leads: [],
    customers: [],
  };
}

export function seededState(): AppState {
  const base = emptyState();
  return { ...base, reminders: SEED_REMINDERS };
}

function normalize(raw: unknown): AppState {
  const parsed = (raw ?? {}) as Partial<AppState>;
  return {
    reminders: parsed.reminders ?? [],
    notes: parsed.notes ?? [],
    attachments: parsed.attachments ?? [],
    leads: normalizeLeads(parsed.leads),
    customers: normalizeCustomers(parsed.customers),
  };
}

async function findBlobUrl(): Promise<string | null> {
  const token = blobToken();
  if (!token) return null;
  const result = await list({ prefix: BLOB_PATHNAME, limit: 10, token });
  const hit = result.blobs.find((b) => b.pathname === BLOB_PATHNAME);
  return hit?.url ?? null;
}

export async function readState(): Promise<AppState> {
  const token = blobToken();
  if (!token) {
    if (localVaultEnabled()) {
      try {
        return normalize(JSON.parse(await fs.readFile(LOCAL_VAULT, "utf8")));
      } catch {
        const seeded = seededState();
        await writeState(seeded);
        return seeded;
      }
    }
    return seededState();
  }
  try {
    const url = await findBlobUrl();
    if (!url) {
      const seeded = seededState();
      await writeState(seeded);
      return seeded;
    }
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const seeded = seededState();
      await writeState(seeded);
      return seeded;
    }
    const data = normalize(await res.json());
    if (
      data.reminders.length === 0 &&
      data.leads.length === 0 &&
      data.notes.length <= 1
    ) {
      // first boot with empty vault — seed open Asuka reminders once
      const seeded = { ...data, reminders: SEED_REMINDERS };
      if (!data.notes.length) seeded.notes = emptyState().notes;
      await writeState(seeded);
      return seeded;
    }
    return data;
  } catch {
    return seededState();
  }
}

export async function writeState(state: AppState): Promise<AppState> {
  const token = blobToken();
  const normalized = normalize(state);
  if (!token) {
    if (localVaultEnabled()) {
      await fs.writeFile(LOCAL_VAULT, JSON.stringify(normalized, null, 2), "utf8");
      return normalized;
    }
    throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  }
  await put(BLOB_PATHNAME, JSON.stringify(normalized), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
    token,
  });
  return normalized;
}

export function assertSyncAuth(req: Request): boolean {
  const expected = process.env.ASUKA_SYNC_TOKEN;
  if (!expected) return false;
  const header = req.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  return token.length > 0 && token === expected;
}
