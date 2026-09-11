export type ReminderPriority = "low" | "medium" | "high";

export interface Reminder {
  id: string;
  title: string;
  notes: string;
  dueAt: string;
  time?: string;
  priority: ReminderPriority;
  done: boolean;
  createdAt: string;
  source: "asuka" | "manual";
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

export type CrmStage = "new_lead" | "proposal_sent" | "closed_won" | "lost";

export interface CallNote {
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
  notes: string;
  callNotes: CallNote[];
  createdAt: string;
  updatedAt: string;
}

export interface AppState {
  reminders: Reminder[];
  notes: Note[];
  attachments: Attachment[];
  leads: Lead[];
}

export const CRM_STAGES: { id: CrmStage; label: string; hint: string }[] = [
  { id: "new_lead", label: "New Lead", hint: "Fresh inbound / Asuka flagged" },
  { id: "proposal_sent", label: "Proposal Sent", hint: "Waiting on a decision" },
  { id: "closed_won", label: "Closed / Won", hint: "Signed and scheduled" },
  { id: "lost", label: "Lost", hint: "Parked or walked" },
];
