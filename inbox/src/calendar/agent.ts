// Calendar agent behind the Dashboard's "Add to calendar" box (UI: app/src/renderer/src/calendarAgent.ts).
//   suggestEvents(query) -> EventCandidate[]   read-only: searches synced mail, memory (:7701 /context), the calendar
//                                               and pending approvals, and flags conflicts. Never writes anything.
//   addCandidate(c)      -> { ok, eventId, htmlLink }   called only after the user clicked Add (that click is the approval).
import type { EventCandidate } from "../../../contracts/types.js";
import { getContext, postEvent } from "../memory.js";
import { approveProposal } from "../proposals.js";
import { getCache, getProposal, listProposals } from "../store.js";
import type { CachedEmail, CachedEvent } from "../types.js";
import { fmtDateTime, fmtTime, insertEvent } from "./create.js";
import { addDays, atHour, eventInterval, freeSlots, startOfDay } from "./freebusy.js";

const H = 36e5;
const MIN = 6e4;
const MAX_CANDIDATES = 4; // the UI shows at most 4
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const STOP = new Set(
  (
    "a an the to at on in for of and my me i need go going have with next this tomorrow today tonight pm am event meeting min mins minutes hour hours " +
    "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun morning afternoon evening noon add schedule put calendar"
  ).split(" "),
);

/** Parse a date/time out of natural text, relative to `now`. Same rules as the UI's local fallback. */
export function parseWhen(text: string, now: Date = new Date()): { start: Date | null; minutes: number; hasTime: boolean } {
  const t = text.toLowerCase();
  let day: Date | null = null;
  const base = startOfDay(now);

  if (/\b(today|tonight)\b/.test(t)) day = new Date(base);
  else if (/\btomorrow\b/.test(t)) day = addDays(base, 1);
  else {
    const wd = DAYS.findIndex((d) => new RegExp(`\\b(next\\s+)?${d.slice(0, 3)}(${d.slice(3)})?\\b`).test(t));
    if (wd >= 0) {
      let diff = (wd - base.getDay() + 7) % 7;
      if (diff === 0 && /\bnext\b/.test(t)) diff = 7;
      day = addDays(base, diff);
    }
    const md = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
    const slash = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    const set = (month: number, date: number) => {
      const d = new Date(base);
      d.setMonth(month, date);
      if (d < base) d.setFullYear(d.getFullYear() + 1);
      return d;
    };
    if (md) day = set(MONTHS.indexOf(md[1]), Number(md[2]));
    else if (slash && Number(slash[1]) <= 12 && Number(slash[2]) <= 31) day = set(Number(slash[1]) - 1, Number(slash[2]));
  }

  let hour: number | null = null;
  let minute = 0;
  const tm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (tm && Number(tm[1]) <= 23 && Number(tm[2] ?? 0) <= 59) {
    hour = Number(tm[1]);
    minute = Number(tm[2] ?? 0);
    if (tm[3] === "pm" && hour < 12) hour += 12;
    if (tm[3] === "am" && hour === 12) hour = 0;
  } else if (/\bnoon\b/.test(t)) hour = 12;
  else if (/\bmorning\b/.test(t)) hour = 10;
  else if (/\bafternoon\b/.test(t)) hour = 14;
  else if (/\b(evening|tonight)\b/.test(t)) hour = 18;

  const dur = t.match(/\b(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)\b/);
  const rawMinutes = dur ? Math.round(Number(dur[1]) * (/^h/.test(dur[2]) ? 60 : 1)) : 60;
  const minutes = Math.min(12 * 60, Math.max(5, rawMinutes));

  if (!day && hour === null) return { start: null, minutes, hasTime: false };
  const start = new Date(day ?? base);
  start.setHours(hour ?? 10, hour === null ? 0 : minute, 0, 0);
  if (start.getTime() < now.getTime()) {
    // A bare time or weekday that already passed today means the next occurrence.
    if (!day) start.setDate(start.getDate() + 1);
    else if (day.getTime() === base.getTime() && !/today|tonight/.test(t)) start.setDate(start.getDate() + 7);
  }
  return { start, minutes, hasTime: hour !== null };
}

