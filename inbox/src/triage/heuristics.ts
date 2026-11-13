// Deterministic triage used in MOCK mode and whenever the LLM is unavailable.
// Produces the same TriagedEmail shape as the model path so the rest of the pipeline doesn't care.
import { TIMEZONE } from "../config.js";
import type { CachedEmail, ContextResponse, Deadline, SenderRole, TriagedEmail } from "../types.js";

// ---------- timezone helpers (all student-facing dates are America/Los_Angeles) ----------

interface Parts { y: number; m: number; d: number; hh: number; mm: number; ss: number; dow: number }
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function zonedParts(date: Date, tz = TIMEZONE): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return {
    y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, ss: +p.second,
    dow: DOW.indexOf(p.weekday.toLowerCase().slice(0, 3)),
  };
}

function tzOffsetMs(date: Date, tz = TIMEZONE): number {
  const p = zonedParts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - date.getTime();
}

/** Build an ISO instant from wall-clock fields in the student's timezone. */
export function zonedToIso(y: number, m: number, d: number, hh: number, mm: number, tz = TIMEZONE): string {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  return new Date(guess - tzOffsetMs(new Date(guess), tz)).toISOString();
}

export function fmtWhen(iso: string, tz = TIMEZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(iso));
}

// ---------- sender role ----------

const ROLE_LABEL: Record<SenderRole, string> = {
  prof: "your professor", ta: "your TA", recruiter: "a recruiter", club: "your club", admin: "the university",
  promo: "a promotional sender", peer: "a classmate", other: "a contact",
};

export function classifySenderRole(email: CachedEmail): SenderRole {
  const from = email.from.toLowerCase();
  const addr = email.fromEmail.toLowerCase();
  const domain = addr.split("@")[1] ?? "";
  const text = `${email.subject}\n${email.bodyText}`.toLowerCase();
  const head = text.slice(0, 400);
  const tail = email.bodyText.toLowerCase().slice(-200); // signature area
  const isEdu = domain.endsWith(".edu");

  // 1. what the display name says about the sender
  if (/\b(prof\.?|professor|dr\.)\s/.test(from + " ")) return "prof";
  if (/\b(ta|gsi|course staff|reader|tutor|instructor)\b/.test(from)) return "ta";
  if (/\b(recruit\w*|talent|careers?|jobs?|hiring)\b/.test(domain + " " + from) && !/\b(career center|fair)\b/.test(from)) return "recruiter";
  // 2. what the mail itself says
  if (/\b(online assessment|coding assessment|interview|hackerrank|codesignal|internship offer)\b/.test(head) && !isEdu) return "recruiter";
  if (
    email.listUnsubscribe ||
    /\b(newsletter|digest)\b/.test(from) ||
    (/\b(no-?reply|donotreply|marketing|promo|deals?|offers?)\b/.test(addr) && !isEdu) ||
    /\b(\d+% off|limited time|flash sale|unsubscribe|promo code)\b/.test(text)
  ) return "promo";
  if (isEdu && /\b(prof\.|professor)\b/.test(tail)) return "prof";
  if (isEdu && /\b(your (ta|gsi)|course staff|head ta|office hours (are|this|next))\b/.test(head + " " + tail)) return "ta";
  if (
    /\b(registrar|financial aid|aid office|bursar|student central|housing|residence|residential|dean|office of|it (services|support)|calnet|career center|health|library|admissions|billing)\b/.test(from + " " + addr) ||
    /\bofficial notice\b/.test(head)
  ) return "admin";
  if (/\b(club|society|team|robotics|hackathon|chapter|association)\b/.test(from + " " + addr) || /\b(club|general meeting|our next meeting)\b/.test(head)) return "club";
  if (isEdu) return "peer";
  return "other";
}

