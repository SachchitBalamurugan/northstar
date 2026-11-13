// Proposal queue routes (shared contract) + approve-handler registry.
// Other modules register what "approve" means for their proposal type, e.g.
//   registerApproveHandler("create_event", async (p) => { /* create the calendar event */ })
import type { FastifyInstance } from "fastify";
import { getProposal, listProposals, setProposalStatus } from "./store.js";
import type { Proposal, ProposalStatus, ProposalType } from "./types.js";

export type ApproveHandler = (p: Proposal) => Promise<Record<string, unknown> | void>;
const handlers = new Map<ProposalType, ApproveHandler>();

export function registerApproveHandler(type: ProposalType, handler: ApproveHandler): void {
  handlers.set(type, handler);
}

/** Approve a proposal: apply user edits to the payload, run its handler, then mark done/failed. */
export async function approveProposal(id: string, edits?: Record<string, unknown>): Promise<Proposal | undefined> {
  const p = getProposal(id);
  if (!p) return undefined;
  if (p.status !== "pending") return p; // already handled: never run a handler (send/create) twice
  if (edits && Object.keys(edits).length) setProposalStatus(id, p.status, edits);
  setProposalStatus(id, "approved");
  const handler = handlers.get(p.type);
  if (!handler) return setProposalStatus(id, "done"); // nothing to execute here (e.g. unsubscribe -> Machine 4)
  try {
    const result = await handler(getProposal(id)!);
    return setProposalStatus(id, "done", result ?? undefined);
  } catch (err) {
    return setProposalStatus(id, "failed", { error: (err as Error).message });
  }
}

const STATUSES: ProposalStatus[] = ["pending", "approved", "rejected", "done", "failed"];

/** Validates the approve body. Returns the allowed payload edits (only `body`), or an error string for a 400. */
export function parseApproveBody(body: unknown): { body?: string } | string {
  if (body == null || body === "") return {};
  if (typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  const payload = (body as { payload?: unknown }).payload;
  if (payload == null) return {};
  if (typeof payload !== "object" || Array.isArray(payload)) return "payload must be an object";
  const text = (payload as { body?: unknown }).body;
  if (text == null) return {};
  if (typeof text !== "string") return "payload.body must be a string";
  if (!text.trim()) return "payload.body must not be empty";
  if (text.length > 20000) return "payload.body is too long";
  return { body: text };
}

export async function proposalRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string } }>("/proposals", async (req, reply) => {
    const s = req.query.status;
    if (s !== undefined && !STATUSES.includes(s as ProposalStatus)) return reply.code(400).send({ error: `status must be one of ${STATUSES.join(", ")}` });
    return listProposals(s as ProposalStatus | undefined);
  });

  // Optional body { payload: { body?: string } }: the user's edited reply text. Other keys (e.g. the UI's `answers`) are ignored.
  app.post<{ Params: { id: string }; Body: unknown }>("/proposals/:id/approve", async (req, reply) => {
    if (!getProposal(req.params.id)) return reply.code(404).send({ error: "proposal not found" });
    const edits = parseApproveBody(req.body);
    if (typeof edits === "string") return reply.code(400).send({ error: edits });
    return await approveProposal(req.params.id, edits);
  });

  app.post<{ Params: { id: string } }>("/proposals/:id/reject", async (req, reply) => {
    const cur = getProposal(req.params.id);
    if (!cur) return reply.code(404).send({ error: "proposal not found" });
    if (cur.status !== "pending") return cur;
    return setProposalStatus(cur.id, "rejected");
  });
}
