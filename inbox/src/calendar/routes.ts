// Calendar routes: GET /calendar/today, GET /calendar/free, POST /schedule/plan, and the
// create_event approve handler. syncCalendar lives in ./sync.ts and is re-exported for app.ts.
import type { FastifyInstance } from "fastify";
import { AUTO_APPROVE_CALENDAR } from "../config.js";
import { contextToText, getContext } from "../memory.js";
import { approveProposal, registerApproveHandler } from "../proposals.js";
import { dropPending, getCache, newProposal, updateCache } from "../store.js";
import { getAuthedClient } from "../google/auth.js";
import { useFixtures } from "../google/status.js";
import type { CachedEvent, Deadline, Proposal } from "../types.js";
import { toCalEvent } from "../types.js";
import { BadCandidate, addCandidate, suggestEvents } from "./agent.js";
import { createCalendarEvent, fmtDateTime } from "./create.js";
import { addDays, atHour, dayKey, eventInterval, freeSlots, minutesBetween, startOfDay } from "./freebusy.js";
import { DAY_END_HOUR, DAY_START_HOUR, DEFAULT_FOCUS_WINDOW, type FocusWindow, type PlannedBlock, parseFocusWindow, planBlocks } from "./planner.js";

export { syncCalendar } from "./sync.js";

