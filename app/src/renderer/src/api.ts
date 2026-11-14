// One typed client per service. Every call falls back to mocks if the service is down.
import type { Insights, Proposal, Triage, CalEvent, KnowledgeFile, SidekickStep, Email } from "@contracts/types";
import { mockInsights, mockProposals, mockTriage, mockToday, mockKnowledge, mockRuns, mockWeek } from "./mocks";
import type { Run } from "./local-types";

// "?demo" in the URL (web preview only) talks to no service at all, so the UI shows sample data, never real mail.
export const DEMO_ONLY = typeof location !== "undefined" && new URLSearchParams(location.search).has("demo");
export const SERVICES = (DEMO_ONLY
  ? { memory: "http://127.0.0.1:9", inbox: "http://127.0.0.1:9", actions: "http://127.0.0.1:9" }
  : { memory: "http://127.0.0.1:7701", inbox: "http://127.0.0.1:7702", actions: "http://127.0.0.1:7703" }) as {
  readonly memory: string; readonly inbox: string; readonly actions: string;
};
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
    const body = await r.json();
    if (path === "/health") { if (body?.mock === true) sawMock = true; else if (body?.mock === false) sawReal = true; }
    return body as T;
  } catch {
    online[svc] = false;
    if (path === "/health") return fallback();
    return demoFallback(fallback);
  }
}

// ---------- demo vs real ----------
// Sample data is for demos only: when a service says MOCK=1, or when no service has ever answered (previewing the UI
// on its own). Once any service reports real mode, a failed or slow call shows NOTHING rather than a made-up inbox,
// calendar or task list, so what is on screen is always the user's own data.
let sawMock = false, sawReal = false;
let modeKnown: Promise<unknown> | null = null;
export const isDemo = () => sawMock || !sawReal;
/** The same shape with every list emptied and every text blanked. */
export function emptyOf<T>(v: T): T {
  if (Array.isArray(v)) return [] as unknown as T;
  if (typeof v === "string") return "" as unknown as T;
  if (typeof v === "number") return 0 as unknown as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, emptyOf(x)])) as T;
  return v;
}
/** What a failed call returns: the sample value in a demo, an empty one otherwise. */
export async function demoFallback<T>(fallback: () => T): Promise<T> {
  await (modeKnown ??= checkHealth()); // know which mode we are in before deciding
  return isDemo() ? fallback() : emptyOf(fallback());
}
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export async function checkHealth(): Promise<Record<ServiceName, boolean>> {
  const run = Promise.all((Object.keys(SERVICES) as ServiceName[]).map(s => req(s, "/health", undefined, () => null)));
  modeKnown ??= run;
  await run;
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
  return lists.flat().filter(p => !local[p.id] && p.status === "pending").sort((a, b) => b.urgency - a.urgency || +new Date(b.createdAt) - +new Date(a.createdAt));
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
    step("Paused before sending. Opening Approve so you can read it and send…", "done");
    // Take the user straight to the draft (it's sorted to the top of Approve).
    setTimeout(async () => {
      const { useUI } = await import("./store");
      const ui = useUI.getState(); ui.closeCommand(); ui.setScreen("approve");
    }, 1400);
  } catch {
    clearTimeout(t);
    step("The inbox service isn't reachable, so nothing was sent.", "done");
  }
}

/** "add/schedule/put … (on/to my) calendar", "remind me …", "block time for …" → the connected Google Calendar via inbox. */
export const isCalendarRequest = (s: string) =>
  /\b(calendar|schedule|reschedule|block (off |out )?time|remind me|book (a )?(slot|time))\b/i.test(s) ||
  (/\b(add|put|save|create)\b/i.test(s) && /\b(event|meeting|hackathon|fair|session|class|lecture|exam|appointment|deadline)\b/i.test(s));

/** Turn a request-shaped title ("Sidekick: can you add hackathon due at 4 pm today to calendar") into an event name ("Hackathon due"). */
function eventTitle(raw: string): string {
  let t = raw.replace(/^\s*(sidekick|ask|note)\s*:\s*/i, "")
    .replace(/^(hey\s+)?(can|could|would)\s+you\s+|^(please|pls)\s+/i, "")
    .replace(/^(add|put|schedule|create|save|block( off| out)?( time)?( for)?)\s+/i, "")
    .replace(/\s+(to|on|in|into)\s+(my\s+)?(google\s+)?calend\w*\b.*$/i, "")
    .replace(/\b(at|by|on)?\s*\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, "")
    .replace(/\b(today|tonight|tomorrow|this (morning|afternoon|evening))\b/gi, "")
    .replace(/\s{2,}/g, " ").trim().replace(/[.,;:]+$/, "");
  return t ? t[0].toUpperCase() + t.slice(1) : raw;
}

