import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE, gateEnabled, mintSession, passwordMatches, safeNext } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const base = new URL(req.url);
  if (!gateEnabled()) return NextResponse.redirect(new URL("/", base), 303);

  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  const next = safeNext(form.get("next")?.toString());

  if (!passwordMatches(password)) {
    await new Promise((r) => setTimeout(r, 600)); // blunt brute-force attempts
    const back = new URL("/login", base);
    back.searchParams.set("e", "1");
    if (next !== "/") back.searchParams.set("next", next);
    return NextResponse.redirect(back, 303);
  }

  const res = NextResponse.redirect(new URL(next, base), 303);
  res.cookies.set({
    name: SESSION_COOKIE,
    value: await mintSession(),
    httpOnly: true,
    secure: base.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
