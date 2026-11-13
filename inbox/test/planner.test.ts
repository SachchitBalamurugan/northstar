// Offline tests for the calendar scheduler. Events are built inline (no fixtures), memory is a mocked fetch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CachedEvent, Deadline } from "../src/types.js";
import { busyIntervals, freeSlots, mergeIntervals } from "../src/calendar/freebusy.js";
import {
  BUFFER_MIN,
  MAX_BLOCK_MIN,
  MAX_DAY_MIN,
  type PlannedBlock,
  blockTitle,
  hasExistingBlock,
  parseFocusWindow,
  planBlocks,
} from "../src/calendar/planner.js";

// Keep store I/O out of the real data folder; set before the store/config modules are imported (below, dynamically).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-cal-"));
process.env.INBOX_DATA_DIR = tmpDir;
process.env.MOCK = "1";
process.env.AUTO_APPROVE_CALENDAR = "0";

// ---- helpers ----
const FOCUS = { startHour: 14, endHour: 17 };
/** Monday 2026-11-16 10:00 local. */
const NOW = new Date(2026, 10, 16, 10, 0, 0, 0);
const local = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m, 0, 0);
const iso = (d: Date) => d.toISOString();
const hm = (s: string) => {
  const d = new Date(s);
  return `${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const minutes = (b: PlannedBlock) => (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60_000;

function ev(id: string, start: Date, end: Date, extra: Partial<CachedEvent> = {}): CachedEvent {
  return { id, title: `Event ${id}`, start: iso(start), end: iso(end), ...extra };
}
function dl(title: string, dueAt: Date, effortMinutes: number): Deadline {
  return { title, dueAt: iso(dueAt), effortMinutes };
}
const plan = (deadlines: Deadline[], events: CachedEvent[] = [], now = NOW, focusWindow = FOCUS) =>
  planBlocks({ deadlines, events, now, focusWindow });

/** Every block must respect the hard rules, regardless of the scenario. */
function assertInvariants(blocks: PlannedBlock[], events: CachedEvent[] = []) {
  const sorted = [...blocks].sort((a, b) => a.start.localeCompare(b.start));
  expect(blocks).toEqual(sorted); // deterministic, chronological
  const perDay = new Map<string, number>();
  for (const b of blocks) {
    const s = new Date(b.start);
    const e = new Date(b.end);
    expect(minutes(b)).toBe(b.minutes);
    expect(b.minutes).toBeGreaterThan(0);
    expect(b.minutes).toBeLessThanOrEqual(MAX_BLOCK_MIN);
    expect(b.title.startsWith("◎ ")).toBe(true);
    expect(b.title.length).toBeLessThanOrEqual(60);
    expect(s.getHours()).toBeGreaterThanOrEqual(9);
    expect(e.getHours() * 60 + e.getMinutes()).toBeLessThanOrEqual(23 * 60);
    expect(s.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
    if (!b.partial) expect(new Date(b.dueAt).getTime() - e.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60_000);
    const key = s.toDateString();
    perDay.set(key, (perDay.get(key) ?? 0) + b.minutes);
  }
  for (const [, m] of perDay) expect(m).toBeLessThanOrEqual(MAX_DAY_MIN);
  // 10-minute buffers between blocks and around existing events
  const all = [
    ...sorted.map((b) => ({ s: new Date(b.start).getTime(), e: new Date(b.end).getTime(), block: true })),
    ...events.filter((x) => !x.allDay).map((x) => ({ s: new Date(x.start).getTime(), e: new Date(x.end).getTime(), block: false })),
  ].sort((a, b) => a.s - b.s);
  for (let i = 1; i < all.length; i++) {
    if (all[i].block || all[i - 1].block) expect(all[i].s - all[i - 1].e).toBeGreaterThanOrEqual(BUFFER_MIN * 60_000);
  }
}

// ---- freebusy ----
describe("freebusy", () => {
  it("merges overlapping and touching busy intervals and returns the gaps", () => {
    const day = local(16, 9);
    const end = local(16, 23);
    const events = [ev("a", local(16, 10), local(16, 11)), ev("b", local(16, 10, 30), local(16, 12)), ev("c", local(16, 12), local(16, 12, 30)), ev("d", local(16, 15), local(16, 16))];
    expect(busyIntervals(events, day, end).map((b) => [hm(iso(b.start)), hm(iso(b.end))])).toEqual([
      ["16 10:00", "16 12:30"],
      ["16 15:00", "16 16:00"],
    ]);
    expect(freeSlots(events, day, end).map((s) => [hm(iso(s.start)), hm(iso(s.end))])).toEqual([
      ["16 09:00", "16 10:00"],
      ["16 12:30", "16 15:00"],
      ["16 16:00", "16 23:00"],
    ]);
  });

  it("treats all-day events as blocking the whole day and clips to the window", () => {
    const events = [ev("holiday", local(16, 0), local(16, 0), { allDay: true })];
    expect(freeSlots(events, local(16, 9), local(16, 23))).toEqual([]);
    expect(freeSlots(events, local(16, 9), local(17, 23)).map((s) => [hm(iso(s.start)), hm(iso(s.end))])).toEqual([["17 00:00", "17 23:00"]]);
  });

  it("mergeIntervals does not mutate its input and drops minMinutes slivers", () => {
    const input = [{ start: local(16, 12), end: local(16, 13) }, { start: local(16, 9), end: local(16, 10) }];
    const merged = mergeIntervals(input);
    expect(merged.map((m) => m.start.getHours())).toEqual([9, 12]);
    expect(input[0].start.getHours()).toBe(12);
    const slots = freeSlots([ev("a", local(16, 9, 5), local(16, 12))], local(16, 9), local(16, 13), { minMinutes: 15 });
    expect(slots.map((s) => hm(iso(s.start)))).toEqual(["16 12:00"]);
  });
});

// ---- planner ----
describe("planBlocks", () => {
  it("splits effort into <=50-min blocks with 10-min buffers inside the focus window", () => {
    const blocks = plan([dl("CS101 essay", local(20, 17), 120)]);
    expect(blocks.map((b) => [hm(b.start), hm(b.end), b.minutes])).toEqual([
      ["16 14:00", "16 14:50", 50],
      ["16 15:00", "16 15:50", 50],
      ["16 16:00", "16 16:20", 20],
    ]);
    expect(blocks.every((b) => b.title === "◎ CS101 essay" && b.deadlineTitle === "CS101 essay" && !b.partial)).toBe(true);
    assertInvariants(blocks);
  });

  it("prefers the focus window over earlier free time (now is 10:00, nothing on the calendar)", () => {
    const [first] = plan([dl("Problem set", local(20, 17), 50)]);
    expect(hm(first.start)).toBe("16 14:00");
  });

  it("reads the focus window from input (2-5pm from memory), not a hard-coded one", () => {
    const [first] = plan([dl("Reading", local(20, 17), 50)], [], NOW, { startHour: 19, endHour: 21 });
    expect(hm(first.start)).toBe("16 19:00");
  });

  it("routes around existing events with a 10-min buffer on both sides", () => {
    const events = [ev("mtg", local(16, 14), local(16, 15))];
    const blocks = plan([dl("Lab report", local(20, 17), 100)], events);
    expect(blocks.map((b) => [hm(b.start), hm(b.end)])).toEqual([
      ["16 15:10", "16 16:00"],
      ["16 16:10", "16 17:00"],
    ]);
    assertInvariants(blocks, events);
  });

  it("never schedules before 09:00 or after 23:00 even with a late focus window", () => {
    const blocks = plan([dl("Big project", local(25, 17), 400)], [], NOW, { startHour: 21, endHour: 23 });
    for (const b of blocks) {
      expect(new Date(b.start).getHours()).toBeGreaterThanOrEqual(9);
      const e = new Date(b.end);
      expect(e.getHours() * 60 + e.getMinutes()).toBeLessThanOrEqual(23 * 60);
    }
    expect(blocks.reduce((s, b) => s + b.minutes, 0)).toBe(400);
    // 21-23 holds two 50-min blocks per day; the rest spills into other focus days before any non-focus hours
    expect(blocks.slice(0, 2).map((b) => hm(b.start))).toEqual(["16 21:00", "16 22:00"]);
    expect(blocks.slice(2, 4).map((b) => hm(b.start))).toEqual(["17 21:00", "17 22:00"]);
    assertInvariants(blocks);
  });

  it("keeps each day at <= 6h of planned work, counting existing events", () => {
    // 5h of meetings already on Monday → at most 60 new minutes that day.
    const events = [ev("long", local(16, 9), local(16, 14))];
    const blocks = plan([dl("Thesis chapter", local(30, 17), 600)], events);
    const mondayMinutes = blocks.filter((b) => new Date(b.start).getDate() === 16).reduce((s, b) => s + b.minutes, 0);
    expect(mondayMinutes).toBe(50); // one 50-min block; the 10-min leftover of cap is too small for a fragment
    const perDay = new Map<number, number>();
    for (const b of blocks) perDay.set(new Date(b.start).getDate(), (perDay.get(new Date(b.start).getDate()) ?? 0) + b.minutes);
    for (const [, m] of perDay) expect(m).toBeLessThanOrEqual(MAX_DAY_MIN);
    expect(blocks.reduce((s, b) => s + b.minutes, 0)).toBe(600);
    assertInvariants(blocks, events);
  });

  it("ends the last block at least 24h before the due date (falls back to morning slots)", () => {
    // Due Tue 12:00 → everything must end by Mon 12:00, i.e. before the focus window opens.
    const blocks = plan([dl("Quiz prep", local(17, 12), 60)]);
    expect(blocks.map((b) => [hm(b.start), hm(b.end)])).toEqual([
      ["16 10:00", "16 10:50"],
      ["16 11:00", "16 11:10"],
    ]);
    expect(blocks.some((b) => b.partial)).toBe(false);
    assertInvariants(blocks);
  });

  it("flags partial on the last block when the effort does not fit before the 24h cutoff", () => {
    const blocks = plan([dl("Grant application", local(17, 12), 300)]);
    expect(blocks.map((b) => [hm(b.start), hm(b.end)])).toEqual([
      ["16 10:00", "16 10:50"],
      ["16 11:00", "16 11:50"],
    ]);
    expect(blocks[blocks.length - 1].partial).toBe(true);
    expect(blocks.slice(0, -1).every((b) => !b.partial)).toBe(true);
  });

  it("never places a block inside the 24h margin, even when the deadline is less than 24h away", () => {
    // Due tonight: the cutoff (yesterday 20:00) is already past, so nothing is planned.
    expect(plan([dl("Financial aid form", local(16, 20), 50)])).toEqual([]);
    // Due tomorrow 10:30 → cutoff is today 10:30; only a 30-min block fits (now is 10:00), flagged partial.
    const blocks = plan([dl("Problem set", local(17, 10, 30), 120)]);
    expect(blocks.map((b) => [hm(b.start), hm(b.end), b.partial])).toEqual([["16 10:00", "16 10:30", true]]);
    for (const b of blocks) expect(new Date(b.dueAt).getTime() - new Date(b.end).getTime()).toBeGreaterThanOrEqual(24 * 60 * 60_000);
  });

  it("widens beyond the focus window only for the part that cannot fit in it", () => {
    // Cutoff Tue 18:00 → two focus windows (Mon + Tue, 3 blocks each = 300 min). 400 min needs 100 min elsewhere.
    const blocks = plan([dl("Thesis chapter", local(18, 18), 400)]);
    expect(blocks.reduce((s, b) => s + b.minutes, 0)).toBe(400);
    const inFocus = (b: PlannedBlock) => new Date(b.start).getHours() >= 14 && new Date(b.end).getHours() * 60 + new Date(b.end).getMinutes() <= 17 * 60;
    expect(blocks.filter(inFocus).reduce((s, b) => s + b.minutes, 0)).toBe(300);
    expect(blocks.filter((b) => !inFocus(b)).reduce((s, b) => s + b.minutes, 0)).toBe(100);
    assertInvariants(blocks);
    // With a later due date the same effort stays entirely inside 14:00-17:00.
    const roomy = plan([dl("Thesis chapter", local(25, 18), 400)]);
    expect(roomy.every(inFocus)).toBe(true);
    assertInvariants(roomy);
  });

  it("uses the default 14:00-17:00 window when the focus window is missing or invalid", () => {
    for (const fw of [undefined, { startHour: 17, endHour: 14 }, { startHour: NaN, endHour: 3 }]) {
      const blocks = planBlocks({ deadlines: [dl("Reading", local(20, 17), 50)], events: [], now: NOW, focusWindow: fw as never });
      expect(blocks.map((b) => [hm(b.start), hm(b.end)])).toEqual([["16 14:00", "16 14:50"]]);
    }
  });

  it("blocks of different deadlines never overlap each other or existing events", () => {
    const events = [ev("class", local(16, 14, 30), local(16, 15, 30)), ev("gym", local(17, 14), local(17, 15))];
    const blocks = plan([dl("Essay", local(19, 17), 150), dl("Lab report", local(19, 18), 150), dl("Quiz prep", local(20, 9), 100)], events);
    expect(blocks.reduce((s, b) => s + b.minutes, 0)).toBe(400);
    const spans = [
      ...blocks.map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()]),
      ...events.map((e) => [new Date(e.start).getTime(), new Date(e.end).getTime()]),
    ];
    for (let i = 0; i < spans.length; i++)
      for (let j = i + 1; j < spans.length; j++) expect(spans[i][0] >= spans[j][1] || spans[j][0] >= spans[i][1]).toBe(true);
    assertInvariants(blocks, events);
  });

  it("caps a day at 6h even across several deadlines, and no block ends after 23:00", () => {
    const wide = { startHour: 9, endHour: 23 };
    const blocks = plan([dl("A", local(25, 17), 300), dl("B", local(25, 18), 300), dl("C", local(25, 19), 300)], [], NOW, wide);
    expect(blocks.reduce((s, b) => s + b.minutes, 0)).toBe(900);
    const perDay = new Map<number, number>();
    for (const b of blocks) perDay.set(new Date(b.start).getDate(), (perDay.get(new Date(b.start).getDate()) ?? 0) + b.minutes);
    // 7 x 50 = 350 per day: the 10 minutes left under the cap are below the 15-min minimum block.
    expect([...perDay.values()]).toEqual([350, 350, 200]);
    assertInvariants(blocks);
    // Late focus window with a lot of work: the last block of each day stops at or before 23:00.
    const late = plan([dl("Night owl project", local(25, 17), 400)], [], NOW, { startHour: 21, endHour: 24 });
    for (const b of late) expect(new Date(b.end).getHours() * 60 + new Date(b.end).getMinutes()).toBeLessThanOrEqual(23 * 60);
    expect(late.filter((b) => new Date(b.start).getHours() >= 21).length).toBeGreaterThan(0);
    assertInvariants(late);
  });

  it("is deterministic and does not mutate its input", () => {
    const events = [ev("class", local(16, 14, 30), local(16, 15, 30))];
    const deadlines = [dl("Essay", local(19, 17), 150), dl("Algebra", local(19, 17), 70)];
    const snapshot = JSON.stringify({ events, deadlines });
    const first = plan(deadlines, events);
    expect(plan(deadlines, events)).toEqual(first);
    expect(plan([...deadlines].reverse(), [...events].reverse())).toEqual(first); // input order does not matter
    expect(JSON.stringify({ events, deadlines })).toBe(snapshot);
    expect(first.every((b) => b.title.startsWith("◎ "))).toBe(true);
  });

  it("an unrelated short ◎ block does not suppress a deadline that merely contains its words", () => {
    const events = [ev("blk", local(17, 14), local(17, 14, 50), { title: "◎ Lab", createdByNorthstar: true })];
    expect(hasExistingBlock(dl("Collaboration essay", local(20, 17), 60), events)).toBe(false);
    // A truncated block title still matches the long deadline it was made for.
    const long = "Write the comparative literature essay on magical realism in Latin America";
    const truncated = [ev("blk", local(17, 14), local(17, 14, 50), { title: blockTitle(long), createdByNorthstar: true })];
    expect(hasExistingBlock(dl(long, local(20, 17), 60), truncated)).toBe(true);
  });

  it("skips deadlines that already have a ◎ block (by title or description), and skips past-due ones", () => {
    const events = [
      ev("blk", local(17, 14), local(17, 14, 50), { title: "◎ CS101 essay", createdByNorthstar: true }),
      ev("blk2", local(17, 15), local(17, 15, 50), { title: "◎ Focus", description: "Northstar focus block for Robotics demo (due Fri)", createdByNorthstar: true }),
      ev("notours", local(17, 16), local(17, 16, 50), { title: "Lab report" }), // same words but not a Northstar block
    ];
    expect(hasExistingBlock(dl("CS101 essay", local(20, 17), 60), events)).toBe(true);
    expect(hasExistingBlock(dl("Robotics demo", local(20, 17), 60), events)).toBe(true);
    expect(hasExistingBlock(dl("Lab report", local(20, 17), 60), events)).toBe(false);
    const blocks = plan(
      [dl("CS101 essay", local(20, 17), 60), dl("Robotics demo", local(20, 17), 60), dl("Lab report", local(20, 17), 50), dl("Old thing", local(15, 17), 50)],
      events,
    );
    expect(blocks.map((b) => b.deadlineTitle)).toEqual(["Lab report"]);
  });

  it("schedules the nearest deadline first and dedupes by title", () => {
    const blocks = plan([
      dl("Later essay", local(28, 17), 50),
      dl("Sooner quiz", local(19, 17), 50),
      dl("sooner quiz", local(19, 17), 50),
    ]);
    expect(blocks.map((b) => [b.deadlineTitle, hm(b.start)])).toEqual([
      ["Sooner quiz", "16 14:00"],
      ["Later essay", "16 15:00"],
    ]);
  });

  it("all-day events block the whole day", () => {
    const events = [ev("conf", local(16, 0), local(17, 0), { allDay: true, title: "Career fair" })];
    const blocks = plan([dl("Essay", local(22, 17), 50)], events);
    expect(hm(blocks[0].start)).toBe("17 14:00");
  });

  it("starts no earlier than now rounded up to 10 minutes", () => {
    const now = new Date(2026, 10, 16, 14, 23, 0, 0);
    const [first] = plan([dl("Essay", local(20, 17), 50)], [], now);
    expect(hm(first.start)).toBe("16 14:30");
  });

  it("truncates long titles to fit 60 chars and keeps the ◎ prefix", () => {
    const long = "A".repeat(80);
    expect(blockTitle(long).length).toBeLessThanOrEqual(60);
    expect(blockTitle(long).startsWith("◎ ")).toBe(true);
    expect(blockTitle("  Short  ")).toBe("◎ Short");
  });
});

describe("parseFocusWindow", () => {
  it.each([
    ["Best focus hours: 2–5pm", 14, 17],
    ["focus 2-5pm", 14, 17],
    ["I do my best focus work from 2 to 5 pm", 14, 17],
    ["focus: 14:00–17:00", 14, 17],
    ["Deep work 9-11am", 9, 11],
    ["focus 10–12pm", 10, 12],
    ["Lab is Tuesdays 10-12.\nBest focus: 7pm to 10pm", 19, 22],
    ["focus 2-5", 14, 17],
  ])("parses %j", (text, s, e) => {
    expect(parseFocusWindow(text)).toEqual({ startHour: s, endHour: e });
  });
  it("returns undefined when there is no range", () => {
    expect(parseFocusWindow("I like mornings")).toBeUndefined();
    expect(parseFocusWindow("")).toBeUndefined();
  });
});

// ---- routes (MOCK=1, memory mocked, only proposal + calendar routes registered) ----
describe("calendar routes (MOCK)", () => {
  let app: Awaited<ReturnType<typeof import("fastify").default>>;
  let store: typeof import("../src/store.js");
  const memoryCalls: { path: string; body: any }[] = [];

  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const pathName = new URL(String(url)).pathname;
        memoryCalls.push({ path: pathName, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (pathName === "/context") {
          return new Response(JSON.stringify({ snippets: [], knowledge: [{ file: "routines.md", content: "# Routines\nBest focus hours: 2–5pm\nLab Tuesdays 10-12" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    store = await import("../src/store.js");
    const { proposalRoutes } = await import("../src/proposals.js");
    const { calendarRoutes } = await import("../src/calendar/routes.js");
    const Fastify = (await import("fastify")).default;
    app = Fastify({ logger: false });
    await app.register(proposalRoutes);
    await app.register(calendarRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns [] from /schedule/plan when there is no triage yet", async () => {
    store.resetCache();
    store.resetProposals();
    const res = await app.inject({ method: "POST", url: "/schedule/plan" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(res.headers["x-northstar-note"]).toMatch(/no triage/);
  });

  it("plans create_event proposals in the 2-5pm window from memory, and approving one adds a ◎ event", async () => {
    store.resetCache();
    store.resetProposals();
    const now = new Date();
    const due = new Date(now.getTime() + 5 * 86_400_000);
    const triagedEmail = (emailId: string, deadlines: Deadline[]) => ({
      emailId, from: "Prof. Lee", subject: "Essay", receivedAt: now.toISOString(), snippet: "", bucket: "needsYou" as const,
      urgency: 2 as const, senderRole: "prof" as const, deadlines, asks: [], why: "",
    });
    store.updateCache({
      events: [ev("existing", new Date(now.getTime() + 86_400_000), new Date(now.getTime() + 86_400_000 + 3_600_000))],
      triage: {
        needsYou: [triagedEmail("e1", [{ title: "CS101 essay", dueAt: due.toISOString(), effortMinutes: 100 }])],
        fyi: [triagedEmail("e2", [{ title: "cs101 essay", dueAt: due.toISOString(), effortMinutes: 100 }, { title: "Old", dueAt: new Date(now.getTime() - 1000).toISOString(), effortMinutes: 30 }])],
        ignored: 0,
      },
    });

    const res = await app.inject({ method: "POST", url: "/schedule/plan" });
    expect(res.statusCode).toBe(200);
    const proposals = res.json() as any[];
    expect(proposals).toHaveLength(2); // 100 min → 50 + 50; the duplicate title and past-due deadline are ignored
    for (const p of proposals) {
      expect(p.type).toBe("create_event");
      expect(p.status).toBe("pending");
      expect(p.title).toBe("◎ CS101 essay");
      expect(p.title.length).toBeLessThanOrEqual(60);
      expect(p.why).toMatch(/2pm–5pm is your best focus window per routines\.md/);
      expect(p.urgency).toBe(2);
      expect(p.dueAt).toBe(due.toISOString());
      const b = p.payload.block as PlannedBlock;
      expect(b.minutes).toBe(50);
      const s = new Date(b.start);
      const e = new Date(b.end);
      expect(s.getHours()).toBeGreaterThanOrEqual(14);
      expect(e.getHours() * 60 + e.getMinutes()).toBeLessThanOrEqual(17 * 60);
    }
    expect(memoryCalls.some((c) => c.path === "/context" && c.body.query === "routines best focus hours")).toBe(true);

    // Re-planning replaces pending create_event proposals instead of stacking them.
    const again = await app.inject({ method: "POST", url: "/schedule/plan" });
    expect((await app.inject({ method: "GET", url: "/proposals?status=pending" })).json()).toHaveLength(2);
    expect(again.json()).toHaveLength(2);

    // Approve the first one → mock event in the cache, memory observation posted.
    const first = again.json()[0];
    memoryCalls.length = 0;
    const approved = await app.inject({ method: "POST", url: `/proposals/${first.id}/approve` });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("done");
    expect(approved.json().payload.eventId).toMatch(/^mock-/);
    const created = store.getCache().events.find((x) => x.id === approved.json().payload.eventId)!;
    expect(created).toBeDefined();
    expect(created.createdByNorthstar).toBe(true);
    expect(created.title).toBe("◎ CS101 essay");
    expect(created.start).toBe(first.payload.block.start);
    const posted = memoryCalls.find((c) => c.path === "/events");
    expect(posted?.body.source).toBe("calendar");
    expect(posted?.body.kind).toBe("observation");
    expect(posted?.body.text).toMatch(/^Scheduled '◎ CS101 essay' .* for CS101 essay$/);
    expect(posted?.body.tags).toContain("minutes:50");
    expect(posted?.body.refs.eventId).toBe(created.id);

    // Visible in /calendar/today if it landed today.
    const today = await app.inject({ method: "GET", url: "/calendar/today" });
    expect(Array.isArray(today.json())).toBe(true);
    if (new Date(created.start).toDateString() === new Date().toDateString()) {
      expect(today.json().map((x: CachedEvent) => x.id)).toContain(created.id);
    }

    // A second plan now skips that deadline because a ◎ block exists.
    const third = await app.inject({ method: "POST", url: "/schedule/plan" });
    expect(third.json()).toEqual([]);
  });

  it("GET /calendar/free lists daytime gaps", async () => {
    const res = await app.inject({ method: "GET", url: "/calendar/free?days=2" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toBe(2);
    for (const s of body.slots) {
      expect(s.minutes).toBeGreaterThanOrEqual(15);
      expect(new Date(s.start).getHours()).toBeGreaterThanOrEqual(9);
    }
  });
});

describe("normalizeGoogleEvent (pure mapping of Google Calendar events)", () => {
  it("maps timed, all-day, cancelled and Northstar events", async () => {
    const { normalizeGoogleEvent } = await import("../src/calendar/sync.js");
    const timed = normalizeGoogleEvent({ id: "e1", summary: "CS lecture", start: { dateTime: "2026-11-16T10:00:00-08:00" }, end: { dateTime: "2026-11-16T11:00:00-08:00" } });
    expect(timed).toEqual({ id: "e1", title: "CS lecture", start: "2026-11-16T18:00:00.000Z", end: "2026-11-16T19:00:00.000Z" });
    // All-day dates are local days (not UTC midnight), so they block the right calendar day.
    const allDay = normalizeGoogleEvent({ id: "e2", summary: "Career fair", start: { date: "2026-11-17" }, end: { date: "2026-11-18" } })!;
    expect(allDay.allDay).toBe(true);
    expect(new Date(allDay.start).getTime()).toBe(new Date(2026, 10, 17).getTime());
    expect(new Date(allDay.end).getTime()).toBe(new Date(2026, 10, 18).getTime());
    expect(normalizeGoogleEvent({ id: "e3", status: "cancelled", start: { dateTime: "2026-11-16T10:00:00Z" }, end: { dateTime: "2026-11-16T11:00:00Z" } })).toBeUndefined();
    expect(normalizeGoogleEvent({ summary: "no id" })).toBeUndefined();
    const range = { start: { dateTime: "2026-11-16T22:00:00Z" }, end: { dateTime: "2026-11-16T22:50:00Z" } };
    expect(normalizeGoogleEvent({ id: "b1", summary: "◎ Essay", ...range })?.createdByNorthstar).toBe(true);
    expect(normalizeGoogleEvent({ id: "b2", summary: "Renamed", extendedProperties: { private: { northstar: "1" } }, ...range })?.createdByNorthstar).toBe(true);
    expect(normalizeGoogleEvent({ id: "b3", summary: "Dentist", ...range })?.createdByNorthstar).toBeUndefined();
  });
});
