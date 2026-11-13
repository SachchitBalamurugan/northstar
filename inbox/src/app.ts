// Fastify app factory + the sync pipeline. server.ts starts it; tests import buildServer().
// Owner map:
//   src/google/auth.ts, src/gmail/*        -> Gmail sub-agent
//   src/calendar/*                         -> Calendar scheduler sub-agent
//   src/llm.ts, src/triage/*, fixtures/    -> Triage/Draft LLM sub-agent
//   everything else in src/               -> lead (shared)
import Fastify from "fastify";
import cors from "@fastify/cors";
import { MOCK } from "./config.js";
import { proposalRoutes } from "./proposals.js";
import { gmailRoutes, syncGmail } from "./gmail/routes.js";
import { calendarRoutes, syncCalendar } from "./calendar/routes.js";
import { calendarAgentRoutes } from "./calendar/add.js";
import { triageRoutes, runTriage } from "./triage/routes.js";

export interface SyncResult {
  emails: number;
  events: number;
  triaged: boolean;
  error?: string;
}

/** Sync mail + calendar (fixtures in MOCK mode), then re-run triage. Called by POST /sync and every 5 min. */
export async function runSync(): Promise<SyncResult> {
  const mail = await syncGmail();
  const cal = await syncCalendar();
  try {
    await runTriage();
    return { emails: mail.emails, events: cal.events, triaged: true };
  } catch (err) {
    const error = (err as Error).message;
    console.warn("[sync] triage failed:", error);
    return { emails: mail.emails, events: cal.events, triaged: false, error };
  }
}

export async function buildServer(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cors, { origin: [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/], methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] });

  app.get("/health", async () => ({ ok: true as const, service: "inbox" as const, mock: MOCK }));
  app.post("/sync", async () => runSync());

  await app.register(proposalRoutes);
  await app.register(gmailRoutes);
  await app.register(calendarRoutes);
  await app.register(calendarAgentRoutes);
  await app.register(triageRoutes);
  return app;
}
