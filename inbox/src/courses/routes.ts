// Course hub: upload a syllabus, look up course info, and turn its dated items into calendar suggestions.
//   POST   /courses/syllabus {course, filename?, text?, pdfBase64?} -> { course, deadlines, proposals }
//   GET    /courses                                                 -> { courses }
//   GET    /courses/search?q=                                       -> { results (<=5), answer? }
//   GET    /courses/:id                                             -> Course & { text, deadlines }
//   DELETE /courses/:id                                             -> { ok: true }
// Nothing is put on the calendar here: every future deadline becomes a pending `create_event` Proposal whose
// payload ({ block }) is what the calendar approve handler (calendar/routes.ts) already executes.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { FIXTURES_DIR, MOCK_ENV } from "../config.js";
import { fmtDateTime } from "../calendar/create.js";
import type { PlannedBlock } from "../calendar/planner.js";
import { postEvent } from "../memory.js";
import { getProposal, newProposal, setProposalStatus } from "../store.js";
import type { Proposal } from "../types.js";
import { extractSyllabus } from "./extract.js";
import { answerFromSnippets, searchCourses } from "./search.js";
import { courseIdFor, deleteCourse, getCourse, listCourses, markSeeded, saveCourse, toCourse, wasSeeded } from "./store.js";
import type { Course, CourseDeadline, ExtractedDeadline, SearchResult, StoredCourse } from "./types.js";

export const SYLLABUS_BODY_LIMIT = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;
const SEED_FIXTURE = "syllabus-cs61b.txt";
const SEED_COURSE = "CS 61B";
const MS_MIN = 60_000;

class BadRequest extends Error {}

function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

function clipTitle(s: string, max = 60): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Same scale the planner passes to newProposal: 1 = most urgent. */
function urgencyFor(dueAt: string, now: Date): 1 | 2 | 3 {
  const days = (new Date(dueAt).getTime() - now.getTime()) / 86_400_000;
  return days <= 2 ? 1 : days <= 5 ? 2 : 3;
}

/**
 * The calendar entry for a deadline. Exams occupy their real slot (start = dueAt, 2 h unless the syllabus gives
 * an end); everything else is a 30-minute marker ending at the due time.
 */
export function blockForDeadline(courseName: string, d: ExtractedDeadline): PlannedBlock {
  const due = new Date(d.dueAt);
  const isExam = d.kind === "exam";
  const start = isExam ? due : new Date(due.getTime() - 30 * MS_MIN);
  const end = isExam ? (d.endAt ? new Date(d.endAt) : new Date(due.getTime() + 120 * MS_MIN)) : due;
  const label = `${courseName}: ${d.title}`;
  return {
    title: clipTitle(isExam || /\bdue\b/i.test(d.title) ? label : `${label} due`),
    start: start.toISOString(),
    end: end.toISOString(),
    deadlineTitle: label,
    dueAt: d.dueAt,
    minutes: Math.round((end.getTime() - start.getTime()) / MS_MIN),
  };
}

/** Pending proposals of a course that are no longer backed by a deadline are closed, never left dangling. */
function retireProposals(course: StoredCourse | undefined, keep: Set<string>): void {
  for (const d of course?.deadlines ?? []) {
    if (!d.proposalId || keep.has(d.proposalId)) continue;
    if (getProposal(d.proposalId)?.status === "pending") setProposalStatus(d.proposalId, "rejected", { superseded: true });
  }
}

export interface IngestInput { course: string; text: string; filename?: string; now?: Date }
export interface IngestResult { course: Course; deadlines: CourseDeadline[]; proposals: Proposal[] }

/** Store a syllabus, extract facts + deadlines, and (re)create one pending create_event proposal per future deadline. */
export async function ingestSyllabus(input: IngestInput): Promise<IngestResult> {
  const now = input.now ?? new Date();
  const name = input.course.replace(/\s+/g, " ").trim();
  const id = courseIdFor(name);
  const text = input.text.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim().slice(0, MAX_TEXT_CHARS);
  const extraction = await extractSyllabus(name, text, now);

  const proposals: Proposal[] = [];
  const deadlines: CourseDeadline[] = [];
  const keep = new Set<string>();
  for (const d of extraction.deadlines) {
    // Ids derive from course + title + due time, so uploading the same syllabus again maps onto the same proposals.
    const hash = shortHash(`${id}|${d.title.toLowerCase()}|${d.dueAt}`);
    const deadline: CourseDeadline = { id: `${id}-${hash}`, courseId: id, title: d.title, dueAt: d.dueAt, kind: d.kind };
    if (new Date(d.dueAt).getTime() > now.getTime()) {
      const proposalId = `syllabus-${id}-${hash}`;
      const existing = getProposal(proposalId);
      // Already approved / rejected / done: leave the user's decision alone (never create the event twice).
      const proposal =
        existing && existing.status !== "pending"
          ? existing
          : newProposal({
              id: proposalId,
              type: "create_event",
              title: blockForDeadline(name, d).title,
              why: `From your ${name} syllabus: ${d.title} ${d.kind === "exam" ? "is on" : "is due"} ${fmtDateTime(d.dueAt)}.`,
              urgency: urgencyFor(d.dueAt, now),
              dueAt: d.dueAt,
              payload: { block: blockForDeadline(name, d), source: "syllabus", courseId: id, deadlineId: deadline.id, kind: d.kind },
            });
      deadline.proposalId = proposal.id;
      keep.add(proposal.id);
      proposals.push(proposal);
    }
    deadlines.push(deadline);
  }
  retireProposals(getCourse(id), keep);

  const stored = saveCourse({
    id,
    name,
    ...(input.filename ? { filename: input.filename } : {}),
    uploadedAt: now.toISOString(),
    summary: extraction.summary,
    deadlineCount: deadlines.length,
    facts: extraction.facts,
    text,
    deadlines,
  });

  // Best-effort observations for memory; postEvent never throws and never fails the upload.
  await Promise.allSettled(
    deadlines.map((d) =>
      postEvent({
        source: "user",
        kind: "deadline",
        text: `${name}: ${d.title} ${d.kind === "exam" ? "on" : "due"} ${fmtDateTime(d.dueAt)} (from the syllabus)`,
        tags: ["syllabus", `course:${id}`, `kind:${d.kind}`, `due:${d.dueAt}`],
      }),
    ),
  );

  return { course: toCourse(stored), deadlines, proposals };
}

