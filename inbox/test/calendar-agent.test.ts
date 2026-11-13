// Calendar agent (POST /calendar/suggest, POST /calendar/add) in demo mode: offline, no Google, no model.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

const env = await vi.hoisted(async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const fsp = await import("node:fs");
  const dir = fsp.mkdtempSync(path.join(os.tmpdir(), "northstar-calagent-test-"));
  process.env.MOCK = "1";
  process.env.INBOX_DATA_DIR = dir;
  process.env.MEMORY_URL = "http://127.0.0.1:1";
  process.env.GOOGLE_CLIENT_ID = "";
  process.env.GOOGLE_CLIENT_SECRET = "";
  process.env.AUTO_APPROVE_CALENDAR = "0";
  return { dir };
});

// Any attempt to reach Google in demo mode fails the test.
const insert = vi.hoisted(() => vi.fn(async () => ({ data: { id: "should-not-happen" } })));
vi.mock("googleapis", () => ({
  google: { auth: { OAuth2: class {} }, calendar: () => ({ events: { insert } }), gmail: () => ({}) },
}));

import type { EventCandidate } from "../../contracts/types.js";
import { buildServer } from "../src/app.js";
import { cleanTitle, conflictFor, parseWhen, suggestEvents } from "../src/calendar/agent.js";
import { getCache, listProposals, newProposal, resetCache, resetProposals, updateCache } from "../src/store.js";
import type { CachedEmail, CachedEvent } from "../src/types.js";

// Memory answers /context with one knowledge line; /events is recorded.
const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
  const body = String(url).endsWith("/context") ? { snippets: [], knowledge: ["classes.md: - Chem 110 lab every Thursday 1:00pm in Whitmore 105"] } : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

const NOW = new Date(2026, 10, 9, 9, 0, 0); // Monday 9 Nov 2026, 9:00 local
const at = (dayOffset: number, hour: number, minute = 0) => new Date(2026, 10, 9 + dayOffset, hour, minute, 0).toISOString();
const email = (id: string, from: string, subject: string, bodyText: string): CachedEmail => ({
  id, threadId: `t-${id}`, from, fromEmail: `${id}@example.edu`, to: "me@uni.edu", subject,
  receivedAt: at(-1, 15), snippet: bodyText.slice(0, 120), bodyText, labels: ["INBOX"], opened: true,
});
const EVENTS: CachedEvent[] = [
  { id: "ev-lecture", title: "CS 201 lecture", start: at(1, 14), end: at(1, 15, 30) },
  { id: "ev-robotics", title: "Robotics club", start: at(3, 18), end: at(3, 19), location: "Maker Lab" },
  { id: "ev-allday", title: "Reading week", start: at(1, 0), end: at(2, 0), allDay: true },
];
const KEYS: (keyof EventCandidate)[] = ["id", "title", "start", "end", "source", "sourceLabel", "confidence"];
const SOURCES = ["you", "email", "knowledge", "calendar", "approval"];

let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => {
  vi.stubGlobal("fetch", fetchMock);
  app = await buildServer({ logger: false });
});
afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
  fs.rmSync(env.dir, { recursive: true, force: true });
});
beforeEach(() => {
  resetCache();
  resetProposals();
  updateCache({
    events: EVENTS,
    emails: [
      email("m-fair", "Career Center", "Fall career fair", "The fall career fair is Wednesday at 11am in the Student Union. Bring resumes."),
      email("m-promo", "Deals", "50% off pizza", "Limited time only."),
    ],
  });
  fetchMock.mockClear();
  insert.mockClear();
});

