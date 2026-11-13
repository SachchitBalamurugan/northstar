// Calendar agent for the Dashboard's "Add to calendar" chat box.
// The user types an event ("career fair next Tue 2pm"). We ask the inbox service to search mail + memory + calendar
// (POST :7702/calendar/suggest). If it's offline, we search the same data locally. Nothing is added until the user approves.
import type { EventCandidate, Email, CalEvent, Proposal, KnowledgeFile } from "@contracts/types";
import { SERVICES, getTriage, getToday, getPendingProposals, listKnowledge, getKnowledge } from "./api";
import { googleCalendarUrl } from "./priorities";

const H = 36e5, MIN = 6e4;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const STOP = new Set(("a an the to at on in for of and my me i need go going have with next this tomorrow today tonight pm am event meeting min mins minutes hour hours "
  + "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun morning afternoon evening noon").split(" "));

/** Parse a date/time out of natural text. Returns null pieces when not found. */
export function parseWhen(text: string, now = new Date()): { start: Date | null; minutes: number } {
  const t = text.toLowerCase();
  let day: Date | null = null;
  const base = new Date(now); base.setHours(0, 0, 0, 0);

  if (/\btoday|tonight\b/.test(t)) day = new Date(base);
  else if (/\btomorrow\b/.test(t)) { day = new Date(base); day.setDate(day.getDate() + 1); }
  else {
    const wd = DAYS.findIndex(d => new RegExp(`\\b(next\\s+)?${d.slice(0, 3)}(${d.slice(3)})?\\b`).test(t));
    if (wd >= 0) {
      day = new Date(base); let diff = (wd - day.getDay() + 7) % 7;
      if (diff === 0 && /\bnext\b/.test(t)) diff = 7; // "next fri" on a Friday = a week out; plain "fri" = today (rolled below if past)
      day.setDate(day.getDate() + diff);
    }
    const md = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/) ?? null;
    const slash = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    if (md) { day = new Date(base); day.setMonth(MONTHS.indexOf(md[1]), Number(md[2])); if (day < base) day.setFullYear(day.getFullYear() + 1); }
    else if (slash) { day = new Date(base); day.setMonth(Number(slash[1]) - 1, Number(slash[2])); if (day < base) day.setFullYear(day.getFullYear() + 1); }
  }

  let hour: number | null = null, minute = 0;
  const tm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (tm) {
    hour = Number(tm[1]); minute = Number(tm[2] ?? 0);
    if (tm[3] === "pm" && hour < 12) hour += 12;
    if (tm[3] === "am" && hour === 12) hour = 0;
  } else if (/\bnoon\b/.test(t)) hour = 12;
  else if (/\bmorning\b/.test(t)) hour = 10;
  else if (/\bafternoon\b/.test(t)) hour = 14;
  else if (/\bevening|tonight\b/.test(t)) hour = 18;

  const dur = t.match(/\b(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)\b/);
  const minutes = dur ? Math.round(Number(dur[1]) * (/^h/.test(dur[2]) ? 60 : 1)) : 60;

  if (!day && hour === null) return { start: null, minutes };
  const start = new Date(day ?? base);
  if (hour !== null) start.setHours(hour, minute, 0, 0);
  else start.setHours(10, 0, 0, 0);
  if (start.getTime() < now.getTime()) {
    // A bare weekday/time that's already passed today means the next occurrence.
    if (!day) start.setDate(start.getDate() + 1);
    else if (day.getTime() === base.getTime() && !/today|tonight/.test(t)) start.setDate(start.getDate() + 7);
  }
  return { start, minutes };
}

/** Strip date/time words to get a clean event title. */
export function cleanTitle(text: string) {
  const t = text
    .replace(/\b(i\s+)?(need|have|want)\s+to\s+(go\s+to|attend|add)\s+/i, "")
    .replace(/\b(add|schedule|put)\s+/i, "")
    .replace(/\b(next\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/gi, "")
    .replace(/\b(today|tomorrow|tonight|this|morning|afternoon|evening|noon)\b/gi, "")
    .replace(/\b(at|on|from|for)\b\s*$/gi, "")
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, "").replace(/\b\d{1,2}:\d{2}\b/g, "")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/gi, "")
    .replace(/\b\d+(\.\d+)?\s*(h|hr|hrs|hours?|m|mins?|minutes)\b/gi, "")
    .replace(/\s+(at|on|for)\s*$/i, "").replace(/\s{2,}/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "New event";
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
function overlap(a: string[], b: string) { const bw = new Set(words(b)); return a.filter(w => bw.has(w)).length; }
const iso = (d: Date) => d.toISOString();
const overlaps = (s: Date, e: Date, ev: CalEvent) => s < new Date(ev.end) && e > new Date(ev.start);

/** Main entry: ask the inbox service, else search locally. */
export async function suggestEvents(query: string): Promise<EventCandidate[]> {
  try {
    const r = await fetch(SERVICES.inbox + "/calendar/suggest", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(8000),
    });
    if (r.ok) { const list = (await r.json()) as EventCandidate[]; if (Array.isArray(list)) return list.slice(0, 4); }
  } catch { /* offline → local search */ }
  return localSuggest(query);
}

