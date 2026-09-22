import { NextResponse } from "next/server";
import { readState, writeState } from "@/lib/server-state";
import { TASKS_SCOPE, encryptToken, exchangeCode, googleAccount, googleConfigured, revokeToken } from "@/lib/google";
import { OAUTH_STATE_COOKIE, doneUrl, redirectUriFor } from "../oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/google/callback — Google sends the browser here after consent. Open in
 * proxy.ts (Google's redirect carries no session), protected by the state cookie
 * set by /api/google/connect. Only the configured account is accepted; anyone
 * else's grant is revoked on the spot. The refresh token is stored encrypted.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (status: string) => {
    const res = NextResponse.redirect(doneUrl(req, status), 302);
    res.cookies.set({ name: OAUTH_STATE_COOKIE, value: "", path: "/api/google", maxAge: 0 });
    return res;
  };

  if (!googleConfigured()) return back("not-configured");
  const denied = url.searchParams.get("error");
  if (denied) return back(`denied:${denied}`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = req.headers.get("cookie") || "";
  const expected = cookie.match(new RegExp(`(?:^|;\\s*)${OAUTH_STATE_COOKIE}=([^;]+)`))?.[1];
  if (!code || !state || !expected || state !== decodeURIComponent(expected)) return back("state-mismatch");

  try {
    const grant = await exchangeCode(code, redirectUriFor(req));
    if (!grant.email || grant.email.toLowerCase() !== googleAccount().toLowerCase()) {
      await revokeToken(grant.refreshToken);
      return back(`wrong-account:${grant.email || "unknown"}`);
    }
    if (!grant.scopes.includes(TASKS_SCOPE)) {
      await revokeToken(grant.refreshToken);
      return back("missing-tasks-scope");
    }
    const current = await readState();
    await writeState({
      ...current,
      google: {
        refreshTokenEnc: await encryptToken(grant.refreshToken),
        email: grant.email,
        scopes: grant.scopes,
        connectedAt: new Date().toISOString(),
      },
    });
    return back("connected");
  } catch (err) {
    return back(`error:${err instanceof Error ? err.message : String(err)}`);
  }
}
