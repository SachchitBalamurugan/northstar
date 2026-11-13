// Triage / draft tests. Fully offline: MOCK=1 (no OpenAI client is ever created) and `fetch` is stubbed so
// memory (:7701) calls never hit the network. Modules are imported dynamically AFTER the env is set,
// because config.ts reads env at import time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CachedEmail, CachedEvent, MemoryEvent, Proposal, TriagedEmail } from "../src/types.js";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-inbox-test-"));
process.env.INBOX_DATA_DIR = DATA_DIR;
process.env.MOCK = "1";
process.env.OPENAI_API_KEY = "";
process.env.MEMORY_URL = "http://127.0.0.1:1"; // never reached: fetch is stubbed below

// Anchor of the fixtures: loading with this `now` applies no day shift, so dates are deterministic.
const ANCHOR = new Date("2026-11-13T08:00:00-08:00");

const PEOPLE_MD = [
  "# People",
  "- Prof. Lee (dlee@berkeley.edu): CS61B instructor and my advisor; replies fast, likes concise emails",
  "- Priya Natarajan: CS61B TA, Thursday office hours",
  "- Diego Ramos: EE16A lab partner",
].join("\n");
const STYLE_MD = [
  "# Writing style",
  "- Greeting: Hi",
  "- Tone: warm, short sentences, no corporate speak",
  "- Sign-off: Thanks! Maya",
].join("\n");

const postedEvents: MemoryEvent[] = [];
const contextQueries: string[] = [];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.endsWith("/events")) {
      postedEvents.push(body as MemoryEvent);
      return json({ ok: true, id: `ev-${postedEvents.length}` });
    }
    if (u.endsWith("/context")) {
      contextQueries.push(body.query);
      return json({ snippets: [], knowledge: [{ file: "people.md", content: PEOPLE_MD }, { file: "writingstyle.md", content: STYLE_MD }] });
    }
    throw new Error(`unexpected network call in test: ${u}`);
  }),
);

type Fixtures = typeof import("../src/fixtures.js");
type Store = typeof import("../src/store.js");
type Heur = typeof import("../src/triage/heuristics.js");
type Triage = typeof import("../src/triage/triage.js");
type Draft = typeof import("../src/triage/draft.js");
type App = typeof import("../src/app.js");

let fixtures: Fixtures, store: Store, heur: Heur, triage: Triage, draft: Draft, appMod: App;
let emails: CachedEmail[];
let events: CachedEvent[];