async function localSuggest(query: string): Promise<EventCandidate[]> {
  const [triage, today, proposals, files] = await Promise.all([getTriage(), getToday(), getPendingProposals(), listKnowledge()]);
  const q = words(query);
  const out: EventCandidate[] = [];
  const { start, minutes } = parseWhen(query);
  const title = cleanTitle(query);

  // 1) What the user typed, with any date we could parse.
  if (start) {
    const end = new Date(start.getTime() + minutes * MIN);
    const clash = today.find(ev => overlaps(start, end, ev));
    out.push({ id: "you", title, start: iso(start), end: iso(end), source: "you", sourceLabel: "From what you typed", confidence: 0.9,
      conflict: clash ? `Overlaps ${clash.title.replace(/^◎\s*/, "")}` : undefined });
  }

  // 2) Related emails (subject/snippet word overlap). Use their deadline as the anchor.
  const mails: Email[] = [...triage.needsYou, ...triage.fyi];
  for (const m of mails) {
    const score = overlap(q, `${m.subject} ${m.snippet} ${m.from}`);
    if (!score) continue;
    // When the user gave a time, the email is supporting evidence for their event rather than a separate one.
    const mine = out.find(c => c.source === "you");
    if (start && mine) {
      mine.sourceLabel = `From what you typed · matches email from ${m.from}`;
      mine.details = `${m.from}: ${m.subject}. ${m.snippet}`;
      mine.confidence = Math.min(0.97, mine.confidence + 0.05);
      continue;
    }
    const when = start ?? (m.dueAt ? new Date(new Date(m.dueAt).getTime() - 2 * H) : null);
    if (!when) continue;
    const s = new Date(when); if (!start) s.setMinutes(0, 0, 0);
    out.push({ id: `mail-${m.id}`, title: start ? title : m.subject.replace(/^(re|fwd?):\s*/i, ""), start: iso(s), end: iso(new Date(s.getTime() + minutes * MIN)),
      details: `${m.from}: ${m.snippet}`, source: "email", sourceLabel: `Email from ${m.from}`, confidence: Math.min(0.85, 0.45 + score * 0.15) });
  }

  // 3) Pending calendar proposals that match.
  for (const p of proposals as Proposal[]) {
    if (p.type !== "create_event" || !p.payload?.start) continue;
    if (!overlap(q, p.title + " " + p.why)) continue;
    out.push({ id: `prop-${p.id}`, title: p.title.replace(/^◎\s*/, ""), start: p.payload.start, end: p.payload.end, details: p.why,
      source: "approval", sourceLabel: "Already suggested by Northstar", confidence: 0.7 });
  }

  // 4) Knowledge files (e.g. classes.md, routines.md) that mention the query terms.
  const hits = await Promise.all((files as KnowledgeFile[]).slice(0, 8).map(async f => ({ f, k: await getKnowledge(f.name) })));
  for (const { f, k } of hits) {
    const line = (k.content ?? "").split("\n").find(l => overlap(q, l) > 0);
    if (!line) continue;
    const when = start ?? parseWhen(line).start;
    if (!when) continue;
    out.push({ id: `kn-${f.name}`, title: start ? title : line.replace(/^[-*#\s]+/, "").replace(/\*\*/g, "").slice(0, 60),
      start: iso(when), end: iso(new Date(when.getTime() + minutes * MIN)), details: line.trim(),
      source: "knowledge", sourceLabel: `From ${f.name}`, confidence: 0.55 });
  }

  // 5) Nothing found and no date: suggest the next free afternoon slot so the user still gets one tap.
  if (out.length === 0) {
    const s = new Date(); s.setDate(s.getDate() + 1); s.setHours(14, 0, 0, 0);
    out.push({ id: "you", title, start: iso(s), end: iso(new Date(s.getTime() + minutes * MIN)), source: "you",
      sourceLabel: "No date found, so this is tomorrow at 2pm. Edit before adding.", confidence: 0.4 });
  }

  // De-dupe by start time + title; best first.
  const seen = new Set<string>();
  return out.sort((a, b) => b.confidence - a.confidence)
    .filter(c => { const k = c.title.toLowerCase() + c.start.slice(0, 16); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 3);
}

/** Add one approved event. Prefers the inbox service (writes to Google Calendar); else opens a prefilled Google Calendar page. */
export async function addEvent(c: EventCandidate): Promise<{ via: "service" | "link"; error?: string }> {
  try {
    const r = await fetch(SERVICES.inbox + "/calendar/add", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidate: c }), signal: AbortSignal.timeout(15000),
    });
    if (r.ok) return { via: "service" };
    // Connected but Google refused (e.g. Calendar API disabled): surface the reason instead of silently opening a link.
    const j = await r.json().catch(() => ({}));
    if (j?.error) return { via: "link", error: String(j.error) };
  } catch { /* offline */ }
  const url = googleCalendarUrl(c.title, new Date(c.start), new Date(c.end), [c.details, c.location].filter(Boolean).join("\n"));
  if (window.northstar) window.northstar.openExternal(url); else window.open(url, "_blank", "noopener");
  return { via: "link" };
}
