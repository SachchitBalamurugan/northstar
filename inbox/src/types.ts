// Contract types (re-exported) plus inbox-internal cache shapes.
export type { Source, Agent, MemoryEvent, Proposal, NextThing, Email, Triage, CalEvent } from "../../contracts/types.js";
import type { CalEvent, Email, MemoryEvent, Proposal } from "../../contracts/types.js";

export type ProposalType = Proposal["type"];
export type ProposalStatus = Proposal["status"];

// Shapes the canonical contracts/types.ts does not define (memory's /context response, inbox triage detail).
export interface ContextRequest { query: string; k?: number }
export interface ContextResponse { snippets: MemoryEvent[]; knowledge: { file: string; content: string }[]; umem?: string }
export type SenderRole = "prof" | "ta" | "recruiter" | "club" | "admin" | "promo" | "peer" | "other";
export interface Deadline { title: string; dueAt: string; course?: string; effortMinutes: number; emailId?: string }
/** Internal triage record. `urgency` here is 1 = most urgent (the wire Proposal.urgency is the opposite, see store.newProposal). */
export interface TriagedEmail {
  emailId: string; from: string; subject: string; receivedAt: string; snippet: string;
  bucket: "needsYou" | "fyi" | "ignore"; urgency: 1 | 2 | 3; senderRole: SenderRole;
  deadlines: Deadline[]; asks: string[]; why: string;
}
export interface TriageResponse { needsYou: TriagedEmail[]; fyi: TriagedEmail[]; ignored: number }

/** What GET /triage serves per email: the contract `Email` the UI renders, plus the triage detail. */
export type WireEmail = Email & TriagedEmail;

const ROLE_LABEL: Record<SenderRole, string | undefined> = {
  prof: "prof", ta: "TA", recruiter: "recruiter", club: "club", admin: "admin", promo: "promo", peer: "classmate", other: undefined,
};
export function toWireEmail(t: TriagedEmail, now: Date = new Date()): WireEmail {
  const due = t.deadlines.map((d) => d.dueAt).filter((d) => new Date(d).getTime() > now.getTime() - 3_600_000).sort()[0];
  const role = ROLE_LABEL[t.senderRole];
  return { ...t, id: t.emailId, ...(role ? { fromRole: role } : {}), ...(due ? { dueAt: due } : {}) };
}
/** Contract `CalEvent` for the UI (`northstar: true` marks ◎ blocks Northstar created). */
export function toCalEvent(e: CachedEvent): CalEvent {
  const northstar = e.createdByNorthstar === true || e.title.startsWith("◎");
  return { id: e.id, title: e.title, start: e.start, end: e.end, ...(northstar ? { northstar: true } : {}) };
}

/** One normalized Gmail message as cached in data/cache.json (and in fixtures/emails.json). */
export interface CachedEmail {
  id: string;
  threadId: string;
  from: string;             // display name
  fromEmail: string;
  to: string;
  subject: string;
  receivedAt: string;       // ISO 8601
  snippet: string;          // <= 200 chars
  bodyText: string;         // quoted replies + signature stripped
  labels: string[];         // e.g. ["INBOX","UNREAD"]
  listUnsubscribe?: string; // URL from the List-Unsubscribe header, if any
  opened?: boolean;         // false if still UNREAD
  sent?: boolean;           // the user's own SENT message (cache.sentEmails)
}

/** One normalized Google Calendar event (and fixtures/events.json). */
export interface CachedEvent {
  id: string;
  title: string;
  start: string;            // ISO 8601
  end: string;              // ISO 8601
  allDay?: boolean;
  location?: string;
  description?: string;
  createdByNorthstar?: boolean; // true for focus blocks we created (titles start with "◎ ")
}

export interface Cache {
  emails: CachedEmail[];
  events: CachedEvent[];
  historyId?: string;       // Gmail incremental sync cursor
  lastSyncAt?: string;
  triage?: TriageResponse;
  triagedAt?: string;
  sentEmails?: CachedEmail[]; // the user's SENT mail, last 14 days (follow-up detection)
  userEmail?: string;
  notices?: import("./followups.js").Notice[];
  followupSeen?: string[];  // dedupe keys `${kind}:${id}` that already fired
}
