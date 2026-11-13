// Dashboard "brain": merges everything Northstar knows (insights, emails, approvals, calendar) into one ranked list.
// Today this ranks on the client from the contract data. When the memory service's insight engine is live,
// its NextThing leads and its cards are folded in, so the ranking automatically gets smarter.
import type { Proposal, Email, CalEvent, NextThing } from "@contracts/types";
import { getInsights, getTriage, getToday, getPendingProposals } from "./api";

export type PriorityKind = "focus" | "email" | "calendar" | "application" | "task";

export interface Priority {
  id: string;
  kind: PriorityKind;
  title: string;
  why: string;
  dueAt?: string;
  score: number;
  minutes?: number;
  proposal?: Proposal;
  email?: Email;
  calendarUrl?: string; // Google Calendar "add event" link
}

export interface DashboardData {
  priorities: Priority[];     // ranked, most important first
  calendarAdds: Priority[];   // things worth putting on the calendar
  today: CalEvent[];
  counts: { emails: number; approvals: number; ignored: number };
}

const H = 36e5;
function dueBoost(iso?: string) {
  if (!iso) return 0;
  const h = (new Date(iso).getTime() - Date.now()) / H;
  if (h < 0) return 45;      // overdue
  if (h < 12) return 40;
  if (h < 24) return 32;
  if (h < 72) return 20;
  if (h < 168) return 8;
  return 0;
}

const gcalDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
export function googleCalendarUrl(title: string, start: Date, end: Date, details = "") {
  const p = new URLSearchParams({ action: "TEMPLATE", text: title.replace(/^◎\s*/, ""), dates: `${gcalDate(start)}/${gcalDate(end)}`, details });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

const norm = (s: string) => s.toLowerCase().replace(/^(re|fwd?):\s*/i, "").replace(/[^a-z0-9 ]/g, "").trim();

export async function loadDashboard(): Promise<DashboardData> {
  const [insights, triage, today, proposals] = await Promise.all([getInsights(), getTriage(), getToday(), getPendingProposals()]);
  const items: Priority[] = [];

  // 1) The insight engine's single next thing always competes at the top.
  const nt: NextThing = insights.nextThing;
  if (nt?.title) items.push({ id: "next", kind: "focus", title: nt.title, why: nt.why, dueAt: nt.dueAt, minutes: nt.minutes, score: 70 + dueBoost(nt.dueAt) });

  // 2) Pending approvals (replies, calendar blocks, applications, tasks).
  const coveredSubjects = new Set<string>();
  for (const p of proposals) {
    const kind: PriorityKind = p.type === "send_reply" ? "email" : p.type === "create_event" ? "calendar"
      : p.type === "fill_form" || p.type === "submit_form" ? "application" : "task";
    const base = { email: 40, calendar: 30, application: 38, task: 18, focus: 0 }[kind];
    const item: Priority = { id: p.id, kind, title: p.title, why: p.why, dueAt: p.dueAt, proposal: p, score: base + p.urgency * 12 + dueBoost(p.dueAt) };
    if (p.type === "send_reply" && p.payload?.subject) coveredSubjects.add(norm(String(p.payload.subject)));
    if (p.type === "create_event" && p.payload?.start && p.payload?.end) {
      item.calendarUrl = googleCalendarUrl(p.title, new Date(p.payload.start), new Date(p.payload.end), p.why);
    }
    if (p.type === "unsubscribe") item.score -= 10;
    items.push(item);
  }

  // 3) Emails that need a human and aren't already covered by a drafted reply.
  for (const e of triage.needsYou) {
    if (coveredSubjects.has(norm(e.subject))) continue;
    const roleBoost = /advisor|prof|recruiter/i.test(e.fromRole ?? "") ? 10 : 0;
    const item: Priority = { id: e.id, kind: "email", title: `${e.from}: ${e.subject}`, why: e.snippet, dueAt: e.dueAt, email: e, score: 34 + roleBoost + dueBoost(e.dueAt) };
    if (e.dueAt) {
      // Suggest a 45-minute block a day before it's due (or 2 hours from now if that's already past).
      const due = new Date(e.dueAt); let start = new Date(due.getTime() - 24 * H); start.setMinutes(0, 0, 0);
      if (start.getTime() < Date.now()) { start = new Date(Date.now() + 2 * H); start.setMinutes(0, 0, 0); }
      item.calendarUrl = googleCalendarUrl(e.subject, start, new Date(start.getTime() + 45 * 6e4), `From ${e.from}. ${e.snippet}`);
    }
    items.push(item);
  }

  items.sort((a, b) => b.score - a.score);
  const calendarAdds = items.filter(i => i.calendarUrl).slice(0, 3);

  return {
    priorities: items.slice(0, 5),
    calendarAdds,
    today,
    counts: { emails: triage.needsYou.length, approvals: proposals.length, ignored: triage.ignored },
  };
}
