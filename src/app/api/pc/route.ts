import { NextResponse } from "next/server";
import { OpsError, pcClaim, pcReport } from "@/lib/ops";
import { errorMessage } from "@/lib/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The PC agent's endpoint (open in proxy.ts, authenticated here by ASUKA_PC_TOKEN —
 * a separate token from Asuka's sync token, so the PC can only claim and report).
 *   GET  → claim queued commands (each carries a salted PIN hash the PC checks locally)
 *   POST → { id, status: "ok" | "error" | "rejected", output } for a claimed command
 */
function authorized(req: Request): boolean {
  const expected = process.env.ASUKA_PC_TOKEN;
  if (!expected) return false;
  const h = req.headers.get("authorization") || "";
  const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  if (t.length !== expected.length) return false;
  let r = 0;
  for (let i = 0; i < t.length; i++) r |= t.charCodeAt(i) ^ expected.charCodeAt(i);
  return r === 0;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ commands: await pcClaim() });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "claim failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ result: await pcReport(await req.json()) });
  } catch (err) {
    const status = err instanceof OpsError ? err.status : 500;
    return NextResponse.json({ error: errorMessage(err) || "report failed" }, { status });
  }
}
