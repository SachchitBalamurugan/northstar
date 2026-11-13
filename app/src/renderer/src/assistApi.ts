// Fetchers, types and mock data for the assist features: daily briefing, resume-work prompts, response controls,
// the tab organizer and the Google connection banner. Same pattern as api.ts: every call falls back to a mock
// (consistent with the demo student, Maya Chen) when its service is offline.
import type { Proposal } from "@contracts/types";
import { SERVICES, approve, type ServiceName } from "./api";

async function call<T>(svc: ServiceName, path: string, init?: RequestInit, timeoutMs = 2500): Promise<T> {
  const r = await fetch(SERVICES[svc] + path, {
    ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as T;
}
async function req<T>(svc: ServiceName, path: string, init: RequestInit | undefined, fallback: () => T, timeoutMs = 2500): Promise<T> {
  try { return await call<T>(svc, path, init, timeoutMs); } catch { return fallback(); }
}
const post = (body: unknown = {}): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

const now = new Date();
const at = (h: number, m = 0, dayOffset = 0) => {
  const d = new Date(now); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString();
};

/* ---------- 1. daily briefing (memory) ---------- */
export type BriefingKind = "event" | "deadline" | "unfinished" | "approval";
export interface BriefingItem { id: string; title: string; why: string; kind: BriefingKind; dueAt?: string; start?: string; minutes?: number; proposalId?: string }
export interface Briefing { date: string; greeting: string; summary: string; items: BriefingItem[]; generatedAt: string }

const mockBriefingItems: BriefingItem[] = [
  { id: "b1", kind: "approval", title: "Reply to Prof. Lee about your extension", why: "She's your advisor and the draft is ready for your OK.", dueAt: at(17), minutes: 5, proposalId: "p1" },
  { id: "b2", kind: "event", title: "Study block: CS 201 project", why: "You focus best 2–5pm, so this is the right window.", start: at(14), minutes: 50 },
  { id: "b3", kind: "unfinished", title: "Finish the Stripe internship application", why: "14 of 15 fields are filled. One answer is left.", dueAt: at(23, 59, 4), minutes: 15, proposalId: "p3" },
  { id: "b4", kind: "deadline", title: "Financial aid verification form", why: "Due Friday. It is a short form once you have your student ID.", dueAt: at(17, 0, 3), minutes: 20 },
];
export const getBriefing = (estimates: boolean) =>
  req<Briefing>("memory", estimates ? "/briefing" : "/briefing?estimates=0", undefined, () => ({
    date: now.toISOString().slice(0, 10), greeting: "Good morning, Maya.",
    summary: "One reply, one study block and one application to finish. The rest can wait.",
    items: mockBriefingItems.map(i => (estimates ? i : { ...i, minutes: undefined })), generatedAt: now.toISOString(),
  }), 8000).then(b => ({ ...b, items: (Array.isArray(b?.items) ? b.items : []).slice(0, 5) }));

/* ---------- 2. resume-work prompts (memory) ---------- */
export interface ResumeItem { id: string; project: string; whereYouStopped: string; nextStep: string; lastTouched: string; why: string }

let mockResume: ResumeItem[] = [
  { id: "r1", project: "CS 201 project", whereYouStopped: "You wrote the outline and stopped at the parser section.",
    nextStep: "Write the tokenizer function", lastTouched: at(21, 30, -1), why: "It's due Friday and you were in a good flow last night." },
  { id: "r2", project: "Stripe internship application", whereYouStopped: "Everything is filled except work authorization.",
    nextStep: "Answer the work authorization question", lastTouched: at(16, 0, -2), why: "Applications close Sunday." },
];
const dropResume = (id: string) => { mockResume = mockResume.filter(r => r.id !== id); return { ok: true }; };
export const getResume = () => req<{ items: ResumeItem[] }>("memory", "/resume", undefined, () => ({ items: mockResume }))
  .then(r => (Array.isArray(r?.items) ? r.items : []).slice(0, 3));
export const resumeDone = (id: string) => req<{ ok: boolean }>("memory", `/resume/${encodeURIComponent(id)}/done`, post(), () => dropResume(id));
export const resumeSnooze = (id: string) => req<{ ok: boolean }>("memory", `/resume/${encodeURIComponent(id)}/snooze`, post(), () => dropResume(id));

/* ---------- 3. response controls (memory) ---------- */
export type RefineMode = "simplify" | "challenge" | "another";
export interface RefineResult { text: string; mode: RefineMode; note?: string; clarify?: string }

function mockRefine(text: string, mode: RefineMode): RefineResult {
  const t = text.trim();
  if (t.length < 12) return { text, mode, clarify: "There isn't much here yet. What do you want this to say?" };
  if (mode === "challenge") {
    return { text: "Two things to check before you send this. Are you promising a date you can really keep? And is there one clear ask, so the reader knows what to do next?",
      mode, note: "Sample feedback. Northstar's memory service is offline." };
  }
  const paras = t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const hello = paras.length > 2 ? paras[0] : "";
  const bye = paras.length > 2 ? paras[paras.length - 1] : "";
  const middle = (paras.length > 2 ? paras.slice(1, -1) : paras).join(" ");
  const sentences = middle.match(/[^.!?]+[.!?]+/g)?.map(s => s.trim()) ?? [middle];
  const body = mode === "simplify"
    ? sentences.slice(0, 2).join(" ")
    : [...sentences.slice(1), sentences[0]].join(" ");
  return { text: [hello, body, bye].filter(Boolean).join("\n\n"), mode,
    note: mode === "simplify" ? "Kept the two sentences that matter." : "Same message, different order. Sample rewrite while the memory service is offline." };
}
export const refine = (text: string, mode: RefineMode, context?: string) =>
  req<RefineResult>("memory", "/refine", post({ text, mode, ...(context ? { context } : {}) }), () => mockRefine(text, mode), 45000);

/**
 * Approve a reply with the user's refined body. The inbox service accepts { payload: { body } } on approve and sends
 * that text. When the service is offline this falls back to the normal approve() so the mock flow still works.
 */
export async function approveEdited(p: Proposal, body: string): Promise<Partial<Proposal>> {
  const svc: ServiceName = p.agent === "ui" ? "memory" : p.agent;
  let res: Response;
  try {
    res = await fetch(`${SERVICES[svc]}/proposals/${p.id}/approve`, { ...post({ payload: { body } }), headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(45000) });
  } catch {
    return approve(p); // offline: keep the local "approved" bookkeeping in api.ts
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({} as { error?: string }));
    return { status: "failed", payload: { error: err?.error ?? "The edited reply was not accepted, so nothing was sent." } };
  }
  return (await res.json()) as Partial<Proposal>;
}

/* ---------- 4. tab organizer (actions) ---------- */
export interface Tab { id: string; title: string; url: string; active?: boolean }
export interface TabGroup { id: string; name: string; why: string; tabIds: string[] }
export interface TabPlan { groups: TabGroup[]; archive: { tabId: string; why: string }[] }
export interface TabSession { id: string; name: string; createdAt: string; tabs: Tab[] | number }

let mockTabs: Tab[] = [
  { id: "t1", title: "CS 201 project spec", url: "https://canvas.example.edu/cs201/project", active: true },
  { id: "t2", title: "maya-chen/cs201-parser", url: "https://github.com/maya-chen/cs201-parser" },
  { id: "t3", title: "How to write a tokenizer in Python", url: "https://stackoverflow.com/questions/tokenizer" },
  { id: "t4", title: "MATH 220 problem set 7", url: "https://canvas.example.edu/math220/ps7" },
  { id: "t5", title: "Desmos graphing calculator", url: "https://www.desmos.com/calculator" },
  { id: "t6", title: "Stripe internship application", url: "https://jobs.example.com/stripe-intern" },
  { id: "t7", title: "Stripe: life as an intern", url: "https://stripe.com/jobs/university" },
  { id: "t8", title: "lofi beats to study to", url: "https://www.youtube.com/watch?v=lofi" },
  { id: "t9", title: "r/college: how do you stay on top of things", url: "https://www.reddit.com/r/college" },
  { id: "t10", title: "Desk lamp search results", url: "https://www.amazon.com/s?k=desk+lamp" },
];
let mockSessions: TabSession[] = [
  { id: "s1", name: "Robotics arm demo research", createdAt: at(19, 0, -3), tabs: [
    { id: "s1a", title: "Servo torque calculator", url: "https://example.com/servo" },
    { id: "s1b", title: "Inverse kinematics intro", url: "https://example.com/ik" } ] },
];
const mockPlan = (): TabPlan => {
  const has = (ids: string[]) => ids.filter(id => mockTabs.some(t => t.id === id));
  return {
    groups: [
      { id: "g1", name: "CS 201 project", why: "Due Friday. These three are the ones you were working in.", tabIds: has(["t1", "t2", "t3"]) },
      { id: "g2", name: "MATH 220 problem set", why: "You have lecture today and the set is open.", tabIds: has(["t4", "t5"]) },
      { id: "g3", name: "Stripe application", why: "Applications close Sunday.", tabIds: has(["t6", "t7"]) },
    ].filter(g => g.tabIds.length > 0),
    archive: [
      { tabId: "t9", why: "Not tied to anything due this week." },
      { tabId: "t10", why: "Shopping can wait. It will be in your saved session." },
    ].filter(a => mockTabs.some(t => t.id === a.tabId)),
  };
};
const mockSave = (name: string, tabs: Tab[]) => {
  const s: TabSession = { id: `s${Date.now()}`, name, createdAt: new Date().toISOString(), tabs };
  mockSessions = [s, ...mockSessions]; return s;
};

export const getTabs = () => req<{ tabs: Tab[] }>("actions", "/tabs", undefined, () => ({ tabs: mockTabs }))
  .then(r => (Array.isArray(r?.tabs) ? r.tabs : []));
export const organizeTabs = (tabs?: Tab[]) => req<TabPlan>("actions", "/tabs/organize", post(tabs ? { tabs } : {}), mockPlan, 45000)
  .then(p => ({ groups: (Array.isArray(p?.groups) ? p.groups : []).slice(0, 5), archive: Array.isArray(p?.archive) ? p.archive : [] }));
export const archiveTabs = (tabIds: string[]) => req<{ ok: boolean; closed: number; sessionId?: string }>("actions", "/tabs/archive", post({ tabIds }), () => {
  const closing = mockTabs.filter(t => tabIds.includes(t.id));
  const s = mockSave(`Archived ${new Date().toLocaleDateString([], { month: "short", day: "numeric" })}`, closing);
  mockTabs = mockTabs.filter(t => !tabIds.includes(t.id));
  return { ok: true, closed: closing.length, sessionId: s.id };
}, 15000);
export const getTabSessions = () => req<{ sessions: TabSession[] }>("actions", "/tabs/sessions", undefined, () => ({ sessions: mockSessions }))
  .then(r => (Array.isArray(r?.sessions) ? r.sessions : []));
export const saveTabSession = (name: string, tabs?: Tab[]) => req<unknown>("actions", "/tabs/sessions", post(tabs ? { name, tabs } : { name }),
  () => mockSave(name, tabs ?? mockTabs), 15000);
export const restoreTabSession = (id: string) => req<{ ok: boolean; opened: number; urls?: string[] }>("actions", `/tabs/sessions/${encodeURIComponent(id)}/restore`, post(), () => {
  const s = mockSessions.find(x => x.id === id);
  const tabs = s && Array.isArray(s.tabs) ? s.tabs : [];
  mockTabs = [...mockTabs, ...tabs.filter(t => !mockTabs.some(m => m.id === t.id))];
  return { ok: !!s, opened: tabs.length, urls: tabs.map(t => t.url) };
}, 15000);

/* ---------- 5. Google connection (inbox) ---------- */
export interface AuthStatus { authed: boolean; configured: boolean; mock: boolean; source: "google" | "fixtures"; email?: string; reason?: string }

/** null means the inbox service is offline: the banner hides itself. Older servers only send { authed, mock }. */
export async function getAuthStatus(): Promise<AuthStatus | null> {
  try {
    const s = await call<Partial<AuthStatus>>("inbox", "/auth/status");
    const authed = !!s.authed, mock = !!s.mock;
    return { ...s, authed, mock, configured: s.configured ?? true, source: s.source ?? (authed && !mock ? "google" : "fixtures") };
  } catch { return null; }
}
/** { url: "" } (with configured: false) when the Google keys are not set up. */
export const getGoogleAuthUrl = () => req<{ url: string; configured?: boolean; error?: string }>("inbox", "/auth/url", undefined, () => ({ url: "" }));
export const disconnectGoogle = () => req<{ ok?: boolean }>("inbox", "/auth/disconnect", post(), () => ({ ok: false }));
export const syncInbox = () => req<unknown>("inbox", "/sync", post(), () => ({ ok: false }), 45000);
