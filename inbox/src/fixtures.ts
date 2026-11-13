// Fixture loader. Fixture files are { "anchor": "<ISO date the fixture was written for>", "items": [...] }.
// Every ISO-8601 timestamp inside `items` is shifted by (today - anchor) in whole days, so demo data
// always looks current ("due Friday" stays in the future).
import fs from "node:fs";
import path from "node:path";
import { FIXTURES_DIR, MOCK_ENV } from "./config.js";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function shiftIsoStrings<T>(value: T, deltaMs: number): T {
  if (typeof value === "string") {
    if (ISO_RE.test(value)) return new Date(new Date(value).getTime() + deltaMs).toISOString() as unknown as T;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => shiftIsoStrings(v, deltaMs)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = shiftIsoStrings(v, deltaMs);
    return out as T;
  }
  return value;
}

/** Demo mail/calendar is only ever shown in demo mode (MOCK=1, or INBOX_DEMO=1 for tests). A real-mode user who has
 *  not connected Google yet sees an empty inbox, never someone else's made-up one. */
export const demoDataAllowed = (): boolean => MOCK_ENV || process.env.INBOX_DEMO === "1";

export function loadFixture<T>(name: string, now: Date = new Date()): T[] {
  if (!demoDataAllowed()) return [];
  const file = path.join(FIXTURES_DIR, name);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { anchor: string; items: T[] };
  const delta = startOfDay(now).getTime() - startOfDay(new Date(raw.anchor)).getTime();
  return shiftIsoStrings(raw.items, delta);
}
