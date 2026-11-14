// Checkpoints: the few moments a running task waits for the student, answered right in the Northstar
// popup (POST /checkpoints/:id). The task does not end; it pauses on a promise and carries on.
//   plan    — once per task, before anything happens: "Run" or "Run & submit" or cancel
//   submit  — a final submit/send that was not pre-approved with "Run & submit"
//   payment — anything that pays; always asked, never pre-approved
//   signin  — a password field: the student signs in themselves, then presses Continue
//   question— the agent needs a fact it was not given; the student types the answer
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { isCancelled } from "./runs.js";

export type CheckpointKind = "plan" | "submit" | "payment" | "signin" | "question";
export type Decision = "run" | "run_submit" | "approve" | "skip" | "cancel" | "continue" | "answer";

export interface Checkpoint {
  id: string;
  runId: string;
  kind: CheckpointKind;
  title: string;
  detail: string;
  /** plan only */
  steps?: string[];
  finalAction?: string | null;
  createdAt: string;
  status: "pending" | "answered" | "expired";
  decision?: Decision;
  answer?: string;
}

export interface CheckpointResult {
  decision: Decision;
  answer?: string;
}

const items = new Map<string, Checkpoint>();
const waiters = new Map<string, (r: CheckpointResult) => void>();
const WAIT_MS = 20 * 60_000;

export function openCheckpoint(c: Omit<Checkpoint, "id" | "createdAt" | "status">): Checkpoint {
  const cp: Checkpoint = { ...c, id: randomUUID(), createdAt: new Date().toISOString(), status: "pending" };
  items.set(cp.id, cp);
  // Keep the store small: drop answered ones older than an hour.
  const cutoff = Date.now() - 3_600_000;
  for (const [id, x] of items) if (x.status !== "pending" && Date.parse(x.createdAt) < cutoff) items.delete(id);
  return cp;
}

/** Waits until the student answers, the run is cancelled ("cancel"), or 20 minutes pass ("cancel"). */
export function waitCheckpoint(cp: Checkpoint): Promise<CheckpointResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: CheckpointResult, status: Checkpoint["status"] = "answered") => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      waiters.delete(cp.id);
      cp.status = status;
      cp.decision = r.decision;
      if (r.answer !== undefined) cp.answer = r.answer;
      resolve(r);
    };
    waiters.set(cp.id, (r) => finish(r));
    const poll = setInterval(() => {
      if (isCancelled(cp.runId)) finish({ decision: "cancel" }, "expired");
    }, 500);
    const timer = setTimeout(() => finish({ decision: "cancel" }, "expired"), WAIT_MS);
  });
}

const ALLOWED: Record<CheckpointKind, Decision[]> = {
  plan: ["run", "run_submit", "cancel"],
  submit: ["approve", "skip"],
  payment: ["approve", "skip"],
  signin: ["continue", "skip"],
  question: ["answer", "skip"],
};

export async function checkpointRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string } }>("/checkpoints", async (req) => {
    const all = [...items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return req.query.status ? all.filter((c) => c.status === req.query.status) : all;
  });

  app.post<{ Params: { id: string }; Body: { decision?: unknown; answer?: unknown } }>("/checkpoints/:id", async (req, reply) => {
    const cp = items.get(req.params.id);
    if (!cp) return reply.code(404).send({ error: "checkpoint not found" });
    if (cp.status !== "pending") return reply.code(409).send({ error: "already answered", checkpoint: cp });
    const decision = String(req.body?.decision ?? "") as Decision;
    if (!ALLOWED[cp.kind].includes(decision)) return reply.code(400).send({ error: `decision must be one of ${ALLOWED[cp.kind].join(", ")}` });
    const answer = typeof req.body?.answer === "string" ? req.body.answer.slice(0, 4000) : undefined;
    if (decision === "answer" && !answer?.trim()) return reply.code(400).send({ error: "answer is required" });
    waiters.get(cp.id)?.({ decision, answer });
    return cp;
  });
}
