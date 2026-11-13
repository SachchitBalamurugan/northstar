// Groups open tabs BY TASK (not by website) and suggests which ones are safe to put away.
// Real mode: fast model + Structured Outputs, with memory context. MOCK / no key / failure: heuristics below.
import { z } from "zod";
import { complete, llmAvailable } from "../llm.js";
import { getContext } from "../memory.js";
import type { OrganizeResult, Tab, TabGroup } from "./types.js";

const MAX_GROUPS = 5;
const STALE_MS = 3 * 24 * 60 * 60 * 1000;

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};
const normUrl = (url: string) => {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
};

const ENTERTAINMENT = /(^|\.)(youtube\.com|youtu\.be|netflix\.com|reddit\.com|twitch\.tv|tiktok\.com|instagram\.com|twitter\.com|x\.com|spotify\.com|hulu\.com|disneyplus\.com|facebook\.com|pinterest\.com|9gag\.com)$/;
const SEARCH = /^(google\.[a-z.]+\/search|bing\.com\/search|duckduckgo\.com\/\?|search\.yahoo\.com)/;
const BLANK = /^(about:blank|chrome:\/\/newtab|edge:\/\/newtab|about:newtab|chrome:\/\/new-tab-page)/i;
const SCHOOL = /(bcourses|canvas|instructure|gradescope|piazza|edstem|blackboard|moodle|brightspace|d2l)\b/;
const JOBS = /\b(intern(ship)?s?|careers?|job(s| posting| board)?|greenhouse|lever\.co|handshake|workday|new grad|recruit\w*|cover letter|resume|linkedin\.com\/jobs)\b/;
const ADMIN = /\b(advis\w+|registrar|registration|enroll\w*|financial aid|fafsa|appointment|housing|tuition|billing|calcentral|student portal|scholarship)\b/;
const MAIL = /^(mail\.google\.com|outlook\.(live|office)\.com|calendar\.google\.com|outlook\.office365\.com)/;
const ESSAY = /\b(essay|draft|paper|thesis|outline|bibliography|works cited|citation)\b/;
const PSET = /\b(homework|hw ?\d+|pset|problem set|assignment|lab ?\d+|project ?\d+)\b/;
/** "English R1B", "CS 61A", "Data 8", "MATH 54". The first word must not be a generic counter word. */
const COURSE = /\b([A-Z][A-Za-z]{1,9})[ -]?([A-Z]?\d{1,3}[A-Z]{0,2})\b/g;
const NOT_A_COURSE = /^(top|summer|fall|spring|winter|chapter|week|lecture|part|episode|step|page|homework|hw|lab|project|problem|set|essay|draft|midterm|quiz|exam|section|unit|version|windows|iphone|ios|python|java|node|react|vue|angular|html|css|es|http|ipv|ep|vol|no|day|room|level|grade|issue|season|web|office|covid|form|figure|table|question|exercise|discussion|note|notes|slide|slides|sp|fa|su|gpt|claude|gemini|llama|utf|sha|md|iso|rfc|route|area|gate|terminal|flight|mp|vitamin|type|model|class|group|team|room|apt|suite|ch|fig|pt|rev|mac|macos|ubuntu|android|pixel|galaxy|xbox|ps|playstation|formula|interstate|highway|studio|ad|order|ticket|case|invoice|ref|id|pr|issue|bug|jira)$/i;
const STOP = new Set("with from that this your have what when where which will about into https http www com org edu docs google page home the and for you are how new tab".split(" "));

function courseOf(title: string): string | null {
  for (const m of title.matchAll(COURSE)) {
    if (NOT_A_COURSE.test(m[1]!)) continue;
    return `${m[1]} ${m[2]}`.replace(/\s+/g, " ");
  }
  return null;
}

const tokens = (s: string) =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)));

interface Bucket {
  key: string;
  name: string;
  why: string;
  tabs: Tab[];
}

