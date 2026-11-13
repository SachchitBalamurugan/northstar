// Contract types (re-exported) plus inbox-internal cache shapes.
export type {
  Source, Agent, MemoryEvent, Proposal, ProposalType, ProposalStatus, NextThing,
  ContextRequest, ContextResponse, TriageResponse, TriagedEmail, Deadline, SenderRole,
} from "../../contracts/types.js";
import type { TriageResponse } from "../../contracts/types.js";

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
}
