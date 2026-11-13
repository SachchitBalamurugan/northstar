// Discover: AI research runs. FRONTEND ONLY for now.
// The UI talks to `startResearch()`, which streams a run (agents → steps → results). Today it's a realistic
// simulation. A future backend implements the same stream at POST /discover/run (SSE of DiscoverEvent),
// and only `startResearch` needs to change.
import { useProfile, contextLine, locationHint, type Profile } from "./profile";

/** " · for a UC Berkeley student near San Francisco Bay Area" (empty when the profile has no school/location). */
function audience(p: Profile): string {
  const loc = p.location || (/bay area/i.test(locationHint(p)) ? "San Francisco Bay Area" : "");
  if (!p.school && !loc) return "";
  return ` · for ${p.school ? `a ${p.school} student` : "you"}${loc ? ` near ${loc}` : ""}`;
}

export type ResultKind = "event" | "opportunity" | "place" | "article";

export interface DiscoverResult {
  id: string;
  kind: ResultKind;
  title: string;
  summary: string;
  source: string;          // domain, e.g. "eventbrite.com"
  url: string;
  start?: string;          // ISO, for events
  end?: string;
  location?: string;
  price?: string;          // "Free", "$15"
  deadline?: string;       // ISO, for opportunities
  why: string;             // why it matches the user (cites memory)
  score: number;           // 0..1 relevance
  agentId: string;
  tags: string[];
}

export interface ResearchAgent { id: string; name: string; task: string; icon: "globe" | "calendar" | "users" | "brain" | "map" | "briefcase" }

export type DiscoverEvent =
  | { type: "plan"; intent: string; agents: ResearchAgent[]; filters: string[] }
  | { type: "step"; agentId: string; text: string }
  | { type: "source"; agentId: string; domain: string }
  | { type: "result"; result: DiscoverResult }
  | { type: "agent_done"; agentId: string; found: number }
  | { type: "done"; total: number; ms: number };

export interface ResearchOptions { when: "any" | "week" | "month"; where: "any" | "campus" | "online" }

/* ------------------------------------------------------------------ */
/* Simulation (replace with a fetch to POST /discover/run when ready) */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const at = (days: number, h: number, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString(); };
let seq = 0;
const rid = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

type Topic = "career" | "fun" | "study" | "general";
function topicOf(q: string): Topic {
  const t = q.toLowerCase();
  if (/career|job|intern|recruit|network|hackathon|fair|resume|swe|engineer/.test(t)) return "career";
  if (/fun|side quest|weekend|hang|explore|adventure|date|friends|food|hike|concert|things to do/.test(t)) return "fun";
  if (/study|learn|course|tutor|exam|research paper|class|textbook/.test(t)) return "study";
  return "general";
}

const AGENTS: Record<Topic, ResearchAgent[]> = {
  career: [
    { id: "a1", name: "Event scout", task: "Career fairs, info sessions and meetups", icon: "calendar" },
    { id: "a2", name: "Campus boards", task: "University career center and club calendars", icon: "users" },
    { id: "a3", name: "Opportunity finder", task: "Internships and programs with open deadlines", icon: "briefcase" },
    { id: "a4", name: "Memory check", task: "Match against your goals and schedule", icon: "brain" },
  ],
  fun: [
    { id: "a1", name: "Event scout", task: "Concerts, markets and pop-ups nearby", icon: "calendar" },
    { id: "a2", name: "Local explorer", task: "Hikes, food spots and hidden gems", icon: "map" },
    { id: "a3", name: "Community boards", task: "Reddit threads and student group posts", icon: "users" },
    { id: "a4", name: "Memory check", task: "Fit around your free time and interests", icon: "brain" },
  ],
  study: [
    { id: "a1", name: "Web search", task: "Guides, explainers and practice sets", icon: "globe" },
    { id: "a2", name: "Campus boards", task: "Tutoring, review sessions and office hours", icon: "users" },
    { id: "a3", name: "Event scout", task: "Study groups and workshops", icon: "calendar" },
    { id: "a4", name: "Memory check", task: "Match to your classes and deadlines", icon: "brain" },
  ],
  general: [
    { id: "a1", name: "Web search", task: "Top sources across the web", icon: "globe" },
    { id: "a2", name: "Event scout", task: "Anything happening soon", icon: "calendar" },
    { id: "a3", name: "Community boards", task: "What students recommend", icon: "users" },
    { id: "a4", name: "Memory check", task: "Rank by what matters to you", icon: "brain" },
  ],
};

