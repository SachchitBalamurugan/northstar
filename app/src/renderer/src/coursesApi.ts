// Courses: syllabi the student uploaded, the deadlines found in them, and search. Inbox service :7702, mock fallback when offline.
import type { Proposal } from "@contracts/types";
import { SERVICES, checkHealth, demoFallback, isDemo } from "./api";

export interface CourseFact { label: string; value: string }
export interface Course {
  id: string;
  name: string;
  filename?: string;
  uploadedAt: string;
  summary: string;
  deadlineCount: number;
  facts: CourseFact[];
}
export type DeadlineKind = "exam" | "assignment" | "project" | "other";
export interface CourseDeadline {
  id: string;
  courseId: string;
  title: string;
  dueAt: string;
  kind: DeadlineKind;
  proposalId?: string;
}
export type CourseDetail = Course & { text: string; deadlines: CourseDeadline[] };
export interface SyllabusUpload { course: string; filename?: string; text?: string; pdfBase64?: string }
/** `offline` is set only by the local mock (inbox service unreachable): nothing reached Approve. */
export interface SyllabusResult { course: Course; deadlines: CourseDeadline[]; proposals: Proposal[]; offline?: boolean }
export interface CourseSearchHit { courseId: string; course: string; snippet: string; score: number }
export interface CourseSearch { results: CourseSearchHit[]; answer?: string }

/* ---------------- mock ---------------- */

const at = (days: number, h: number, m = 0) => { const t = new Date(); t.setDate(t.getDate() + days); t.setHours(h, m, 0, 0); return t.toISOString(); };
const fmt = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const d61b: CourseDeadline[] = [
  { id: "dl-1", courseId: "cs61b", title: "Project 3: Build Your Own World", dueAt: at(7, 17), kind: "project" },
  { id: "dl-2", courseId: "cs61b", title: "Lab 11: Graphs", dueAt: at(11, 23, 59), kind: "assignment" },
  { id: "dl-3", courseId: "cs61b", title: "Homework 4: Sorting", dueAt: at(18, 23, 59), kind: "assignment" },
  { id: "dl-4", courseId: "cs61b", title: "Final exam", dueAt: at(33, 8), kind: "exam" },
];

const mockCourses: CourseDetail[] = [{
  id: "cs61b", name: "CS61B Data Structures", filename: "cs61b-fa26-syllabus.pdf", uploadedAt: at(-2, 19),
  summary: "Data structures and algorithms in Java with Prof. Lee. Three large projects carry most of the grade, with weekly labs and two midterms.",
  deadlineCount: d61b.length,
  facts: [
    { label: "Lectures", value: "MWF 10-11am" },
    { label: "Late policy", value: "4 slip days total, max 2 per project" },
    { label: "Grading", value: "Projects 40%, exams 45%, labs and homework 15%" },
    { label: "Office hours", value: "TA Priya, Thu 2-4pm, Soda 283" },
  ],
  deadlines: d61b,
  text: [
    "CS61B Data Structures, Fall 2026. Instructor: Prof. Lee. Lectures Monday, Wednesday and Friday 10-11am.",
    "Late policy: every student has 4 slip days for the semester. At most 2 slip days can be used on a single project. Labs and homework cannot be turned in late.",
    "Grading: projects 40%, midterms and final exam 45%, labs and homework 15%. The lower midterm score can be replaced by your final exam score.",
    `Project 3 (Build Your Own World) is due ${fmt(d61b[0].dueAt)}. Partners are allowed. Start with world generation before interactivity.`,
    `Lab 11 (Graphs) is due ${fmt(d61b[1].dueAt)}. Homework 4 (Sorting) is due ${fmt(d61b[2].dueAt)}.`,
    `The final exam is on ${fmt(d61b[3].dueAt)}. Midterm 2 was held in week 10; there is no further midterm. One double-sided cheat sheet is allowed.`,
    "Office hours: TA Priya holds office hours Thursday 2-4pm in Soda 283. Prof. Lee holds advising hours by appointment.",
    "Collaboration: you may discuss ideas, but all code you submit must be written by you or your project partner.",
  ].join("\n"),
}];

