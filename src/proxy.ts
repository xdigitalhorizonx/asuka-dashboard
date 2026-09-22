import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, bearerMatchesCron, bearerMatchesSync, gateEnabled, verifySession } from "@/lib/auth";

/** Paths that stay reachable without a session: the login flow, the Asuka bot's
 *  bearer-protected sync API, the Stripe webhook (authenticated by its signature),
 *  and the home-screen assets — iOS fetches the manifest and apple-touch-icon
 *  without cookies, so they must not redirect to /login. */
const OPEN = [
  "/login",
  "/api/login",
  "/api/logout",
  "/api/sync",
  "/api/stripe/webhook",
  "/api/google/callback", // Google's redirect carries no session; guarded by its own state cookie
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/icons",
];

export async function proxy(req: NextRequest) {
  if (!gateEnabled()) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (OPEN.some((p) => pathname === p || pathname.startsWith(p + "/"))) return NextResponse.next();

  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    if (bearerMatchesSync(req)) return NextResponse.next();
    if (pathname === "/api/stripe/sync" && bearerMatchesCron(req)) return NextResponse.next();
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
