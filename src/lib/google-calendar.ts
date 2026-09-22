/**
 * Google Calendar v3 — read the primary calendar's events for a date window so
 * they show on the Calendar tab and the Overview "Today" panel.
 * Test seam: GOOGLE_CALENDAR_API_BASE.
 */
import { CALENDAR_SCOPE, googleAuthFor, googleFetch, type GoogleAuth } from "./google";
import type { AppState, CalendarEvent } from "./types";

const API_BASE = () => (process.env.GOOGLE_CALENDAR_API_BASE || "https://www.googleapis.com/calendar/v3").replace(/\/$/, "");
const CALENDAR_ID = () => process.env.GOOGLE_CALENDAR_ID || "primary";

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

function toEvent(e: GEvent): CalendarEvent | null {
  const start = e.start?.dateTime ?? e.start?.date;
  const end = e.end?.dateTime ?? e.end?.date ?? start;
  if (!start || e.status === "cancelled") return null;
  return {
    id: e.id,
    title: e.summary || "(untitled)",
    start,
    end: end ?? start,
    allDay: !e.start?.dateTime,
    ...(e.location ? { location: e.location } : {}),
    ...(e.htmlLink ? { link: e.htmlLink } : {}),
  };
}

/** Events overlapping [from, to] (local "YYYY-MM-DD", inclusive). */
export async function listEvents(auth: GoogleAuth, from: string, to: string): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(`${API_BASE()}/calendars/${encodeURIComponent(CALENDAR_ID())}/events`);
    u.searchParams.set("singleEvents", "true");
    u.searchParams.set("orderBy", "startTime");
    u.searchParams.set("maxResults", "250");
    u.searchParams.set("timeMin", new Date(`${from}T00:00:00`).toISOString());
    u.searchParams.set("timeMax", new Date(`${to}T23:59:59`).toISOString());
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const page = await googleFetch<{ items?: GEvent[]; nextPageToken?: string }>(auth, "GET", u);
    for (const e of page.items ?? []) {
      const ev = toEvent(e);
      if (ev) out.push(ev);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export interface CalendarView {
  events: CalendarEvent[];
  /** false when Google isn't connected or the calendar scope wasn't granted. */
  connected: boolean;
  error?: string;
}

/** Read-only view for the browser; never throws. */
export async function calendarView(state: Pick<AppState, "google">, from: string, to: string): Promise<CalendarView> {
  try {
    const auth = await googleAuthFor(state);
    if (!auth || !auth.scopes.includes(CALENDAR_SCOPE)) return { events: [], connected: false };
    return { events: await listEvents(auth, from, to), connected: true };
  } catch (err) {
    return { events: [], connected: true, error: err instanceof Error ? err.message : String(err) };
  }
}