const strip = ({ text: _t, deadlines: _d, ...c }: CourseDetail): Course => c;

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
const DATE_RE = new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`, "i");

function mockExtract(courseId: string, text: string): CourseDeadline[] {
  const out: CourseDeadline[] = [];
  for (const raw of text.split(/\n|(?<=\.)\s+/)) {
    const line = raw.trim(); const m = line.match(DATE_RE);
    if (!m || line.length < 8) continue;
    const now = new Date();
    const due = new Date(`${m[1].slice(0, 3)} ${m[2]}, ${m[3] ?? now.getFullYear()} 23:59`);
    if (isNaN(+due)) continue;
    if (!m[3] && +due < +now - 30 * 864e5) due.setFullYear(due.getFullYear() + 1);
    const kind: DeadlineKind = /exam|midterm|final|quiz/i.test(line) ? "exam" : /project/i.test(line) ? "project" : /homework|hw|lab|essay|draft|assignment|problem set/i.test(line) ? "assignment" : "other";
    const title = line.replace(DATE_RE, "").replace(/\b(is|are)?\s*(due|on|by)\b\s*[:,-]?\s*$/i, "").replace(/[\s:,.-]+$/, "").slice(0, 70) || "Deadline";
    out.push({ id: `dl-${courseId}-${out.length + 1}`, courseId, title, dueAt: due.toISOString(), kind });
  }
  return out.sort((a, b) => +new Date(a.dueAt) - +new Date(b.dueAt));
}

function mockUpload(u: SyllabusUpload): SyllabusResult {
  const id = `${u.course.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "course"}-${Date.now().toString(36)}`;
  const text = u.text ?? "";
  const deadlines = text ? mockExtract(id, text) : [
    { id: `dl-${id}-1`, courseId: id, title: "Midterm", dueAt: at(12, 19), kind: "exam" as const },
    { id: `dl-${id}-2`, courseId: id, title: "Final project", dueAt: at(26, 17), kind: "project" as const },
  ];
  const detail: CourseDetail = {
    id, name: u.course, filename: u.filename, uploadedAt: new Date().toISOString(),
    summary: text ? text.replace(/\s+/g, " ").trim().slice(0, 160) : "Sample reading of this syllabus. Connect the inbox service to read the real file.",
    deadlineCount: deadlines.length, facts: [], deadlines, text,
  };
  mockCourses.unshift(detail);
  return { course: strip(detail), deadlines, proposals: [], offline: true };
}

const STOP = new Set("the a an is are was when what whats how do does i my of for to in on and or it its can be there any".split(" "));
function mockSearch(q: string): CourseSearch {
  const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOP.has(t));
  if (!terms.length) return { results: [] };
  const hits: CourseSearchHit[] = [];
  for (const c of mockCourses) {
    for (const line of c.text.split("\n")) {
      const low = line.toLowerCase();
      const n = terms.filter(t => low.includes(t)).length;
      if (n) hits.push({ courseId: c.id, course: c.name, snippet: line, score: n / terms.length });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const results = hits.slice(0, 3);
  return { results, answer: results[0] && results[0].score >= 0.5 ? results[0].snippet : undefined };
}

/* ---------------- client ---------------- */

async function req<T>(path: string, init: RequestInit | undefined, fallback: () => T, timeoutMs = 2500): Promise<T> {
  try {
    const r = await fetch(SERVICES.inbox + path, { ...init, headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as T;
  } catch {
    return demoFallback(fallback);
  }
}

export const listCourses = async (): Promise<Course[]> =>
  (await req<{ courses: Course[] }>("/courses", undefined, () => ({ courses: mockCourses.map(strip) }))).courses ?? [];

export const getCourse = (id: string) => req<CourseDetail | null>(`/courses/${encodeURIComponent(id)}`, undefined,
  () => mockCourses.find(c => c.id === id) ?? null);

export const deleteCourse = (id: string) => req<unknown>(`/courses/${encodeURIComponent(id)}`, { method: "DELETE" }, () => {
  const i = mockCourses.findIndex(c => c.id === id); if (i >= 0) mockCourses.splice(i, 1);
  return { ok: true };
});

/** Reading a syllabus is an LLM call, so it gets a long timeout. Falls back to the mock only when the service is
 *  unreachable; if it is up but fails or times out this throws, so the UI never claims deadlines that do not exist. */
export async function uploadSyllabus(u: SyllabusUpload): Promise<SyllabusResult> {
  let r: Response;
  try {
    r = await fetch(SERVICES.inbox + "/courses/syllabus", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(u), signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) throw new Error("timeout");
    await checkHealth();
    if (!isDemo()) throw new Error("offline"); // real mode: never pretend a syllabus was read
    return mockUpload(u);
  }
  if (r.status === 404 && isDemo()) return mockUpload(u); // endpoint not shipped yet
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as SyllabusResult;
}

export const searchCourses = (q: string) => req<CourseSearch>(`/courses/search?q=${encodeURIComponent(q)}`, undefined, () => mockSearch(q), 30000);
