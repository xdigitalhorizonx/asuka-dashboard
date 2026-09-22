import { CRM_STAGES, type CrmStage, type Lead } from "./types";

export const MONO = "var(--font-geist-mono), var(--font-mono)";

/** `tint(hue, 12)` → the hue at 12% over transparent; used for selected rows, chips, glows. */
export function tint(hue: string, pct: number): string {
  return `color-mix(in srgb, ${hue} ${pct}%, transparent)`;
}

/** One pastel per pipeline stage — sky → lavender → apricot → mint, with "lost" a dusty rose-grey. */
export function stageColor(s: CrmStage): string {
  switch (s) {
    case "new_lead":
      return "var(--color-accent)";
    case "appointment_set":
      return "var(--color-violet)";
    case "proposal_sent":
      return "var(--color-amber)";
    case "closed_won":
      return "var(--color-green)";
    default:
      return "color-mix(in srgb, var(--color-primary) 35%, var(--color-muted))";
  }
}

export function stageLabel(s: CrmStage): string {
  return CRM_STAGES.find((x) => x.id === s)?.label ?? s;
}

/** Local calendar date "YYYY-MM-DD" (not UTC — the board is used in Pacific time). */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function fmtStamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "YYYY-MM-DDTHH:MM" (local) → "Thu, Sep 17, 2:00 PM" */
export function fmtAppt(local: string): string {
  const d = new Date(local);
  return Number.isNaN(d.getTime())
    ? local
    : d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function apptTime(local: string): string {
  const d = new Date(local);
  return Number.isNaN(d.getTime())
    ? local.slice(11, 16)
    : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function hasAppointment(l: Lead): l is Lead & { appointmentAt: string } {
  return l.stage === "appointment_set" && !!l.appointmentAt;
}
