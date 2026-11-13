// Northstar Inbox + Calendar service (Machine 3) — entrypoint. Port 7702.
// Run: npm run dev   (tsx watch src/server.ts)
import { HOST, MOCK, PORT, SYNC_INTERVAL_MS } from "./config.js";
import { buildServer, runSync } from "./app.js";

const app = await buildServer();
await app.listen({ host: HOST, port: PORT });
app.log.info({ mock: MOCK }, `inbox service listening on http://${HOST}:${PORT}`);

runSync().catch((err) => app.log.warn({ err }, "initial sync failed"));
setInterval(() => runSync().catch((err) => app.log.warn({ err }, "periodic sync failed")), SYNC_INTERVAL_MS).unref();
