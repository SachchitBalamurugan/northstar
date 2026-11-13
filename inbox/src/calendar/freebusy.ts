// Pure free/busy math over CachedEvent[]. No I/O. All times are machine-local Dates.
import type { CachedEvent } from "../types.js";

export interface Interval {
  start: Date;
  end: Date;
}

export const MS_MIN = 60_000;

// ---- small date helpers (local time) ----
export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
/** Local `day` at hour:minute (hour may be 24 = midnight at the end of the day). */
export function atHour(day: Date, hour: number, minute = 0): Date {
  const x = startOfDay(day);
  x.setHours(hour, minute, 0, 0);
  return x;
}
/** Local calendar date as YYYY-MM-DD. */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
export function minutesBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / MS_MIN);
}
export function addMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * MS_MIN);
}

/** The time span an event occupies. All-day events block whole local days. Invalid/zero-length → undefined. */
export function eventInterval(ev: CachedEvent): Interval | undefined {
  const start = new Date(ev.start);
  const end = new Date(ev.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return undefined;
  if (ev.allDay) {
    const s = startOfDay(start);
    let e = startOfDay(end);
    if (e.getTime() <= s.getTime()) e = addDays(s, 1); // end is exclusive; same-day → one full day
    return { start: s, end: e };
  }
  if (end.getTime() <= start.getTime()) return undefined;
  return { start, end };
}

/** Sort by start and merge overlapping or touching intervals. Returns a new array. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start.getTime() <= last.end.getTime()) {
      if (iv.end.getTime() > last.end.getTime()) last.end = iv.end;
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  }
  return out;
}

export function clipInterval(iv: Interval, from: Date, to: Date): Interval | undefined {
  const s = iv.start.getTime() > from.getTime() ? iv.start : from;
  const e = iv.end.getTime() < to.getTime() ? iv.end : to;
  return e.getTime() > s.getTime() ? { start: s, end: e } : undefined;
}

/** Gaps inside `window` not covered by `busy` (busy need not be merged). */
export function gapsIn(window: Interval, busy: Interval[]): Interval[] {
  const merged = mergeIntervals(busy);
  const gaps: Interval[] = [];
  let cursor = window.start;
  for (const b of merged) {
    if (b.end.getTime() <= cursor.getTime()) continue;
    if (b.start.getTime() >= window.end.getTime()) break;
    if (b.start.getTime() > cursor.getTime()) gaps.push({ start: cursor, end: b.start });
    if (b.end.getTime() > cursor.getTime()) cursor = b.end;
  }
  if (window.end.getTime() > cursor.getTime()) gaps.push({ start: cursor, end: window.end });
  return gaps;
}

export interface BusyOpts {
  /** Grow every busy interval by this many minutes on each side (e.g. 10-min buffers). */
  padMinutes?: number;
}

/** Merged busy intervals from events, clipped to [dayStart, dayEnd). */
export function busyIntervals(events: CachedEvent[], dayStart: Date, dayEnd: Date, opts: BusyOpts = {}): Interval[] {
  const pad = (opts.padMinutes ?? 0) * MS_MIN;
  const out: Interval[] = [];
  for (const ev of events) {
    const iv = eventInterval(ev);
    if (!iv) continue;
    const padded = { start: new Date(iv.start.getTime() - pad), end: new Date(iv.end.getTime() + pad) };
    const clipped = clipInterval(padded, dayStart, dayEnd);
    if (clipped) out.push(clipped);
  }
  return mergeIntervals(out);
}

export interface FreeOpts extends BusyOpts {
  /** Drop gaps shorter than this (minutes). Default 1. */
  minMinutes?: number;
}

/** Free gaps between `from` and `to`, with overlapping busy intervals merged. */
export function freeSlots(events: CachedEvent[], from: Date, to: Date, opts: FreeOpts = {}): Interval[] {
  const busy = busyIntervals(events, from, to, opts);
  const min = (opts.minMinutes ?? 1) * MS_MIN;
  return gapsIn({ start: from, end: to }, busy).filter((g) => g.end.getTime() - g.start.getTime() >= min);
}

/** Minutes of timed (non all-day) events that fall on the local day of `day`. */
export function plannedMinutesOnDay(events: CachedEvent[], day: Date): number {
  const from = startOfDay(day);
  const to = addDays(from, 1);
  let total = 0;
  for (const ev of events) {
    if (ev.allDay) continue;
    const iv = eventInterval(ev);
    if (!iv) continue;
    const c = clipInterval(iv, from, to);
    if (c) total += minutesBetween(c.start, c.end);
  }
  return total;
}