const STEPS: Record<string, string[]> = {
  a1: ["Searching 6 event listings", "Filtering to dates you're free", "Reading event pages"],
  a2: ["Opening campus calendars", "Checking club announcements", "De-duplicating listings"],
  a3: ["Scanning postings and programs", "Checking deadlines", "Reading eligibility"],
  a4: ["Reading goals.md and routines.md", "Comparing against your calendar", "Scoring results"],
};
const SOURCES: Record<Topic, string[]> = {
  career: ["handshake.com", "career.berkeley.edu", "eventbrite.com", "meetup.com", "linkedin.com", "devpost.com"],
  fun: ["eventbrite.com", "reddit.com/r/berkeley", "alltrails.com", "yelp.com", "sfstation.com", "dothebay.com"],
  study: ["khanacademy.org", "slader.com", "tutoring.berkeley.edu", "youtube.com", "reddit.com/r/learnprogramming"],
  general: ["google.com", "reddit.com", "eventbrite.com", "wikipedia.org", "nytimes.com"],
};

function results(topic: Topic, opts: ResearchOptions): Omit<DiscoverResult, "id">[] {
  const near = opts.where !== "online";
  const sets: Record<Topic, Omit<DiscoverResult, "id">[]> = {
    career: [
      { kind: "event", title: "Fall Engineering & Tech Career Fair", summary: "150+ employers including Stripe, Figma and NVIDIA. Bring printed resumes; business casual.", source: "career.berkeley.edu", url: "https://career.berkeley.edu", start: at(4, 11), end: at(4, 15), location: "MLK Student Union, Pauley Ballroom", price: "Free", why: "Your goal this semester is landing a SWE internship.", score: 0.97, agentId: "a2", tags: ["career fair", "on campus"] },
      { kind: "event", title: "Stripe Engineering Info Session + Q&A", summary: "Hear from new-grad engineers, then 1:1 resume chats. Pizza provided.", source: "handshake.com", url: "https://joinhandshake.com", start: at(2, 18), end: at(2, 19, 30), location: "Soda Hall 306", price: "Free", why: "You started a Stripe application. This helps you finish it.", score: 0.94, agentId: "a1", tags: ["info session"] },
      { kind: "opportunity", title: "Google STEP Internship (2027)", summary: "Paid summer internship for first- and second-year CS students. Two short interviews.", source: "careers.google.com", url: "https://careers.google.com", deadline: at(12, 23, 59), why: "Built for sophomores like you, and the deadline fits your calendar.", score: 0.9, agentId: "a3", tags: ["internship", "deadline"] },
      { kind: "event", title: "Bay Area Women in Tech Meetup", summary: "Lightning talks + networking. Recruiters from 12 startups attending.", source: "meetup.com", url: "https://meetup.com", start: at(6, 18, 30), end: at(6, 21), location: near ? "Downtown Berkeley" : "Online", price: "Free", why: "Evening slot, and you're free that night.", score: 0.83, agentId: "a1", tags: ["networking"] },
      { kind: "event", title: "Cal Hacks Prep Workshop", summary: "Team formation, project ideas and judging tips before the hackathon.", source: "devpost.com", url: "https://devpost.com", start: at(8, 14), end: at(8, 16), location: "Jacobs Hall", price: "Free", why: "Hands-on projects help your robotics + SWE story.", score: 0.78, agentId: "a2", tags: ["hackathon"] },
      { kind: "article", title: "How to stand out at a career fair (as a sophomore)", summary: "A 5-minute checklist: 30-second pitch, 3 target companies, follow-up email template.", source: "reddit.com/r/cscareerquestions", url: "https://reddit.com/r/cscareerquestions", why: "Prep for the career fair in 4 days.", score: 0.72, agentId: "a4", tags: ["guide"] },
    ],
    fun: [
      { kind: "event", title: "Night Market at Jack London Square", summary: "60+ food stalls, live DJ, and a vintage pop-up. Easy BART ride.", source: "eventbrite.com", url: "https://eventbrite.com", start: at(1, 18), end: at(1, 22), location: "Jack London Square, Oakland", price: "Free entry", why: "Saturday evening is open on your calendar.", score: 0.95, agentId: "a1", tags: ["food", "weekend"] },
      { kind: "place", title: "Sunrise hike to the Big C", summary: "35-minute climb behind campus with a view of the whole bay. Go early to beat the crowd.", source: "alltrails.com", url: "https://alltrails.com", start: at(2, 7), end: at(2, 8, 30), location: "Big C Trailhead", price: "Free", why: "Short, outdoors, and resets focus before a study day.", score: 0.91, agentId: "a2", tags: ["outdoors", "quick"] },
      { kind: "event", title: "Board game night at Victory Point Cafe", summary: "Drop-in tables, 900+ games, staff will teach you anything.", source: "yelp.com", url: "https://yelp.com", start: at(3, 19), end: at(3, 22), location: "Victory Point Cafe, Berkeley", price: "$10", why: "Low-key and social. Good after robotics.", score: 0.86, agentId: "a3", tags: ["social"] },
      { kind: "event", title: "Free Friday at SFMOMA", summary: "Free admission for Bay Area residents with ID. New immersive light exhibit.", source: "sfstation.com", url: "https://sfstation.com", start: at(7, 12), end: at(7, 17), location: "SFMOMA, San Francisco", price: "Free", why: "A full afternoon, and you have no deadlines that day.", score: 0.8, agentId: "a1", tags: ["art"] },
      { kind: "place", title: "Cheese Board pizza + Live Oak Park picnic", summary: "Locals' favorite combo. Pizza line moves fast after 5pm.", source: "reddit.com/r/berkeley", url: "https://reddit.com/r/berkeley", location: "Shattuck Ave", price: "$", why: "10 minutes from your dorm.", score: 0.76, agentId: "a2", tags: ["food", "quick"] },
    ],
    study: [
      { kind: "event", title: "CS 61B Exam Review Session", summary: "TA-led walkthrough of past midterm problems. Slides posted after.", source: "tutoring.berkeley.edu", url: "https://tutoring.berkeley.edu", start: at(2, 17), end: at(2, 19), location: "Wheeler 150", price: "Free", why: "Your CS 61B project is due Friday.", score: 0.95, agentId: "a2", tags: ["review"] },
      { kind: "article", title: "Visual guide to graph algorithms", summary: "Animated explanations of BFS, DFS, Dijkstra and A* with practice problems.", source: "khanacademy.org", url: "https://khanacademy.org", why: "Matches this week's CS 61B topics.", score: 0.88, agentId: "a1", tags: ["guide"] },
      { kind: "event", title: "Silent study group (Pomodoro, 4x25)", summary: "Body-doubling study session with timed breaks. Cameras optional.", source: "reddit.com/r/learnprogramming", url: "https://reddit.com", start: at(1, 14), end: at(1, 16), location: near ? "Moffitt Library 4th floor" : "Online", price: "Free", why: "2–5pm is your best focus window.", score: 0.86, agentId: "a3", tags: ["focus", "ADHD-friendly"] },
    ],
    general: [
      { kind: "article", title: "Top results for your search", summary: "A summary of the best sources found across the web.", source: "google.com", url: "https://google.com", why: "Most relevant overall.", score: 0.8, agentId: "a1", tags: ["overview"] },
      { kind: "event", title: "Upcoming related event", summary: "A nearby event that matches your search.", source: "eventbrite.com", url: "https://eventbrite.com", start: at(5, 18), end: at(5, 20), location: near ? "Berkeley" : "Online", price: "Free", why: "You're free that evening.", score: 0.74, agentId: "a2", tags: ["event"] },
    ],
  };
  let list = sets[topic];
  const profile = useProfile.getState().profile;
  const loc = locationHint(profile);
  if (loc || profile.school) {
    list = list.map(r => {
      let why = r.why;
      if (profile.school && why.startsWith("Your goal this semester")) why = why.replace("Your goal this semester", `As a ${profile.school} student, your goal this semester`);
      if (loc && profile.location && r.kind === "event" && r.location && r.location !== "Online") why = `Near you: ${why}`;
      return why === r.why ? r : { ...r, why };
    });
  }
  if (opts.when === "week") list = list.filter(r => !r.start || new Date(r.start).getTime() - Date.now() < 7 * 864e5);
  return list;
}

