import { NextResponse } from "next/server";
import { readState } from "@/lib/server-state";
import { calendarView } from "@/lib/google-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — Google Calendar events in a
 * window (max 120 days). Session / bearer gated like /api/state. Answers
 * `{ connected: false }` with no events when Google or the calendar scope is absent.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  if (!DAY.test(from) || !DAY.test(to) || from > to) {
    return NextResponse.json({ error: "from/to must be YYYY-MM-DD with from <= to" }, { status: 400 });
  }
  const span = (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000;
  if (span > 120) return NextResponse.json({ error: "window too large (max 120 days)" }, { status: 400 });
  const state = await readState();
  return NextResponse.json(await calendarView(state, from, to));
}
