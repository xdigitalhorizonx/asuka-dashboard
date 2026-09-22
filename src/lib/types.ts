export type ReminderPriority = "low" | "medium" | "high";
export type ReminderSource = "asuka" | "manual";
/** Where reminders live: Brandon's Google Tasks list, or the JSON vault when Google isn't configured. */
export type RemindersBackend = "google" | "vault";

export interface Reminder {
  id: string;
  title: string;
  notes: string;
  /** Local "YYYY-MM-DD", or "" for an undated task. */
  dueAt: string;
  time?: string;
  priority: ReminderPriority;
  done: boolean;
  createdAt: string;
  source: ReminderSource;
}

/**
 * Dashboard-side fields Google Tasks has no column for, keyed by Google task id.
 * Server-owned: never sent to, or accepted from, the browser.
 */
export interface ReminderMeta {
  priority: ReminderPriority;
  time?: string;
  source: ReminderSource;
  /** The id the reminder was first known by (Asuka's "r6", a manual uid) so re-syncs find the same task. */
  externalId?: string;
  createdAt: string;
}

/** The Google account link made by the in-app Connect flow. Server-owned; the browser never sees it. */
export interface GoogleLink {
  /** AES-GCM ciphertext of the refresh token (see lib/google.ts). */
  refreshTokenEnc: string;
  email: string;
  scopes: string[];
  connectedAt: string;
}

/** A Google Calendar event as shown on the board. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** RFC 3339 for timed events, "YYYY-MM-DD" for all-day ones. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  link?: string;
}

export const REMINDER_PRIORITIES: ReminderPriority[] = ["low", "medium", "high"];

export function isReminderPriority(v: unknown): v is ReminderPriority {
  return v === "low" || v === "medium" || v === "high";
}

/** Coerce an incoming reminder (Asuka sync, browser) into the current shape. */
export function normalizeReminder(raw: Partial<Reminder> & { id: string; title: string }): Reminder {
  const now = new Date().toISOString();
  const dueAt = typeof raw.dueAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.dueAt) ? raw.dueAt : "";
  const time = typeof raw.time === "string" && /^\d{2}:\d{2}$/.test(raw.time) ? raw.time : undefined;
  return {
    id: raw.id,
    title: raw.title,
    notes: typeof raw.notes === "string" ? raw.notes : "",
    dueAt,
    ...(time ? { time } : {}),
    priority: isReminderPriority(raw.priority) ? raw.priority : "medium",
    done: raw.done === true,
    createdAt: raw.createdAt || now,
    source: raw.source === "asuka" ? "asuka" : "manual",
  };
}

export interface Note {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
  pinned: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  dataUrl: string;
  createdAt: string;
  linkedReminderId?: string;
}

export type CrmStage = "new_lead" | "appointment_set" | "proposal_sent" | "closed_won" | "lost";

/** One timestamped entry in a lead's running log (call, email, meeting, …). */
export interface LeadNote {
  id: string;
  body: string;
  createdAt: string;
}

