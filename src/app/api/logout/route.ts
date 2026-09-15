import { NextResponse } from "next/server";
import { SESSION_COOKIE, gateEnabled } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const base = new URL(req.url);
  const res = NextResponse.redirect(new URL(gateEnabled() ? "/login" : "/", base), 303);
  res.cookies.set({ name: SESSION_COOKIE, value: "", path: "/", maxAge: 0 });
  return res;
}
