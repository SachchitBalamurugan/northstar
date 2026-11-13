// Proposal store + the contract's /proposals routes. Nothing irreversible runs without an approve.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { DATA_DIR } from "./config.js";
import type { Proposal, ProposalStatus, ProposalType } from "./types.js";

const FILE = path.join(DATA_DIR, "proposals.json");
const store = new Map<string, Proposal>();

try {
  for (const p of JSON.parse(fs.readFileSync(FILE, "utf8")) as Proposal[]) store.set(p.id, p);
} catch {
  /* first run */
}

function persist() {
  fs.writeFileSync(FILE, JSON.stringify([...store.values()], null, 2));
}

export function createProposal(
  p: Pick<Proposal, "type" | "title" | "why" | "payload"> & Partial<Pick<Proposal, "urgency" | "dueAt">>,
): Proposal {
  const full: Proposal = {
    id: randomUUID(),
    agent: "actions",
    createdAt: new Date().toISOString(),
    status: "pending",
    urgency: 2,
    ...p,
    title: p.title.slice(0, 60),
  };
  store.set(full.id, full);
  persist();
  return full;
}

export function getProposal(id: string): Proposal | undefined {
  return store.get(id);
}

export function listProposals(status?: ProposalStatus): Proposal[] {
  const all = [...store.values()].sort((a, b) => b.urgency - a.urgency || a.createdAt.localeCompare(b.createdAt));
  return status ? all.filter((p) => p.status === status) : all;
}

export function updateProposal(id: string, patch: Partial<Proposal>): Proposal | undefined {
  const cur = store.get(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch, id: cur.id };
  store.set(id, next);
  persist();
  if (next.status !== cur.status && (next.status === "done" || next.status === "failed" || next.status === "rejected"))
    for (const l of settledListeners)
      try {
        l(next);
      } catch {
        /* a listener must never break the proposal flow */
      }
  return next;
}

/** Called once a proposal reaches "done", "failed" or "rejected" (used by the run registry). */
const settledListeners: Array<(p: Proposal) => void> = [];
export function onProposalSettled(listener: (p: Proposal) => void) {
  settledListeners.push(listener);
}

/**
 * Runs when a proposal of this type is approved. Return a payload patch (merged into payload) or void.
 * Throwing marks the proposal "failed" with payload.error set.
 */
export type ApproveHandler = (p: Proposal, input?: ApproveInput) => Promise<Record<string, unknown> | void>;
/** Optional body of POST /proposals/:id/approve. `answers` maps a field selector to the user's answer. */
export interface ApproveInput {
  answers?: Record<string, string>;
}
const handlers = new Map<ProposalType, ApproveHandler>();

export function onApprove(type: ProposalType, handler: ApproveHandler) {
  handlers.set(type, handler);
}

/** Approve + execute. Used by POST /proposals/:id/approve and POST /submit. */
export async function approveProposal(id: string, input?: ApproveInput): Promise<Proposal | undefined> {
  const p = store.get(id);
  if (!p) return undefined;
  if (p.status !== "pending") return p;
  updateProposal(id, { status: "approved" });
  const handler = handlers.get(p.type);
  if (!handler) return updateProposal(id, { status: "done" });
  try {
    const patch = await handler(store.get(id)!, input);
    return updateProposal(id, { status: "done", payload: { ...store.get(id)!.payload, ...(patch ?? {}) } });
  } catch (err) {
    return updateProposal(id, {
      status: "failed",
      payload: { ...store.get(id)!.payload, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** Keeps only string answers; anything else in the body is ignored. */
export function parseApproveInput(body: unknown): ApproveInput {
  const raw = body && typeof body === "object" ? (body as { answers?: unknown }).answers : undefined;
  const answers: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v.trim()) answers[k] = v.trim();
  return { answers };
}

export async function proposalRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: ProposalStatus } }>("/proposals", async (req) =>
    listProposals(req.query.status),
  );

  app.post<{ Params: { id: string }; Body: ApproveInput | null }>("/proposals/:id/approve", async (req, reply) => {
    const p = await approveProposal(req.params.id, parseApproveInput(req.body));
    if (!p) return reply.code(404).send({ error: "proposal not found" });
    return p;
  });

  app.post<{ Params: { id: string } }>("/proposals/:id/reject", async (req, reply) => {
    const cur = getProposal(req.params.id);
    if (!cur) return reply.code(404).send({ error: "proposal not found" });
    if (cur.status !== "pending") return cur;
    return updateProposal(cur.id, { status: "rejected" });
  });
}
