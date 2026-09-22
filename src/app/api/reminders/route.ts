import { NextResponse } from "next/server";
import { normalizeReminder, type Reminder } from "@/lib/types";
import { readState, writeState } from "@/lib/server-state";
import { GoogleTasksError } from "@/lib/google-tasks";
import {
  clientPayload,
  discardVaultReminders,
  errorMessage,
  listReminders,
  migrateVaultReminders,
  removeReminder,
  setReminderDone,
  upsertReminder,
} from "@/lib/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Browser-side reminder mutations. Same session / bearer gate as /api/state.
 * Works against Google Tasks when configured, otherwise the vault, and always
 * answers with the fresh list so the UI can replace its optimistic copy.
 */
type Body =
  | { action: "upsert"; reminder: Partial<Reminder> & { id: string; title: string } }
  | { action: "set_done"; id: string; done: boolean }
  | { action: "remove"; id: string }
  | { action: "migrate_vault" }
  | { action: "discard_vault" };

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body?.action) return NextResponse.json({ error: "action required" }, { status: 400 });

  try {
    let state = await readState();
    switch (body.action) {
      case "upsert": {
        const r = body.reminder;
        if (!r || typeof r.id !== "string" || !r.id || typeof r.title !== "string" || !r.title.trim()) {
          return NextResponse.json({ error: "reminder.id and reminder.title required" }, { status: 400 });
        }
        state = (await upsertReminder(state, normalizeReminder({ ...r, title: r.title.trim() }))).state;
        break;
      }
      case "set_done":
        if (typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
        state = await setReminderDone(state, body.id, body.done === true);
        break;
      case "remove":
        if (typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
        state = await removeReminder(state, body.id);
        break;
      case "migrate_vault":
        state = await migrateVaultReminders(state);
        break;
      case "discard_vault":
        state = discardVaultReminders(state);
        break;
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    state = await writeState(state);
    return NextResponse.json(clientPayload(state, await listReminders(state)));
  } catch (err) {
    const status = err instanceof GoogleTasksError ? 502 : 500;
    return NextResponse.json({ error: errorMessage(err) || "reminder update failed" }, { status });
  }
}
