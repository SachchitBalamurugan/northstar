// Calendar sync: the next 14 days of events into the cache (fixtures in MOCK mode).
import fs from "node:fs";
import path from "node:path";
import type { calendar_v3 } from "googleapis";
import { FIXTURES_DIR } from "../config.js";
import { ensureCacheSource, useFixtures } from "../google/status.js";
import { loadFixture } from "../fixtures.js";
import { getAuthedClient } from "../google/auth.js";
import { getCache, updateCache } from "../store.js";
import type { CachedEvent } from "../types.js";
import { BLOCK_PREFIX } from "./planner.js";

const EVENTS_FIXTURE = "events.json";
const SYNC_DAYS = 14;

const byStart = (a: CachedEvent, b: CachedEvent) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id);

/**
 * Demo mode: replace the cached events with the fixture, keeping events added in this demo (ids start "mock-")
 * and Northstar blocks, since no real calendar remembers them.
 */
function mergeKeepingBlocks(fresh: CachedEvent[]): CachedEvent[] {
  const ids = new Set(fresh.map((e) => e.id));
  const kept = getCache().events.filter((e) => (e.createdByNorthstar || e.id.startsWith("mock-")) && !ids.has(e.id));
  return [...fresh, ...kept].sort(byStart);
}

export async function syncCalendar(): Promise<{ events: number }> {
  const fixtures = useFixtures();
  ensureCacheSource(fixtures ? "fixtures" : "google");
  const fresh = fixtures ? syncMock() : await syncGoogle();
  if (!fresh) return { events: 0 };
  // Real mode: Google Calendar is the truth, so an event the user deleted there disappears here too.
  const events = fixtures ? mergeKeepingBlocks(fresh) : [...fresh].sort(byStart);
  updateCache({ events });
  return { events: events.length };
}

function syncMock(): CachedEvent[] | undefined {
  const file = path.join(FIXTURES_DIR, EVENTS_FIXTURE);
  if (!fs.existsSync(file)) {
    console.warn(`[calendar] MOCK: fixture ${file} not found yet; keeping cached events`);
    return undefined;
  }
  try {
    return loadFixture<CachedEvent>(EVENTS_FIXTURE).map((e) => ({
      ...e,
      createdByNorthstar: e.createdByNorthstar ?? e.title.startsWith(BLOCK_PREFIX),
    }));
  } catch (err) {
    console.warn(`[calendar] MOCK: could not read ${file}: ${(err as Error).message}`);
    return undefined;
  }
}

/** Local midnight for a Google all-day date ("YYYY-MM-DD") as ISO. */
function localDateIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toISOString();
}

export function normalizeGoogleEvent(ev: calendar_v3.Schema$Event): CachedEvent | undefined {
  if (!ev.id || ev.status === "cancelled") return undefined;
  const allDay = !ev.start?.dateTime && !!ev.start?.date;
  const start = ev.start?.dateTime ?? (ev.start?.date ? localDateIso(ev.start.date) : undefined);
  const end = ev.end?.dateTime ?? (ev.end?.date ? localDateIso(ev.end.date) : undefined);
  if (!start || !end) return undefined;
  const title = ev.summary ?? "(no title)";
  const out: CachedEvent = {
    id: ev.id,
    title,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
  if (allDay) out.allDay = true;
  if (ev.location) out.location = ev.location;
  if (ev.description) out.description = ev.description;
  if (title.startsWith(BLOCK_PREFIX) || ev.extendedProperties?.private?.northstar === "1") out.createdByNorthstar = true;
  return out;
}

async function syncGoogle(): Promise<CachedEvent[]> {
  const { google } = await import("googleapis"); // lazy: the full googleapis bundle is slow to load
  const calendar = google.calendar({ version: "v3", auth: await getAuthedClient() });
  const now = new Date();
  // From the start of today, so events earlier today still show in GET /calendar/today.
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const timeMin = dayStart.toISOString();
  const timeMax = new Date(now.getTime() + SYNC_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const out: CachedEvent[] = [];
  let pageToken: string | undefined;
  do {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
    });
    for (const ev of res.data.items ?? []) {
      const n = normalizeGoogleEvent(ev);
      if (n) out.push(n);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/** Live fetch of primary-calendar events in [from, to) (real mode only; throws on Google errors). */
export async function fetchGoogleRange(from: Date, to: Date): Promise<CachedEvent[]> {
  const { google } = await import("googleapis");
  const calendar = google.calendar({ version: "v3", auth: await getAuthedClient() });
  const out: CachedEvent[] = [];
  let pageToken: string | undefined;
  do {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 2500,
      pageToken,
    });
    for (const ev of res.data.items ?? []) {
      const n = normalizeGoogleEvent(ev);
      if (n) out.push(n);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}
