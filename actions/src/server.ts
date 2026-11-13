import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { FIXTURES_DIR, MOCK, PORT } from "./config.js";
import { proposalRoutes } from "./proposals.js";
import { profileRoutes } from "./profile.js";
import { closeBrowser } from "./browser.js";
import fillRoutes from "./fill/index.js";
import sidekickRoutes from "./sidekick/index.js";

const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });
await app.register(cors, { origin: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] });
await app.register(fastifyStatic, { root: FIXTURES_DIR, prefix: "/fixtures/" });

app.get("/health", async () => ({ ok: true, service: "actions", mock: MOCK }));

await app.register(proposalRoutes);
await app.register(profileRoutes);
await app.register(fillRoutes); // POST /fill, POST /submit
await app.register(sidekickRoutes); // POST /sidekick (SSE)

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await closeBrowser();
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: "127.0.0.1", port: PORT });