describe("parseWhen / cleanTitle", () => {
  it("reads weekdays, times and durations relative to now", () => {
    expect(parseWhen("career fair next tue 2pm", NOW)).toMatchObject({ start: new Date(2026, 10, 10, 14, 0), minutes: 60, hasTime: true });
    expect(parseWhen("dentist tomorrow 9:30am for 45 min", NOW)).toMatchObject({ start: new Date(2026, 10, 10, 9, 30), minutes: 45 });
    expect(parseWhen("study group nov 20 at 6pm 2 hours", NOW)).toMatchObject({ start: new Date(2026, 10, 20, 18, 0), minutes: 120 });
    expect(parseWhen("coffee at 8am", NOW).start).toEqual(new Date(2026, 10, 10, 8, 0)); // 8am already passed today
    expect(parseWhen("call mom", NOW)).toMatchObject({ start: null, hasTime: false });
  });
  it("strips the date words out of the title", () => {
    expect(cleanTitle("I need to go to career fair next Tue 2pm")).toBe("Career fair");
    expect(cleanTitle("add dentist tomorrow at 9:30am")).toBe("Dentist");
    expect(cleanTitle("tomorrow 3pm")).toBe("New event");
  });
  it("conflictFor ignores all-day markers and the event itself", () => {
    expect(conflictFor(EVENTS, new Date(at(1, 14, 30)), new Date(at(1, 15)))).toBe("Overlaps CS 201 lecture");
    expect(conflictFor(EVENTS, new Date(at(1, 14, 30)), new Date(at(1, 15)), "ev-lecture")).toBeUndefined();
    expect(conflictFor(EVENTS, new Date(at(1, 9)), new Date(at(1, 10)))).toBeUndefined();
  });
});

