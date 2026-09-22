/**
 * Reminders provider. When Google Tasks is configured, Brandon's task list is the
 * source of truth for title / notes / due date / done, and the vault keeps a small
 * sidecar (`reminderMeta`) for the fields Google can't hold: priority, time, source
 * and the id Asuka knows the reminder by. Without Google, reminders live in the
 * vault exactly as before.
 *
 * Every mutation returns the vault state to persist; callers `writeState()` it.
 */
import {
  deleteTask,
  getTaskList,
  googleTasksEnabled,
  insertTask,
  listTasks,
  patchTask,
  taskListId,
  type GoogleTask,
  type GoogleTaskPatch,
} from "./google-tasks";
import type { AppState, Reminder, ReminderMeta, RemindersBackend } from "./types";

export interface RemindersView {
  reminders: Reminder[];
  source: RemindersBackend;
  /** Title of the Google list (falls back to its id). */
  list?: string;
  /** Google was configured but unreachable; the rest of the board still works. */
  error?: string;
  /** Reminders still sitting in the vault from before Google was connected — moved only on request. */
  pendingVault?: number;
}

export function remindersBackend(): RemindersBackend {
  return googleTasksEnabled() ? "google" : "vault";
}

/** Error text for the UI; Node's bare "fetch failed" gets its cause appended (e.g. ECONNREFUSED). */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : "";
  return cause && !err.message.includes(cause) ? `${err.message}: ${cause}` : err.message;
}

const dueOf = (t: GoogleTask): string => (t.due ? t.due.slice(0, 10) : "");
const toGoogleDue = (dueAt: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(dueAt) ? `${dueAt}T00:00:00.000Z` : null);

function fromTask(t: GoogleTask, meta: ReminderMeta | undefined): Reminder {
  return {
    id: t.id,
    title: t.title || "(untitled)",
    notes: t.notes || "",
    dueAt: dueOf(t),
    ...(meta?.time ? { time: meta.time } : {}),
    priority: meta?.priority ?? "medium",
    done: t.status === "completed",
    createdAt: meta?.createdAt ?? t.updated,
    source: meta?.source ?? "manual",
  };
}

/** Open first, soonest first, undated last; done at the bottom. */
function sortReminders(rs: Reminder[]): Reminder[] {
  return rs.slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ad = a.dueAt || "9999-99-99";
    const bd = b.dueAt || "9999-99-99";
    if (ad !== bd) return ad < bd ? -1 : 1;
    const at = a.time || "99:99";
    const bt = b.time || "99:99";
    if (at !== bt) return at < bt ? -1 : 1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
}

/** Resolve an incoming id (Google id, Asuka id, or manual uid) to the Google task id we already know. */
function googleIdFor(meta: Record<string, ReminderMeta>, id: string): string | null {
  if (meta[id]) return id;
  for (const [gid, m] of Object.entries(meta)) if (m.externalId === id) return gid;
  return null;
}

async function upsertGoogle(
  state: AppState,
  r: Reminder,
  known?: GoogleTask[]
): Promise<{ state: AppState; reminder: Reminder }> {
  const meta = { ...(state.reminderMeta ?? {}) };
  let gid = googleIdFor(meta, r.id);
  if (!gid && known?.some((t) => t.id === r.id)) gid = r.id;

  const base: GoogleTaskPatch = { title: r.title, notes: r.notes || "", status: r.done ? "completed" : "needsAction" };
  const due = toGoogleDue(r.dueAt);
  const task = gid
    ? await patchTask(gid, { ...base, due, ...(r.done ? {} : { completed: null }) })
    : await insertTask({ ...base, ...(due ? { due } : {}) });

  const prev = meta[task.id];
  const externalId = r.id !== task.id ? r.id : prev?.externalId;
  meta[task.id] = {
    priority: r.priority,
    ...(r.time ? { time: r.time } : {}),
    source: r.source,
    ...(externalId ? { externalId } : {}),
    createdAt: prev?.createdAt ?? r.createdAt ?? new Date().toISOString(),
  };
  return { state: { ...state, reminderMeta: meta }, reminder: fromTask(task, meta[task.id]) };
}