/** Strip date/time words to get a clean event title. */
export function cleanTitle(text: string): string {
  const t = text
    .replace(/\b(i\s+)?(need|have|want)\s+to\s+(go\s+to|attend|add)\s+/i, "")
    .replace(/\b(add|schedule|put)\s+/i, "")
    .replace(/\b(next\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/gi, "")
    .replace(/\b(today|tomorrow|tonight|this|morning|afternoon|evening|noon)\b/gi, "")
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, "")
    .replace(/\b\d{1,2}:\d{2}\b/g, "")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/gi, "")
    .replace(/\b\d{1,2}\/\d{1,2}\b/g, "")
    .replace(/\b\d+(\.\d+)?\s*(h|hr|hrs|hours?|m|mins?|minutes)\b/gi, "")
    .replace(/\b(to|in)\s+(my\s+)?calendar\b/gi, "")
    .replace(/(\s+(at|on|for|from|to)\b)+\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return t ? (t[0].toUpperCase() + t.slice(1)).slice(0, 120) : "New event";
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
function overlap(q: string[], text: string): number {
  const bw = new Set(words(text));
  return q.filter((w) => bw.has(w)).length;
}
const iso = (d: Date) => d.toISOString();
const plain = (title: string) => title.replace(/^◎\s*/, "");
const oneLine = (s: string, max = 240) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** "Overlaps <title>" for the first cached event that clashes with [start, end), ignoring `ignoreId`. */
export function conflictFor(events: CachedEvent[], start: Date, end: Date, ignoreId?: string): string | undefined {
  for (const ev of events) {
    if (ev.id === ignoreId || ev.allDay) continue; // an all-day marker ("Reading week") is not a clash
    const iv = eventInterval(ev);
    if (iv && start.getTime() < iv.end.getTime() && end.getTime() > iv.start.getTime()) return `Overlaps ${plain(ev.title)}`;
  }
  return undefined;
}

/** Earliest upcoming deadline that triage pulled out of each email. */
function deadlinesByEmail(now: Date): Map<string, string> {
  const out = new Map<string, string>();
  const triage = getCache().triage;
  for (const item of [...(triage?.needsYou ?? []), ...(triage?.fyi ?? [])]) {
    const due = (item.deadlines ?? [])
      .map((d) => d.dueAt)
      .filter((d) => new Date(d).getTime() > now.getTime())
      .sort()[0];
    if (due) out.set(item.emailId, due);
  }
  return out;
}

/** Search synced mail, memory, the calendar and pending approvals for events matching what the user typed. */
export async function suggestEvents(query: string, now: Date = new Date()): Promise<EventCandidate[]> {
  const cache = getCache();
  const q = words(query);
  const typed = parseWhen(query, now);
  const { start, minutes } = typed;
  const title = cleanTitle(query);
  const out: EventCandidate[] = [];
  const span = (s: Date) => ({ start: iso(s), end: iso(new Date(s.getTime() + minutes * MIN)) });

  // 1) What the user typed, with any date we could parse.
  let mine: EventCandidate | undefined;
  if (start) {
    mine = { id: "you", title, ...span(start), source: "you", sourceLabel: "From what you typed", confidence: 0.9 };
    out.push(mine);
  }

  // 2) Related emails. A time written in the email wins; otherwise the deadline triage found, minus two hours.
  const dueBy = deadlinesByEmail(now);
  const mails = cache.emails
    .map((m) => ({ m, score: overlap(q, `${m.subject} ${m.snippet} ${m.from}`) * 2 + overlap(q, m.bodyText.slice(0, 1500)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.receivedAt.localeCompare(a.m.receivedAt))
    .slice(0, 3);
  for (const { m, score } of mails) {
    if (mine) {
      // The user gave a time, so the email is supporting detail for their event, not a second event.
      if (!mine.details) {
        mine.sourceLabel = `From what you typed · matches email from ${m.from}`;
        mine.details = oneLine(`${m.from}: ${m.subject}. ${m.snippet}`);
        mine.confidence = Math.min(0.97, mine.confidence + 0.05);
      }
      continue;
    }
    const when = whenFromEmail(m, dueBy.get(m.id), now);
    if (!when) continue;
    out.push({
      id: `mail-${m.id}`,
      title: m.subject.replace(/^((re|fwd?):\s*)+/i, "").slice(0, 120) || title,
      ...span(when),
      details: oneLine(`${m.from}: ${m.snippet}`),
      source: "email",
      sourceLabel: `Email from ${m.from}`,
      confidence: Math.min(0.85, 0.45 + score * 0.08),
    });
  }

  // 3) Already on the calendar? Show it so the user does not add it twice.
  for (const ev of cache.events) {
    const iv = eventInterval(ev);
    if (!iv || iv.end.getTime() < now.getTime() || !overlap(q, `${ev.title} ${ev.location ?? ""}`)) continue;
    out.push({
      id: `cal-${ev.id}`,
      title: plain(ev.title),
      start: iso(iv.start),
      end: iso(iv.end),
      ...(ev.location ? { location: ev.location } : {}),
      ...(ev.description ? { details: oneLine(ev.description) } : {}),
      source: "calendar",
      sourceLabel: `Already on your calendar, ${fmtDateTime(ev.start)}`,
      confidence: 0.6,
    });
  }

  // 4) Pending calendar approvals that match.
  for (const p of listProposals("pending")) {
    if (p.type !== "create_event" || !p.payload?.start || !p.payload?.end) continue;
    if (!overlap(q, `${p.title} ${p.why}`)) continue;
    out.push({
      id: `prop-${p.id}`,
      title: plain(p.title),
      start: p.payload.start,
      end: p.payload.end,
      details: p.why,
      source: "approval",
      sourceLabel: "Already suggested by Northstar",
      confidence: 0.7,
    });
  }

  // 5) Memory: knowledge files (classes.md, routines.md, ...) and remembered notes that mention the query.
  if (q.length) {
    const ctx = await getContext(query, 6); // fail-soft: empty when memory is offline
    const notes = [
      ...ctx.knowledge.map((k) => ({ label: `From ${k.file}`, id: `kn-${k.file}`, text: k.content })),
      ...ctx.snippets.slice(0, 4).map((s, i) => ({ label: "From your memory", id: `mem-${i}`, text: s.text })),
    ];
    for (const n of notes) {
      const line = n.text.split("\n").find((l) => overlap(q, l) > 0);
      if (!line) continue;
      const when = start ?? parseWhen(line, now).start;
      if (!when) continue;
      if (mine) {
        if (!mine.details) mine.details = oneLine(line.replace(/^[-*#\s]+/, ""));
        continue;
      }
      out.push({
        id: n.id,
        title: oneLine(line.replace(/^[-*#\s]+/, "").replace(/\*\*/g, ""), 60) || title,
        ...span(when),
        details: oneLine(line),
        source: "knowledge",
        sourceLabel: n.label,
        confidence: 0.55,
      });
    }
  }

  // 6) Nothing found and no date: offer the first free hour tomorrow afternoon so there is still one tap.
  if (out.length === 0) {
    const tomorrow = addDays(startOfDay(now), 1);
    const timed = cache.events.filter((e) => !e.allDay); // an all-day marker does not make the day busy
    const free = freeSlots(timed, atHour(tomorrow, 14), atHour(tomorrow, 20), { minMinutes: minutes })[0];
    const s = free?.start ?? atHour(tomorrow, 14);
    out.push({
      id: "you",
      title,
      ...span(s),
      source: "you",
      sourceLabel: `No date found, so this is tomorrow at ${fmtTime(iso(s))}. Edit before adding.`,
      confidence: 0.4,
    });
  }

  // Conflicts against everything synced from the calendar (an event never conflicts with itself).
  for (const c of out) {
    const clash = conflictFor(cache.events, new Date(c.start), new Date(c.end), c.source === "calendar" ? c.id.slice(4) : undefined);
    if (clash) c.conflict = clash;
  }

  // De-dupe by title + start minute; best first.
  const seen = new Set<string>();
  return out
    .sort((a, b) => b.confidence - a.confidence)
    .filter((c) => {
      const k = c.title.toLowerCase() + c.start.slice(0, 16);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_CANDIDATES);
}

function whenFromEmail(m: CachedEmail, dueAt: string | undefined, now: Date): Date | null {
  // Dates in an email are relative to when it was written ("this Thursday at 6pm").
  const written = parseWhen(`${m.subject}. ${m.bodyText.slice(0, 1500)}`, new Date(m.receivedAt));
  if (written.start && written.hasTime && written.start.getTime() > now.getTime()) return written.start;
  if (dueAt) {
    const s = new Date(new Date(dueAt).getTime() - 2 * H);
    s.setMinutes(0, 0, 0);
    if (s.getTime() > now.getTime()) return s;
  }
  return null;
}

// ---------------------------------------------------------------- add

export class BadCandidate extends Error {}

/** Validate the body of POST /calendar/add. Throws BadCandidate with a plain message. */
export function parseCandidate(raw: unknown): EventCandidate {
  const c = (raw ?? {}) as Partial<EventCandidate>;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BadCandidate("candidate is required");
  if (typeof c.title !== "string" || !c.title.trim()) throw new BadCandidate("candidate.title is required");
  const start = new Date(typeof c.start === "string" ? c.start : NaN);
  const end = new Date(typeof c.end === "string" ? c.end : NaN);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new BadCandidate("candidate.start and candidate.end must be ISO dates");
  if (end.getTime() <= start.getTime()) throw new BadCandidate("candidate.end must be after candidate.start");
  if (end.getTime() - start.getTime() > 14 * 24 * H) throw new BadCandidate("candidate is longer than two weeks");
  return {
    id: typeof c.id === "string" ? c.id : "you",
    title: c.title.trim().slice(0, 200),
    start: start.toISOString(),
    end: end.toISOString(),
    ...(typeof c.location === "string" && c.location.trim() ? { location: c.location.trim().slice(0, 300) } : {}),
    ...(typeof c.details === "string" && c.details.trim() ? { details: c.details.trim().slice(0, 2000) } : {}),
    source: c.source ?? "you",
    sourceLabel: typeof c.sourceLabel === "string" ? c.sourceLabel : "",
    confidence: typeof c.confidence === "number" ? c.confidence : 1,
  };
}

export interface AddResult {
  ok: true;
  eventId: string;
  htmlLink: string;
  /** True in demo mode: nothing was written to a real calendar. */
  mock?: true;
  /** True when this exact event was already there, so nothing new was created. */
  duplicate?: true;
}

/**
 * Put one event on the calendar. The route calls this only for an explicit user "Add" click, which is the approval.
 * Real Google Calendar when connected; a fake "mock-" id in demo mode. Adding the same thing twice creates one event.
 */
export async function addCandidate(raw: unknown): Promise<AddResult> {
  const c = parseCandidate(raw);

  // A candidate that came from a pending approval card: approve that card instead of making a second event.
  if (c.id.startsWith("prop-")) {
    const p = getProposal(c.id.slice(5));
    if (p?.type === "create_event" && p.status === "pending") {
      const done = await approveProposal(p.id);
      if (done?.status === "done" && typeof done.payload?.eventId === "string") {
        return { ok: true, eventId: done.payload.eventId, htmlLink: "" };
      }
      throw new Error(done?.payload?.error ?? "could not add that event");
    }
  }

  // Double click, or it is already on the calendar: same title and start means the same event.
  const same = getCache().events.find((e) => plain(e.title).toLowerCase() === plain(c.title).toLowerCase() && new Date(e.start).getTime() === new Date(c.start).getTime());
  if (same) return { ok: true, eventId: same.id, htmlLink: "", duplicate: true };

  const { eventId, htmlLink, mock } = await insertEvent({ title: c.title, start: c.start, end: c.end, description: c.details, location: c.location });
  await postEvent({
    source: "calendar",
    kind: "observation",
    text: `Added '${c.title}' to the calendar, ${fmtDateTime(c.start)}–${fmtTime(c.end)}`,
    tags: ["calendar", "added"],
    refs: { eventId },
  });
  return { ok: true, eventId, htmlLink, ...(mock ? { mock: true as const } : {}) };
}
