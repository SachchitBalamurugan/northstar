// Create one focus-block event (the approve handler for `create_event` proposals).
import { randomUUID } from "node:crypto";
import { MOCK } from "../config.js";
import { getAuthedClient } from "../google/auth.js";
import { postEvent } from "../memory.js";
import { getCache, updateCache } from "../store.js";
import type { CachedEvent } from "../types.js";
import { dayKey } from "./freebusy.js";
import type { PlannedBlock } from "./planner.js";

export interface CreateOpts {
  /** Override config MOCK (tests). */
  mock?: boolean;
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function blockDescription(block: PlannedBlock): string {
  return `Northstar focus block for ${block.deadlineTitle} (due ${fmtDateTime(block.dueAt)})`;
}

export async function createCalendarEvent(block: PlannedBlock, opts: CreateOpts = {}): Promise<{ eventId: string }> {
  if (!block?.start || !block?.end || !block?.title) throw new Error("create_event payload needs { block: { title, start, end } }");
  const mock = opts.mock ?? MOCK;
  const description = blockDescription(block);

  let eventId: string;
  if (mock) {
    eventId = `mock-${randomUUID()}`;
  } else {
    const { google } = await import("googleapis"); // lazy: the full googleapis bundle is slow to load
    const calendar = google.calendar({ version: "v3", auth: await getAuthedClient() });
    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: block.title,
        description,
        start: { dateTime: block.start },
        end: { dateTime: block.end },
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
        extendedProperties: { private: { northstar: "1" } },
      },
    });
    eventId = res.data.id ?? `gcal-${randomUUID()}`;
  }

  // Show it in GET /calendar/today right away (the next sync keeps Northstar blocks anyway).
  const ev: CachedEvent = { id: eventId, title: block.title, start: block.start, end: block.end, description, createdByNorthstar: true };
  const events = [...getCache().events.filter((e) => e.id !== eventId), ev].sort((a, b) => a.start.localeCompare(b.start));
  updateCache({ events });

  await postEvent({
    source: "calendar",
    kind: "observation",
    text: `Scheduled '${block.title}' ${fmtDateTime(block.start)}–${fmtTime(block.end)} for ${block.deadlineTitle}`,
    tags: ["block", `day:${dayKey(new Date(block.start))}`, `minutes:${block.minutes}`],
    refs: { eventId },
  });
  return { eventId };
}
