// Triage + draft routes. `runTriage` is also used by app.ts' sync loop.
import type { FastifyInstance } from "fastify";
import { getCache } from "../store.js";
import { toWireEmail, type TriageResponse } from "../types.js";
import { collectDeadlines, runTriage as runTriageNow } from "./triage.js";
import { draftReply, NotFoundError } from "./draft.js";

// Single flight: a sync and a GET /triage arriving together share one run (one set of LLM calls).
let inFlight: Promise<TriageResponse> | undefined;
export function runTriage(): Promise<TriageResponse> {
  inFlight ??= runTriageNow().finally(() => (inFlight = undefined));
  return inFlight;
}

/** Contract shape for the UI: Email fields (id, fromRole, dueAt) on every item, needsYou never above 5. */
function toWire(t: TriageResponse) {
  return { needsYou: t.needsYou.slice(0, 5).map((e) => toWireEmail(e)), fyi: t.fyi.map((e) => toWireEmail(e)), ignored: t.ignored };
}

export async function triageRoutes(app: FastifyInstance): Promise<void> {
  // Cached triage; runs it the first time.
  app.get("/triage", async () => toWire(getCache().triage ?? (await runTriage())));

  // Force a fresh run (e.g. after the user edits memory).
  app.post("/triage/run", async () => toWire(await runTriage()));

  // Flattened deadlines sorted by dueAt. `?all=1` includes ones already past.
  app.get<{ Querystring: { all?: string } }>("/deadlines", async (req) => {
    const triage = getCache().triage ?? (await runTriage());
    return collectDeadlines(triage, { includePast: req.query.all === "1" });
  });

  app.post<{ Body: { emailId?: string } | null }>("/draft", async (req, reply) => {
    const emailId = req.body?.emailId;
    if (typeof emailId !== "string" || !emailId) return reply.code(400).send({ error: "emailId required" });
    try {
      return await draftReply(emailId);
    } catch (err) {
      if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });
}
