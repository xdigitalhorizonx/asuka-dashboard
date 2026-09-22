import { NextResponse } from "next/server";
import { isCrmStage, normalizeLead, normalizeReminder, type AppState, type Lead, type Reminder } from "@/lib/types";
import { assertSyncAuth, readState, writeState } from "@/lib/server-state";
import { GoogleTasksError } from "@/lib/google-tasks";
import {
  clientPayload,
  errorMessage,
  listReminders,
  remindersBackend,
  removeReminder,
  replaceReminders,
  setReminderDone,
  upsertReminder,
} from "@/lib/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SyncBody =
  | { action: "ping" }
  | { action: "set_state"; state: AppState }
  | { action: "replace_reminders"; reminders: Reminder[] }
  | { action: "upsert_reminder"; reminder: Reminder }
  | { action: "resolve_reminder"; id: string }
  | { action: "remove_reminder"; id: string }
  | { action: "upsert_lead"; lead: Partial<Lead> };

function isReminderInput(v: unknown): v is Partial<Reminder> & { id: string; title: string } {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<Reminder>;
  return typeof r.id === "string" && r.id.length > 0 && typeof r.title === "string" && r.title.length > 0;
}

export async function POST(req: Request) {
  if (!assertSyncAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: SyncBody;
  try {
    body = (await req.json()) as SyncBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body?.action) {
    return NextResponse.json({ error: "action required" }, { status: 400 });
  }

  if (body.action === "ping") {
    return NextResponse.json({ ok: true, service: "asuka-dashboard-sync", reminders: remindersBackend() });
  }

  try {
    let state = await readState();

    switch (body.action) {
      case "set_state": {
        // Reminders are owned by the reminders backend; a whole-state push keeps the server's copy + sidecar.
        const google = remindersBackend() === "google";
        state = await writeState({
          ...body.state,
          ...(google ? { reminders: state.reminders } : {}),
          ...(state.reminderMeta ? { reminderMeta: state.reminderMeta } : {}),
        });
        break;
      }
      case "replace_reminders": {
        const incoming = Array.isArray(body.reminders) ? body.reminders.filter(isReminderInput).map(normalizeReminder) : [];
        state = await writeState(await replaceReminders(state, incoming));
        break;
      }
      case "upsert_reminder": {
        if (!isReminderInput(body.reminder)) {
          return NextResponse.json({ error: "reminder.id and reminder.title required" }, { status: 400 });
        }
        state = await writeState((await upsertReminder(state, normalizeReminder(body.reminder))).state);
        break;
      }
      case "resolve_reminder": {
        if (!body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        state = await writeState(await setReminderDone(state, body.id, true));
        break;
      }
      case "remove_reminder": {
        if (!body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        state = await writeState(await removeReminder(state, body.id));
        break;
      }
      case "upsert_lead": {
        const lead = body.lead;
        if (!lead || typeof lead.id !== "string" || !lead.id || typeof lead.name !== "string" || !lead.name) {
          return NextResponse.json(
            { error: "lead.id and lead.name required" },
            { status: 400 }
          );
        }
        // Partial upsert: fields Asuka does not send are kept from the existing
        // record, so a re-sync never wipes dashboard-side notes, stage, or appointment.
        const existing = state.leads.find((l) => l.id === lead.id);
        const now = new Date().toISOString();
        const normalized = normalizeLead({
          ...existing,
          ...lead,
          id: lead.id,
          name: lead.name,
          stage: isCrmStage(lead.stage) ? lead.stage : existing?.stage ?? "new_lead",
          noteLog: Array.isArray(lead.noteLog) ? lead.noteLog : existing?.noteLog ?? [],
          appointmentAt:
            typeof lead.appointmentAt === "string" ? lead.appointmentAt : existing?.appointmentAt,
          createdAt: lead.createdAt || existing?.createdAt || now,
          updatedAt: now,
        });
        const others = state.leads.filter((l) => l.id !== normalized.id);
        state = await writeState({ ...state, leads: [normalized, ...others] });
        break;
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }

    return NextResponse.json(clientPayload(state, await listReminders(state)));
  } catch (err) {
    const status = err instanceof GoogleTasksError ? 502 : 500;
    return NextResponse.json({ error: errorMessage(err) || "sync failed" }, { status });
  }
}

export async function GET(req: Request) {
  if (!assertSyncAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const state = await readState();
    return NextResponse.json(clientPayload(state, await listReminders(state)));
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "Failed to read state" }, { status: 500 });
  }
}
