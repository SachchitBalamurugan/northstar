// Bridge to the "Northstar Bridge" Chrome extension (northstar/extension). The extension runs in the
// student's normal, signed-in Chrome and connects to ws://127.0.0.1:7703/bridge. Commands go out as
// {id, cmd, args}; replies come back as {id, ok, result|error}. Only chrome-extension:// origins may
// connect, so a web page can never pose as the extension.
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

let sock: WebSocket | null = null;
let version = "";
const pending = new Map<string, Pending>();

export function bridgeConnected(): boolean {
  return !!sock && sock.readyState === sock.OPEN;
}

export function bridgeInfo() {
  return { connected: bridgeConnected(), version: bridgeConnected() ? version : null };
}

/** Sends one command to the extension and waits for its answer. */
export function bridgeCall<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  const s = sock;
  if (!s || s.readyState !== s.OPEN) return Promise.reject(new Error("The Northstar Bridge extension is not connected"));
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Chrome did not answer "${cmd}" in time`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    s.send(JSON.stringify({ id, cmd, args }));
  });
}

function dropAll(reason: string) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

export async function bridgeRoutes(app: FastifyInstance) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

  app.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url?.startsWith("/bridge")) return;
    const origin = String(req.headers.origin ?? "");
    if (!origin.startsWith("chrome-extension://")) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (sock && sock !== ws) sock.close(1000, "replaced");
      sock = ws;
      app.log.info(`[bridge] Chrome extension connected (${origin})`);
      ws.on("message", (data) => {
        let msg: { id?: string; ok?: boolean; result?: unknown; error?: string; type?: string; version?: string };
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg.type === "hello") version = String(msg.version ?? "");
        if (!msg.id) return;
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || "Chrome command failed"));
      });
      ws.on("close", () => {
        if (sock === ws) {
          sock = null;
          dropAll("The Chrome extension disconnected");
          app.log.info("[bridge] Chrome extension disconnected");
        }
      });
    });
  });

  app.get("/bridge/status", async () => bridgeInfo());
}
