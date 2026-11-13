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

export async function proposalRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: ProposalStatus } }>("/proposals", async (req) => listProposals(req.query.status));

  app.post<{ Params: { id: string }; Body: { payload?: Record<string, unknown> } | null }>(
    "/proposals/:id/approve",
    async (req, reply) => {
      const p = await approveProposal(req.params.id, req.body?.payload);
      if (!p) return reply.code(404).send({ error: "proposal not found" });
      return p;
    },
  );

  app.post<{ Params: { id: string } }>("/proposals/:id/reject", async (req, reply) => {
    const p = setProposalStatus(req.params.id, "rejected");
    if (!p) return reply.code(404).send({ error: "proposal not found" });
    return p;
  });
}
