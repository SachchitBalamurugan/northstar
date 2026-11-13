// Run registry: every automation (Sidekick task or form fill) that is running or has run.
// Kept in memory and mirrored to ${DATA_DIR}/runs.json. Screenshots are never stored here.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { DATA_DIR } from "./config.js";
import { onProposalSettled } from "./proposals.js";

export interface RunStep {
  step: number;
  action: string;
  detail: string;
  at: string;
}
export type RunStatus = "running" | "done" | "stopped" | "error";
export interface Run {
  id: string;
  kind: "sidekick" | "fill";
  instruction: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  steps: RunStep[];
  lastDetail: string;
  proposalId?: string;
  url?: string;
}

/** Thrown by long-running work when its run was cancelled through POST /runs/:id/cancel. */
export class RunCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "RunCancelled";
  }
}

const FILE = path.join(DATA_DIR, "runs.json");
const MAX_STORED = 100;
const MAX_LISTED = 30;
const MAX_STEPS_STORED = 200;

/** Oldest first. */
let runs: Run[] = [];
const cancelled = new Set<string>();

function persist() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(runs, null, 2));
  } catch {
    /* the registry still works in memory */
  }
}

try {
  const loaded = JSON.parse(fs.readFileSync(FILE, "utf8")) as Run[];
  if (Array.isArray(loaded)) {
    runs = loaded.filter((r) => r && typeof r.id === "string" && Array.isArray(r.steps)).slice(-MAX_STORED);
    let changed = false;
    for (const r of runs) {
      if (r.status !== "running") continue;
      r.status = "error";
      r.lastDetail = "Interrupted by restart";
      r.endedAt = new Date().toISOString();
      r.steps.push({ step: r.steps.length + 1, action: "error", detail: r.lastDetail, at: r.endedAt });
      changed = true;
    }
    if (changed) persist();
  }
} catch {
  /* first run */
}

export function createRun(kind: Run["kind"], instruction: string, url?: string): Run {
  const run: Run = {
    id: randomUUID(),
    kind,
    instruction,
    status: "running",
    startedAt: new Date().toISOString(),
    steps: [],
    lastDetail: "",
    ...(url ? { url } : {}),
  };
  runs.push(run);
  if (runs.length > MAX_STORED) runs = runs.slice(-MAX_STORED);
  persist();
  return run;
}

export function getRun(id: string): Run | undefined {
  return runs.find((r) => r.id === id);
}

export function listRuns(status?: string): Run[] {
  const all = [...runs].reverse();
  return (status ? all.filter((r) => r.status === status) : all).slice(0, MAX_LISTED);
}

function pushStep(run: Run, action: string, detail: string) {
  const at = new Date().toISOString();
  run.steps.push({ step: (run.steps[run.steps.length - 1]?.step ?? 0) + 1, action, detail, at });
  if (run.steps.length > MAX_STEPS_STORED) run.steps.splice(0, run.steps.length - MAX_STEPS_STORED);
  run.lastDetail = detail;
}

/** Records one step of a run that is still running. Ignored once the run has ended. */
export function addRunStep(id: string, action: string, detail: string, patch?: { url?: string }) {
  const run = getRun(id);
  if (!run || run.status !== "running") return;
  pushStep(run, action, detail);
  if (patch?.url) run.url = patch.url;
  persist();
}

/** Ends a running run. `step` is recorded as the final step when given. Ignored once the run has ended. */
export function finishRun(
  id: string,
  status: Exclude<RunStatus, "running">,
  opts: { step?: { action: string; detail: string }; proposalId?: string; url?: string } = {},
): Run | undefined {
  const run = getRun(id);
  if (!run || run.status !== "running") return run;
  if (opts.step) pushStep(run, opts.step.action, opts.step.detail);
  if (opts.proposalId) run.proposalId = opts.proposalId;
  if (opts.url) run.url = opts.url;
  run.status = status;
  run.endedAt = new Date().toISOString();
  cancelled.delete(id);
  persist();
  return run;
}

/** True once POST /runs/:id/cancel was called for this run. Runners check this between steps. */
export function isCancelled(id: string): boolean {
  return cancelled.has(id);
}

/** Marks a running run cancelled right away; the runner notices at its next step and stops working. */
export function cancelRun(id: string): Run | undefined {
  const run = getRun(id);
  if (!run || run.status !== "running") return run;
  finishRun(id, "error", { step: { action: "error", detail: "Cancelled" } });
  cancelled.add(id); // after finishRun, which clears the flag
  return run;
}

// A run paused for approval follows its proposal's outcome.
onProposalSettled((p) => {
  const run = runs.find((r) => r.proposalId === p.id && r.status === "stopped");
  if (!run) return;
  if (p.status === "done") {
    const confirmation = typeof p.payload?.confirmation === "string" ? p.payload.confirmation.replace(/\s+/g, " ").trim() : "";
    pushStep(run, "done", p.type === "fill_form" || confirmation ? `Submitted. ${confirmation}`.trim() : "Approved by you.");
    run.status = "done";
  } else if (p.status === "failed") {
    pushStep(run, "error", typeof p.payload?.error === "string" && p.payload.error ? p.payload.error : "The approved action failed.");
    run.status = "error";
  } else if (p.status === "rejected") {
    pushStep(run, "done", "Skipped by you");
    run.status = "done";
  } else return;
  run.endedAt = new Date().toISOString();
  persist();
});

export async function runRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string } }>("/runs", async (req) => listRuns(req.query.status));

  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const run = getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return run;
  });

  app.post<{ Params: { id: string } }>("/runs/:id/cancel", async (req, reply) => {
    const run = cancelRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return run;
  });
}
