// Discover: things Northstar researched for the student. Memory service :7701, with a mock fallback when it is offline.
import { SERVICES, isDemo } from "./api";

export type DiscoverCategory = "opportunity" | "resource" | "event" | "reading" | "idea";

export interface DiscoverItem {
  id: string;
  title: string;
  summary: string;
  why: string;
  category: DiscoverCategory;
  url?: string;
  sourceLabel?: string;
  deadline?: string;
  nextStep: string;
  confidence: number;
  saved?: boolean;
}

export interface DiscoverFeed {
  generatedAt: string | null;
  basedOn: string[];
  items: DiscoverItem[];
}

/** Thrown when the service is reachable but the call failed or ran out of time (so we should not show mocks). */
export class DiscoverError extends Error {}

const inDays = (d: number, h = 17) => { const t = new Date(); t.setDate(t.getDate() + d); t.setHours(h, 0, 0, 0); return t.toISOString(); };

const mockItems = (): DiscoverItem[] => [
  {
    id: "disc-1", category: "event", confidence: 0.92,
    title: "Career Center internship fair: three teams worth your time",
    summary: "The fall internship fair has about 40 employers. Three of them hire sophomores for software roles and list Java or data structures experience, which is exactly what CS61B is giving you.",
    why: "Your goals say to attend the fair on Thursday, and you have 6 applications out with only one moving.",
    url: "https://career.berkeley.edu/", sourceLabel: "career.berkeley.edu",
    deadline: inDays(6, 11),
    nextStep: "Pick the three booths tonight so Thursday is one short loop, not a wander.",
  },
  {
    id: "disc-2", category: "opportunity", confidence: 0.86,
    title: "Sophomore-friendly SWE internships still open for summer 2027",
    summary: "A community-maintained list of summer 2027 internships, updated daily. Filtering for roles that accept second-year students leaves a short list that closes over the next few weeks.",
    why: "You want a summer 2027 software internship and most big programs close before winter break.",
    url: "https://github.com/SimplifyJobs/Summer2026-Internships", sourceLabel: "github.com",
    deadline: inDays(17),
    nextStep: "Choose two roles from the list. I can pre-fill both applications for you to approve.",
  },
  {
    id: "disc-3", category: "resource", confidence: 0.81,
    title: "A 75-minute practice set shaped like the Nimbus assessment",
    summary: "Nimbus online assessments are usually two medium problems on arrays, hash maps and graph traversal. This practice set matches that format and length.",
    why: "Your Nimbus assessment link expires Wednesday and there is no practice block on your calendar yet.",
    url: "https://leetcode.com/studyplan/top-interview-150/", sourceLabel: "leetcode.com",
    deadline: inDays(5, 23),
    nextStep: "Do one timed problem this weekend. Just one, to see the format.",
  },
  {
    id: "disc-4", category: "idea", confidence: 0.74,
    title: "Turn your Cal Robotics work into a resume line",
    summary: "Recruiters for sophomore roles look for one concrete project with a number in it. Your robotics sub-team work can be written as a single measurable bullet.",
    why: "You are in Cal Robotics and want a sub-team lead role, but your applications do not mention it yet.",
    nextStep: "Tell me one thing you built or fixed on the team and I will draft the bullet.",
  },
  {
    id: "disc-5", category: "reading", confidence: 0.68,
    title: "How to start a big project when it feels too big",
    summary: "A short guide from the CS61B staff on breaking Build Your Own World into a first 30-minute step: generate one room, render it, stop.",
    why: "Project 3 is due Friday, it keeps getting pushed, and you asked to start big projects 5 days out.",
    url: "https://sp24.datastructur.es/", sourceLabel: "datastructur.es",
    deadline: inDays(7),
    nextStep: "Read the first section only (about 6 minutes), then stop.",
  },
];

let mock: DiscoverFeed = {
  generatedAt: new Date(Date.now() - 3 * 36e5).toISOString(),
  basedOn: ["Summer 2027 SWE internship", "CS61B Project 3", "Nimbus assessment", "Cal Robotics", "Starts big projects early"],
  items: mockItems(),
};

type Outcome<T> = { ok: true; data: T } | { ok: false; offline: boolean };

async function call<T>(path: string, init?: RequestInit, timeoutMs = 2500): Promise<Outcome<T>> {
  try {
    const r = await fetch(SERVICES.memory + path, {
      ...init, headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, offline: r.status === 404 }; // 404: endpoint not shipped yet, treat as offline
    return { ok: true, data: (await r.json()) as T };
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, offline: !timedOut || timeoutMs <= 2500 };
  }
}

const clean = (f: DiscoverFeed): DiscoverFeed => ({
  generatedAt: f?.generatedAt ?? null,
  basedOn: (f?.basedOn ?? []).slice(0, 5),
  items: (f?.items ?? []).slice(0, 5),
});

export async function getDiscover(): Promise<DiscoverFeed> {
  const r = await call<DiscoverFeed>("/discover");
  return clean(r.ok ? r.data : isDemo() ? mock : { generatedAt: null, basedOn: [], items: [] });
}

/** Real research can take 30-60 s, so this waits up to two minutes. */
export async function runDiscover(focus?: string): Promise<DiscoverFeed> {
  const f = focus?.trim();
  const r = await call<DiscoverFeed>("/discover/run", { method: "POST", body: JSON.stringify(f ? { focus: f } : {}) }, 120000);
  if (r.ok) return clean(r.data);
  if (!r.offline) throw new DiscoverError("Research did not finish");
  await new Promise(res => setTimeout(res, 1800));
  const items = mockItems();
  mock = {
    generatedAt: new Date().toISOString(),
    basedOn: f ? [f, ...mock.basedOn.filter(b => b !== f)].slice(0, 5) : mock.basedOn,
    items: f ? items.map((it, i) => (i === 0 ? { ...it, why: `You asked me to look into "${f}". ${it.why}` } : it)) : items,
  };
  return clean(mock);
}

export async function saveDiscover(id: string): Promise<void> {
  mock = { ...mock, items: mock.items.map(i => (i.id === id ? { ...i, saved: true } : i)) };
  await call(`/discover/${encodeURIComponent(id)}/save`, { method: "POST", body: "{}" });
}

export async function dismissDiscover(id: string): Promise<void> {
  mock = { ...mock, items: mock.items.filter(i => i.id !== id) };
  await call(`/discover/${encodeURIComponent(id)}/dismiss`, { method: "POST", body: "{}" });
}
