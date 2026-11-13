// One typed client per service. Every call falls back to mocks if the service is down.
import type { Insights, Proposal, Triage, CalEvent, KnowledgeFile, SidekickStep, Email } from "@contracts/types";
import { mockInsights, mockProposals, mockTriage, mockToday, mockKnowledge } from "./mocks";

export const SERVICES = { memory: "http://127.0.0.1:7701", inbox: "http://127.0.0.1:7702", actions: "http://127.0.0.1:7703" } as const;
export type ServiceName = keyof typeof SERVICES;

const online: Record<ServiceName, boolean> = { memory: false, inbox: false, actions: false };
export const isOnline = (s: ServiceName) => online[s];

async function req<T>(svc: ServiceName, path: string, init: RequestInit | undefined, fallback: () => T, timeoutMs = 2500): Promise<T> {
  try {
    const r = await fetch(SERVICES[svc] + path, {
      ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(String(r.status));
    online[svc] = true;
    return (await r.json()) as T;
  } catch {
    online[svc] = false;
    return fallback();
  }
}
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export async function checkHealth(): Promise<Record<ServiceName, boolean>> {
  await Promise.all((Object.keys(SERVICES) as ServiceName[]).map(s => req(s, "/health", undefined, () => null)));
  return { ...online };
}

// ---------- adapters: backend shapes → UI shapes ----------
// Machines 2 & 3 use urgency 1 = MOST urgent; the UI and the actions service use 3 = most urgent. Normalize here.
function normProposal(p: Proposal): Proposal {
  const flip = p.agent === "inbox" || p.agent === "memory";
  const payload = p.payload && p.type === "create_event" && p.payload.block && !p.payload.start
    ? { ...p.payload, start: p.payload.block.start, end: p.payload.block.end } : p.payload;
  return { ...p, urgency: (flip ? 4 - p.urgency : p.urgency) as 1 | 2 | 3, payload, dueAt: p.dueAt ?? undefined };
}
type BackendEmail = { emailId: string; from: string; senderRole?: string; subject: string; snippet: string; receivedAt: string; deadlines?: { dueAt: string }[] };
function normEmail(e: any): Email {
  if (!e || e.id) return e as Email; // already UI-shaped (mocks)
  const b = e as BackendEmail;
  const due = (b.deadlines ?? []).map(d => d.dueAt).filter(Boolean).sort()[0];
  return { id: b.emailId, from: b.from, fromRole: b.senderRole, subject: b.subject, snippet: b.snippet, receivedAt: b.receivedAt, dueAt: due };
}
function normEvents(r: any): CalEvent[] {
  const list: any[] = Array.isArray(r) ? r : (r?.events ?? []);
  return list.map(e => ({ id: e.id, title: e.title, start: e.start, end: e.end, northstar: e.northstar ?? e.createdByNorthstar ?? false }));
}
const normKnowledge = (k: any): KnowledgeFile => ({ name: k.name ?? k.file, content: k.content, updatedAt: k.updatedAt });

// memory :7701
export const getInsights = () => req<Insights>("memory", "/insights", undefined, () => mockInsights)
  .then(i => ({ ...i, cards: (i.cards ?? []).map(c => (isOnline("memory") ? normProposal(c) : c)) }));
export const listKnowledge = () => req<any[]>("memory", "/knowledge", undefined, () => mockKnowledge.map(({ name }) => ({ name })))
  .then(list => list.map(normKnowledge));
export const getKnowledge = (file: string) => req<any>("memory", `/knowledge/${encodeURIComponent(file)}`, undefined,
  () => mockKnowledge.find(k => k.name === file) ?? { name: file, content: "" }).then(normKnowledge);
export const putKnowledge = (file: string, content: string) => req("memory", `/knowledge/${encodeURIComponent(file)}`,
  { method: "PUT", body: JSON.stringify({ content }) }, () => { const k = mockKnowledge.find(k => k.name === file); if (k) k.content = content; return { ok: true }; });
export const remember = (text: string, tags: string[] = []) => req("memory", "/remember", post({ text, scope: "global", tags }), () => ({ ok: true }));

// inbox :7702
export const getTriage = () => req<any>("inbox", "/triage", undefined, () => mockTriage, 15000)
  .then((t): Triage => ({ needsYou: (t.needsYou ?? []).map(normEmail), fyi: (t.fyi ?? []).map(normEmail), ignored: t.ignored ?? 0 }));
export const getToday = () => req<any>("inbox", "/calendar/today", undefined, () => mockToday).then(normEvents);
/** Events from today through `days` days (Workflow → Calendar). Falls back to today only. */
export const getRange = (days = 7) => req<any>("inbox", `/calendar/range?days=${days}`, undefined, () => mockToday).then(normEvents);
export const draftReply = (emailId: string) => req<Proposal>("inbox", "/draft", post({ emailId }), () => mockProposals[0], 30000).then(normProposal);
export const getAuthUrl = () => req<{ url: string }>("inbox", "/auth/url", undefined, () => ({ url: "" }));
export const getAuthStatus = () => req<{ authed: boolean; mock: boolean }>("inbox", "/auth/status", undefined, () => ({ authed: false, mock: true }));
export const syncInbox = () => req<any>("inbox", "/sync", post({}), () => null, 60000);

// proposals: merged from all three services
const local: Record<string, Proposal["status"]> = {};
export async function getPendingProposals(): Promise<Proposal[]> {
  const lists = await Promise.all((Object.keys(SERVICES) as ServiceName[]).map(s =>
    req<Proposal[]>(s, "/proposals?status=pending", undefined, () => mockProposals.filter(p => p.agent === s))
      .then(list => (isOnline(s) ? list.map(normProposal) : list))));
  return lists.flat().filter(p => !local[p.id] && p.status === "pending").sort((a, b) => b.urgency - a.urgency);
}
const svcFor = (p: Proposal): ServiceName => (p.agent === "ui" ? "memory" : p.agent);
// Approving can run real work (submitting a form in the browser), so it gets a long timeout and returns the
// finished Proposal. `answers` maps a field selector to what the user typed for a "Needs you" field.
export const approve = (p: Proposal, answers?: Record<string, string>) => {
  local[p.id] = "approved";
  return req<Partial<Proposal>>(svcFor(p), `/proposals/${p.id}/approve`, post(answers ? { answers } : {}), () => ({}), 45000);
};
export const reject = (p: Proposal) => { local[p.id] = "rejected"; return req(svcFor(p), `/proposals/${p.id}/reject`, post({}), () => ({ ok: true })); };

// actions :7703 — Sidekick streams SSE steps; mock stream if offline
export async function runSidekick(instruction: string, onStep: (s: SidekickStep) => void): Promise<void> {
  try {
    const r = await fetch(SERVICES.actions + "/sidekick", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruction }) });
    if (!r.ok || !r.body) throw new Error("offline");
    online.actions = true;
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
      for (const p of parts) { const line = p.split("\n").find(l => l.startsWith("data:")); if (line) onStep(JSON.parse(line.slice(5))); }
    }
  } catch {
    online.actions = false;
    const steps = ["Opening the browser", "Reading the page", `Working on: ${instruction}`, "Filling 14 of 15 fields", "Paused before submit. Waiting for your OK"];
    for (let i = 0; i < steps.length; i++) { await new Promise(r => setTimeout(r, 700)); onStep({ step: i + 1, action: i === steps.length - 1 ? "done" : "act", detail: steps[i] }); }
  }
}
