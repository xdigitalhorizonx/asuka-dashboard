import { NextResponse } from "next/server";
import type { AppState, Lead, Reminder } from "@/lib/types";
import { assertSyncAuth, readState, writeState } from "@/lib/server-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SyncBody =
  | { action: "ping" }
  | { action: "set_state"; state: AppState }
  | { action: "replace_reminders"; reminders: Reminder[] }
  | { action: "upsert_reminder"; reminder: Reminder }
  | { action: "resolve_reminder"; id: string }
  | { action: "remove_reminder"; id: string }
  | { action: "upsert_lead"; lead: Lead };

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
    return NextResponse.json({ ok: true, service: "asuka-dashboard-sync" });
  }

  try {
    let state = await readState();

    switch (body.action) {
      case "set_state":
        state = await writeState(body.state);
        break;
      case "replace_reminders":
        state = await writeState({ ...state, reminders: body.reminders ?? [] });
        break;
      case "upsert_reminder": {
        const reminder = body.reminder;
        if (!reminder?.id) {
          return NextResponse.json({ error: "reminder.id required" }, { status: 400 });
        }
        const others = state.reminders.filter((r) => r.id !== reminder.id);
        state = await writeState({ ...state, reminders: [reminder, ...others] });
        break;
      }
      case "resolve_reminder": {
        if (!body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        state = await writeState({
          ...state,
          reminders: state.reminders.map((r) =>
            r.id === body.id ? { ...r, done: true } : r
          ),
        });
        break;
      }
      case "remove_reminder": {
        if (!body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        state = await writeState({
          ...state,
          reminders: state.reminders.filter((r) => r.id !== body.id),
        });
        break;
      }
      case "upsert_lead": {
        const lead = body.lead;
        if (!lead?.id || !lead?.name) {
          return NextResponse.json(
            { error: "lead.id and lead.name required" },
            { status: 400 }
          );
        }
        const normalized: Lead = {
          id: lead.id,
          name: lead.name,
          company: lead.company ?? "",
          email: lead.email ?? "",
          phone: lead.phone ?? "",
          value: Number(lead.value) || 0,
          stage: lead.stage ?? "new_lead",
          notes: lead.notes ?? "",
          createdAt: lead.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const others = state.leads.filter((l) => l.id !== normalized.id);
        state = await writeState({ ...state, leads: [normalized, ...others] });
        break;
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }

    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "sync failed" },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  if (!assertSyncAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const state = await readState();
    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read state" },
      { status: 500 }
    );
  }
}
