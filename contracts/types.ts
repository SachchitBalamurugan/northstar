// Northstar shared contract. Owned by Machine 1. Do not change without telling every machine.
export type Source = "gmail" | "calendar" | "screen" | "form" | "user" | "insight";
export type Agent = "ui" | "memory" | "inbox" | "actions";

export interface MemoryEvent {
  id?: string; ts: string; agent: Agent; source: Source;
  kind: "observation" | "preference" | "deadline" | "task" | "fact"; text: string;
  tags?: string[]; refs?: { emailId?: string; eventId?: string; url?: string };
}

export interface Proposal {
  id: string; agent: Agent; createdAt: string;
  type: "send_reply" | "create_event" | "fill_form" | "submit_form" | "unsubscribe" | "task";
  title: string; // ≤ 60 chars, plain language
  why: string;   // one sentence, cites memory
  payload: any; urgency: 1 | 2 | 3; dueAt?: string;
  status: "pending" | "approved" | "rejected" | "done" | "failed";
}

export interface NextThing { title: string; why: string; minutes: number; proposalId?: string; dueAt?: string }

// Shapes used by the UI (from the endpoint table)
export interface Insights { nextThing: NextThing; cards: Proposal[] }
export interface Email { id: string; from: string; fromRole?: string; subject: string; snippet: string; receivedAt: string; dueAt?: string }
export interface Triage { needsYou: Email[]; fyi: Email[]; ignored: number }
export interface CalEvent { id: string; title: string; start: string; end: string; northstar?: boolean }
export interface KnowledgeFile { name: string; updatedAt?: string; content?: string }
export interface SidekickStep { step: number; action: string; detail: string; screenshot?: string }

// Calendar agent (Dashboard → "Add to calendar" chat box). NEW: Machine 3 implements these on inbox :7702.
//   POST /calendar/suggest {query}            → EventCandidate[]  (search mail + memory + calendar, return events to add)
//   POST /calendar/add     {candidate}        → { ok, eventId, htmlLink }  (only called after the user approves)
// The UI falls back to a local search + a prefilled Google Calendar link when the service is offline.
export interface EventCandidate {
  id: string;
  title: string;
  start: string;           // ISO
  end: string;             // ISO
  location?: string;
  details?: string;
  source: "you" | "email" | "knowledge" | "calendar" | "approval";
  sourceLabel: string;     // e.g. "Email from Stripe Recruiting", "classes.md"
  confidence: number;      // 0..1
  conflict?: string;       // e.g. "Overlaps Robotics club"
}
