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
