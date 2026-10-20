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

/** "YYYY-MM-DD" → "Sep 14", read as a local date (not UTC midnight, which lands on the 13th in Pacific). */
export function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return Number.isNaN(dt.getTime()) ? ymd : dt.toLocaleDateString([], { month: "short", day: "numeric" });
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

export type CallTier = "first" | "next" | "later" | "email";

export interface CallPriority {
  tier: CallTier;
  /** Short reason in plain words, e.g. "Site is broken right now". */
  headline: string;
  /** The researched finding from the lead's background block. */
  detail: string;
  /** "YYYY-MM-DD" the site was last checked, from the background block. */
  checkedOn?: string;
  /** "YYYY-MM-DD" an intro email went out, from the background block's Outreach section. */
  emailedOn?: string;
}

export const CALL_TIERS: { id: CallTier; label: string; short: string; hint: string }[] = [
  { id: "first", label: "Call first", short: "1ST", hint: "Their own site is broken or parked right now" },
  { id: "next", label: "Call next", short: "NEXT", hint: "No website, or a Facebook page only" },
  { id: "later", label: "Later", short: "LATER", hint: "Site works but is dated" },
  { id: "email", label: "Email only", short: "EMAIL", hint: "No phone number on file" },
];

export function callTierColor(t: CallTier): string {
  switch (t) {
    case "first":
      return "var(--color-danger)";
    case "next":
      return "var(--color-amber)";
    case "later":
      return "var(--color-sky)";
    default:
      return "var(--color-muted)";
  }
}

export function callTierLabel(t: CallTier): string {
  return CALL_TIERS.find((x) => x.id === t)?.label ?? t;
}

/** Sort key: lower calls sooner. */
export function callTierRank(t: CallTier | undefined): number {
  return t ? CALL_TIERS.findIndex((x) => x.id === t) : CALL_TIERS.length;
}

/**
 * Who to call first among researched New Leads, read from the background block the
 * Chamber research wrote: "[NO WEBSITE|BROKEN SITE|OUTDATED SITE] <finding>\n…Current
 * site: …". A broken or parked domain is the strongest pitch (they can see the problem
 * on their phone), then no site at all, then a dated site. Facebook answers bots with
 * HTTP 400, so a "broken" Facebook link is really "Facebook page only". Leads without
 * that block, or past New Lead, get no tier.
 */
export function callPriority(l: Lead): CallPriority | null {
  if (l.stage !== "new_lead") return null;
  const m = l.notes.match(/^\s*\[(NO WEBSITE|BROKEN SITE|OUTDATED SITE)\]\s*([^\n]*)/i);
  if (!m) return null;
  const tag = m[1].toUpperCase();
  const detail = m[2].trim();
  const site = l.notes.match(/^Current site:\s*(.*)$/im)?.[1].trim() ?? "";
  const facebook = /facebook\.com/i.test(site);
  const checkedOn = l.notes.match(/verified live (\d{4}-\d{2}-\d{2})/i)?.[1];
  const emailedOn = l.notes.match(/^-+\s*Outreach (\d{4}-\d{2}-\d{2})/im)?.[1];
  const base = { detail: tag === "BROKEN SITE" && facebook ? `Listed site is a Facebook page: ${site}` : detail, checkedOn, emailedOn };

  let tier: Exclude<CallTier, "email">;
  let headline: string;
  if (tag === "BROKEN SITE" && !facebook) {
    tier = "first";
    headline = "Site is broken right now";
  } else if (tag === "NO WEBSITE" && /parked/i.test(detail)) {
    tier = "first";
    headline = "Domain shows a parking page";
  } else if (tag === "OUTDATED SITE") {
    tier = "later";
    headline = "Site works but is dated";
  } else {
    tier = "next";
    headline = facebook ? "Facebook page only, no website" : "No website at all";
  }
  if (!l.phone.trim()) return { ...base, tier: "email", headline: `No phone on file · ${headline.toLowerCase()}` };
  return { ...base, tier, headline };
}
