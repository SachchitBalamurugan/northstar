// Course hub shapes (served by src/courses/routes.ts).
export type DeadlineKind = "exam" | "assignment" | "project" | "other";

export interface CourseFact { label: string; value: string }

export interface Course {
  id: string;
  name: string;
  filename?: string;
  uploadedAt: string; // ISO
  summary: string;
  deadlineCount: number;
  facts: CourseFact[]; // <= 8
}

export interface CourseDeadline {
  id: string;
  courseId: string;
  title: string;
  dueAt: string; // ISO
  kind: DeadlineKind;
  proposalId?: string;
}

/** What is persisted per course in data/courses.json. */
export interface StoredCourse extends Course {
  text: string;
  deadlines: CourseDeadline[];
}

/** Extractor output, before ids are assigned. `endAt` is set when the syllabus gives an end time (exams). */
export interface ExtractedDeadline { title: string; dueAt: string; kind: DeadlineKind; endAt?: string }
export interface Extraction { summary: string; facts: CourseFact[]; deadlines: ExtractedDeadline[] }

export interface SearchResult { courseId: string; course: string; snippet: string; score: number }
