/**
 * Minimal Google Tasks v1 client. Auth (refresh token → access token) lives in
 * ./google; every call takes the GoogleAuth resolved for the current request.
 *
 * Env: GOOGLE_TASKS_LIST — task list id (default "@default" = "My Tasks").
 * Test seam: GOOGLE_TASKS_API_BASE.
 */
import { googleFetch, type GoogleAuth } from "./google";

export { GoogleApiError as GoogleTasksError } from "./google";

const API_BASE = () => (process.env.GOOGLE_TASKS_API_BASE || "https://tasks.googleapis.com/tasks/v1").replace(/\/$/, "");

export interface GoogleTask {
  id: string;
  title: string;
  notes?: string;
  status: "needsAction" | "completed";
  /** RFC 3339; Google keeps only the date part. */
  due?: string;
  completed?: string;
  updated: string;
  deleted?: boolean;
  hidden?: boolean;
}

export interface GoogleTaskList {
  id: string;
  title: string;
}

/** Fields we send. `null` on a PATCH clears the field. */
export type GoogleTaskPatch = {
  title?: string;
  notes?: string;
  status?: GoogleTask["status"];
  due?: string | null;
  completed?: string | null;
};

export function taskListId(): string {
  return process.env.GOOGLE_TASKS_LIST || "@default";
}

function url(path: string, query: Record<string, string> = {}): URL {
  const u = new URL(API_BASE() + path);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u;
}

const listPath = () => `/lists/${encodeURIComponent(taskListId())}`;

export async function getTaskList(auth: GoogleAuth): Promise<GoogleTaskList> {
  return googleFetch<GoogleTaskList>(auth, "GET", url(`/users/@me/lists/${encodeURIComponent(taskListId())}`));
}

/** Every live task in the list (open + completed, including ones Google has hidden). */
export async function listTasks(auth: GoogleAuth): Promise<GoogleTask[]> {
  const out: GoogleTask[] = [];
  let pageToken: string | undefined;
  do {
    const page = await googleFetch<{ items?: GoogleTask[]; nextPageToken?: string }>(
      auth,
      "GET",
      url(`${listPath()}/tasks`, { maxResults: "100", showCompleted: "true", showHidden: "true", ...(pageToken ? { pageToken } : {}) })
    );
    for (const t of page.items ?? []) if (!t.deleted) out.push(t);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export async function insertTask(auth: GoogleAuth, body: GoogleTaskPatch): Promise<GoogleTask> {
  const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null && v !== undefined));
  return googleFetch<GoogleTask>(auth, "POST", url(`${listPath()}/tasks`), clean);
}

export async function patchTask(auth: GoogleAuth, id: string, body: GoogleTaskPatch): Promise<GoogleTask> {
  return googleFetch<GoogleTask>(auth, "PATCH", url(`${listPath()}/tasks/${encodeURIComponent(id)}`), body);
}

/** Idempotent: a task that is already gone is not an error. */
export async function deleteTask(auth: GoogleAuth, id: string): Promise<void> {
  try {
    await googleFetch<void>(auth, "DELETE", url(`${listPath()}/tasks/${encodeURIComponent(id)}`));
  } catch (err) {
    if (err instanceof Error && "status" in err && (err as { status?: number }).status === 404) return;
    throw err;
  }
}