/** Deterministic grouping from domains and title keywords. Tabs listed in `keep` are never suggested for archive. */
export function heuristicOrganize(tabs: Tab[], keep: Set<string> = new Set()): OrganizeResult {
  const archive: { tabId: string; why: string }[] = [];
  const buckets = new Map<string, Bucket>();
  const loose: Tab[] = [];
  const seenUrl = new Map<string, Tab>();
  const canArchive = (t: Tab) => !t.active && !keep.has(t.id);
  const put = (key: string, name: string, why: string, t: Tab) => {
    const b = buckets.get(key) ?? { key, name, why, tabs: [] };
    b.tabs.push(t);
    buckets.set(key, b);
  };

  for (const t of tabs) {
    const h = host(t.url);
    const text = `${t.title} ${t.url}`.toLowerCase();
    const bare = t.url.replace(/^https?:\/\/(www\.)?/, "").toLowerCase();

    const dupOf = seenUrl.get(normUrl(t.url));
    if (dupOf && canArchive(t)) {
      archive.push({ tabId: t.id, why: `Same page as "${dupOf.title.slice(0, 50)}", which stays open.` });
      continue;
    }
    if (!dupOf) seenUrl.set(normUrl(t.url), t);

    if (BLANK.test(t.url) && canArchive(t)) {
      archive.push({ tabId: t.id, why: "Empty new tab." });
      continue;
    }

    const course = courseOf(t.title);
    if (course) {
      put(`course:${course.toLowerCase()}`, course, "", t);
      continue;
    }
    if (JOBS.test(text)) {
      put("jobs", /intern/.test(text) ? "Internship applications" : "Job applications", "These are postings and application pages for the same job search.", t);
      continue;
    }
    if (ADMIN.test(text)) {
      put("admin", "Campus admin", "Appointments, registration and other school paperwork.", t);
      continue;
    }
    if (MAIL.test(bare)) {
      put("mail", "Email and calendar", "Your inbox and schedule.", t);
      continue;
    }
    if (SEARCH.test(bare) && canArchive(t)) {
      archive.push({ tabId: t.id, why: "A search results page. Easy to search again if you need it." });
      continue;
    }
    if (ENTERTAINMENT.test(h) && canArchive(t)) {
      archive.push({ tabId: t.id, why: "Looks like a break tab, not part of a task. Saved so you can come back to it later." });
      continue;
    }
    if (t.lastAccessed && Date.now() - t.lastAccessed > STALE_MS && canArchive(t)) {
      archive.push({ tabId: t.id, why: "You have not looked at this in over 3 days. Saved so you can reopen it." });
      continue;
    }
    if (SCHOOL.test(text)) {
      put("school", "Coursework", "Course sites without one clear assignment.", t);
      continue;
    }
    loose.push(t);
  }

  // Helper tabs (ChatGPT, docs, Stack Overflow, …) join the task whose tabs they share words with.
  const rest: Tab[] = [];
  for (const t of loose) {
    const mine = tokens(t.title);
    let best: Bucket | null = null;
    let bestScore = 0;
    for (const b of buckets.values()) {
      const theirs = tokens(`${b.name} ${b.tabs.filter((x) => !loose.includes(x)).map((x) => x.title).join(" ")}`);
      let score = 0;
      for (const w of mine) if (theirs.has(w)) score++;
      if (score > bestScore) {
        best = b;
        bestScore = score;
      }
    }
    if (best) best.tabs.push(t);
    else rest.push(t);
  }
  if (rest.length) buckets.set("rest", { key: "rest", name: "Reading and reference", why: "Open pages that are not tied to one task yet.", tabs: rest });

  // Name course groups after the work being done in them ("English R1B essay").
  for (const b of buckets.values()) {
    if (!b.key.startsWith("course:")) continue;
    const text = b.tabs.map((t) => t.title).join(" ").toLowerCase();
    const kind = ESSAY.test(text) ? "essay" : PSET.test(text) ? "homework" : "coursework";
    b.name = `${b.name} ${kind}`;
    b.why = `${b.tabs.length} tab${b.tabs.length === 1 ? "" : "s"} for the same ${kind === "coursework" ? "class" : kind}, so you can work on it in one place.`;
  }

  // Never more than 5 groups: fold the smallest ones together.
  let list = [...buckets.values()].sort((a, b) => b.tabs.length - a.tabs.length);
  if (list.length > MAX_GROUPS) {
    const kept = list.slice(0, MAX_GROUPS - 1);
    const folded = list.slice(MAX_GROUPS - 1);
    kept.push({ key: "else", name: "Everything else", why: `Smaller things: ${folded.map((b) => b.name).join(", ")}.`.slice(0, 200), tabs: folded.flatMap((b) => b.tabs) });
    list = kept;
  }
  const order = new Map(tabs.map((t, i) => [t.id, i]));
  const groups: TabGroup[] = list.map((b, i) => ({
    id: `g${i + 1}`,
    name: b.name,
    why: b.why,
    tabIds: b.tabs.map((t) => t.id).sort((x, y) => order.get(x)! - order.get(y)!),
  }));
  return { groups, archive, source: "heuristic" };
}