export interface Lead {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  value: number;
  stage: CrmStage;
  /** Background / sourcing intel — one free-form block. */
  notes: string;
  /** Running timestamped log added from the dashboard. Newest first. */
  noteLog: LeadNote[];
  /** Local wall-clock "YYYY-MM-DDTHH:MM" (datetime-local). Used while stage === "appointment_set". */
  appointmentAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type PaymentMethod = "check" | "cash" | "card";

export const PAYMENT_METHODS: { id: PaymentMethod; label: string }[] = [
  { id: "check", label: "Check" },
  { id: "cash", label: "Cash" },
  { id: "card", label: "Card" },
];

export interface Transaction {
  id: string;
  /** Dollars (not cents). */
  amount: number;
  method: PaymentMethod;
  /** Local "YYYY-MM-DD". */
  date: string;
  memo: string;
  createdAt: string;
  /** Stripe charge / payment-intent id when imported from Stripe. */
  stripeId?: string;
}

export interface Customer {
  id: string;
  company: string;
  contact: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  notes: string;
  /** Newest first. */
  transactions: Transaction[];
  stripeCustomerId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppState {
  reminders: Reminder[];
  notes: Note[];
  attachments: Attachment[];
  leads: Lead[];
  customers: Customer[];
  /** Only present in the server vault while reminders are backed by Google Tasks. */
  reminderMeta?: Record<string, ReminderMeta>;
  /** Only present in the server vault after the in-app Google connect. */
  google?: GoogleLink;
}

export const CRM_STAGES: { id: CrmStage; label: string; hint: string }[] = [
  { id: "new_lead", label: "New Lead", hint: "Fresh inbound / Asuka flagged" },
  { id: "appointment_set", label: "Appointment Set", hint: "Meeting on the calendar" },
  { id: "proposal_sent", label: "Proposal Sent", hint: "Waiting on a decision" },
  { id: "closed_won", label: "Closed / Won", hint: "Signed and scheduled" },
  { id: "lost", label: "Lost", hint: "Parked or walked" },
];

export function isCrmStage(v: unknown): v is CrmStage {
  return typeof v === "string" && CRM_STAGES.some((s) => s.id === v);
}

function isLeadNote(v: unknown): v is LeadNote {
  if (!v || typeof v !== "object") return false;
  const n = v as Partial<LeadNote>;
  return typeof n.id === "string" && typeof n.body === "string" && typeof n.createdAt === "string";
}

/**
 * Coerce a stored or incoming lead into the current shape. Records written before
 * noteLog / appointmentAt existed come through with sane defaults; bad stages fall
 * back to "new_lead" instead of breaking the board.
 */
export function normalizeLead(raw: Partial<Lead> & { id: string; name: string }): Lead {
  const log = Array.isArray(raw.noteLog) ? raw.noteLog.filter(isLeadNote) : [];
  log.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const appointmentAt =
    typeof raw.appointmentAt === "string" && raw.appointmentAt ? raw.appointmentAt : undefined;
  const now = new Date().toISOString();
  return {
    id: raw.id,
    name: raw.name,
    company: raw.company ?? "",
    email: raw.email ?? "",
    phone: raw.phone ?? "",
    value: Number(raw.value) || 0,
    stage: isCrmStage(raw.stage) ? raw.stage : "new_lead",
    notes: typeof raw.notes === "string" ? raw.notes : "",
    noteLog: log,
    ...(appointmentAt ? { appointmentAt } : {}),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now,
  };
}

export function isPaymentMethod(v: unknown): v is PaymentMethod {
  return v === "check" || v === "cash" || v === "card";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isTransaction(v: unknown): v is Transaction {
  if (!v || typeof v !== "object") return false;
  const t = v as Partial<Transaction>;
  return typeof t.id === "string" && Number.isFinite(Number(t.amount)) && isPaymentMethod(t.method) && typeof t.date === "string";
}

export function normalizeCustomer(raw: Partial<Customer> & { id: string }): Customer {
  const now = new Date().toISOString();
  const tx = (Array.isArray(raw.transactions) ? raw.transactions.filter(isTransaction) : []).map((t) => ({
    id: t.id,
    amount: Math.round(Number(t.amount) * 100) / 100,
    method: t.method,
    date: t.date,
    memo: str(t.memo),
    createdAt: t.createdAt || now,
    ...(t.stripeId ? { stripeId: t.stripeId } : {}),
  }));
  tx.sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1));
  return {
    id: raw.id,
    company: str(raw.company),
    contact: str(raw.contact),
    address: str(raw.address),
    phone: str(raw.phone),
    email: str(raw.email),
    website: str(raw.website),
    notes: str(raw.notes),
    transactions: tx,
    ...(raw.stripeCustomerId ? { stripeCustomerId: raw.stripeCustomerId } : {}),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now,
  };
}

export function normalizeCustomers(raw: unknown): Customer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Partial<Customer> & { id: string } => !!c && typeof c === "object" && typeof (c as Customer).id === "string")
    .map(normalizeCustomer);
}

export function customerTotal(c: Customer): number {
  return Math.round(c.transactions.reduce((s, t) => s + t.amount, 0) * 100) / 100;
}

export function normalizeLeads(raw: unknown): Lead[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is Partial<Lead> & { id: string; name: string } =>
      !!l && typeof l === "object" && typeof (l as Lead).id === "string" && typeof (l as Lead).name === "string"
    )
    .map(normalizeLead);
}
