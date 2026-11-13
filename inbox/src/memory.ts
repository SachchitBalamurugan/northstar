// Client for the memory service (:7701). Every call is fail-soft: if memory is down we log and move on.
import { MEMORY_URL } from "./config.js";
import type { ContextResponse, MemoryEvent } from "./types.js";

const TIMEOUT_MS = 1500;
let down = false;

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
    if (down) console.warn("[memory] reachable again");
    down = false;
    return (await res.json()) as T;
  } catch (err) {
    // one line per outage, not one per call (a triage run makes dozens of calls)
    if (!down) console.warn(`[memory] unreachable at ${MEMORY_URL}, continuing without it (${(err as Error).message})`);
    down = true;
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
  return normalizeContext(await call<unknown>("POST", "/context", { query, k }));
}

/**
 * The memory service answers `{snippets: string[], knowledge: string[]}` where a knowledge item is
 * "<file>: <excerpt>" (and "umem: <text>" for the umem mirror). The rest of inbox works with
 * `{file, content}` and MemoryEvent-shaped snippets, so convert here. Object-shaped items pass through.
 * Without this, a live memory service made /triage, /deadlines and /draft throw (k.content / s.text undefined).
 */
export function normalizeContext(raw: unknown): ContextResponse {
  const r = (raw ?? {}) as { snippets?: unknown; knowledge?: unknown; umem?: unknown };
  const out: ContextResponse = { snippets: [], knowledge: [] };
  if (typeof r.umem === "string" && r.umem) out.umem = r.umem;
  for (const k of Array.isArray(r.knowledge) ? r.knowledge : []) {
    if (typeof k === "string") {
      const m = /^([\w.-]+):\s?([\s\S]*)$/.exec(k);
      if (m?.[1] === "umem") out.umem = out.umem ?? m[2];
      else out.knowledge.push(m ? { file: m[1], content: m[2] } : { file: "memory", content: k });
    } else if (k && typeof k === "object" && typeof (k as { content?: unknown }).content === "string") {
      out.knowledge.push({ file: String((k as { file?: unknown }).file ?? "memory"), content: (k as { content: string }).content });
    }
  }
  for (const s of Array.isArray(r.snippets) ? r.snippets : []) {
    if (typeof s === "string") out.snippets.push({ ts: "", agent: "memory", source: "user", kind: "observation", text: s });
    else if (s && typeof s === "object" && typeof (s as { text?: unknown }).text === "string") out.snippets.push(s as MemoryEvent);
  }
  return out;
}

/** Flatten a context response into a short text block for prompts. */
export function contextToText(ctx: ContextResponse, maxChars = 2500): string {
  const parts: string[] = [];
  for (const k of ctx.knowledge) parts.push(`## ${k.file}\n${k.content}`);
  if (ctx.snippets.length) parts.push("## recent memory\n" + ctx.snippets.map((s) => `- [${s.kind}] ${s.text}`).join("\n"));
  if (ctx.umem) parts.push("## umem\n" + ctx.umem);
  return parts.join("\n\n").slice(0, maxChars);
}
