import { NextResponse } from "next/server";
import type { AppState } from "@/lib/types";
import { readState, writeState } from "@/lib/server-state";
import { clientPayload, errorMessage, listReminders, remindersBackend } from "@/lib/reminders";
import { googleStatus } from "@/lib/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-owned fields the browser must never overwrite (token link, reminder sidecar). */
function serverOwned(current: AppState): Partial<AppState> {
  return {
    ...(current.reminderMeta ? { reminderMeta: current.reminderMeta } : {}),
    ...(current.google ? { google: current.google } : {}),
  };
}

export async function GET() {
  try {
    const state = await readState();
    return NextResponse.json(clientPayload(state, await listReminders(state), { google: googleStatus(state) }));
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "Failed to read state" }, { status: 500 });
  }
}

/**
 * The browser posts its whole copy of the board. Reminders are not part of that
 * contract any more — they change through /api/reminders — so while Google is
 * connected the posted `reminders` are ignored; the token link and sidecar are
 * always kept from the server copy.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { state?: AppState };
    if (!body?.state || typeof body.state !== "object") {
      return NextResponse.json({ error: "state required" }, { status: 400 });
    }
    const current = await readState();
    const google = remindersBackend(current) === "google";
    const state = await writeState({
      ...body.state,
      ...(google ? { reminders: current.reminders } : {}),
      ...serverOwned(current),
    });
    return NextResponse.json({ ...state, reminderMeta: undefined, google: undefined, remindersSource: remindersBackend(state) });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "Failed to write state" }, { status: 500 });
  }
}