// ---------- deadlines ----------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY_RE = "(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)";
// "by"/"before"/"until" only count when followed by something date-like ("come by my office hours" is not a deadline)
const TRIGGER_RE =
  /\b(due|deadline|no later than|within \d+ days?|submit(?:ted)?|turn in|expires?|closes?|needs? to be (?:in|done|submitted))\b|\b(by|before|until)\s+(?:the\s+)?(end|\d|next\b|this\b|tomorrow|tonight|today|noon|midnight|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b|\b(\d{1,2}):(\d{2})\b|\b(noon|midnight|end of (?:the )?day|eod|close of business)\b/i;

function splitSentences(text: string): string[] {
  return text.replace(/[ \t]+/g, " ").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function parseTime(s: string): { hh: number; mm: number } | undefined {
  const m = TIME_RE.exec(s);
  if (!m) return undefined;
  if (m[6]) {
    const w = m[6].toLowerCase();
    if (w === "noon") return { hh: 12, mm: 0 };
    if (w === "midnight") return { hh: 23, mm: 59 };
    return { hh: 17, mm: 0 };
  }
  if (m[1]) {
    let hh = +m[1];
    const mm = m[2] ? +m[2] : 0;
    const pm = m[3].toLowerCase().startsWith("p");
    if (pm && hh < 12) hh += 12;
    if (!pm && hh === 12) hh = 0;
    return { hh, mm };
  }
  return { hh: +m[4], mm: +m[5] };
}

/** Find the due date in one sentence, resolved against the email's receivedAt (student timezone). */
function parseDueDate(sentence: string, received: Date): { iso: string; explicitTime: boolean } | undefined {
  const iso = parseDueDateIso(sentence, received);
  return iso ? { iso, explicitTime: parseTime(sentence.toLowerCase()) !== undefined } : undefined;
}

function parseDueDateIso(sentence: string, received: Date): string | undefined {
  const s = sentence.toLowerCase();
  const now = zonedParts(received);
  const time = parseTime(s) ?? { hh: 23, mm: 59 };
  const dayStart = Date.UTC(now.y, now.m - 1, now.d);
  const addDays = (n: number) => {
    const d = new Date(dayStart + n * 86_400_000);
    return zonedToIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), time.hh, time.mm);
  };
  const withYear = (y: number, m: number, d: number) => {
    // a date that already passed by more than a month means next year
    const candidate = Date.UTC(y, m - 1, d);
    const yy = candidate < dayStart - 30 * 86_400_000 ? y + 1 : y;
    return zonedToIso(yy, m, d, time.hh, time.mm);
  };
  // when a sentence names several dates ("moved from Nov 17 to Nov 20"), the last one is the deadline
  const last = (re: RegExp): RegExpExecArray | null => {
    let found: RegExpExecArray | null = null;
    for (const hit of s.matchAll(re)) found = hit as RegExpExecArray;
    return found;
  };

  let m: RegExpExecArray | null;
  if ((m = last(/\b(\d{4})-(\d{2})-(\d{2})\b/g))) return zonedToIso(+m[1], +m[2], +m[3], time.hh, time.mm);
  if ((m = last(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`, "g")))) {
    const month = MONTHS.indexOf(m[1].slice(0, 3)) + 1;
    return withYear(m[3] ? +m[3] : now.y, month, +m[2]);
  }
  if ((m = last(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : now.y;
    return withYear(y, +m[1], +m[2]);
  }
  if ((m = /\b(?:within|in)\s+(\d+)\s+days?\b/.exec(s))) return addDays(+m[1]);
  if (/\b(today|tonight|end of (?:the )?day|eod)\b/.test(s)) return addDays(0);
  if (/\btomorrow\b/.test(s)) return addDays(1);
  if ((m = last(new RegExp(`\\b(next\\s+|this\\s+)?${WEEKDAY_RE}\\b`, "g")))) {
    const target = DOW.indexOf(m[2].slice(0, 3));
    let ahead = (target - now.dow + 7) % 7;
    if (m[1]?.startsWith("next") && ahead < 2) ahead += 7;
    return addDays(ahead);
  }
  return undefined;
}

export function extractCourse(text: string): string | undefined {
  const m = /\b((?:CS|EECS|EE|MATH|DATA|STAT|PHYSICS|PHYS|CHEM|BIO|ENGLISH|ENG|R)\s?\d{1,3}[A-Z]?)\b/i.exec(text);
  if (!m) return undefined;
  const code = m[1].replace(/\s+/g, "").toUpperCase();
  return code.startsWith("R1") ? `English ${code}` : code;
}

export function estimateEffort(text: string, hasDeadline: boolean): number {
  const t = text.toLowerCase();
  if (/\bproject\b/.test(t)) return 180;
  if (/\b(essay|paper)\b/.test(t)) return 150;
  if (/\b(homework|hw\s?\d*|problem set|pset|assessment|coding challenge)\b/.test(t)) return 120;
  if (/\b(lab|report|checkoff|check-off)\b/.test(t)) return 90;
  if (/\b(form|worksheet|survey|rsvp|register|sign ?up|upload|application)\b/.test(t)) return 30;
  if (/\b(reply|confirm|let me know|respond|send me)\b/.test(t)) return 10;
  return hasDeadline ? 30 : 10;
}

function cleanSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim();
}

/** Turn a subject like "CS70 HW 11 released - due Tuesday 11/17 11:59pm" into a task name ("HW 11"). */
export function deadlineTitle(subject: string, course?: string): string {
  let t = cleanSubject(subject)
    .replace(/^[A-Z]{1,6}\s?\d{1,3}[A-Z]?\s*[:—-]\s*/i, "") // leading course prefix "CS61B: "
    .replace(/^(action required|reminder|important|urgent)\s*[:—-]?\s*/i, "")
    .replace(/\s*[-–—:,(]?\s*\b(due|deadline|by|before|next|this)\b.*$/i, "") // trailing "due Friday..."
    .replace(/\s*[-–—]\s*[^-–—]*\?$/, "") // trailing " - who's doing X?"
    .replace(/\b(released|posted|is out|reminder)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/[\s:;,.\-–—]+$/g, "")
    .trim();
  if (!t) t = cleanSubject(subject).slice(0, 60);
  if (course && !t.toUpperCase().includes(course.toUpperCase())) t = `${course}: ${t}`;
  return t.slice(0, 70);
}

export function extractDeadlines(email: CachedEmail, role: SenderRole): Deadline[] {
  if (role === "promo") return [];
  const received = new Date(email.receivedAt);
  const course = extractCourse(`${email.subject} ${email.bodyText}`);
  const title = deadlineTitle(email.subject, course);
  // one deadline per calendar day; a sentence with an explicit time wins over one without ("due Nov 20" vs "Nov 20 at 5 PM")
  const byDay = new Map<string, { dueAt: string; explicitTime: boolean; sentence: string }>();
  for (const sentence of [email.subject, ...splitSentences(email.bodyText)]) {
    if (!TRIGGER_RE.test(sentence)) continue;
    const parsed = parseDueDate(sentence, received);
    if (!parsed) continue;
    const day = parsed.iso.slice(0, 10);
    const prev = byDay.get(day);
    if (!prev || (parsed.explicitTime && !prev.explicitTime)) byDay.set(day, { dueAt: parsed.iso, explicitTime: parsed.explicitTime, sentence });
    if (byDay.size >= 3) break;
  }
  return [...byDay.values()].map((d) => ({
    title,
    dueAt: d.dueAt,
    course,
    effortMinutes: estimateEffort(`${email.subject} ${d.sentence} ${email.bodyText.slice(0, 300)}`, true),
    emailId: email.id,
  }));
}

// ---------- asks ----------

const IMPERATIVE_RE = /^(please|make sure|be sure|remember to|don't forget|submit|complete|reply|respond|send|bring|confirm|rsvp|fill (out|in)|let me know|sign up|register|upload|schedule|pick|choose|review)\b/i;
const QUESTION_TO_YOU_RE = /\b(you|your|u)\b|^(can|could|would|will|do|does|are|is|what|when|which|where|how|any chance|want|wanna|interested|free|down)\b/i;

export function extractAsks(email: CachedEmail): string[] {
  const asks: string[] = [];
  for (const s of splitSentences(email.bodyText)) {
    const isQuestion = s.endsWith("?") && QUESTION_TO_YOU_RE.test(s);
    const isImperative = IMPERATIVE_RE.test(s);
    if ((isQuestion || isImperative) && s.length > 8) asks.push(s.length > 140 ? s.slice(0, 137) + "..." : s);
    if (asks.length >= 4) break;
  }
  return asks;
}

// ---------- memory ----------

/** First line of knowledge/snippets that mentions the sender, for citing memory in `why`. */
export function memoryMention(ctx: ContextResponse | undefined, email: CachedEmail): { line: string; file: string } | undefined {
  if (!ctx) return undefined;
  const names = email.from
    .replace(/[(),"<>]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !/^(prof|professor|dr|the|and|office|of|team|staff)\.?$/i.test(w));
  const keys = [...names, email.fromEmail].map((k) => k.toLowerCase());
  if (!keys.length) return undefined;
  for (const k of ctx.knowledge ?? []) {
    for (const line of k.content.split("\n")) {
      const l = line.toLowerCase();
      if (keys.some((key) => l.includes(key))) return { line: line.replace(/^[\s#*-]+/, "").trim(), file: k.file };
    }
  }
  for (const s of ctx.snippets ?? []) {
    const l = s.text.toLowerCase();
    if (keys.some((key) => l.includes(key))) return { line: s.text.trim(), file: "memory" };
  }
  return undefined;
}

// ---------- the classifier ----------

const DAY = 86_400_000;

export function heuristicTriage(email: CachedEmail, ctx?: ContextResponse, now: Date = new Date()): TriagedEmail {
  const senderRole = classifySenderRole(email);
  const deadlines = extractDeadlines(email, senderRole);
  const asks = senderRole === "promo" ? [] : extractAsks(email);
  const hasQuestion = asks.some((a) => a.endsWith("?"));
  const staff = senderRole === "prof" || senderRole === "ta" || senderRole === "recruiter" || senderRole === "admin";

  let bucket: TriagedEmail["bucket"];
  if (senderRole === "promo") bucket = "ignore";
  else if (hasQuestion || deadlines.length > 0 || (staff && asks.length > 0)) bucket = "needsYou";
  else bucket = "fyi";

  // urgency: proximity of the earliest deadline (big tasks count as urgent earlier), then who is asking
  const soonest = deadlines.map((d) => new Date(d.dueAt).getTime()).sort((a, b) => a - b)[0];
  const effort = deadlines.length ? Math.max(...deadlines.map((d) => d.effortMinutes)) : 0;
  let urgency: 1 | 2 | 3 = 3;
  if (soonest !== undefined) {
    const daysLeft = (soonest - now.getTime()) / DAY;
    if (daysLeft <= 3 || (daysLeft <= 8 && effort >= 120)) urgency = 1;
    else if (daysLeft <= 8 || senderRole === "prof") urgency = 2;
  } else if (bucket === "needsYou") {
    urgency = staff ? 2 : 3;
  }

  // why: one sentence, citing memory when it knows the sender
  const mention = memoryMention(ctx, email);
  const who = mention ? `${mention.line} (per ${mention.file})` : `${email.from} is ${ROLE_LABEL[senderRole]}`;
  let why: string;
  if (bucket === "ignore") why = `${email.from} looks like marketing${email.opened === false ? " you haven't opened" : ""}.`;
  else if (deadlines.length) why = `${who}; ${deadlines[0].title} is due ${fmtWhen(deadlines[0].dueAt)} (~${deadlines[0].effortMinutes} min).`;
  else if (bucket === "needsYou") why = `${who} and is waiting on you: "${asks[0].slice(0, 80)}".`;
  else why = `${who}; heads-up only, nothing due.`;

  return {
    emailId: email.id, from: email.from, subject: email.subject, receivedAt: email.receivedAt, snippet: email.snippet,
    bucket, urgency, senderRole, deadlines, asks, why,
  };
}
