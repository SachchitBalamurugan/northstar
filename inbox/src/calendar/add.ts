// Calendar agent endpoints used by the UI's "Add to calendar" chat box (see contracts/types.ts EventCandidate).
//   POST /calendar/add {candidate}  → writes ONE user-approved event to Google Calendar (mock: cache only)
//   GET  /calendar/range?days=7     → events from today through N days, for the Workflow → Calendar week view
// The UI only calls /calendar/add after the user clicks "Add" on a specific candidate.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { MOCK } from "../config.js";
import { getAuthedClient, isAuthed } from "../google/auth.js";
import { postEvent } from "../memory.js";
import { getCache, updateCache } from "../store.js";
import type { CachedEvent } from "../types.js";
import { fmtDateTime, fmtTime } from "./create.js";
import { addDays, eventInterval, startOfDay } from "./freebusy.js";

interface Candidate { title?: string; start?: string; end?: string; details?: string; location?: string; sourceLabel?: string; source?: string }

export async function calendarAgentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { candidate?: Candidate } | null }>("/calendar/add", async (req, reply) => {
    const c = req.body?.candidate;
    if (!c?.title || !c.start || !c.end) return reply.code(400).send({ error: "candidate needs { title, start, end }" });
    if (Number.isNaN(Date.parse(c.start)) || Number.isNaN(Date.parse(c.end)) || Date.parse(c.end) <= Date.parse(c.start)) {
      return reply.code(400).send({ error: "invalid start/end" });
    }
    if (!MOCK && !isAuthed()) return reply.code(401).send({ error: "Google not connected. Open /auth/url first." });

    const description = [c.details, c.sourceLabel ? `Added by Northstar (${c.sourceLabel})` : "Added by Northstar"].filter(Boolean).join("\n\n");
    let eventId: string, htmlLink: string | undefined;
    if (MOCK) {
      eventId = `mock-${randomUUID()}`;
    } else {
      const { google } = await import("googleapis");
      const calendar = google.calendar({ version: "v3", auth: await getAuthedClient() });
      const res = await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: c.title, description, location: c.location,
          start: { dateTime: c.start }, end: { dateTime: c.end },
          reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
          extendedProperties: { private: { northstar: "1" } },
        },
      });
      eventId = res.data.id ?? `gcal-${randomUUID()}`;
      htmlLink = res.data.htmlLink ?? undefined;
    }

    // Events the user typed into the calendar themselves belong to "My calendar"; agent-suggested ones are Northstar blocks.
    const ev: CachedEvent = { id: eventId, title: c.title, start: c.start, end: c.end, description, location: c.location, createdByNorthstar: c.source !== "user" };
    updateCache({ events: [...getCache().events.filter((e) => e.id !== eventId), ev].sort((a, b) => a.start.localeCompare(b.start)) });
    await postEvent({
      source: "calendar", kind: "observation",
      text: `User approved adding '${c.title}' ${fmtDateTime(c.start)}–${fmtTime(c.end)} to their calendar`,
      tags: ["calendar-agent"], refs: { eventId },
    }).catch(() => undefined);
    return { ok: true, eventId, htmlLink, mock: MOCK };
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
      .sort((a, b) => a.start.localeCompare(b.start));
    return { from: from.toISOString(), to: to.toISOString(), events };
  });

  // Edit (move / rename / retime) an event the user changed in the calendar UI.
  app.patch<{ Params: { id: string }; Body: Candidate | null }>("/calendar/events/:id", async (req, reply) => {
    const id = req.params.id, b = req.body ?? {};
    const cur = getCache().events.find((e) => e.id === id);
    if (!cur) return reply.code(404).send({ error: "unknown event" });
    const next = { ...cur, title: b.title ?? cur.title, start: b.start ?? cur.start, end: b.end ?? cur.end,
      location: b.location ?? cur.location, description: b.details ?? cur.description };
    if (Date.parse(next.end) <= Date.parse(next.start)) return reply.code(400).send({ error: "end must be after start" });
    if (!MOCK && !id.startsWith("mock-")) {
      if (!isAuthed()) return reply.code(401).send({ error: "Google not connected" });
      const { google } = await import("googleapis");
      const calendar = google.calendar({ version: "v3", auth: await getAuthedClient() });
      await calendar.events.patch({ calendarId: "primary", eventId: id, requestBody: {
        summary: next.title, location: next.location, description: next.description,
        start: { dateTime: next.start }, end: { dateTime: next.end } } });
    }
    updateCache({ events: getCache().events.map((e) => (e.id === id ? next : e)).sort((a, c) => a.start.localeCompare(c.start)) });
    return { ok: true, event: next };
  });

  // Delete an event (the UI asks the user to confirm first).
  app.delete<{ Params: { id: string } }>("/calendar/events/:id", async (req, reply) => {
    const id = req.params.id;
    if (!getCache().events.some((e) => e.id === id)) return reply.code(404).send({ error: "unknown event" });
    if (!MOCK && !id.startsWith("mock-")) {
      if (!isAuthed()) return reply.code(401).send({ error: "Google not connected" });
      const { google } = await import("googleapis");
      const calendar = google.calendar({ version: "v3", auth: await getAuthedClient() });
      await calendar.events.delete({ calendarId: "primary", eventId: id });
    }
    updateCache({ events: getCache().events.filter((e) => e.id !== id) });
    return { ok: true };
  });
}
