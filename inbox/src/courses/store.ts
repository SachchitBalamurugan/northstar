// Persistent course store: data/courses.json (syllabus text, extracted facts and deadlines).
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import type { Course, StoredCourse } from "./types.js";

const COURSES_PATH = path.join(DATA_DIR, "courses.json");

interface State { courses: StoredCourse[]; seeded?: boolean }

function read(): State {
  try {
    const raw = JSON.parse(fs.readFileSync(COURSES_PATH, "utf8")) as Partial<State>;
    return { courses: Array.isArray(raw.courses) ? raw.courses : [], seeded: raw.seeded === true };
  } catch {
    return { courses: [] };
  }
}

let state: State = read();

function persist(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${COURSES_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, COURSES_PATH);
}

/** "CS 61B" and "cs61b" are the same course: the id is the name lowercased with everything but letters/digits removed. */
export function courseIdFor(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return id || "course";
}

export function listCourses(): StoredCourse[] {
  return [...state.courses];
}
export function getCourse(id: string): StoredCourse | undefined {
  return state.courses.find((c) => c.id === id);
}
/** Insert or replace by id. Newest upload first. */
export function saveCourse(course: StoredCourse): StoredCourse {
  state.courses = [course, ...state.courses.filter((c) => c.id !== course.id)];
  persist();
  return course;
}
export function deleteCourse(id: string): StoredCourse | undefined {
  const found = getCourse(id);
  if (!found) return undefined;
  state.courses = state.courses.filter((c) => c.id !== id);
  persist();
  return found;
}

/** The MOCK fixture is seeded once per data dir, so deleting the sample course does not bring it back. */
export function wasSeeded(): boolean {
  return state.seeded === true;
}
export function markSeeded(): void {
  state.seeded = true;
  persist();
}

/** Public shape: no text, no deadline list. */
export function toCourse(c: StoredCourse): Course {
  return {
    id: c.id,
    name: c.name,
    ...(c.filename ? { filename: c.filename } : {}),
    uploadedAt: c.uploadedAt,
    summary: c.summary,
    deadlineCount: c.deadlines.length,
    facts: c.facts,
  };
}

/** Test helper. */
export function resetCourses(): void {
  state = { courses: [] };
  persist();
}
