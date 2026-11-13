// One typed client per service. Every call falls back to mocks if the service is down.
import type { Insights, Proposal, Triage, CalEvent, KnowledgeFile, SidekickStep } from "@contracts/types";
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

// memory :7701
export const getInsights = () => req<Insights>("memory", "/insights", undefined, () => mockInsights);
export const listKnowledge = () => req<KnowledgeFile[]>("memory", "/knowledge", undefined, () => mockKnowledge.map(({ name }) => ({ name })));
export const getKnowledge = (file: string) => req<KnowledgeFile>("memory", `/knowledge/${encodeURIComponent(file)}`, undefined,
  () => mockKnowledge.find(k => k.name === file) ?? { name: file, content: "" });
export const putKnowledge = (file: string, content: string) => req("memory", `/knowledge/${encodeURIComponent(file)}`,
  { method: "PUT", body: JSON.stringify({ content }) }, () => { const k = mockKnowledge.find(k => k.name === file); if (k) k.content = content; return { ok: true }; });
export const remember = (text: string, tags: string[] = []) => req("memory", "/remember", post({ text, scope: "global", tags }), () => ({ ok: true }));

// inbox :7702
export const getTriage = () => req<Triage>("inbox", "/triage", undefined, () => mockTriage);
export const getToday = () => req<CalEvent[]>("inbox", "/calendar/today", undefined, () => mockToday);
export const draftReply = (emailId: string) => req<Proposal>("inbox", "/draft", post({ emailId }), () => mockProposals[0]);
export const getAuthUrl = () => req<{ url: string }>("inbox", "/auth/url", undefined, () => ({ url: "" }));

// proposals: merged from all three services
const local: Record<string, Proposal["status"]> = {};
export async function getPendingProposals(): Promise<Proposal[]> {
  const lists = await Promise.all((Object.keys(SERVICES) as ServiceName[]).map(s =>
    req<Proposal[]>(s, "/proposals?status=pending", undefined, () => mockProposals.filter(p => p.agent === s))));
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
