// Whose name goes at the bottom of an email. The Knowledge folder may still describe the demo student
// ("Maya"); the user's own Profile (Knowledge/profile.md, "- Name: ...") always wins. No profile name → no name.
import { MEMORY_URL } from "./config.js";

const DEMO_NAMES = /\bMaya\b/g;

export async function signerName(): Promise<string | null> {
  try {
    const r = await fetch(`${MEMORY_URL}/knowledge/profile.md`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const { content } = (await r.json()) as { content?: string };
    const m = content?.match(/^- Name:\s*(.+)$/m);
    return m?.[1]?.trim() || null;
  } catch { return null; }
}

/** Prompt rule appended to every email-writing system prompt. */
export function signRule(name: string | null): string {
  return name
    ? `\nSign off with the user's real name "${name}". Ignore any other name that appears in the context (it is demo data).`
    : `\nDo not sign with a personal name (end with just "Thanks!" or "Best,"). Ignore any name like "Maya" in the context; it is demo data.`;
}

/** Swap a demo-name sign-off ("Thanks! Maya") for the real one, or drop the name. */
export function fixSignOff(text: string, name: string | null): string {
  return name ? text.replace(DEMO_NAMES, name) : text.replace(/[ \t]*\bMaya\b[ \t]*$/gm, "").replace(DEMO_NAMES, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}
