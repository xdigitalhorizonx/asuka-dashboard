/**
 * Minimal Google Tasks v1 client for one pre-authorised account
 * (brandon@digitalhorizon.dev). Auth is a long-lived refresh token minted once
 * with `node scripts/google-tasks-auth.mjs` and stored in env; access tokens are
 * refreshed here and cached in memory for the life of the serverless instance.
 *
 * Env:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_TASKS_REFRESH_TOKEN — required to enable
 *   GOOGLE_TASKS_LIST — task list id (default "@default" = "My Tasks")
 *   GOOGLE_TASKS_API_BASE, GOOGLE_OAUTH_TOKEN_URL — override only for tests against a mock
 */
export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";

const API_BASE = () => (process.env.GOOGLE_TASKS_API_BASE || "https://tasks.googleapis.com/tasks/v1").replace(/\/$/, "");
const TOKEN_URL = () => process.env.GOOGLE_OAUTH_TOKEN_URL || "https://oauth2.googleapis.com/token";

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

export class GoogleTasksError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GoogleTasksError";
  }
}

export function googleTasksEnabled(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_TASKS_REFRESH_TOKEN);
}

export function taskListId(): string {
  return process.env.GOOGLE_TASKS_LIST || "@default";
}

let cached: { token: string; exp: number } | null = null;

async function errorDetail(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string | { message?: string }; error_description?: string };
    if (typeof j.error === "string") return j.error_description || j.error;
    return j.error?.message || "";
  } catch {
    return "";
  }
}

async function accessToken(force = false): Promise<string> {
  if (!force && cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch(TOKEN_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      refresh_token: process.env.GOOGLE_TASKS_REFRESH_TOKEN || "",
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    cached = null;
    const detail = await errorDetail(res);
    throw new GoogleTasksError(`Google token refresh failed (HTTP ${res.status}${detail ? `: ${detail}` : ""})`, res.status);
  }
  const j = (await res.json()) as { access_token: string; expires_in?: number };
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function call<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
  retryAuth = true
): Promise<T> {
  const url = new URL(API_BASE() + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  if (res.status === 401 && retryAuth) {
    await accessToken(true);
    return call<T>(method, path, opts, false);
  }
  if (!res.ok) {
    const detail = await errorDetail(res);
    throw new GoogleTasksError(`Google Tasks ${method} ${path} failed (HTTP ${res.status}${detail ? `: ${detail}` : ""})`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const listPath = () => `/lists/${encodeURIComponent(taskListId())}`;

export async function getTaskList(): Promise<GoogleTaskList> {
  return call<GoogleTaskList>("GET", `/users/@me/lists/${encodeURIComponent(taskListId())}`);
}

/** Every live task in the list (open + completed, including ones Google has hidden). */
export async function listTasks(): Promise<GoogleTask[]> {
  const out: GoogleTask[] = [];
  let pageToken: string | undefined;
  do {
    const page = await call<{ items?: GoogleTask[]; nextPageToken?: string }>("GET", `${listPath()}/tasks`, {
      query: { maxResults: "100", showCompleted: "true", showHidden: "true", ...(pageToken ? { pageToken } : {}) },
    });
    for (const t of page.items ?? []) if (!t.deleted) out.push(t);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export async function insertTask(body: GoogleTaskPatch): Promise<GoogleTask> {
  const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null && v !== undefined));
  return call<GoogleTask>("POST", `${listPath()}/tasks`, { body: clean });
}

export async function patchTask(id: string, body: GoogleTaskPatch): Promise<GoogleTask> {
  return call<GoogleTask>("PATCH", `${listPath()}/tasks/${encodeURIComponent(id)}`, { body });
}

/** Idempotent: a task that is already gone is not an error. */
export async function deleteTask(id: string): Promise<void> {
  try {
    await call<void>("DELETE", `${listPath()}/tasks/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof GoogleTasksError && err.status === 404) return;
    throw err;
  }
}
