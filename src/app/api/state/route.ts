import { NextResponse } from "next/server";
import type { AppState } from "@/lib/types";
import { readState, writeState } from "@/lib/server-state";
import { clientPayload, errorMessage, listReminders, remindersBackend } from "@/lib/reminders";
import { googleStatus } from "@/lib/google";
import { migrateLegacyAttachments } from "@/lib/files";
import { storeMode } from "@/lib/blobstore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-owned fields the browser must never overwrite: the Google token link, the
 * reminder sidecar, and legacy vault attachments (files live in /api/files now, so a
 * browser copy posting `attachments: []` must not be able to erase anything).
 */
function serverOwned(current: AppState): Partial<AppState> {
  return {
    attachments: current.attachments,
    ...(current.reminderMeta ? { reminderMeta: current.reminderMeta } : {}),
    ...(current.google ? { google: current.google } : {}),
  };
}

/**
 * One-time move of base64 attachments out of the vault into file storage. Runs on
 * the first board load after deploy; a failure leaves them in the vault and the
 * next load retries.
 */
async function moveLegacyAttachments(state: AppState): Promise<AppState> {
  if (!state.attachments.length || storeMode() === "none") return state;
  try {
    const moved = await migrateLegacyAttachments(state);
    if (!moved.size) return state;
    const fresh = await readState();
    return await writeState({ ...fresh, attachments: fresh.attachments.filter((a) => !moved.has(a.id)) });
  } catch (err) {
    console.error("legacy attachment migration failed:", err);
    return state;
  }
}

export async function GET() {
  try {
    const state = await moveLegacyAttachments(await readState());
    return NextResponse.json(clientPayload(state, await listReminders(state), { google: googleStatus(state) }));
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "Failed to read state" }, { status: 500 });
  }
}

/**
 * The browser posts its whole copy of the board. Reminders are not part of that
 * contract any more — they change through /api/reminders — so while Google is
 * connected the posted `reminders` are ignored; the token link, sidecar and legacy
 * attachments are always kept from the server copy.
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
    return NextResponse.json({ ...state, attachments: [], reminderMeta: undefined, google: undefined, remindersSource: remindersBackend(state) });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "Failed to write state" }, { status: 500 });
  }
}
