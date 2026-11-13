// Client for the memory service (:7701). Every call is fail-soft: if memory is down we log and move on.
import { MEMORY_URL } from "./config.js";
import type { ContextResponse, MemoryEvent } from "./types.js";

const TIMEOUT_MS = 1500;

async function call<T>(method: string, pathName: string, body?: unknown): Promise<T | undefined> {
  try {
    const res = await fetch(`${MEMORY_URL}${pathName}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[memory] ${method} ${pathName} -> ${res.status}`);
      return undefined;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[memory] unreachable: ${method} ${pathName} (${(err as Error).message})`);
    return undefined;
  }
}

type NewEvent = Omit<MemoryEvent, "ts" | "agent"> & Partial<Pick<MemoryEvent, "ts" | "agent">>;

/** POST :7701/events — record what we observed. */
export async function postEvent(ev: NewEvent): Promise<void> {
  await call("POST", "/events", { ts: new Date().toISOString(), agent: "inbox", ...ev });
}

/** POST :7701/context — read memory before deciding anything. Empty context if memory is down. */
export async function getContext(query: string, k = 6): Promise<ContextResponse> {
  return (await call<ContextResponse>("POST", "/context", { query, k })) ?? { snippets: [], knowledge: [] };
}

/** Flatten a context response into a short text block for prompts. */
export function contextToText(ctx: ContextResponse, maxChars = 2500): string {
  const parts: string[] = [];
  for (const k of ctx.knowledge) parts.push(`## ${k.file}\n${k.content}`);
  if (ctx.snippets.length) parts.push("## recent memory\n" + ctx.snippets.map((s) => `- [${s.kind}] ${s.text}`).join("\n"));
  if (ctx.umem) parts.push("## umem\n" + ctx.umem);
  return parts.join("\n\n").slice(0, maxChars);
}
