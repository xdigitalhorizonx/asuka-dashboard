import { NextResponse } from "next/server";
import type { AppState } from "@/lib/types";
import { readState, writeState } from "@/lib/server-state";
import { clientPayload, errorMessage, listReminders, remindersBackend } from "@/lib/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = await readState();
    return NextResponse.json(clientPayload(state, await listReminders(state)));
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "Failed to read state" }, { status: 500 });
  }
}

/**
 * The browser posts its whole copy of the board. Reminders are not part of that
 * contract any more — they change through /api/reminders — so when Google Tasks is
 * the backend the posted `reminders` are ignored and the server-owned sidecar is kept.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { state?: AppState };
    if (!body?.state || typeof body.state !== "object") {
      return NextResponse.json({ error: "state required" }, { status: 400 });
    }
    const current = await readState();
    const google = remindersBackend() === "google";
    const state = await writeState({
      ...body.state,
      ...(google ? { reminders: current.reminders } : {}),
      ...(current.reminderMeta ? { reminderMeta: current.reminderMeta } : {}),
    });
    return NextResponse.json({ ...state, reminderMeta: undefined, remindersSource: remindersBackend() });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "Failed to write state" }, { status: 500 });
  }
}
