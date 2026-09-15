import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, bearerMatchesSync, gateEnabled, verifySession } from "@/lib/auth";

/** Paths that stay reachable without a session: the login flow and the Asuka bot's bearer-protected sync API. */
const OPEN = ["/login", "/api/login", "/api/logout", "/api/sync"];

export async function proxy(req: NextRequest) {
  if (!gateEnabled()) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (OPEN.some((p) => pathname === p || pathname.startsWith(p + "/"))) return NextResponse.next();

  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    if (bearerMatchesSync(req)) return NextResponse.next();
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