beforeAll(async () => {
  [fixtures, store, heur, triage, draft, appMod] = await Promise.all([
    import("../src/fixtures.js"), import("../src/store.js"), import("../src/triage/heuristics.js"),
    import("../src/triage/triage.js"), import("../src/triage/draft.js"), import("../src/app.js"),
  ]);
  emails = fixtures.loadFixture<CachedEmail>("emails.json", ANCHOR);
  events = fixtures.loadFixture<CachedEvent>("events.json", ANCHOR);
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const byId = (id: string) => emails.find((e) => e.id === id)!;

describe("fixtures", () => {
  it("has 30 emails with unique ids, ISO dates, short snippets, newest first", () => {
    expect(emails).toHaveLength(30);
    expect(new Set(emails.map((e) => e.id)).size).toBe(30);
    for (const e of emails) {
      expect(e.id).toMatch(/^m\d{3}$/);
      expect(e.receivedAt).toMatch(ISO);
      expect(e.snippet.length).toBeLessThanOrEqual(200);
      expect(e.threadId).toBeTruthy();
      expect(e.labels.length).toBeGreaterThan(0);
      expect(e.fromEmail).toContain("@");
    }
    for (let i = 1; i < emails.length; i++) expect(emails[i - 1].receivedAt >= emails[i].receivedAt).toBe(true);
    const span = new Date(emails[0].receivedAt).getTime() - new Date(emails.at(-1)!.receivedAt).getTime();
    expect(span).toBeLessThanOrEqual(7 * 86_400_000);
  });

  it("has 10 events with unique ids, ISO dates, one Northstar focus block and an all-day event", () => {
    expect(events).toHaveLength(10);
    expect(new Set(events.map((e) => e.id)).size).toBe(10);
    for (const e of events) {
      expect(e.id).toMatch(/^e\d{3}$/);
      expect(e.start).toMatch(ISO);
      expect(e.end).toMatch(ISO);
      expect(new Date(e.end).getTime()).toBeGreaterThan(new Date(e.start).getTime());
    }
    const focus = events.filter((e) => e.createdByNorthstar);
    expect(focus).toHaveLength(1);
    expect(focus[0].title.startsWith("◎ ")).toBe(true);
    expect(events.some((e) => e.allDay)).toBe(true);
  });

  it("day-shifts timestamps when loaded for a different day", () => {
    const later = fixtures.loadFixture<CachedEmail>("emails.json", new Date("2026-11-20T15:00:00-08:00"));
    expect(new Date(later[0].receivedAt).getTime() - new Date(emails[0].receivedAt).getTime()).toBe(7 * 86_400_000);
  });
});

describe("heuristics", () => {
  const ctx = () => ({ snippets: [], knowledge: [{ file: "people.md", content: PEOPLE_MD }] });

  it("Prof. Lee's syllabus change -> prof / needsYou with the Nov 20 5pm deadline, citing memory", () => {
    const t = heur.heuristicTriage(byId("m001"), ctx(), ANCHOR);
    expect(t.senderRole).toBe("prof");
    expect(t.bucket).toBe("needsYou");
    expect(t.urgency).toBe(1);
    expect(t.deadlines).toHaveLength(1);
    expect(t.deadlines[0].dueAt).toBe(new Date("2026-11-20T17:00:00-08:00").toISOString());
    expect(t.deadlines[0].course).toBe("CS61B");
    expect(t.deadlines[0].effortMinutes).toBe(180);
    expect(t.deadlines[0].emailId).toBe("m001");
    expect(t.why).toContain("per people.md");
    expect(t.why).toContain("advisor");
  });

  it("recruiter OA invite -> recruiter / needsYou with a deadline 5 days out", () => {
    const t = heur.heuristicTriage(byId("m003"), undefined, ANCHOR);
    expect(t.senderRole).toBe("recruiter");
    expect(t.bucket).toBe("needsYou");
    expect(t.deadlines).toHaveLength(1);
    expect(t.deadlines[0].dueAt).toBe(new Date("2026-11-17T23:59:00-08:00").toISOString());
    expect(t.asks.length).toBeGreaterThan(0);
  });

  it("promos -> promo / ignore with no deadlines", () => {
    for (const id of ["m002", "m010", "m012", "m014", "m018", "m021", "m023", "m026"]) {
      const t = heur.heuristicTriage(byId(id), undefined, ANCHOR);
      expect(t.senderRole, id).toBe("promo");
      expect(t.bucket, id).toBe("ignore");
      expect(t.deadlines, id).toHaveLength(0);
    }
  });

  it("classifies the rest sensibly", () => {
    const role = (id: string) => heur.classifySenderRole(byId(id));
    expect(role("m005")).toBe("admin");
    expect(role("m006")).toBe("ta");
    expect(role("m007")).toBe("ta");
    expect(role("m004")).toBe("club");
    expect(role("m008")).toBe("peer");
    expect(role("m020")).toBe("other");
    expect(role("m013")).toBe("admin");
    expect(role("m016")).toBe("promo");

    const aid = heur.heuristicTriage(byId("m005"), undefined, ANCHOR);
    expect(aid.bucket).toBe("needsYou");
    expect(aid.deadlines[0].dueAt).toBe(new Date("2026-11-20T17:00:00-08:00").toISOString());
    expect(aid.deadlines[0].effortMinutes).toBe(30);

    const hw = heur.heuristicTriage(byId("m007"), undefined, ANCHOR);
    expect(hw.deadlines[0].dueAt).toBe(new Date("2026-11-17T23:59:00-08:00").toISOString());
    expect(hw.deadlines[0].course).toBe("CS70");

    // "come by my office hours Thursday" is not a deadline
    const ta = heur.heuristicTriage(byId("m006"), undefined, ANCHOR);
    expect(ta.deadlines).toHaveLength(0);
    expect(ta.bucket).toBe("needsYou");

    // relative weekday resolved against receivedAt (Wed Nov 11 -> Sunday Nov 15)
    const group = heur.heuristicTriage(byId("m008"), undefined, ANCHOR);
    expect(group.deadlines.map((d) => d.dueAt)).toContain(new Date("2026-11-15T23:59:00-08:00").toISOString());

    expect(heur.heuristicTriage(byId("m004"), undefined, ANCHOR).bucket).toBe("fyi");
    expect(heur.heuristicTriage(byId("m009"), undefined, ANCHOR).bucket).toBe("fyi");
  });
});

describe("runTriage", () => {
  let result: Awaited<ReturnType<Triage["runTriage"]>>;

  beforeAll(async () => {
    store.resetProposals();
    store.updateCache({ emails, events });
    postedEvents.length = 0;
    contextQueries.length = 0;
    result = await triage.runTriage(ANCHOR);
  });

  it("caps needsYou at 5, sorted by urgency then dueAt, and includes the key emails", () => {
    expect(result.needsYou.length).toBeLessThanOrEqual(5);
    expect(result.needsYou.length).toBeGreaterThan(0);
    const ids = result.needsYou.map((t) => t.emailId);
    expect(ids).toContain("m001");
    expect(ids).toContain("m003");
    for (let i = 1; i < result.needsYou.length; i++) {
      const a = result.needsYou[i - 1], b = result.needsYou[i];
      expect(a.urgency <= b.urgency).toBe(true);
    }
    expect(result.ignored).toBe(9);
    const all = [...result.needsYou, ...result.fyi];
    expect(all.length + result.ignored).toBe(30);
    for (const t of all) {
      expect(t.why.length).toBeGreaterThan(10);
      expect(t.snippet).toBeTruthy();
    }
  });

  it("asked memory for context on every email and persisted the triage in the cache", () => {
    expect(contextQueries.length).toBeGreaterThanOrEqual(30);
    expect(contextQueries.some((q) => q.includes("Prof. Daniel Lee"))).toBe(true);
    expect(store.getCache().triage?.needsYou.length).toBe(result.needsYou.length);
    expect(store.getCache().triagedAt).toBe(ANCHOR.toISOString());
  });

  it("writes deadlines and asks to memory with the agreed tags, once per email", async () => {
    const deadlines = postedEvents.filter((e) => e.kind === "deadline");
    const tasks = postedEvents.filter((e) => e.kind === "task");
    expect(deadlines.length).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThan(0);
    const lee = deadlines.find((e) => e.refs?.emailId === "m001")!;
    expect(lee.source).toBe("gmail");
    expect(lee.agent).toBe("inbox");
    expect(lee.text).toContain("CS61B");
    expect(lee.tags).toEqual(expect.arrayContaining([`due:${new Date("2026-11-20T17:00:00-08:00").toISOString()}`, "course:CS61B", "effort:180", "role:prof"]));
    const ask = tasks.find((e) => e.refs?.emailId === "m001")!;
    expect(ask.tags).toEqual(expect.arrayContaining(["role:prof", "ask"]));

    // second run: nothing re-posted, and no sender gets a second unsubscribe proposal
    const before = postedEvents.length;
    await triage.runTriage(ANCHOR);
    expect(postedEvents.length).toBe(before);
    const senders = store.listProposals().filter((p) => p.type === "unsubscribe").map((p) => p.payload.sender);
    expect(new Set(senders).size).toBe(senders.length);
    expect(JSON.parse(fs.readFileSync(path.join(DATA_DIR, "triage_state.json"), "utf8")).postedEmailIds).toContain("m001");
  });

  it("proposes unsubscribing from the repeat promo sender the user never opens", () => {
    const unsubs = store.listProposals("pending").filter((p) => p.type === "unsubscribe");
    expect(unsubs.length).toBeGreaterThan(0);
    const bb = unsubs.find((p) => p.payload.sender === "hello@news.bluebottlecoffee.com")!;
    expect(bb).toBeDefined();
    expect(bb.title).toBe("Unsubscribe from Blue Bottle Coffee");
    expect(bb.why).toContain("2 unopened");
    expect(bb.urgency).toBe(3);
    expect(bb.payload.url).toMatch(/^https:\/\/news\.bluebottlecoffee\.com\/unsubscribe/);
    expect(bb.payload.emailIds.sort()).toEqual(["m002", "m014"]);
    // the newsletter she does open is never proposed
    expect(unsubs.some((p) => p.payload.sender === "eecs-news@berkeley.edu")).toBe(false);
  });

  it("collectDeadlines flattens, de-duplicates and sorts by dueAt", () => {
    const ds = triage.collectDeadlines(result, { now: ANCHOR });
    expect(ds.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < ds.length; i++) expect(ds[i - 1].dueAt <= ds[i].dueAt).toBe(true);
    for (const d of ds) {
      expect(d).toEqual({ title: expect.any(String), dueAt: expect.stringMatching(ISO), course: expect.any(String), effortMinutes: expect.any(Number), emailId: expect.stringMatching(/^m\d{3}$/) });
    }
    expect(new Set(ds.map((d) => `${d.title}|${d.dueAt}`)).size).toBe(ds.length);
    expect(ds.find((d) => d.emailId === "m001")?.title).toBe("CS61B: Project 2");
  });
});

describe("routes", () => {
  let app: Awaited<ReturnType<App["buildServer"]>>;

  beforeAll(async () => {
    // Load fixtures relative to the real clock here, so GET /deadlines (which hides past deadlines) stays meaningful on any day.
    store.resetProposals();
    store.updateCache({ emails: fixtures.loadFixture<CachedEmail>("emails.json"), events: fixtures.loadFixture<CachedEvent>("events.json"), triage: undefined, triagedAt: undefined });
    app = await appMod.buildServer({ logger: false });
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /triage runs triage on first call and serves the cached result afterwards", async () => {
    const r1 = await app.inject({ method: "GET", url: "/triage" });
    expect(r1.statusCode).toBe(200);
    const body = r1.json();
    expect(body.needsYou.length).toBeLessThanOrEqual(5);
    expect(typeof body.ignored).toBe("number");
    const r2 = await app.inject({ method: "GET", url: "/triage" });
    expect(r2.json().needsYou.map((t: TriagedEmail) => t.emailId)).toEqual(body.needsYou.map((t: TriagedEmail) => t.emailId));
    const r3 = await app.inject({ method: "POST", url: "/triage/run" });
    expect(r3.statusCode).toBe(200);
  });

  it("GET /deadlines returns {title,dueAt,course,effortMinutes,emailId} sorted by dueAt", async () => {
    const r = await app.inject({ method: "GET", url: "/deadlines" });
    expect(r.statusCode).toBe(200);
    const ds = r.json() as { title: string; dueAt: string; course: string; effortMinutes: number; emailId: string }[];
    expect(ds.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < ds.length; i++) expect(ds[i - 1].dueAt <= ds[i].dueAt).toBe(true);
    expect(Object.keys(ds[0]).sort()).toEqual(["course", "dueAt", "effortMinutes", "emailId", "title"]);
    for (const d of ds) expect(new Date(d.dueAt).getTime()).toBeGreaterThan(Date.now() - 3_600_000);
  });

  it("POST /draft returns a send_reply proposal in Maya's voice ending with her sign-off", async () => {
    const r = await app.inject({ method: "POST", url: "/draft", payload: { emailId: "m015" } });
    expect(r.statusCode).toBe(200);
    const p = r.json() as Proposal;
    expect(p.type).toBe("send_reply");
    expect(p.agent).toBe("inbox");
    expect(p.status).toBe("pending");
    expect(p.title.length).toBeLessThanOrEqual(60);
    expect(p.title).toMatch(/^Reply to Prof\. Lee about /);
    expect(p.why).toContain("per people.md");
    expect([1, 2, 3]).toContain(p.urgency);
    expect(p.payload).toMatchObject({ emailId: "m015", threadId: "t-lee-advising", to: "dlee@berkeley.edu", autoSend: false });
    expect(p.payload.subject).toBe("Re: Advising: pick a time next week?");
    expect(p.payload.body.startsWith("Hi Prof. Lee,")).toBe(true);
    expect(p.payload.body.trimEnd().endsWith("Thanks! Maya")).toBe(true);
    expect(p.payload.originalBody).toBe(p.payload.body);
    expect(store.getProposal(p.id)?.type).toBe("send_reply");
  });

  it("POST /draft carries the deadline through and 404s on unknown ids", async () => {
    const r = await app.inject({ method: "POST", url: "/draft", payload: { emailId: "m001" } });
    const p = r.json() as Proposal;
    expect(p.dueAt).toMatch(ISO);
    expect(p.urgency).toBe(1);
    expect(p.payload.body).toContain("Prof. Lee");
    const missing = await app.inject({ method: "POST", url: "/draft", payload: { emailId: "nope" } });
    expect(missing.statusCode).toBe(404);
    const empty = await app.inject({ method: "POST", url: "/draft", payload: {} });
    expect(empty.statusCode).toBe(400);
  });
});

describe("writing style parsing", () => {
  it("reads the sign-off, greeting and name from writingstyle.md with sane defaults", async () => {
    const s = draft.parseWritingStyle(STYLE_MD);
    expect(s).toMatchObject({ signOff: "Thanks! Maya", greeting: "Hi", name: "Maya" });
    const d = draft.parseWritingStyle("");
    expect(d.signOff).toBe("Thanks!\nMaya");
    expect(d.name).toBe("Maya");
    const q = draft.parseWritingStyle('Sign-off: "Cheers, M"\nName: Maya');
    expect(q.signOff).toBe("Cheers, M");
    expect(q.name).toBe("Maya");
  });
});