async function calendarViaInbox(instruction: string, onStep: (s: SidekickStep) => void): Promise<void> {
  const { suggestEvents, addEvent } = await import("./calendarAgent");
  let n = 0; const step = (detail: string, action = "act") => onStep({ step: ++n, action, detail });
  step("Searching your email, files and calendar for this event…");
  const found = await suggestEvents(instruction);
  const best = found[0] ? { ...found[0], title: eventTitle(found[0].title) } : undefined;
  if (!best) { step("I couldn't find a date for that. Try adding a day and time, e.g. \"Saturday 10am\".", "done"); return; }
  const when = new Date(best.start).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  step(`Found: ${best.title}, ${when} (${best.sourceLabel})`);
  step("Adding it to your connected Google Calendar…");
  const r = await addEvent(best);
  if (r.via === "service") step(`Added "${best.title}" on ${when}. You can edit or delete it in Workflow > Calendar.`, "done");
  else if (r.error && /has not been used|is disabled|accessNotConfigured/i.test(r.error))
    step("Google refused: the Google Calendar API is turned off in your Google Cloud project. Enable it (APIs & Services > Library > Google Calendar API), wait a minute, then try again.", "done");
  else if (r.error) step(`Google Calendar said: ${r.error.slice(0, 160)}`, "done");
  else step("The inbox service isn't reachable, so I opened Google Calendar with the event filled in. Press Save there.", "done");
}

/** "fill/apply to https://..." -> actions /fill: opens the form in the user's Chrome, fills it from the profile, pauses before submit. */
const URL_RE = /https?:\/\/[^\s"'<>)]+/i;
export const isFillRequest = (s: string) => URL_RE.test(s) && /\b(fill|apply|application|form|sign ?up|register|complete)\b/i.test(s);

async function fillViaActions(instruction: string, onStep: (s: SidekickStep) => void): Promise<void> {
  let n = 0; const step = (detail: string, action = "act") => onStep({ step: ++n, action, detail });
  const url = instruction.match(URL_RE)![0].replace(/[.,;:!?]+$/, "");
  let host = url; try { host = new URL(url).hostname; } catch { /* keep raw */ }
  step(`Opening ${host} in your Chrome (you stay logged in)…`);
  try {
    const r = await fetch(SERVICES.actions + "/fill", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }), signal: AbortSignal.timeout(180_000),
    });
    const p = await r.json().catch(() => ({}));
    if (!r.ok) { step(p?.error ?? `Couldn't fill that form (HTTP ${r.status}).`, "done"); return; }
    online.actions = true;
    const fields: { label: string; value: string; confidence?: number }[] = Array.isArray(p?.payload?.fields) ? p.payload.fields : [];
    const unknown = Array.isArray(p?.payload?.unknown) ? p.payload.unknown.length : 0;
    const filled = fields.filter(f => f.value != null && String(f.value).trim() !== "").length;
    const need = fields.length - filled + unknown;
    step(`Filled ${filled} of ${fields.length + unknown} fields from your profile (${need} need you)`);
    step("Paused before submitting. Opening Approve so you can check every field…", "done");
    setTimeout(async () => {
      const { useUI } = await import("./store");
      const ui = useUI.getState(); ui.closeCommand(); ui.setScreen("approve");
    }, 1400);
  } catch (e) {
    step(e instanceof Error && e.name === "TimeoutError" ? "Filling took too long and was stopped." : "The actions service isn't reachable, so nothing was filled.", "done");
  }
}

export async function runSidekick(instruction: string, onStep: (s: SidekickStep) => void): Promise<void> {
  if (isEmailRequest(instruction)) return composeViaInbox(instruction, onStep);
  // With the Chrome extension connected, the task agent fills forms in the student's own tab.
  if (isFillRequest(instruction) && !(await bridgeStatus()).connected) return fillViaActions(instruction, onStep);
  if (isCalendarRequest(instruction)) return calendarViaInbox(instruction, onStep);
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

/** Is the Northstar Bridge Chrome extension connected (tasks run in the student's own Chrome)? */
export async function bridgeStatus(): Promise<{ connected: boolean; version: string | null }> {
  try {
    const r = await fetch(SERVICES.actions + "/bridge/status", { signal: AbortSignal.timeout(1500) });
    if (r.ok) return await r.json();
  } catch { /* offline */ }
  return { connected: false, version: null };
}

/** Answer a running task's checkpoint from the popup (plan approval, final submit, sign-in, question). */
export async function answerCheckpoint(id: string, decision: string, answer?: string): Promise<boolean> {
  try {
    const r = await fetch(SERVICES.actions + `/checkpoints/${encodeURIComponent(id)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, answer }),
    });
    return r.ok;
  } catch { return false; }
}

// actions :7703 — automation runs (what is running now and what ran recently), newest first
export const getRuns = () => req<Run[]>("actions", "/runs", undefined, () => mockRuns);
export const cancelRun = (id: string) => req<Run | null>("actions", `/runs/${encodeURIComponent(id)}/cancel`, post({}), () => {
  const r = mockRuns.find(m => m.id === id);
  if (r && r.status === "running") { r.status = "error"; r.endedAt = new Date().toISOString(); r.lastDetail = "Stopped by you"; }
  return r ?? null;
});
