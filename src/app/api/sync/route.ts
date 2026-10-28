import { NextResponse } from "next/server";
import { isCrmStage, normalizeLead, normalizeReminder, type AppState, type Lead, type Note, type Reminder } from "@/lib/types";
import { assertSyncAuth, readState, writeState } from "@/lib/server-state";
import { GoogleApiError, googleStatus } from "@/lib/google";
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
import { OpsError, pcEnqueue, pcStatus, sendSms, smsAck, smsInbox, smsSent, smsStatus } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SyncBody =
  | { action: "ping" }
  | { action: "set_state"; state: AppState }
  | { action: "replace_reminders"; reminders: Reminder[] }
  | { action: "upsert_reminder"; reminder: Reminder }
  | { action: "resolve_reminder"; id: string }
  | { action: "remove_reminder"; id: string }
  | { action: "upsert_lead"; lead: Partial<Lead> }
  | { action: "upsert_note"; note: Partial<Note> & { id: string } }
  | { action: "remove_note"; id: string }
  | { action: "send_sms"; to: string; text: string }
  | { action: "sms_inbox"; include_handled?: boolean }
  | { action: "sms_ack"; ids: string[] }
  | { action: "sms_sent"; limit?: number }
  | { action: "pc_enqueue"; command: string; pin: string }
  | { action: "pc_status"; limit?: number };

/** Texting and PC-queue actions: they live in object storage, not the board vault. */
async function opsAction(body: SyncBody): Promise<Record<string, unknown> | null> {
  switch (body.action) {
    case "send_sms":
      return { sent: await sendSms(String(body.to ?? ""), String(body.text ?? "")) };
    case "sms_inbox":
      return { messages: await smsInbox(body.include_handled === true) };
    case "sms_ack":
      return { acked: await smsAck(body.ids) };
    case "sms_sent":
      return { sent: await smsSent(Math.min(Math.max(Number(body.limit) || 20, 1), 200)) };
    case "pc_enqueue":
      return { queued: await pcEnqueue(body.command, body.pin) };
    case "pc_status":
      return { commands: await pcStatus(Math.min(Math.max(Number(body.limit) || 10, 1), 50)) };
    default:
      return null;
  }
}

/** Merge a partial note into the board. Changing the body without new formatting drops the stale rich-text copy. */
function mergeNote(existing: Note | undefined, input: Partial<Note> & { id: string }): Note {
  const body = typeof input.body === "string" ? input.body : existing?.body ?? "";
  const bodyChanged = !!existing && typeof input.body === "string" && input.body !== existing.body;
  const html = typeof input.html === "string" ? input.html : bodyChanged ? undefined : existing?.html;
  return {
    id: input.id,
    title: typeof input.title === "string" ? input.title : existing?.title ?? "",
    body,
    ...(html ? { html } : {}),
    updatedAt: new Date().toISOString(),
    pinned: typeof input.pinned === "boolean" ? input.pinned : existing?.pinned ?? false,
  };
}

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

  try {
    const ops = await opsAction(body);
    if (ops) return NextResponse.json({ ok: true, ...ops });

    let state = await readState();

    if (body.action === "ping") {
      return NextResponse.json({ ok: true, service: "asuka-dashboard-sync", reminders: remindersBackend(state), google: googleStatus(state), ops: smsStatus() });
    }

    switch (body.action) {
      case "set_state": {
        // Reminders are owned by the reminders backend; a whole-state push keeps the server's
        // copy, the sidecar, the Google link and any legacy vault attachments (files live in
        // /api/files) — none of which Asuka ever sees.
        const google = remindersBackend(state) === "google";
        state = await writeState({
          ...body.state,
          attachments: state.attachments,
          ...(google ? { reminders: state.reminders } : {}),
          ...(state.reminderMeta ? { reminderMeta: state.reminderMeta } : {}),
          ...(state.google ? { google: state.google } : {}),
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
      case "upsert_note": {
        const note = body.note;
        if (!note || typeof note.id !== "string" || !note.id) {
          return NextResponse.json({ error: "note.id required" }, { status: 400 });
        }
        const existing = state.notes.find((n) => n.id === note.id);
        if (!existing && (typeof note.title !== "string" || !note.title)) {
          return NextResponse.json({ error: "note.title required for a new note" }, { status: 400 });
        }
        const merged = mergeNote(existing, note);
        const notes = existing ? state.notes.map((n) => (n.id === merged.id ? merged : n)) : [merged, ...state.notes];
        state = await writeState({ ...state, notes });
        break;
      }
      case "remove_note": {
        if (!body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        state = await writeState({ ...state, notes: state.notes.filter((n) => n.id !== body.id) });
        break;
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }

    return NextResponse.json(clientPayload(state, await listReminders(state), { google: googleStatus(state) }));
  } catch (err) {
    const status = err instanceof GoogleApiError ? 502 : err instanceof OpsError ? err.status : 500;
    return NextResponse.json({ error: errorMessage(err) || "sync failed" }, { status });
  }
}

export async function GET(req: Request) {
  if (!assertSyncAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const state = await readState();
    return NextResponse.json(clientPayload(state, await listReminders(state), { google: googleStatus(state) }));
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "Failed to read state" }, { status: 500 });
  }
}
