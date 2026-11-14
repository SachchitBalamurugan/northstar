import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { FIXTURES_DIR, MOCK, PORT } from "./config.js";
import { proposalRoutes } from "./proposals.js";
import { profileRoutes } from "./profile.js";
import { runRoutes } from "./runs.js";
import { closeBrowser } from "./browser.js";
import fillRoutes from "./fill/index.js";
import sidekickRoutes from "./sidekick/index.js";
import { desktopRoutes } from "./desktop/agent.js";
import tabRoutes from "./tabs/index.js";
import activityRoutes from "./activity/index.js";
import linkedinRoutes from "./linkedin/index.js";
import { bridgeRoutes } from "./bridge.js";
import { checkpointRoutes } from "./checkpoints.js";

const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });
// This service can act in the student's signed-in Chrome, so only Northstar itself may call it:
// the Electron/Vite renderer on localhost, the packaged app (Origin "null"/file), or no Origin (curl, services).
const LOCAL_ORIGIN = /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|null|file:\/\/.*)$/i;
await app.register(cors, {
  origin: (origin, cb) => cb(null, !origin || LOCAL_ORIGIN.test(origin)),
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});
app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(origin) && !origin.startsWith("chrome-extension://"))
    return reply.code(403).send({ error: "Only the Northstar app may call this service" });
});
await app.register(fastifyStatic, { root: FIXTURES_DIR, prefix: "/fixtures/" });

app.get("/health", async () => ({ ok: true, service: "actions", mock: MOCK }));

await app.register(proposalRoutes);
await app.register(profileRoutes);
await app.register(runRoutes); // GET /runs, GET /runs/:id, POST /runs/:id/cancel
await app.register(fillRoutes); // POST /fill, POST /submit
await app.register(sidekickRoutes); // POST /sidekick (SSE)
await app.register(desktopRoutes); // GET /desktop/status
await app.register(activityRoutes); // GET /activity, POST /activity/enable (opt-in: which app/site/document is in front)
await app.register(tabRoutes); // GET /tabs, POST /tabs/organize, /tabs/sessions*, POST /tabs/archive
await app.register(bridgeRoutes); // ws /bridge (Chrome extension), GET /bridge/status
await app.register(checkpointRoutes); // GET /checkpoints, POST /checkpoints/:id (answers from the popup)
await app.register(linkedinRoutes); // POST /linkedin/import, GET /linkedin, POST /apply/batch

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await closeBrowser();
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: "127.0.0.1", port: PORT });
