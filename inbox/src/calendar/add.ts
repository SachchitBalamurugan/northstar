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

interface Candidate { title?: string; start?: string; end?: string; details?: string; location?: string; sourceLabel?: string }

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

    const ev: CachedEvent = { id: eventId, title: c.title, start: c.start, end: c.end, description, createdByNorthstar: true };
    updateCache({ events: [...getCache().events.filter((e) => e.id !== eventId), ev].sort((a, b) => a.start.localeCompare(b.start)) });
    await postEvent({
      source: "calendar", kind: "observation",
      text: `User approved adding '${c.title}' ${fmtDateTime(c.start)}–${fmtTime(c.end)} to their calendar`,
      tags: ["calendar-agent"], refs: { eventId },
    }).catch(() => undefined);
    return { ok: true, eventId, htmlLink, mock: MOCK };
  });

  app.get<{ Querystring: { days?: string } }>("/calendar/range", async (req) => {
    const days = Math.min(31, Math.max(1, Number(req.query.days ?? 7) || 7));
    const from = startOfDay(new Date()), to = addDays(from, days);
    const events = getCache().events
      .filter((ev) => { const iv = eventInterval(ev); return iv && iv.start < to && iv.end > from; })
      .sort((a, b) => a.start.localeCompare(b.start));
    return { from: from.toISOString(), days, events };
  });
}