describe("suggestEvents", () => {
  it("uses what the user typed, backs it with the matching email and flags the calendar conflict", async () => {
    const list = await suggestEvents("career fair tomorrow 2pm", NOW);
    expect(list[0]).toMatchObject({ id: "you", title: "Career fair", start: at(1, 14), end: at(1, 15), source: "you", conflict: "Overlaps CS 201 lecture" });
    expect(list[0].sourceLabel).toContain("matches email from Career Center");
    expect(list[0].details).toContain("Fall career fair");
    expect(list[0].confidence).toBeGreaterThan(0.9);
  });

  it("with no time typed, proposes the time written in the matching email", async () => {
    const list = await suggestEvents("career fair", NOW);
    expect(list[0]).toMatchObject({ id: "mail-m-fair", title: "Fall career fair", start: at(2, 11), end: at(2, 12), source: "email", sourceLabel: "Email from Career Center" });
    expect(list[0].conflict).toBeUndefined();
    expect(list.some((c) => c.id === "mail-m-promo")).toBe(false);
  });

  it("shows an event that is already on the calendar instead of inviting a duplicate", async () => {
    const list = await suggestEvents("robotics", NOW);
    const cal = list.find((c) => c.source === "calendar")!;
    expect(cal).toMatchObject({ id: "cal-ev-robotics", title: "Robotics club", start: at(3, 18), location: "Maker Lab" });
    expect(cal.sourceLabel).toMatch(/^Already on your calendar/);
    expect(cal.conflict).toBeUndefined(); // it does not conflict with itself
  });

  it("searches memory (:7701 /context) and pending approvals", async () => {
    const p = newProposal({ type: "create_event", title: "◎ Chem lab report", why: "Due Friday for Chem 110", urgency: 2, payload: { block: { title: "◎ Chem lab report", start: at(2, 15), end: at(2, 15, 50), minutes: 50, deadlineTitle: "Chem lab report", dueAt: at(4, 17) } } });
    const list = await suggestEvents("chem lab", NOW);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "http://127.0.0.1:1/context")).toBe(true);
    expect(list.find((c) => c.source === "knowledge")).toMatchObject({ id: "kn-classes.md", sourceLabel: "From classes.md", start: at(3, 13) });
    expect(list.find((c) => c.source === "approval")).toMatchObject({ id: `prop-${p.id}`, title: "Chem lab report", start: at(2, 15) });
  });

  it("always returns something, at most 4, in the exact EventCandidate shape", async () => {
    const none = await suggestEvents("call grandma", NOW);
    expect(none).toHaveLength(1);
    expect(none[0]).toMatchObject({ id: "you", title: "Call grandma", source: "you", confidence: 0.4 });
    expect(new Date(none[0].start).getTime()).toBe(new Date(at(1, 15, 30)).getTime()); // first free hour tomorrow afternoon, after the lecture
    for (const q of ["career fair tomorrow 2pm", "robotics club lecture career chem lab", "x"]) {
      const list = await suggestEvents(q, NOW);
      expect(list.length).toBeGreaterThan(0);
      expect(list.length).toBeLessThanOrEqual(4);
      for (const c of list) {
        for (const k of KEYS) expect(c[k], `${q}: ${k}`).toBeDefined();
        expect(SOURCES).toContain(c.source);
        expect(new Date(c.end).getTime()).toBeGreaterThan(new Date(c.start).getTime());
        expect(c.start).toBe(new Date(c.start).toISOString());
        expect(c.confidence).toBeGreaterThanOrEqual(0);
        expect(c.confidence).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("routes", () => {
  it("POST /calendar/suggest returns an array, changes nothing, and validates the query", async () => {
    const before = JSON.stringify(getCache().events);
    const res = await app.inject({ method: "POST", url: "/calendar/suggest", payload: { query: "career fair next tue 2pm" } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    expect(res.json()[0]).toMatchObject({ source: "you", title: "Career fair" });
    expect(JSON.stringify(getCache().events)).toBe(before);
    expect(listProposals()).toHaveLength(0);
    expect((await app.inject({ method: "POST", url: "/calendar/suggest", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/calendar/suggest", payload: { query: "  " } })).statusCode).toBe(400);
  });

  it("POST /calendar/add in demo mode returns a fake event id, shows it on the calendar and never calls Google", async () => {
    const candidate: EventCandidate = { id: "you", title: "Career fair", start: at(0, 16), end: at(0, 17), location: "Student Union", source: "you", sourceLabel: "From what you typed", confidence: 0.9 };
    const res = await app.inject({ method: "POST", url: "/calendar/add", payload: { candidate } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, mock: true });
    expect(body.eventId).toMatch(/^mock-/);
    expect(body.htmlLink).toContain("https://calendar.google.com/calendar/render?action=TEMPLATE");
    expect(insert).not.toHaveBeenCalled();
    expect(getCache().events.find((e) => e.id === body.eventId)).toMatchObject({ title: "Career fair", start: at(0, 16), location: "Student Union" });
    // logged to memory
    const posted = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/events")).map(([, init]) => JSON.parse(String(init?.body)));
    expect(posted.at(-1)).toMatchObject({ agent: "inbox", source: "calendar", refs: { eventId: body.eventId } });
    // adding the same thing again does not duplicate it
    const again = (await app.inject({ method: "POST", url: "/calendar/add", payload: { candidate } })).json();
    expect(again).toMatchObject({ ok: true, eventId: body.eventId, duplicate: true });
    expect(getCache().events.filter((e) => e.title === "Career fair")).toHaveLength(1);
  });

  it("adding a candidate that came from an approval card approves that card instead of making a second event", async () => {
    const p = newProposal({ type: "create_event", title: "◎ Chem lab report", why: "Due Friday", urgency: 2, payload: { block: { title: "◎ Chem lab report", start: at(2, 15), end: at(2, 15, 50), minutes: 50, deadlineTitle: "Chem lab report", dueAt: at(4, 17) } } });
    const candidate = { id: `prop-${p.id}`, title: "Chem lab report", start: at(2, 15), end: at(2, 15, 50), source: "approval", sourceLabel: "Already suggested by Northstar", confidence: 0.7 };
    const body = (await app.inject({ method: "POST", url: "/calendar/add", payload: { candidate } })).json();
    expect(body.ok).toBe(true);
    expect(listProposals().find((x) => x.id === p.id)).toMatchObject({ status: "done", payload: { eventId: body.eventId } });
    expect(getCache().events.filter((e) => e.title === "◎ Chem lab report")).toHaveLength(1);
  });

  it("rejects a malformed candidate with 400 and adds nothing", async () => {
    const before = getCache().events.length;
    for (const candidate of [undefined, { title: "", start: at(1, 9), end: at(1, 10) }, { title: "X", start: "soon", end: at(1, 10) }, { title: "X", start: at(1, 10), end: at(1, 9) }]) {
      const res = await app.inject({ method: "POST", url: "/calendar/add", payload: { candidate } });
      expect(res.statusCode).toBe(400);
      expect(res.json().ok).toBe(false);
    }
    expect(getCache().events).toHaveLength(before);
  });
});
