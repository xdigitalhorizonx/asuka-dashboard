/**
 * Google OAuth for the board's one account (brandon@digitalhorizon.dev).
 *
 * Credentials: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — a "Web application"
 * OAuth client whose authorised redirect URI is https://<host>/api/google/callback.
 *
 * The refresh token comes from one of two places:
 *   1. GOOGLE_TASKS_REFRESH_TOKEN in env (minted with scripts/google-tasks-auth.mjs), or
 *   2. the in-app Connect flow (/api/google/connect → Google → /api/google/callback),
 *      which stores it AES-256-GCM encrypted in the vault under state.google. The key
 *      is GOOGLE_TOKEN_KEY (falls back to ASUKA_SESSION_SECRET, then the dashboard
 *      password), so the public-URL blob never holds a usable secret.
 *
 * Access tokens are refreshed here and cached per refresh token for the life of
 * the serverless instance. Test seams: GOOGLE_OAUTH_TOKEN_URL, GOOGLE_OAUTH_AUTH_URL,
 * GOOGLE_OAUTH_REVOKE_URL.
 */
import type { AppState, GoogleLink } from "./types";

export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const SCOPES = ["openid", "email", TASKS_SCOPE, CALENDAR_SCOPE];

const TOKEN_URL = () => process.env.GOOGLE_OAUTH_TOKEN_URL || "https://oauth2.googleapis.com/token";
const AUTH_URL = () => process.env.GOOGLE_OAUTH_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const REVOKE_URL = () => process.env.GOOGLE_OAUTH_REVOKE_URL || "https://oauth2.googleapis.com/revoke";

export class GoogleApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export interface GoogleAuth {
  refreshToken: string;
  email?: string;
  scopes: string[];
  via: "env" | "vault";
}

/** Client id + secret are present, so the Connect flow can run. */
export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** The only Google account allowed to connect. */
export function googleAccount(): string {
  return process.env.GOOGLE_ACCOUNT || "brandon@digitalhorizon.dev";
}

/** A refresh token exists somewhere (env or vault); cheap, synchronous. */
export function googleConnected(state: Pick<AppState, "google">): boolean {
  return googleConfigured() && (!!process.env.GOOGLE_TASKS_REFRESH_TOKEN || !!state.google?.refreshTokenEnc);
}

/** What the browser is told — never the token itself. */
export function googleStatus(state: Pick<AppState, "google">) {
  const env = !!process.env.GOOGLE_TASKS_REFRESH_TOKEN;
  const link = state.google;
  const connected = googleConnected(state);
  const scopes = env ? SCOPES : link?.scopes ?? [];
  return {
    configured: googleConfigured(),
    connected,
    account: googleAccount(),
    ...(connected ? { email: env ? googleAccount() : link?.email, via: env ? ("env" as const) : ("vault" as const) } : {}),
    ...(link?.connectedAt && !env ? { connectedAt: link.connectedAt } : {}),
    tasks: connected && scopes.includes(TASKS_SCOPE),
    calendar: connected && scopes.includes(CALENDAR_SCOPE),
  };
}

/** The credential for this request, or null when Google isn't connected. Env wins (legacy CLI path). */
export async function googleAuthFor(state: Pick<AppState, "google">): Promise<GoogleAuth | null> {
  if (!googleConfigured()) return null;
  const env = process.env.GOOGLE_TASKS_REFRESH_TOKEN;
  if (env) return { refreshToken: env, email: googleAccount(), scopes: SCOPES, via: "env" };
  const link = state.google;
  if (!link?.refreshTokenEnc) return null;
  const refreshToken = await decryptToken(link.refreshTokenEnc);
  return { refreshToken, email: link.email, scopes: link.scopes, via: "vault" };
}

// ───────────────────────── access tokens ─────────────────────────

const cache = new Map<string, { token: string; exp: number }>();

async function errorDetail(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string | { message?: string }; error_description?: string };
    if (typeof j.error === "string") return j.error_description || j.error;
    return j.error?.message || "";
  } catch {
    return "";
  }
}