/**
 * Explicit, one-click move of the reminders that were in the vault before Google
 * was connected. Never runs on a read: two concurrent first loads would otherwise
 * both insert. Idempotent per reminder — the old id becomes the task's externalId,
 * so a retry after a partial failure patches instead of duplicating.
 */
export async function migrateVaultReminders(state: AppState): Promise<AppState> {
  if (!googleTasksEnabled()) return state;
  let next = state;
  for (const r of state.reminders) next = (await upsertGoogle(next, r)).state;
  return { ...next, reminders: [] };
}

/** Drop the pre-Google vault reminders without touching Google. */
export function discardVaultReminders(state: AppState): AppState {
  return { ...state, reminders: [] };
}

/** Read-only: what the reminders backend currently holds. Never mutates anything. */
export async function listReminders(state: AppState): Promise<RemindersView> {
  if (!googleTasksEnabled()) return { reminders: state.reminders, source: "vault" };
  const pending = state.reminders.length ? { pendingVault: state.reminders.length } : {};
  try {
    const meta = state.reminderMeta ?? {};
    const [tasks, list] = await Promise.all([listTasks(), getTaskList().catch(() => null)]);
    const reminders = sortReminders(tasks.map((t) => fromTask(t, meta[t.id])));
    return { reminders, source: "google", list: list?.title ?? taskListId(), ...pending };
  } catch (err) {
    return { reminders: [], source: "google", list: taskListId(), error: errorMessage(err), ...pending };
  }
}

export async function upsertReminder(state: AppState, r: Reminder): Promise<{ state: AppState; reminder: Reminder }> {
  if (!googleTasksEnabled()) {
    const others = state.reminders.filter((x) => x.id !== r.id);
    return { state: { ...state, reminders: [r, ...others] }, reminder: r };
  }
  return upsertGoogle(state, r);
}

export async function setReminderDone(state: AppState, id: string, done: boolean): Promise<AppState> {
  if (!googleTasksEnabled()) {
    return { ...state, reminders: state.reminders.map((r) => (r.id === id ? { ...r, done } : r)) };
  }
  const gid = googleIdFor(state.reminderMeta ?? {}, id) ?? id;
  await patchTask(gid, done ? { status: "completed" } : { status: "needsAction", completed: null });
  return state;
}

export async function removeReminder(state: AppState, id: string): Promise<AppState> {
  if (!googleTasksEnabled()) {
    return { ...state, reminders: state.reminders.filter((r) => r.id !== id) };
  }
  const meta = { ...(state.reminderMeta ?? {}) };
  const gid = googleIdFor(meta, id) ?? id;
  await deleteTask(gid);
  delete meta[gid];
  return { ...state, reminderMeta: meta };
}

/**
 * Asuka's "full sync". In the vault it is a plain replace (as it always was).
 * In Google it upserts everything she sends and removes only the tasks she created
 * earlier and no longer sends — tasks Brandon made himself are never touched.
 */
export async function replaceReminders(state: AppState, incoming: Reminder[]): Promise<AppState> {
  if (!googleTasksEnabled()) return { ...state, reminders: incoming };
  const known = await listTasks();
  let next = state;
  for (const r of incoming) next = (await upsertGoogle(next, r, known)).state;
  const keep = new Set(incoming.map((r) => r.id));
  const meta = { ...(next.reminderMeta ?? {}) };
  for (const [gid, m] of Object.entries(meta)) {
    if (m.source === "asuka" && m.externalId && !keep.has(m.externalId) && !keep.has(gid)) {
      await deleteTask(gid);
      delete meta[gid];
    }
  }
  return { ...next, reminderMeta: meta };
}

/** What the browser and the Asuka bot receive: vault content plus the live reminders. */
export function clientPayload(state: AppState, view: RemindersView) {
  return {
    reminders: view.reminders,
    notes: state.notes,
    attachments: state.attachments,
    leads: state.leads,
    customers: state.customers,
    remindersSource: view.source,
    ...(view.list ? { remindersList: view.list } : {}),
    ...(view.error ? { remindersError: view.error } : {}),
    ...(view.pendingVault ? { remindersPending: view.pendingVault } : {}),
  };
}
