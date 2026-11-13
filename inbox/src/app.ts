// Fastify app factory + the sync pipeline. server.ts starts it; tests import buildServer().
// Owner map:
//   src/google/*, src/gmail/*, src/calendar/*   -> Gmail / Calendar sub-agent
//   everything else in src/ (incl. src/triage/*) -> lead
import Fastify from "fastify";
import cors from "@fastify/cors";
import { MOCK, MOCK_ENV, refreshMode } from "./config.js";
import { llmAvailable } from "./llm.js";
import { proposalRoutes } from "./proposals.js";
import { getCache } from "./store.js";
import { toCalEvent } from "./types.js";
import { gmailRoutes, syncGmail } from "./gmail/routes.js";
import { calendarRoutes, syncCalendar } from "./calendar/routes.js";
import { triageRoutes, runTriage } from "./triage/routes.js";
import { courseRoutes } from "./courses/routes.js";
import { composeRoutes } from "./gmail/compose.js";
import { briefRoutes, regenerateBrief } from "./triage/brief.js";
import { authStatus } from "./google/status.js";

export interface SyncResult {
  /** "fixtures" with MOCK=1 or while Google is not configured / signed in; "google" otherwise. */
  source: "fixtures" | "google";
  emails: number;
  events: number;
  triaged: boolean;
  error?: string;
}

async function syncOnce(): Promise<SyncResult> {
  const source = refreshMode() ? "fixtures" : "google";
  const errors: string[] = [];
  let emails = getCache().emails.length;
  let events = getCache().events.length;
  // A failing Google call must not take the service down: keep whatever is cached and still triage it.
  try {
    emails = (await syncGmail()).emails;
  } catch (err) {
    errors.push(`mail: ${(err as Error).message}`);
  }
  try {
    events = (await syncCalendar()).events;
  } catch (err) {
    errors.push(`calendar: ${(err as Error).message}`);
  }
  let triaged = false;
  try {
    await runTriage();
    triaged = true;
  } catch (err) {
    errors.push(`triage: ${(err as Error).message}`);
  }
  if (triaged) regenerateBrief().catch(() => {});
  if (errors.length) console.warn("[sync]", errors.join("; "));
  return { source, emails, events, triaged, ...(errors.length ? { error: errors.join("; ") } : {}) };
}

let syncing: Promise<SyncResult> | undefined;
/** Sync mail (7 days) + calendar (14 days), then triage. Called by POST /sync and every 5 min; overlapping calls share one run. */
export function runSync(): Promise<SyncResult> {
  syncing ??= syncOnce().finally(() => (syncing = undefined));
  return syncing;
}

export async function buildServer(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? "info" } });
  // Any localhost origin, plus origin-less / file:// requests (the packaged Electron renderer sends "null").
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || origin === "null" || /^(https?|file|app):\/\/(localhost|127\.0\.0\.1|\[::1\])?(:\d+)?(\/|$)/.test(origin)),
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  // The UI posts with content-type json and sometimes no body; treat an empty JSON body as {}.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = (body as string).trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }), undefined);
    }
  });

  app.get("/health", async () => ({
    ok: true as const,
    service: "inbox" as const,
    llm: llmAvailable(),
    ...authStatus(), // { authed, configured, mock, source, email?, reason? }
  }));
  app.post("/sync", async () => runSync());

  // The next 7 days (today included) for the Activity screen. Same CalEvent shape as /calendar/today.
  app.get("/calendar/week", async () => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 7);
    return getCache()
      .events.filter((e) => new Date(e.start).getTime() < to.getTime() && new Date(e.end).getTime() > from.getTime())
      .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
      .map(toCalEvent);
  });

  // Right after Google sign-in: switch from fixtures to the real account and pull it in.
  app.addHook("onResponse", async (req, reply) => {
    if (req.url.startsWith("/auth/callback") && reply.statusCode === 200 && !refreshMode()) {
      runSync().catch((err) => app.log.warn({ err }, "post-auth sync failed"));
    }
  });

  await app.register(proposalRoutes);
  await app.register(gmailRoutes);
  await app.register(calendarRoutes);
  await app.register(triageRoutes);
  await app.register(courseRoutes);
  await app.register(composeRoutes);
  await app.register(briefRoutes);
  return app;
}