/* ------------------------------------------------------------------ */
/* Real backend: memory service POST /discover/run {focus}             */
/* (MOCK=0: OpenAI web research over the student's memory; MOCK=1: fixtures) */
/* ------------------------------------------------------------------ */
const MEMORY = "http://127.0.0.1:7701";
interface BackendItem { id: string; title: string; summary: string; why: string; category: "opportunity" | "resource" | "event" | "reading" | "idea";
  url?: string; sourceLabel?: string; deadline?: string; nextStep?: string; confidence?: number }

async function memoryOnline(): Promise<boolean> {
  try { return (await fetch(`${MEMORY}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

async function runBackend(query: string, opts: ResearchOptions): Promise<BackendItem[]> {
  const profile = useProfile.getState().profile;
  const where = opts.where === "campus" ? ` near ${profile.school || "campus"}` : opts.where === "online" ? " (online)" : "";
  const when = opts.when === "week" ? " this week" : opts.when === "month" ? " this month" : "";
  const ctx = contextLine(profile);
  const r = await fetch(`${MEMORY}/discover/run`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ focus: `${query}${when}${where}${ctx ? `. About me: ${ctx}` : ""}` }), signal: AbortSignal.timeout(180_000), // web research can take a while
  });
  if (!r.ok) throw new Error(`discover/run ${r.status}`);
  const body = await r.json();
  return (body.items ?? []) as BackendItem[];
}

function mapItem(it: BackendItem, agentId: string): DiscoverResult {
  const kind: ResultKind = it.category === "event" ? "event" : it.category === "opportunity" ? "opportunity" : "article";
  const isEvent = kind === "event" && !!it.deadline;
  let source = it.sourceLabel ?? "";
  if (!source && it.url) { try { source = new URL(it.url).hostname.replace(/^www\./, ""); } catch { /* ignore */ } }
  return {
    id: it.id, kind, title: it.title, summary: it.nextStep ? `${it.summary} Next step: ${it.nextStep}` : it.summary,
    source: source || "Northstar research", url: it.url ?? "",
    start: isEvent ? it.deadline : undefined, end: isEvent ? new Date(Date.parse(it.deadline!) + 60 * 60e3).toISOString() : undefined,
    deadline: kind === "opportunity" ? it.deadline : undefined,
    why: it.why, score: it.confidence ?? 0.7, agentId, tags: [it.category],
  };
}

/** Start a research run. Calls `onEvent` as the run streams. Returns a cancel function.
 *  Uses the real memory-service research when it's running; otherwise the built-in simulation. */
export function startResearch(query: string, opts: ResearchOptions, onEvent: (e: DiscoverEvent) => void): () => void {
  let cancelled = false;
  const t0 = Date.now();
  const emit = (e: DiscoverEvent) => { if (!cancelled) onEvent(e); };
  (async () => {
    if (!(await memoryOnline())) { if (!cancelled) simulate(); return; }
    const topic = topicOf(query);
    const agents = AGENTS[topic];
    const filters = [opts.when === "week" ? "This week" : opts.when === "month" ? "This month" : "Any time", opts.where === "campus" ? "Near campus" : opts.where === "online" ? "Online" : "Anywhere"];
    emit({ type: "plan", intent: `Researching: ${query}${audience(useProfile.getState().profile)}`, agents, filters });
    const research = runBackend(query, opts);
    // Show the agents working while the real research runs (steps + sources only; results come from the backend).
    const srcs = SOURCES[topic];
    let settled = false; research.finally(() => { settled = true; });
    for (let i = 0; i < 3 && !settled && !cancelled; i++) {
      for (const a of agents) {
        await sleep(350 + Math.random() * 350); if (cancelled || settled) break;
        const steps = STEPS[a.id] ?? [];
        emit({ type: "step", agentId: a.id, text: steps[i] ?? "Still searching…" });
        emit({ type: "source", agentId: a.id, domain: srcs[(i + agents.indexOf(a)) % srcs.length] });
      }
    }
    for (const a of agents) emit({ type: "step", agentId: a.id, text: settled ? "Reading results" : "Waiting on web research…" });
    let items: BackendItem[];
    try { items = await research; } catch { if (!cancelled) { emit({ type: "step", agentId: agents[0].id, text: "Research service failed; showing offline results" }); simulate(true); } return; }
    if (cancelled) return;
    const counts: Record<string, number> = {};
    for (const [i, it] of items.entries()) {
      const agentId = agents[i % agents.length].id; counts[agentId] = (counts[agentId] ?? 0) + 1;
      await sleep(180); if (cancelled) return;
      emit({ type: "result", result: mapItem(it, agentId) });
    }
    for (const a of agents) emit({ type: "agent_done", agentId: a.id, found: counts[a.id] ?? 0 });
    emit({ type: "done", total: items.length, ms: Date.now() - t0 });
  })();

  function simulate(skipPlan = false) { void simulateRun(query, opts, emit, () => cancelled, skipPlan, t0); }
  return () => { cancelled = true; };
}

/** Offline simulation of a research run (used when the memory service isn't running or fails). */
async function simulateRun(query: string, opts: ResearchOptions, onEvent: (e: DiscoverEvent) => void, isCancelled: () => boolean, skipPlan: boolean, t0: number): Promise<void> {
    const topic = topicOf(query);
    const agents = AGENTS[topic];
    const filters = [opts.when === "week" ? "This week" : opts.when === "month" ? "This month" : "Any time", opts.where === "campus" ? "Near campus" : opts.where === "online" ? "Online" : "Anywhere"];
    const intent = topic === "career" ? "Career events and opportunities that fit your schedule"
      : topic === "fun" ? "Fun things to do when you're free" : topic === "study" ? "Study help for your current classes" : `Research: ${query}`;
    const intentFull = `${intent}${audience(useProfile.getState().profile)}`;
    if (!skipPlan) { await sleep(500); if (isCancelled()) return; onEvent({ type: "plan", intent: intentFull, agents, filters }); }

    const pool = results(topic, opts);
    const srcs = SOURCES[topic];
    // Agents work "in parallel": interleave their steps, sources and results.
    const queues = agents.map(a => {
      const mine = pool.filter(r => r.agentId === a.id);
      const ev: DiscoverEvent[] = [];
      (STEPS[a.id] ?? []).forEach((s, i) => {
        ev.push({ type: "step", agentId: a.id, text: s });
        ev.push({ type: "source", agentId: a.id, domain: srcs[(i + agents.indexOf(a)) % srcs.length] });
        const r = mine[i]; if (r) ev.push({ type: "result", result: { ...r, id: rid() } });
      });
      mine.slice(3).forEach(r => ev.push({ type: "result", result: { ...r, id: rid() } }));
      ev.push({ type: "agent_done", agentId: a.id, found: mine.length });
      return ev;
    });
    let total = 0;
    while (queues.some(q => q.length)) {
      for (const q of queues) {
        const e = q.shift(); if (!e) continue;
        await sleep(220 + Math.random() * 380); if (isCancelled()) return;
        if (e.type === "result") total++;
        onEvent(e);
      }
    }
    onEvent({ type: "done", total, ms: Date.now() - t0 });
}

/** Markdown for "Save as file". */
export function toMarkdown(title: string, items: DiscoverResult[]): string {
  const lines = [`# ${title}`, "", `_Saved from Northstar Discover on ${new Date().toLocaleString()}_`, ""];
  for (const r of items) {
    lines.push(`## ${r.title}`, "", r.summary, "");
    if (r.start) lines.push(`- **When:** ${new Date(r.start).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`);
    if (r.location) lines.push(`- **Where:** ${r.location}`);
    if (r.price) lines.push(`- **Cost:** ${r.price}`);
    if (r.deadline) lines.push(`- **Deadline:** ${new Date(r.deadline).toLocaleDateString()}`);
    lines.push(`- **Why it fits:** ${r.why}`, `- **Source:** [${r.source}](${r.url})`, "");
  }
  return lines.join("\n");
}
