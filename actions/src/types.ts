// Mirror of contracts/types.ts (Machine 1 owns the canonical copy).
export type Source = "gmail" | "calendar" | "screen" | "form" | "user" | "insight";
export type Agent = "ui" | "memory" | "inbox" | "actions";

export interface MemoryEvent {
  id?: string;
  ts: string;
  agent: Agent;
  source: Source;
  kind: "observation" | "preference" | "deadline" | "task" | "fact";
  text: string;
  tags?: string[];
  refs?: { emailId?: string; eventId?: string; url?: string };
}

export type ProposalType =
  | "send_reply"
  | "create_event"
  | "fill_form"
  | "submit_form"
  | "unsubscribe"
  | "task";
export type ProposalStatus = "pending" | "approved" | "rejected" | "done" | "failed";

export interface Proposal {
  id: string;
  agent: Agent;
  createdAt: string;
  type: ProposalType;
  title: string; // <= 60 chars
  why: string; // one sentence, cites memory
  payload: any;
  urgency: 1 | 2 | 3;
  dueAt?: string;
  status: ProposalStatus;
}

export interface NextThing {
  title: string;
  why: string;
  minutes: number;
  proposalId?: string;
  dueAt?: string;
}

/** One SSE frame from POST /sidekick. */
export interface SidekickStep {
  step: number;
  action: string;
  detail: string;
  screenshot?: string; // base64 PNG, no data: prefix
}

export interface Profile {
  name: string;
  email: string;
  phone: string;
  school: string;
  major: string;
  gpa: string;
  gradYear: string;
  linkedin: string;
  github: string;
  resumePath: string;
  workAuthorization: string;
  [key: string]: string;
}
