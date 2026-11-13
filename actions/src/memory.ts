// Client for the memory service (:7701). Memory being down is never fatal.
import { MEMORY_URL, MOCK } from "./config.js";
import type { MemoryEvent } from "./types.js";

export interface MemoryContext {
  snippets: string[];
  knowledge: string[];
}

const MOCK_CONTEXT: MemoryContext = {
  snippets: [
    "Maya is hunting for a summer software engineering internship.",
    "Maya is on the robotics club software team and built the vision pipeline for the 2026 competition bot.",
    "Best focus hours are 2-5pm.",
  ],
  knowledge: [
    "goals.md: Land a summer SWE internship; keep GPA above 3.5; ship the robotics club autonomous nav stack.",
    "README.md: Maya Chen, CS sophomore with ADHD. Likes building things that help people stay organised.",
    "writingstyle.md: Casual but polite. Short sentences. No buzzwords. Signs off with 'Thanks, Maya'.",
  ],
};

async function call(path: string, body: unknown, timeoutMs = 2500): Promise<any | null> {
  try {
    const res = await fetch(`${MEMORY_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null;
  }
}

const asStrings = (xs: unknown): string[] =>
  Array.isArray(xs) ? xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [];

/** Read context before deciding anything. If memory is unreachable: fixture context in MOCK mode, else empty. */
export async function getContext(query: string, k = 8): Promise<MemoryContext> {
  const res = await call("/context", { query, k });
  if (res) return { snippets: asStrings(res.snippets), knowledge: asStrings(res.knowledge) };
  return MOCK ? MOCK_CONTEXT : { snippets: [], knowledge: [] };
}

/** Write an observation to memory. Returns false if memory was unreachable. */
export async function postEvent(
  ev: Omit<MemoryEvent, "ts" | "agent"> & { ts?: string },
): Promise<boolean> {
  const full: MemoryEvent = { ts: new Date().toISOString(), agent: "actions", ...ev };
  return (await call("/events", full)) !== null;
}
