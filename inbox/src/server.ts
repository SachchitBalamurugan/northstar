// Northstar Inbox + Calendar service (Machine 3) — entrypoint. Port 7702.
// Run: npm run dev   (tsx watch src/server.ts)
import { HOST, PORT, SYNC_INTERVAL_MS } from "./config.js";
import { buildServer, runSync } from "./app.js";
import { authStatus } from "./google/status.js";

const app = await buildServer();
await app.listen({ host: HOST, port: PORT });
const status = authStatus();
app.log.info(
  { source: status.source, mock: status.mock, configured: status.configured, authed: status.authed },
  `inbox service listening on http://${HOST}:${PORT} (data: ${status.source}${status.reason ? `. ${status.reason}` : ""})`,
);

runSync().catch((err) => app.log.warn({ err }, "initial sync failed"));
setInterval(() => runSync().catch((err) => app.log.warn({ err }, "periodic sync failed")), SYNC_INTERVAL_MS).unref();