/** Events overlapping the local calendar day of `day`, sorted by start. */
export function eventsOnDay(events: CachedEvent[], day: Date): CachedEvent[] {
  const from = startOfDay(day);
  const to = addDays(from, 1);
  return events
    .filter((ev) => {
      const iv = eventInterval(ev);
      return iv && iv.start.getTime() < to.getTime() && iv.end.getTime() > from.getTime();
    })
    .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

/** Deadlines from the cached triage (needsYou + fyi), deduped by title, past-due dropped. */
export function deadlinesFromTriage(now: Date = new Date()): Deadline[] {
  const triage = getCache().triage;
  if (!triage) return [];
  const seen = new Set<string>();
  const out: Deadline[] = [];
  for (const item of [...(triage.needsYou ?? []), ...(triage.fyi ?? [])]) {
    for (const d of item.deadlines ?? []) {
      const key = d.title.trim().toLowerCase();
      const due = new Date(d.dueAt).getTime();
      if (!key || seen.has(key) || !Number.isFinite(due) || due <= now.getTime()) continue;
      seen.add(key);
      out.push({ ...d, emailId: d.emailId ?? item.emailId });
    }
  }
  return out;
}

/** Read "best focus hours" from memory. Returns the window plus which knowledge file (if any) it came from. */
export async function focusWindowFromMemory(): Promise<{ window: FocusWindow; sourceFile?: string }> {
  const ctx = await getContext("routines best focus hours");
  for (const k of ctx.knowledge ?? []) {
    const fw = parseFocusWindow(k.content);
    if (fw) return { window: fw, sourceFile: k.file };
  }
  const fw = parseFocusWindow(contextToText(ctx));
  return fw ? { window: fw } : { window: DEFAULT_FOCUS_WINDOW };
}

function fmtHour(h: number): string {
  const whole = Math.floor(h);
  const h12 = whole % 12 === 0 ? 12 : whole % 12;
  return `${h12}${whole < 12 ? "am" : "pm"}`;
}

export function urgencyFor(dueAt: string, now: Date): 1 | 2 | 3 {
  const days = (new Date(dueAt).getTime() - now.getTime()) / 86_400_000;
  return days <= 2 ? 1 : days <= 5 ? 2 : 3;
}

function whyFor(block: PlannedBlock, fw: FocusWindow, sourceFile: string | undefined): string {
  const due = `Due ${fmtDateTime(block.dueAt)}`;
  const window = `${fmtHour(fw.startHour)}–${fmtHour(fw.endHour)}`;
  const source = sourceFile ? `per ${sourceFile}` : "by default";
  const tail = block.partial ? "; this is what fits, so it may need more time" : "";
  return `${due} and ${window} is your best focus window ${source}${tail}.`;
}

/** Plan blocks for every open deadline and turn them into pending create_event proposals. */
export async function planAndPropose(now: Date = new Date()): Promise<Proposal[]> {
  const deadlines = deadlinesFromTriage(now);
  if (!deadlines.length) return [];
  const { window, sourceFile } = await focusWindowFromMemory();
  const blocks = planBlocks({ deadlines, events: getCache().events, now, focusWindow: window });

  dropPending("create_event");
  const proposals: Proposal[] = [];
  for (const block of blocks) {
    const p = newProposal({
      type: "create_event",
      title: block.title,
      why: whyFor(block, window, sourceFile),
      urgency: urgencyFor(block.dueAt, now),
      dueAt: block.dueAt,
      payload: { block },
    });
    proposals.push(AUTO_APPROVE_CALENDAR ? (await approveProposal(p.id)) ?? p : p);
  }
  return proposals;
}

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  registerApproveHandler("create_event", async (p) => createCalendarEvent(p.payload?.block as PlannedBlock));

  app.get("/calendar/today", async () => {
    const now = new Date();
    return eventsOnDay(getCache().events, now).map(toCalEvent); // contract: CalEvent[] (app/src/renderer/src/api.ts getToday)
  });

  // ?from=ISO&to=ISO (any window up to ~6 weeks, for day/week/month views) or ?days=N from today.
  app.get<{ Querystring: { days?: string; from?: string; to?: string } }>("/calendar/range", async (req) => {
    let from: Date, to: Date;
    if (req.query.from && req.query.to && !Number.isNaN(Date.parse(req.query.from)) && !Number.isNaN(Date.parse(req.query.to))) {
      from = new Date(req.query.from); to = new Date(req.query.to);
      if (+to - +from > 45 * 864e5) to = new Date(+from + 45 * 864e5);
    } else {
      const days = Math.min(45, Math.max(1, Number(req.query.days ?? 7) || 7));
      from = startOfDay(new Date()); to = addDays(from, days);
    }
    const events = getCache().events
      .filter((ev) => { const iv = eventInterval(ev); return iv && iv.start < to && iv.end > from; })
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((ev) => ({ ...ev, ...toCalEvent(ev) })); // CalEvent plus location / description / allDay
    return { from: from.toISOString(), to: to.toISOString(), events };
  });

  // Edit (move / rename / retime) an event the user changed in the calendar UI. The user's own edit is the approval.
  type EventPatch = { title?: string; start?: string; end?: string; location?: string; details?: string };
  app.patch<{ Params: { id: string }; Body: EventPatch | null }>("/calendar/events/:id", async (req, reply) => {
    const id = req.params.id, b = req.body ?? {};
    const cur = getCache().events.find((e) => e.id === id);
    if (!cur) return reply.code(404).send({ error: "unknown event" });
    const next: CachedEvent = { ...cur, title: b.title ?? cur.title, start: b.start ?? cur.start, end: b.end ?? cur.end,
      location: b.location ?? cur.location, description: b.details ?? cur.description };
    if (Number.isNaN(Date.parse(next.start)) || Number.isNaN(Date.parse(next.end)) || Date.parse(next.end) <= Date.parse(next.start)) {
      return reply.code(400).send({ error: "end must be after start" });
    }
    if (!useFixtures() && !id.startsWith("mock-")) {
      try {
        const { google } = await import("googleapis");
        const calendar = google.calendar({ version: "v3", auth: await getAuthedClient() });
        await calendar.events.patch({ calendarId: "primary", eventId: id, requestBody: {
          summary: next.title, location: next.location, description: next.description,
          start: { dateTime: next.start }, end: { dateTime: next.end } } });
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    }
    updateCache({ events: getCache().events.map((e) => (e.id === id ? next : e)).sort((a, c) => a.start.localeCompare(c.start)) });
    return { ok: true, event: { ...next, ...toCalEvent(next) } };
  });

  // Delete an event (the UI asks the user to confirm first).
  app.delete<{ Params: { id: string } }>("/calendar/events/:id", async (req, reply) => {
    const id = req.params.id;
    if (!getCache().events.some((e) => e.id === id)) return reply.code(404).send({ error: "unknown event" });
    if (!useFixtures() && !id.startsWith("mock-")) {
      try {
        const { google } = await import("googleapis");
        const calendar = google.calendar({ version: "v3", auth: await getAuthedClient() });
        await calendar.events.delete({ calendarId: "primary", eventId: id });
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    }
    updateCache({ events: getCache().events.filter((e) => e.id !== id) });
    return { ok: true };
  });

  app.get<{ Querystring: { days?: string } }>("/calendar/free", async (req) => {
    const days = Math.min(30, Math.max(1, Number(req.query.days ?? 7) || 7));
    const now = new Date();
    const slots: { start: string; end: string; minutes: number }[] = [];
    for (let i = 0; i < days; i++) {
      const day = addDays(startOfDay(now), i);
      const from = i === 0 ? new Date(Math.max(now.getTime(), atHour(day, DAY_START_HOUR).getTime())) : atHour(day, DAY_START_HOUR);
      const to = atHour(day, DAY_END_HOUR);
      if (to.getTime() <= from.getTime()) continue;
      for (const s of freeSlots(getCache().events, from, to, { minMinutes: 15 })) {
        slots.push({ start: s.start.toISOString(), end: s.end.toISOString(), minutes: minutesBetween(s.start, s.end) });
      }
    }
    return { from: dayKey(now), days, slots };
  });

  // "Add to calendar" box. Suggest only reads; nothing is added until the user picks one.
  app.post<{ Body: { query?: unknown } | null }>("/calendar/suggest", async (req, reply) => {
    const query = req.body?.query;
    if (typeof query !== "string" || !query.trim()) return reply.code(400).send({ error: "query is required" });
    return suggestEvents(query.trim().slice(0, 500));
  });

  // Called only after the user clicked Add on a candidate: that click is the approval.
  app.post<{ Body: { candidate?: unknown } | null }>("/calendar/add", async (req, reply) => {
    try {
      return await addCandidate(req.body?.candidate);
    } catch (err) {
      const bad = err instanceof BadCandidate;
      // A non-2xx makes the UI fall back to a prefilled Google Calendar page, so the user is never stuck.
      return reply.code(bad ? 400 : 502).send({ ok: false, error: (err as Error).message });
    }
  });

  app.post("/schedule/plan", async (_req, reply) => {
    const proposals = await planAndPropose();
    if (!getCache().triage) reply.header("x-northstar-note", "no triage yet; run POST /sync first");
    return proposals;
  });
}
