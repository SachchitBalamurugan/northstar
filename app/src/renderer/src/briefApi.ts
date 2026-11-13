// Inbox briefing client (inbox service :7702). See contracts/brief.md.
import type { Proposal } from "@contracts/types";
import { SERVICES } from "./api";

export interface BriefItem {
  emailId: string;
  threadId?: string;
  from: string;
  fromEmail?: string;
  subject: string;
  receivedAt: string;
  importance: "high" | "medium" | "low";
  oneLine: string;
  why: string;
  suggestedReply: string | null;
}
export interface Brief {
  generatedAt: string | null;
  summary: string;
  items: BriefItem[];
  source: "google" | "fixtures";
  stale?: boolean;
}

const OFFLINE: Brief = { generatedAt: null, summary: "", items: [], source: "fixtures" };

async function call<T>(path: string, init: RequestInit | undefined, timeoutMs: number): Promise<T> {
  const r = await fetch(SERVICES.inbox + path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    let msg = `Inbox service error (${r.status})`;
    try { const j = await r.json(); if (j?.error) msg = String(j.error); } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

export async function getBrief(): Promise<Brief> {
  try { return await call<Brief>("/inbox/brief", undefined, 15000); }
  catch { return { ...OFFLINE, items: [] }; }
}

/** Regenerates now (LLM, can take ~60s). Throws on failure so the UI keeps the brief it already has. */
export const refreshBrief = () => call<Brief>("/inbox/brief/refresh", { method: "POST", body: "{}" }, 150_000);

export const replyToEmail = (emailId: string, body: string) =>
  call<Proposal>(`/inbox/brief/${encodeURIComponent(emailId)}/reply`, { method: "POST", body: JSON.stringify({ body }) }, 30000);

export const emailMeBrief = () =>
  call<Proposal>("/inbox/brief/email-me", { method: "POST", body: "{}" }, 30000);
