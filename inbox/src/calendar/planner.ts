// Pure focus-block planner. No I/O; fully unit-tested in test/planner.test.ts.
//
// Rules (from docs/kit/3-inbox-calendar.md):
//   - For every deadline without an existing "◎" block, split effortMinutes into blocks of <= 50 min
//     separated by 10-min buffers (also 10 min away from any existing event).
//   - Prefer the focus window (e.g. 14:00-17:00) on every eligible day first, then other daytime slots.
//   - Never before 09:00 or after 23:00. At most 6 h of planned work per day (existing events + new blocks).
//   - The last block must end >= 24 h before dueAt. Nearest deadline first. Start no earlier than `now`
//     rounded up to the next 10 min.
//   - If a deadline can't be fully placed, place what fits and flag `partial: true` on its last block.
//   - The 24 h margin is a hard rule: a deadline less than ~1 day away gets no blocks (never one inside the margin).
import type { CachedEvent, Deadline } from "../types.js";
import {
  type Interval,
  MS_MIN,
  addDays,
  addMinutes,
  atHour,
  dayKey,
  eventInterval,
  gapsIn,
  minutesBetween,
  plannedMinutesOnDay,
  startOfDay,
} from "./freebusy.js";

export const MAX_BLOCK_MIN = 50;
export const BUFFER_MIN = 10;
/** Don't create fragments shorter than this unless it is the final remainder of a deadline. */
export const MIN_BLOCK_MIN = 15;
export const DAY_START_HOUR = 9;
export const DAY_END_HOUR = 23;
export const MAX_DAY_MIN = 6 * 60;
export const LEAD_TIME_MS = 24 * 60 * MS_MIN;
export const DEFAULT_FOCUS_WINDOW: FocusWindow = { startHour: 14, endHour: 17 };
export const BLOCK_PREFIX = "◎ ";

export interface FocusWindow {
  startHour: number;
  endHour: number;
}

export interface PlannedBlock {
  title: string;         // "◎ <deadline title>", <= 60 chars
  start: string;         // ISO 8601
  end: string;           // ISO 8601
  deadlineTitle: string;
  dueAt: string;         // ISO 8601
  minutes: number;
  partial?: boolean;     // true on the last block when the deadline could not be fully placed
}

export interface PlanInput {
  deadlines: Deadline[];
  events: CachedEvent[];
  now: Date;
  focusWindow: FocusWindow;
}

/** "◎ " + title, trimmed so the whole thing fits the 60-char Proposal title limit. */
export function blockTitle(deadlineTitle: string): string {
  const max = 60 - BLOCK_PREFIX.length;
  const t = deadlineTitle.trim().replace(/\s+/g, " ");
  return BLOCK_PREFIX + (t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t);
}