// ---------- LLM ----------

const Schema = z.object({
  groups: z.array(z.object({ name: z.string(), why: z.string(), tabIds: z.array(z.string()) })),
  archive: z.array(z.object({ tabId: z.string(), why: z.string() })),
});

const SYSTEM = `You tidy a student's browser tabs. The student has ADHD and too many tabs open.
Group the tabs BY TASK the student is working on (for example "R1B essay", "Internship applications", "CS 61A homework"), never by website. A ChatGPT, search or docs tab belongs to the task it is helping with.
Rules:
- At most 5 groups. Short plain names (2 to 4 words). Each group gets one calm sentence "why" that says what ties its tabs together; use the memory context (courses, goals, deadlines) when it helps.
- Every tab id goes in exactly one group OR in archive, never both. Copy ids exactly.
- archive = tabs that are safe to put away for now: exact duplicates, stale entertainment, old search result pages, empty tabs. Give each a one sentence, non-judgmental "why". Archived tabs are saved and can be reopened, so say that rather than "close".
- Never archive the tab marked active or any tab marked keep.
- Do not invent tabs, tasks or facts.`;

async function llmOrganize(tabs: Tab[], keep: Set<string>): Promise<OrganizeResult> {
  const ctx = await getContext(`current courses, assignments, deadlines, goals. Open tabs: ${tabs.map((t) => t.title).join("; ").slice(0, 600)}`);
  const res = await complete({
    tier: "fast",
    system: SYSTEM,
    schema: Schema,
    schemaName: "tab_groups",
    input: JSON.stringify({
      tabs: tabs.map((t) => ({ id: t.id, title: t.title.slice(0, 140), url: t.url.slice(0, 200), active: !!t.active, keep: keep.has(t.id) })),
      memory: ctx,
    }),
  });

  // Trust nothing: unknown ids are dropped, each tab is placed once, protected tabs are never archived.
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const used = new Set<string>();
  const archive: OrganizeResult["archive"] = [];
  for (const a of res.archive) {
    const t = byId.get(a.tabId);
    if (!t || used.has(t.id) || t.active || keep.has(t.id)) continue;
    used.add(t.id);
    archive.push({ tabId: t.id, why: a.why.trim().slice(0, 200) || "Safe to put away for now." });
  }
  const groups: TabGroup[] = [];
  for (const g of res.groups) {
    const ids = g.tabIds.filter((id) => byId.has(id) && !used.has(id));
    ids.forEach((id) => used.add(id));
    if (!ids.length) continue;
    const target = groups.length < MAX_GROUPS ? null : groups[MAX_GROUPS - 1]!;
    if (target) target.tabIds.push(...ids);
    else groups.push({ id: `g${groups.length + 1}`, name: g.name.trim().slice(0, 40) || "Tabs", why: g.why.trim().slice(0, 200), tabIds: ids });
  }
  const left = tabs.filter((t) => !used.has(t.id)).map((t) => t.id);
  if (left.length) {
    if (groups.length < MAX_GROUPS) groups.push({ id: `g${groups.length + 1}`, name: "Everything else", why: "Open pages that are not tied to one task yet.", tabIds: left });
    else groups[MAX_GROUPS - 1]!.tabIds.push(...left);
  }
  if (!groups.length && !archive.length) throw new Error("model returned nothing usable");
  return { groups, archive, source: "llm" };
}

export async function organizeTabs(tabs: Tab[], keep: Set<string> = new Set()): Promise<OrganizeResult> {
  if (!tabs.length) return { groups: [], archive: [], source: "heuristic" };
  if (llmAvailable()) {
    try {
      return await llmOrganize(tabs, keep);
    } catch {
      /* fall through to heuristics */
    }
  }
  return heuristicOrganize(tabs, keep);
}
