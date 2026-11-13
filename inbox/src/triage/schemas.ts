// Zod schemas mirroring contracts/types.ts for Structured Outputs.
// Rules for OpenAI strict JSON schema: every field required (use .nullable(), never .optional()),
// no unsupported keywords (no min/max/regex/format), closed objects.
import { z } from "zod";

export const BucketSchema = z.enum(["needsYou", "fyi", "ignore"]);
export const UrgencySchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const SenderRoleSchema = z.enum(["prof", "ta", "recruiter", "club", "admin", "promo", "peer", "other"]);

export const DeadlineSchema = z.object({
  title: z.string().describe("Short task name, e.g. 'CS61B Project 2 (Gitlet)'"),
  dueAt: z.string().describe("ISO 8601 date-time with timezone offset, e.g. 2026-11-20T17:00:00-08:00"),
  course: z.string().nullable().describe("Course code like CS61B, or null"),
  effortMinutes: z.int().describe("Estimated minutes of focused work: project 180, homework 120, form 30, reply 10"),
});

/** What the model returns per email. Metadata (from/subject/receivedAt/snippet) is filled from the cache. */
export const TriageItemSchema = z.object({
  emailId: z.string(),
  bucket: BucketSchema,
  urgency: UrgencySchema.describe("1 = most urgent"),
  senderRole: SenderRoleSchema,
  deadlines: z.array(DeadlineSchema),
  asks: z.array(z.string()).describe("Concrete things the sender wants from the student"),
  why: z.string().describe("One sentence; cite memory when it applies"),
});

/** Full contract shape (TriagedEmail) — used to validate what we store and serve. */
export const TriagedEmailSchema = TriageItemSchema.extend({
  from: z.string(),
  subject: z.string(),
  receivedAt: z.string(),
  snippet: z.string(),
});

export const TriageBatchSchema = z.object({ items: z.array(TriageItemSchema) });

export const DraftSchema = z.object({
  subject: z.string(),
  body: z.string().describe("Plain-text reply in the student's voice, ending with their usual sign-off"),
});

export type TriageItem = z.infer<typeof TriageItemSchema>;
export type TriageBatch = z.infer<typeof TriageBatchSchema>;
export type Draft = z.infer<typeof DraftSchema>;
