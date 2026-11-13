// Triage + draft routes. `runTriage` is also used by app.ts' sync loop.
import type { FastifyInstance } from "fastify";
import { getCache } from "../store.js";
import { collectDeadlines, runTriage } from "./triage.js";
import { draftReply, NotFoundError } from "./draft.js";

export { runTriage };

export async function triageRoutes(app: FastifyInstance): Promise<void> {
  // Cached triage; runs it the first time.
  app.get("/triage", async () => getCache().triage ?? (await runTriage()));

  // Force a fresh run (e.g. after the user edits memory).
  app.post("/triage/run", async () => runTriage());

  // Flattened deadlines sorted by dueAt. `?all=1` includes ones already past.
  app.get<{ Querystring: { all?: string } }>("/deadlines", async (req) => {
    const triage = getCache().triage ?? (await runTriage());
    return collectDeadlines(triage, { includePast: req.query.all === "1" });
  });

  app.post<{ Body: { emailId?: string } | null }>("/draft", async (req, reply) => {
    const emailId = req.body?.emailId;
    if (!emailId) return reply.code(400).send({ error: "emailId required" });
    try {
      return await draftReply(emailId);
    } catch (err) {
      if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });
}
