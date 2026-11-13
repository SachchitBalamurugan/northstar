// One typed client per service. Every call falls back to mocks if the service is down.
import type { Insights, Proposal, Triage, CalEvent, KnowledgeFile, SidekickStep, Email } from "@contracts/types";
import { mockInsights, mockProposals, mockTriage, mockToday, mockKnowledge, mockRuns, mockWeek } from "./mocks";
import type { Run } from "./local-types";

export const SERVICES = { memory: "http://127.0.0.1:7701", inbox: "http://127.0.0.1:7702", actions: "http://127.0.0.1:7703" } as const;
export type ServiceName = keyof typeof SERVICES;

const online: Record<ServiceName, boolean> = { memory: false, inbox: false, actions: false };
export const isOnline = (s: ServiceName) => online[s];

async function req<T>(svc: ServiceName, path: string, init: RequestInit | undefined, fallback: () => T, timeoutMs = 2500): Promise<T> {
  try {
    const r = await fetch(SERVICES[svc] + path, {
      ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers || {}) },
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
// memory and inbox already serve urgency on the contract scale (3 = most urgent), so it is not flipped here.
function normProposal(p: Proposal): Proposal {
  const payload = p.payload && p.type === "create_event" && p.payload.block && !p.payload.start
    ? { ...p.payload, start: p.payload.block.start, end: p.payload.block.end } : p.payload;
  return { ...p, payload, dueAt: p.dueAt ?? undefined };
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
// ---- Full calendar (Workflow → Calendar). Offline: an in-memory demo calendar so every feature still works. ----
export interface CalEventFull extends CalEvent { location?: string; description?: string; allDay?: boolean }
let demoEvents: CalEventFull[] | null = null;
function demo(): CalEventFull[] {
  if (demoEvents) return demoEvents;
  const d = (dayOff: number, h: number, m = 0) => { const x = new Date(); x.setDate(x.getDate() + dayOff); x.setHours(h, m, 0, 0); return x.toISOString(); };
  demoEvents = [
    ...mockToday,
    { id: "d1", title: "CS 201 lecture", start: d(1, 10), end: d(1, 11, 15), location: "Soda 306" },
    { id: "d2", title: "Office hours: TA Jordan", start: d(2, 15), end: d(2, 16), location: "Cory 540" },
    { id: "d3", title: "◎ Study block: CS 201 project", start: d(2, 14), end: d(2, 14, 50), northstar: true },
    { id: "d4", title: "Stripe online assessment", start: d(3, 18), end: d(3, 19, 30) },
    { id: "d5", title: "Robotics build night", start: d(4, 19), end: d(4, 21), location: "Etcheverry" },
    { id: "d6", title: "MATH 220 midterm", start: d(6, 9), end: d(6, 11), location: "Wheeler 150" },
    { id: "d7", title: "Coffee with Diego", start: d(-1, 16), end: d(-1, 16, 45) },
    { id: "d8", title: "◎ Study block: MATH 220", start: d(5, 14), end: d(5, 15, 30), northstar: true },
    { id: "d9", title: "Career fair", start: d(9, 11), end: d(9, 15), location: "MLK Ballroom" },
  ];
  return demoEvents;
}
export const getEventsBetween = (from: Date, to: Date) =>
  req<any>("inbox", `/calendar/range?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`, undefined,
    () => demo().filter(e => new Date(e.start) < to && new Date(e.end) > from))
    .then((r): CalEventFull[] => (Array.isArray(r) ? r : r.events ?? []).map((e: any) => ({
      id: e.id, title: e.title, start: e.start, end: e.end, location: e.location, description: e.description ?? e.details,
      allDay: e.allDay, northstar: e.northstar ?? e.createdByNorthstar ?? false })));
export const createEvent = (e: { title: string; start: string; end: string; location?: string; details?: string }) =>
  req<any>("inbox", "/calendar/add", post({ candidate: { ...e, source: "user", sourceLabel: "Created in Northstar" } }), () => {
    const ev = { id: `local-${Date.now()}`, title: e.title, start: e.start, end: e.end, location: e.location, description: e.details };
    demo().push(ev); return { ok: true, eventId: ev.id, local: true };
  }, 15000);
export const updateEvent = (id: string, patch: { title?: string; start?: string; end?: string; location?: string; details?: string }) =>
  req<any>("inbox", `/calendar/events/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }, () => {
    const ev = demo().find(x => x.id === id);
    if (ev) Object.assign(ev, { ...patch, description: patch.details ?? ev.description });
    return { ok: true, local: true };
  }, 15000);
export const deleteEvent = (id: string) =>
  req<any>("inbox", `/calendar/events/${encodeURIComponent(id)}`, { method: "DELETE" }, () => {
    demoEvents = demo().filter(x => x.id !== id); return { ok: true, local: true };
  }, 15000);

export const getWeek = () => req<any>("inbox", "/calendar/week", undefined, () => mockWeek).then(normEvents);
// A real draft is an LLM call (about 5 s): with the default 2.5 s timeout the UI silently fell back to a mock proposal.
export const draftReply = (emailId: string) => req<Proposal>("inbox", "/draft", post({ emailId }), () => mockProposals[0], 45000).then(normProposal);
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
/** "send/write an email to x@y.com about …" → inbox /compose (Gmail API, real research), not the browser agent. */
const EMAIL_ADDR = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
export const isEmailRequest = (s: string) => EMAIL_ADDR.test(s) && /\b(e-?mail|send|write|message|tell)\b/i.test(s);

async function composeViaInbox(instruction: string, onStep: (s: SidekickStep) => void): Promise<void> {
  const research = /\b(latest|news|recent|today|this week|update|trends?|happening)\b/i.test(instruction);
  let n = 0; const step = (detail: string, action = "act") => onStep({ step: ++n, action, detail });
  step(`Writing to ${instruction.match(EMAIL_ADDR)![0]}`);
  if (research) step("Researching current sources on the web (this can take a minute)…");
  const t = setTimeout(() => step("Writing the email in your voice…"), research ? 25000 : 1500);
  try {
    const r = await fetch(SERVICES.inbox + "/compose", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction }), signal: AbortSignal.timeout(200_000),
    });
    clearTimeout(t);
    const p = await r.json();
    if (!r.ok) { step(p?.error ?? "Couldn't write that email.", "done"); return; }
    online.inbox = true;
    step(`Drafted "${p.payload?.subject ?? p.title}"${p.payload?.sources?.length ? ` with ${p.payload.sources.length} sources` : ""}`);
    step("Paused before sending. Open Approve to read it and send.", "done");
  } catch {
    clearTimeout(t);
    step("The inbox service isn't reachable, so nothing was sent.", "done");
  }
}

export async function runSidekick(instruction: string, onStep: (s: SidekickStep) => void): Promise<void> {
  if (isEmailRequest(instruction)) return composeViaInbox(instruction, onStep);
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
    for (let i = 0; i < steps.length; i++) { await new Promise(r => setTimeout(r, 700)); onStep({ step: i + 1, action: i === steps.length - 1 ? "stopped" : "act", detail: steps[i] }); }
  }
}

// actions :7703 — automation runs (what is running now and what ran recently), newest first
export const getRuns = () => req<Run[]>("actions", "/runs", undefined, () => mockRuns);
export const cancelRun = (id: string) => req<Run | null>("actions", `/runs/${encodeURIComponent(id)}/cancel`, post({}), () => {
  const r = mockRuns.find(m => m.id === id);
  if (r && r.status === "running") { r.status = "error"; r.endedAt = new Date().toISOString(); r.lastDetail = "Stopped by you"; }
  return r ?? null;
});
