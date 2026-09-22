import { NextResponse } from "next/server";
import { consentUrl, googleAccount, googleConfigured } from "@/lib/google";
import { OAUTH_STATE_COOKIE, redirectUriFor } from "../oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/google/connect — start the one-click Google connect. Session-gated by
 * proxy.ts, so only someone who is already inside the board can begin it. Sends
 * the browser to Google's consent screen for brandon@digitalhorizon.dev with the
 * Tasks + Calendar scopes; Google comes back to /api/google/callback.
 */
export async function GET(req: Request) {
  if (!googleConfigured()) {
    return NextResponse.json(
      { error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on this deployment — see README → Reminders = Google Tasks" },
      { status: 503 }
    );
  }
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  const res = NextResponse.redirect(consentUrl(redirectUriFor(req), state), 302);
  res.cookies.set({
    name: OAUTH_STATE_COOKIE,
    value: state,
    httpOnly: true,
    secure: new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https",
    sameSite: "lax",
    path: "/api/google",
    maxAge: 600,
  });
  res.headers.set("x-google-account", googleAccount());
  return res;
}