async function pdfToText(base64: string): Promise<string> {
  const b64 = base64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 5 || buf.subarray(0, 1024).indexOf("%PDF-") === -1) throw new BadRequest("That file is not a PDF. Upload a PDF or paste the syllabus text.");
  let pages: string[];
  try {
    const { extractText } = await import("unpdf"); // lazy: pdf.js is only loaded when a PDF is uploaded
    pages = (await extractText(new Uint8Array(buf), { mergePages: false })).text;
  } catch (err) {
    throw new BadRequest(`Could not read that PDF (${(err as Error).message.slice(0, 120)}). Try pasting the syllabus text instead.`);
  }
  return pages.join("\n\n").trim();
}

let seeding: Promise<void> | undefined;
/** MOCK=1 with nothing stored: load the sample syllabus once so the UI has a course to show. */
export function ensureSeeded(): Promise<void> {
  if (!MOCK_ENV || wasSeeded() || listCourses().length) return Promise.resolve();
  seeding ??= (async () => {
    try {
      const text = fs.readFileSync(path.join(FIXTURES_DIR, SEED_FIXTURE), "utf8");
      await ingestSyllabus({ course: SEED_COURSE, text, filename: SEED_FIXTURE });
    } catch (err) {
      console.warn(`[courses] could not seed the sample syllabus (${(err as Error).message})`);
    }
    markSeeded();
  })().finally(() => (seeding = undefined));
  return seeding;
}

interface SyllabusBody { course?: unknown; filename?: unknown; text?: unknown; pdfBase64?: unknown }

export async function courseRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: SyllabusBody }>("/courses/syllabus", { bodyLimit: SYLLABUS_BODY_LIMIT }, async (req, reply) => {
    const body = (req.body ?? {}) as SyllabusBody;
    const course = typeof body.course === "string" ? body.course.trim() : "";
    if (!course) return reply.code(400).send({ error: "course is required (for example \"CS 61B\")" });
    if (course.length > 80) return reply.code(400).send({ error: "course name is too long (80 characters max)" });
    const filename = typeof body.filename === "string" && body.filename.trim() ? path.basename(body.filename.trim()).slice(0, 200) : undefined;
    let text = typeof body.text === "string" ? body.text.trim() : "";
    const pdf = typeof body.pdfBase64 === "string" ? body.pdfBase64.trim() : "";
    if (!text && !pdf) return reply.code(400).send({ error: "Send the syllabus as text or as pdfBase64." });
    if (!text) {
      try {
        text = await pdfToText(pdf);
      } catch (err) {
        if (err instanceof BadRequest) return reply.code(400).send({ error: err.message });
        throw err;
      }
      if (!text.replace(/\s+/g, "")) return reply.code(400).send({ error: "That PDF has no text to read (it may be a scan). Paste the syllabus text instead." });
    }
    return ingestSyllabus({ course, text, filename });
  });

  app.get("/courses", async () => {
    await ensureSeeded();
    return { courses: listCourses().map(toCourse) };
  });

  app.get<{ Querystring: { q?: string } }>("/courses/search", async (req) => {
    await ensureSeeded();
    const q = String(req.query.q ?? "").trim().slice(0, 300);
    if (!q) return { results: [] as SearchResult[] };
    const results = searchCourses(listCourses(), q);
    const answer = await answerFromSnippets(q, results);
    return { results, ...(answer ? { answer } : {}) };
  });

  app.get<{ Params: { id: string } }>("/courses/:id", async (req, reply) => {
    await ensureSeeded();
    const c = getCourse(req.params.id) ?? getCourse(courseIdFor(req.params.id));
    if (!c) return reply.code(404).send({ error: "course not found" });
    return { ...toCourse(c), text: c.text, deadlines: c.deadlines };
  });

  app.delete<{ Params: { id: string } }>("/courses/:id", async (req, reply) => {
    const c = getCourse(req.params.id);
    if (!c) return reply.code(404).send({ error: "course not found" });
    retireProposals(c, new Set());
    deleteCourse(c.id);
    return { ok: true as const };
  });
}
