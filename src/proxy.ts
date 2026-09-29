import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, bearerMatchesCron, bearerMatchesSync, gateEnabled, verifySession } from "@/lib/auth";

/** Paths that stay reachable without a session: the login flow, the Asuka bot's
 *  bearer-protected sync API, the Stripe webhook (authenticated by its signature),
 *  the home-screen assets — iOS fetches the manifest and apple-touch-icon
 *  without cookies, so they must not redirect to /login — and the customer-facing
 *  live invoices (/i/<id> + /api/public/invoices/<id>/…), where the unguessable
 *  invoice id in the URL is the credential. Everything else stays behind the login. */
const OPEN = [
  "/login",
  "/i",
  "/api/public",
  "/api/login",
  "/api/logout",
  "/api/sync",
  "/api/stripe/webhook",
  "/api/google/callback", // Google's redirect carries no session; guarded by its own state cookie
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/icons",
];

/** What the branded invoice-link host serves: the live invoices and the assets they load. */
const PAY_HOST_PATHS = ["/i", "/api/public", "/manifest.webmanifest", "/apple-touch-icon.png", "/icons"];

/**
 * The host of INVOICE_PUBLIC_ORIGIN (e.g. pay.digitalhorizon.dev) when it's a dedicated
 * client-facing domain. A *.vercel.app origin is the dashboard's own host, never restricted.
 */
function payHost(): string {
  try {
    const host = new URL(process.env.INVOICE_PUBLIC_ORIGIN || "").host.toLowerCase();
    return host.endsWith(".vercel.app") ? "" : host;
  } catch {
    return "";
  }
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Clients only ever see invoice pages on the branded link domain; everything else there
  // (the dashboard, its login) goes to the Digital Horizon site instead.
  const pay = payHost();
  if (pay && (req.headers.get("host") || req.nextUrl.host).toLowerCase() === pay) {
    if (PAY_HOST_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) return NextResponse.next();
    return NextResponse.redirect("https://digitalhorizon.dev/", 307);
  }

  if (!gateEnabled()) return NextResponse.next();
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