function norm(s: string | undefined): string {
  return (s ?? "").replace(/^◎\s*/u, "").replace(/…$/u, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** True if a Northstar block for this deadline already exists (title or description references it). */
export function hasExistingBlock(deadline: Deadline, events: CachedEvent[]): boolean {
  const target = norm(deadline.title);
  if (target.length < 3) return false;
  return events.some((ev) => {
    if (!ev.createdByNorthstar) return false;
    const title = norm(ev.title);
    const desc = norm(ev.description);
    // Block titles are truncated ("…") to fit 60 chars; only then may the title be a prefix of the deadline.
    // (A plain substring match made "◎ Lab" suppress "Collaboration essay".)
    const truncated = /…\s*$/u.test(ev.title ?? "");
    return (
      (title.length >= 3 && (title.includes(target) || (truncated && target.startsWith(title)))) ||
      (desc.length > 0 && desc.includes(target))
    );
  });
}

export function roundUpToMinutes(d: Date, step = 10): Date {
  const ms = step * MS_MIN;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}

function clampWindow(fw: FocusWindow | undefined): FocusWindow {
  if (!fw || !Number.isFinite(fw.startHour) || !Number.isFinite(fw.endHour)) return DEFAULT_FOCUS_WINDOW;
  const s = Math.max(DAY_START_HOUR, Math.min(DAY_END_HOUR, fw.startHour));
  const e = Math.max(DAY_START_HOUR, Math.min(DAY_END_HOUR, fw.endHour));
  return e > s ? { startHour: s, endHour: e } : DEFAULT_FOCUS_WINDOW;
}

function clipTo(iv: Interval, from: Date, to: Date): Interval | undefined {
  const s = Math.max(iv.start.getTime(), from.getTime());
  const e = Math.min(iv.end.getTime(), to.getTime());
  return e > s ? { start: new Date(s), end: new Date(e) } : undefined;
}

/** Candidate windows in priority order: every day's focus window first, then every day's other daytime hours. */
function candidateWindows(earliest: Date, latestEnd: Date, fw: FocusWindow): Interval[] {
  const focus: Interval[] = [];
  const rest: Interval[] = [];
  const lastDay = startOfDay(latestEnd);
  for (let day = startOfDay(earliest); day.getTime() <= lastDay.getTime(); day = addDays(day, 1)) {
    const push = (list: Interval[], h1: number, h2: number) => {
      if (h2 <= h1) return;
      const iv = clipTo({ start: atHour(day, h1), end: atHour(day, h2) }, earliest, latestEnd);
      if (iv) list.push(iv);
    };
    push(focus, fw.startHour, fw.endHour);
    push(rest, DAY_START_HOUR, fw.startHour);
    push(rest, fw.endHour, DAY_END_HOUR);
  }
  return [...focus, ...rest];
}

function pad(iv: Interval): Interval {
  return { start: addMinutes(iv.start, -BUFFER_MIN), end: addMinutes(iv.end, BUFFER_MIN) };
}

export function planBlocks(input: PlanInput): PlannedBlock[] {
  const { deadlines, events, now } = input;
  const fw = clampWindow(input.focusWindow);
  const earliest = roundUpToMinutes(now, 10);

  // Occupied time, padded by the buffer so anything placed in a gap is >= 10 min from neighbours.
  const occupied: Interval[] = [];
  for (const ev of events) {
    const iv = eventInterval(ev);
    if (iv) occupied.push(pad(iv));
  }
  // Planned minutes per local day (existing timed events + blocks placed in this run).
  const load = new Map<string, number>();
  const loadOf = (day: Date): number => {
    const key = dayKey(day);
    if (!load.has(key)) load.set(key, plannedMinutesOnDay(events, day));
    return load.get(key)!;
  };
  const addLoad = (day: Date, min: number) => load.set(dayKey(day), loadOf(day) + min);

  // Deadlines: valid, in the future, not already scheduled, deduped by title, nearest first.
  const seen = new Set<string>();
  const todo = deadlines
    .filter((d) => {
      const due = new Date(d.dueAt).getTime();
      if (!Number.isFinite(due) || due <= now.getTime()) return false;
      const key = norm(d.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return !hasExistingBlock(d, events);
    })
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime() || a.title.localeCompare(b.title));

  const place = (dl: Deadline, latestEnd: Date): PlannedBlock[] => {
    const effort = Math.max(0, Math.round(Number(dl.effortMinutes) || 0));
    const blocks: PlannedBlock[] = [];
    if (!effort || latestEnd.getTime() <= earliest.getTime()) return blocks;
    let remaining = effort;
    const title = blockTitle(dl.title);

    for (const window of candidateWindows(earliest, latestEnd, fw)) {
      if (remaining <= 0) break;
      let capLeft = MAX_DAY_MIN - loadOf(window.start);
      if (capLeft < Math.min(MIN_BLOCK_MIN, remaining)) continue;
      for (const gap of gapsIn(window, occupied)) {
        let cursor = gap.start;
        while (remaining > 0 && capLeft > 0) {
          const room = minutesBetween(cursor, gap.end);
          const size = Math.min(MAX_BLOCK_MIN, remaining, room, capLeft);
          if (size <= 0 || (size < MIN_BLOCK_MIN && size < remaining)) break; // no useful room left here
          const start = cursor;
          const end = addMinutes(start, size);
          blocks.push({ title, start: start.toISOString(), end: end.toISOString(), deadlineTitle: dl.title, dueAt: dl.dueAt, minutes: size });
          occupied.push(pad({ start, end }));
          addLoad(start, size);
          remaining -= size;
          capLeft -= size;
          cursor = addMinutes(end, BUFFER_MIN);
        }
        if (remaining <= 0) break;
      }
    }
    if (blocks.length && remaining > 0) blocks[blocks.length - 1].partial = true;
    return blocks;
  };

  const out: PlannedBlock[] = [];
  for (const dl of todo) {
    const due = new Date(dl.dueAt);
    // Hard rule: every block ends >= 24 h before dueAt. A deadline closer than that gets no block.
    out.push(...place(dl, new Date(due.getTime() - LEAD_TIME_MS)));
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

/**
 * Parse a focus window such as "2–5pm", "2-5 pm", "14:00–17:00", "best focus 2 to 5 pm" from memory text.
 * Lines mentioning "focus" win; otherwise the first time range in the text. Undefined if nothing parses.
 */
export function parseFocusWindow(text: string): FocusWindow | undefined {
  if (!text) return undefined;
  const RANGE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:–|—|-|to|until|till|and)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi;
  const tryLine = (line: string): FocusWindow | undefined => {
    RANGE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RANGE.exec(line))) {
      const fw = toWindow(m);
      if (fw) return fw;
    }
    return undefined;
  };
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (/focus|deep work|best hours/i.test(line)) {
      const fw = tryLine(line);
      if (fw) return fw;
    }
  }
  return tryLine(text.replace(/\r?\n/g, " "));
}

function toWindow(m: RegExpExecArray): FocusWindow | undefined {
  const [, h1, , mer1, h2, , mer2] = m;
  let start = Number(h1);
  let end = Number(h2);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > 24 || end > 24) return undefined;
  const to24 = (h: number, mer: string | undefined): number => {
    if (!mer) return h;
    const p = mer.toLowerCase();
    if (p === "am") return h === 12 ? 0 : h;
    return h === 12 ? 12 : h + 12;
  };
  if (mer1) start = to24(start, mer1);
  if (mer2) end = to24(end, mer2);
  if (!mer1 && mer2) {
    // "2–5pm": the start shares the meridiem unless that would push it past the end ("10–12pm" stays 10).
    const shifted = to24(Number(h1), mer2);
    if (shifted <= end) start = shifted;
  }
  if (!mer1 && !mer2 && start < 7 && end <= 12) {
    // "2-5" with no am/pm: nobody focuses at 2 am.
    start += 12;
    end += 12;
  }
  if (!(start < end) || start < 0 || end > 24) return undefined;
  return { startHour: start, endHour: end };
}
