// Course hub tests. Fully offline: MOCK=1 (no OpenAI client is ever created) and `fetch` is stubbed so memory
// (:7701) calls never hit the network. Modules are imported dynamically AFTER the env is set.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MemoryEvent, Proposal } from "../src/types.js";
import type { Course, CourseDeadline, SearchResult } from "../src/courses/types.js";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-courses-test-"));
process.env.INBOX_DATA_DIR = DATA_DIR;
process.env.MOCK = "1";
process.env.OPENAI_API_KEY = "";
process.env.MEMORY_URL = "http://127.0.0.1:1"; // never reached: fetch is stubbed below

const NOW = new Date(2026, 10, 13, 8, 0); // Fri Nov 13 2026, local time
const FIXTURE = fs.readFileSync(path.join(__dirname, "..", "fixtures", "syllabus-cs61b.txt"), "utf8");

const postedEvents: MemoryEvent[] = [];
let memoryDown = false;
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (memoryDown) throw new Error("connect ECONNREFUSED");
    if (u.endsWith("/events")) {
      postedEvents.push(JSON.parse(String(init?.body)) as MemoryEvent);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected network call in test: ${u}`);
  }),
);

type Extract = typeof import("../src/courses/extract.js");
type Search = typeof import("../src/courses/search.js");
type Routes = typeof import("../src/courses/routes.js");
type CStore = typeof import("../src/courses/store.js");
type Store = typeof import("../src/store.js");
type App = typeof import("../src/app.js");

let extract: Extract, search: Search, routes: Routes, cstore: CStore, store: Store, appMod: App;
let app: Awaited<ReturnType<App["buildServer"]>>;

beforeAll(async () => {
  [extract, search, routes, cstore, store, appMod] = await Promise.all([
    import("../src/courses/extract.js"), import("../src/courses/search.js"), import("../src/courses/routes.js"),
    import("../src/courses/store.js"), import("../src/store.js"), import("../src/app.js"),
  ]);
  app = await appMod.buildServer({ logger: false });
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const local = (iso: string) => {
  const d = new Date(iso);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};
/** A date `days` from now as "Month D" plus the Date at 23:59 local. */
function inDays(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(23, 59, 0, 0);
  return { date: d, named: d.toLocaleDateString("en-US", { month: "long", day: "numeric" }), year: d.getFullYear() };
}

describe("deterministic syllabus parser", () => {
  it("pulls the dated items out of the fixture syllabus with the term's year", () => {
    const got = extract.parseDeadlines(FIXTURE, NOW);
    expect(got.map((d) => [d.title, d.kind, ...local(d.dueAt)])).toEqual([
      ["Homework 9 (Hashing)", "assignment", 2026, 11, 16, 23, 59],
      ["Project 2B: Gitlet checkpoint", "project", 2026, 11, 20, 23, 59],
      ["Midterm 2", "exam", 2026, 11, 24, 19, 0],
      ["Lab 12 (Graphs)", "assignment", 2026, 12, 2, 23, 59],
      ["Project 3: Build Your Own World", "project", 2026, 12, 4, 23, 59],
      ["Homework 10 (Sorting)", "assignment", 2026, 12, 9, 23, 59],
      ["Final exam", "exam", 2026, 12, 16, 8, 0],
    ]);
    expect(local(got[2].endAt!)).toEqual([2026, 11, 24, 21, 0]);
    expect(local(got[6].endAt!)).toEqual([2026, 12, 16, 11, 0]);
  });

  it("handles 'Nov 20', '11/20', long dates with times, and skips breaks and office hours", () => {
    const text = [
      "Spring 2027",
      "Essay 1 due Feb 12",
      "3/5 Problem Set 4 due",
      "Quiz 2: Friday, March 19, 2:30 PM",
      "Final paper due Friday, April 30, 2027, 5 PM",
      "No class March 22 (spring break)",
      "Office hours: Tuesdays; extra project office hours on April 28",
      "You may bring 1 page of notes to the exam.",
      "Lab report due Feb 30",
    ].join("\n");
    const got = extract.parseDeadlines(text, NOW);
    expect(got.map((d) => [d.title, d.kind, ...local(d.dueAt)])).toEqual([
      ["Essay 1", "assignment", 2027, 2, 12, 23, 59],
      ["Problem Set 4", "assignment", 2027, 3, 5, 23, 59],
      ["Quiz 2", "exam", 2027, 3, 19, 14, 30],
      ["Final paper", "assignment", 2027, 4, 30, 17, 0],
    ]);
  });

  it("infers the year from today when the syllabus names none", () => {
    const got = extract.parseDeadlines("Homework 1 due Nov 20\nHomework 7 due Jan 15", NOW);
    expect(got.map((d) => local(d.dueAt).slice(0, 3))).toEqual([[2026, 11, 20], [2027, 1, 15]]);
  });

  it("extracts at most 8 labelled facts", () => {
    const facts = extract.parseFacts(FIXTURE);
    const by = Object.fromEntries(facts.map((f) => [f.label, f.value]));
    expect(facts.length).toBeLessThanOrEqual(8);
    expect(by["Instructor"]).toContain("Prof. Daniel Lee");
    expect(by["Office hours"]).toContain("Tuesdays 3:00-4:30 PM");
    expect(by["Late policy"]).toContain("5 slip days");
    expect(by["Grading"]).toContain("Projects 40%");
    for (const f of facts) expect(f.value.length).toBeLessThanOrEqual(220);
  });
});

describe("search", () => {
  it("ranks the matching chunk first and returns nothing for unknown terms", () => {
    const course = { id: "cs61b", name: "CS 61B", uploadedAt: NOW.toISOString(), summary: "", deadlineCount: 0, facts: [], text: FIXTURE, deadlines: [] };
    const late = search.searchCourses([course], "late policy slip days");
    expect(late.length).toBeGreaterThan(0);
    expect(late.length).toBeLessThanOrEqual(5);
    expect(late[0].snippet).toContain("5 slip days");
    expect(late[0].score).toBeGreaterThan(0);
    expect(search.searchCourses([course], "when are office hours")[0].snippet).toContain("Soda 779");
    expect(search.searchCourses([course], "zebra kazoo")).toEqual([]);
    expect(search.searchCourses([course], "the of and")).toEqual([]);
  });
});

describe("course routes (MOCK=1)", () => {
  const a = inDays(6);
  const b = inDays(20);
  const past = inDays(-10);
  const syllabus = (extra = "") =>
    [
      "HIST 7B: US History",
      `Term year ${a.year}`,
      "Instructor: Dr. Rivera",
      "Late policy: One free 48-hour extension per student.",
      "",
      `Reading response 1 due ${past.named}, ${past.year}`,
      `Essay draft due ${a.named}, ${a.year}`,
      `Final project due ${b.named}, ${b.year}, 5:00 PM`,
      extra,
    ].join("\n");
  const upload = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/courses/syllabus", payload });
  const pendingFor = (courseId: string) => store.listProposals("pending").filter((p) => p.payload?.courseId === courseId);

  it("seeds the fixture syllabus when nothing is stored", async () => {
    const r = await app.inject({ method: "GET", url: "/courses" });
    expect(r.statusCode).toBe(200);
    const { courses } = r.json() as { courses: Course[] };
    expect(courses).toHaveLength(1);
    expect(courses[0]).toMatchObject({ id: "cs61b", name: "CS 61B", deadlineCount: 7 });
    expect(courses[0].summary.length).toBeGreaterThan(10);
    expect(courses[0]).not.toHaveProperty("text");
    // Deleting the sample must not bring it back.
    expect((await app.inject({ method: "DELETE", url: "/courses/cs61b" })).json()).toEqual({ ok: true });
    expect(((await app.inject({ method: "GET", url: "/courses" })).json() as { courses: Course[] }).courses).toEqual([]);
    expect(pendingFor("cs61b")).toEqual([]);
  });

  it("rejects uploads with no course, no content, or an unreadable PDF", async () => {
    expect((await upload({ text: "x" })).statusCode).toBe(400);
    const none = await upload({ course: "HIST 7B" });
    expect(none.statusCode).toBe(400);
    expect(typeof (none.json() as { error: string }).error).toBe("string");
    expect((await upload({ course: "HIST 7B", text: "   " })).statusCode).toBe(400);
    expect((await upload({ course: "HIST 7B", pdfBase64: Buffer.from("not a pdf").toString("base64") })).statusCode).toBe(400);
    expect(cstore.listCourses()).toEqual([]);
  });

  it("stores the syllabus and proposes one create_event per future deadline", async () => {
    postedEvents.length = 0;
    const r = await upload({ course: "HIST 7B", filename: "hist7b.txt", text: syllabus() });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { course: Course; deadlines: CourseDeadline[]; proposals: Proposal[] };
    expect(body.course).toMatchObject({ id: "hist7b", name: "HIST 7B", filename: "hist7b.txt", deadlineCount: 3 });
    expect(body.course.facts).toContainEqual({ label: "Instructor", value: "Dr. Rivera" });
    expect(body.deadlines.map((d) => d.title)).toEqual(["Reading response 1", "Essay draft", "Final project"]);
    expect(body.deadlines[0].proposalId).toBeUndefined(); // already past
    expect(body.proposals).toHaveLength(2);
    for (const p of body.proposals) {
      expect(p).toMatchObject({ type: "create_event", status: "pending", agent: "inbox" });
      expect(p.title.length).toBeLessThanOrEqual(60);
      expect(p.why).toContain("From your HIST 7B syllabus");
      expect(new Date(p.dueAt!).getTime()).toBeGreaterThan(Date.now());
      // Shape the calendar approve handler executes ({ block }) plus what the UI renders (top-level start/end).
      expect(p.payload.block).toMatchObject({ title: p.title, dueAt: p.dueAt });
      expect(new Date(p.payload.block.end).getTime()).toBeGreaterThan(new Date(p.payload.block.start).getTime());
      expect(p.payload).toMatchObject({ start: p.payload.block.start, end: p.payload.block.end, source: "syllabus", courseId: "hist7b" });
    }
    expect(body.proposals[0].title).toBe("HIST 7B: Essay draft due");
    expect(new Date(body.deadlines[1].dueAt).getTime()).toBe(a.date.getTime());
    expect(local(body.deadlines[2].dueAt).slice(3)).toEqual([17, 0]);
    expect(body.deadlines.filter((d) => d.proposalId).map((d) => d.proposalId)).toEqual(body.proposals.map((p) => p.id));
    // One "deadline" memory event per deadline.
    expect(postedEvents).toHaveLength(3);
    expect(postedEvents.every((e) => e.kind === "deadline" && e.agent === "inbox" && e.tags?.includes("course:hist7b"))).toBe(true);
  });

  it("replaces the course on re-upload without duplicating proposals", async () => {
    const before = pendingFor("hist7b").map((p) => p.id).sort();
    const again = (await upload({ course: "hist 7b", text: syllabus() })).json() as { course: Course; proposals: Proposal[] };
    expect(again.course.id).toBe("hist7b");
    expect(pendingFor("hist7b").map((p) => p.id).sort()).toEqual(before);
    expect(cstore.listCourses()).toHaveLength(1);

    // A changed syllabus: one deadline dropped, one added. The dropped one's pending proposal is closed.
    const c = inDays(9);
    const changed = syllabus(`Museum visit report due ${c.named}, ${c.year}`).replace(/^Essay draft.*$/m, "");
    const r = (await upload({ course: "HIST 7B", text: changed })).json() as { deadlines: CourseDeadline[]; proposals: Proposal[] };
    expect(r.proposals.map((p) => p.title).sort()).toEqual(["HIST 7B: Final project due", "HIST 7B: Museum visit report due"]);
    expect(pendingFor("hist7b")).toHaveLength(2);
    expect(store.listProposals().filter((p) => p.payload?.courseId === "hist7b")).toHaveLength(3);
  });

  it("approving a syllabus proposal creates the calendar event once, and a re-upload leaves it alone", async () => {
    const target = pendingFor("hist7b").find((p) => p.title.includes("Final project"))!;
    const r = await app.inject({ method: "POST", url: `/proposals/${target.id}/approve` });
    const done = r.json() as Proposal;
    expect(done.status).toBe("done");
    expect(String(done.payload.eventId)).toMatch(/^mock-/);
    expect(store.getCache().events.filter((e) => e.title === target.title)).toHaveLength(1);

    const c = inDays(9);
    const re = (await upload({ course: "HIST 7B", text: syllabus(`Museum visit report due ${c.named}, ${c.year}`).replace(/^Essay draft.*$/m, "") })).json() as { proposals: Proposal[] };
    expect(re.proposals.find((p) => p.id === target.id)?.status).toBe("done");
    expect(pendingFor("hist7b")).toHaveLength(1);
  });

  it("serves one course with its text and deadlines, and 404s on unknown ids", async () => {
    const r = await app.inject({ method: "GET", url: "/courses/hist7b" });
    expect(r.statusCode).toBe(200);
    const c = r.json() as Course & { text: string; deadlines: CourseDeadline[] };
    expect(c.text).toContain("Dr. Rivera");
    expect(c.deadlines).toHaveLength(3);
    expect(c.deadlineCount).toBe(3);
    expect((await app.inject({ method: "GET", url: "/courses/nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/courses/nope" })).statusCode).toBe(404);
  });

  it("searches across courses without an LLM answer in MOCK mode", async () => {
    await upload({ course: "CS 61B", text: FIXTURE });
    const r = await app.inject({ method: "GET", url: "/courses/search?q=" + encodeURIComponent("how many slip days do I get") });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { results: SearchResult[]; answer?: string };
    expect(body.answer).toBeUndefined();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.length).toBeLessThanOrEqual(5);
    expect(body.results[0]).toMatchObject({ courseId: "cs61b", course: "CS 61B" });
    expect(body.results[0].snippet).toContain("5 slip days");
    const ext = (await app.inject({ method: "GET", url: "/courses/search?q=extension" })).json() as { results: SearchResult[] };
    expect(ext.results.map((x) => x.courseId)).toContain("hist7b");
    expect(((await app.inject({ method: "GET", url: "/courses/search" })).json() as { results: SearchResult[] }).results).toEqual([]);
  });

  it("still accepts an upload when memory is down", async () => {
    memoryDown = true;
    try {
      const d = inDays(4);
      const r = await upload({ course: "MATH 54", text: `Homework 12 due ${d.named}, ${d.year}` });
      expect(r.statusCode).toBe(200);
      expect((r.json() as { proposals: Proposal[] }).proposals).toHaveLength(1);
    } finally {
      memoryDown = false;
    }
  });

  it("accepts a syllabus body larger than the default 1 MB limit", async () => {
    const d = inDays(4);
    const big = `Homework 3 due ${d.named}, ${d.year}\n\n` + "Lecture notes filler paragraph.\n".repeat(60_000);
    expect(big.length).toBeGreaterThan(1_500_000);
    const r = await upload({ course: "BIG 1", text: big });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { course: Course }).course.deadlineCount).toBe(1);
    await app.inject({ method: "DELETE", url: "/courses/big1" });
  });

  it("deleting a course closes its pending proposals", async () => {
    expect(pendingFor("hist7b").length).toBeGreaterThan(0);
    expect((await app.inject({ method: "DELETE", url: "/courses/hist7b" })).json()).toEqual({ ok: true });
    expect(pendingFor("hist7b")).toEqual([]);
    expect(cstore.getCourse("hist7b")).toBeUndefined();
  });
});