export async function accessToken(auth: GoogleAuth, force = false): Promise<string> {
  const hit = cache.get(auth.refreshToken);
  if (!force && hit && hit.exp > Date.now() + 60_000) return hit.token;
  const res = await fetch(TOKEN_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      refresh_token: auth.refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    cache.delete(auth.refreshToken);
    const detail = await errorDetail(res);
    throw new GoogleApiError(`Google token refresh failed (HTTP ${res.status}${detail ? `: ${detail}` : ""})`, res.status);
  }
  const j = (await res.json()) as { access_token: string; expires_in?: number };
  cache.set(auth.refreshToken, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

/** Authenticated JSON call with one retry on 401 (stale access token). */
export async function googleFetch<T>(
  auth: GoogleAuth,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: URL,
  body?: unknown,
  retryAuth = true
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken(auth)}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (res.status === 401 && retryAuth) {
    await accessToken(auth, true);
    return googleFetch<T>(auth, method, url, body, false);
  }
  if (!res.ok) {
    const detail = await errorDetail(res);
    throw new GoogleApiError(`Google ${method} ${url.pathname} failed (HTTP ${res.status}${detail ? `: ${detail}` : ""})`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ───────────────────────── consent flow ─────────────────────────

export function consentUrl(redirectUri: string, state: string): string {
  const u = new URL(AUTH_URL());
  u.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    login_hint: googleAccount(),
    state,
  }).toString();
  return u.toString();
}

function jwtEmail(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")) as { email?: string };
    return payload.email;
  } catch {
    return undefined;
  }
}

export async function exchangeCode(code: string, redirectUri: string): Promise<{ refreshToken: string; email?: string; scopes: string[] }> {
  const res = await fetch(TOKEN_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await errorDetail(res);
    throw new GoogleApiError(`Google code exchange failed (HTTP ${res.status}${detail ? `: ${detail}` : ""})`, res.status);
  }
  const j = (await res.json()) as { refresh_token?: string; id_token?: string; scope?: string };
  if (!j.refresh_token) {
    throw new GoogleApiError("Google did not return a refresh token — revoke the app at myaccount.google.com/permissions and connect again");
  }
  return { refreshToken: j.refresh_token, email: jwtEmail(j.id_token), scopes: (j.scope || "").split(" ").filter(Boolean) };
}

/** Best effort; a token that is already invalid is not an error. */
export async function revokeToken(refreshToken: string): Promise<void> {
  try {
    await fetch(REVOKE_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
      cache: "no-store",
    });
  } catch {
    // offline or already revoked
  }
}

// ───────────────────────── token at rest ─────────────────────────

function tokenSecret(): string {
  return process.env.GOOGLE_TOKEN_KEY || process.env.ASUKA_SESSION_SECRET || process.env.ASUKA_DASHBOARD_PASSWORD || "";
}

async function aesKey(): Promise<CryptoKey> {
  const secret = tokenSecret();
  if (!secret) {
    throw new GoogleApiError("Set GOOGLE_TOKEN_KEY (or ASUKA_SESSION_SECRET) so the Google refresh token can be stored encrypted");
  }
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptToken(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return Buffer.from(out).toString("base64url");
}

export async function decryptToken(enc: string): Promise<string> {
  const buf = Buffer.from(enc, "base64url");
  if (buf.length < 13) throw new GoogleApiError("Stored Google token is corrupt — connect Google again");
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.subarray(0, 12) }, await aesKey(), buf.subarray(12));
    return new TextDecoder().decode(plain);
  } catch (err) {
    if (err instanceof GoogleApiError) throw err;
    throw new GoogleApiError("Stored Google token can't be decrypted (GOOGLE_TOKEN_KEY changed?) — connect Google again");
  }
}

export function describeLink(link: GoogleLink): string {
  return `${link.email} · connected ${link.connectedAt.slice(0, 10)}`;
}
