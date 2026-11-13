// Who the student is. The name the user typed into Northstar lives in the actions service (GET :7703/profile);
// nothing here is ever a made-up person. Demo mode (MOCK=1) keeps the demo student.
import { ACTIONS_URL, MOCK_ENV } from "./config.js";

let cached: { at: number; name: string } | null = null;

/** The student's first name, or "" when they have not told Northstar yet. Cached for a minute. */
export async function studentName(): Promise<string> {
  if (MOCK_ENV) return "Maya";
  if (cached && Date.now() - cached.at < 60_000) return cached.name;
  let name = "";
  try {
    const res = await fetch(`${ACTIONS_URL}/profile`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const p = (await res.json()) as { firstName?: string; name?: string };
      name = (p.firstName || (p.name ?? "").trim().split(/\s+/)[0] || "").trim();
    }
  } catch {
    /* actions is offline: fall through with no name */
  }
  cached = { at: Date.now(), name };
  return name;
}
