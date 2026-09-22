/**
 * Password gate for the board. Active only when ASUKA_DASHBOARD_PASSWORD is set.
 * Sessions are a signed "exp.hmac" cookie (Web Crypto, so it runs in proxy + routes).
 */
export const SESSION_COOKIE = "asuka_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function gateEnabled(): boolean {
  return !!process.env.ASUKA_DASHBOARD_PASSWORD;
}

function secret(): string {
  return process.env.ASUKA_SESSION_SECRET || process.env.ASUKA_DASHBOARD_PASSWORD || "";
}

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function hmac(msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function mintSession(): Promise<string> {
  const exp = String(Date.now() + SESSION_MAX_AGE * 1000);
  return `${exp}.${await hmac(exp)}`;
}

export async function verifySession(token: string | undefined): Promise<boolean> {
  if (!token || !secret()) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return timingSafeEqual(await hmac(exp), sig);
}

export function passwordMatches(input: string): boolean {
  const expected = process.env.ASUKA_DASHBOARD_PASSWORD || "";
  return expected.length > 0 && timingSafeEqual(expected, input);
}

/** Same bearer the Asuka bot uses on /api/sync — lets scripts hit /api/state without a browser session. */
export function bearerMatchesSync(req: Request): boolean {
  const expected = process.env.ASUKA_SYNC_TOKEN;
  if (!expected) return false;
  const h = req.headers.get("authorization") || "";
  const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  return t.length > 0 && timingSafeEqual(t, expected);
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET` — lets the scheduled Stripe reconcile through the gate. */
export function bearerMatchesCron(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const h = req.headers.get("authorization") || "";
  const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  return t.length > 0 && timingSafeEqual(t, expected);
}

/** Only allow same-origin relative redirects after login. */
export function safeNext(raw: string | null | undefined): string {
  const n = String(raw ?? "/");
  return n.startsWith("/") && !n.startsWith("//") ? n : "/";
}
