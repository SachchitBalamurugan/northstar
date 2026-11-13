// Create one focus-block event (the approve handler for `create_event` proposals).
import { randomUUID } from "node:crypto";
import { getAuthedClient } from "../google/auth.js";
import { useFixtures } from "../google/status.js";
import { postEvent } from "../memory.js";
import { getCache, updateCache } from "../store.js";
import type { CachedEvent } from "../types.js";
import { dayKey } from "./freebusy.js";
import type { PlannedBlock } from "./planner.js";

export interface CreateOpts {
  /** Override the live mode check (tests). */
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

export interface NewEvent {
  title: string;
  start: string; // ISO
  end: string; // ISO
  description?: string;
  location?: string;
  /** True for ◎ focus blocks Northstar planned (tagged in Google so later syncs recognise them). */
  northstarBlock?: boolean;
}

/** A prefilled "new event" page on Google Calendar. Used as the link in demo mode, where nothing real is created. */
export function calendarTemplateUrl(ev: NewEvent): string {
  const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const q = new URLSearchParams({ action: "TEMPLATE", text: ev.title, dates: `${stamp(ev.start)}/${stamp(ev.end)}` });
  if (ev.description) q.set("details", ev.description);
  if (ev.location) q.set("location", ev.location);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

/**
 * Insert one event on the primary calendar and mirror it into the cache. This is the ONLY place that writes to
 * Google Calendar. Callers: the create_event approve handler and POST /calendar/add (the user's "Add" click).
 * Demo mode makes a "mock-" id and never calls Google.
 */
export async function insertEvent(ev: NewEvent, opts: CreateOpts = {}): Promise<{ eventId: string; htmlLink: string; mock: boolean }> {
  const mock = opts.mock ?? useFixtures();
  let eventId: string;
  let htmlLink: string;
  if (mock) {
    eventId = `mock-${randomUUID()}`;
    htmlLink = calendarTemplateUrl(ev);
  } else {
    const { google } = await import("googleapis"); // lazy: the full googleapis bundle is slow to load
    const calendar = google.calendar({ version: "v3", auth: await getAuthedClient() });
    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: ev.title,
        ...(ev.description ? { description: ev.description } : {}),
        ...(ev.location ? { location: ev.location } : {}),
        start: { dateTime: ev.start },
        end: { dateTime: ev.end },
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
        extendedProperties: { private: ev.northstarBlock ? { northstar: "1" } : { northstarAdded: "1" } },
      },
    });
    eventId = res.data.id ?? `gcal-${randomUUID()}`;
    htmlLink = res.data.htmlLink ?? "";
  }

  // Show it in GET /calendar/today right away (the next sync reads it back from Google anyway).
  const cached: CachedEvent = { id: eventId, title: ev.title, start: ev.start, end: ev.end };
  if (ev.description) cached.description = ev.description;
  if (ev.location) cached.location = ev.location;
  if (ev.northstarBlock) cached.createdByNorthstar = true;
  const events = [...getCache().events.filter((e) => e.id !== eventId), cached].sort((a, b) => a.start.localeCompare(b.start));
  updateCache({ events });
  return { eventId, htmlLink, mock };
}

export async function createCalendarEvent(block: PlannedBlock, opts: CreateOpts = {}): Promise<{ eventId: string }> {
  if (!block?.start || !block?.end || !block?.title) throw new Error("create_event payload needs { block: { title, start, end } }");
  const { eventId } = await insertEvent(
    { title: block.title, start: block.start, end: block.end, description: blockDescription(block), northstarBlock: true },
    opts,
  );

  await postEvent({
    source: "calendar",
    kind: "observation",
    text: `Scheduled '${block.title}' ${fmtDateTime(block.start)}–${fmtTime(block.end)} for ${block.deadlineTitle}`,
    tags: ["block", `day:${dayKey(new Date(block.start))}`, `minutes:${block.minutes}`],
    refs: { eventId },
  });
  return { eventId };
}
