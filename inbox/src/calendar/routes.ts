// Calendar routes: GET /calendar/today, GET /calendar/free, POST /schedule/plan, and the
// create_event approve handler. syncCalendar lives in ./sync.ts and is re-exported for app.ts.
import type { FastifyInstance } from "fastify";
import { AUTO_APPROVE_CALENDAR } from "../config.js";
import { contextToText, getContext } from "../memory.js";
import { approveProposal, registerApproveHandler } from "../proposals.js";
import { dropPending, getCache, newProposal } from "../store.js";
import type { CachedEvent, Deadline, Proposal } from "../types.js";
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
    return { date: dayKey(now), events: eventsOnDay(getCache().events, now) };
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

  app.post("/schedule/plan", async (_req, reply) => {
    const proposals = await planAndPropose();
    if (!getCache().triage) reply.header("x-northstar-note", "no triage yet; run POST /sync first");
    return proposals;
  });
}
