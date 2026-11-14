// Shared configuration. Import this first; it loads the repo-root .env.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const INBOX_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(INBOX_DIR, "..");
// inbox/.env wins over the repo-root .env; neither ever overrides a variable set in the real environment.
dotenv.config({ path: path.join(INBOX_DIR, ".env"), quiet: true });
dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });

/** MOCK=1 as set in the environment: no LLM, no Google, fixtures + deterministic rules only. */
export const MOCK_ENV = process.env.MOCK === "1";
export const PORT = Number(process.env.PORT ?? process.env.INBOX_PORT ?? 7702);
export const HOST = "127.0.0.1";
export const MEMORY_URL = process.env.MEMORY_URL ?? "http://127.0.0.1:7701";
export const ACTIONS_URL = process.env.ACTIONS_URL ?? "http://127.0.0.1:7703";
export const DATA_DIR = process.env.INBOX_DATA_DIR ? path.resolve(process.env.INBOX_DATA_DIR) : path.join(INBOX_DIR, "data");
export const FIXTURES_DIR = path.join(INBOX_DIR, "fixtures");
export const TOKENS_PATH = path.join(DATA_DIR, "tokens.json");
export const CACHE_PATH = path.join(DATA_DIR, "cache.json");
export const PROPOSALS_PATH = path.join(DATA_DIR, "proposals.json");

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
export const OPENAI_MODEL_FAST = process.env.OPENAI_MODEL_FAST ?? "gpt-6-luna";
export const OPENAI_MODEL_SMART = process.env.OPENAI_MODEL_SMART ?? "gpt-6.1-sol";

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
export const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? `http://${HOST}:${PORT}/auth/callback`;
// Minimum needed: read mail, create + send reply drafts (gmail.compose covers drafts.create and drafts.send),
// read + insert events on the user's calendars (calendar.events covers events.list), and the account's address.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
  // Read-only Google Docs for the task agent: find docs by name, read their text.
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
];

/** True when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set. */
export function googleConfigured(): boolean {
  return GOOGLE_CLIENT_ID !== "" && GOOGLE_CLIENT_SECRET !== "";
}
/** True when data/tokens.json holds a refresh or access token (no network check). */
export function hasGoogleTokens(): boolean {
  try {
    const t = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")) as { refresh_token?: string; access_token?: string } | null;
    return Boolean(t && typeof t === "object" && (t.refresh_token || t.access_token));
  } catch {
    return false;
  }
}
/** True when a Google OAuth client is configured AND tokens are stored, i.e. real Gmail/Calendar can be used. */
export function googleReady(): boolean {
  return googleConfigured() && hasGoogleTokens();
}
/**
 * "Use fixtures instead of Google". True with MOCK=1, and also whenever Google is not usable yet (no OAuth
 * client or no tokens), so the service serves fixture mail/calendar instead of crashing. The LLM is gated
 * separately on MOCK_ENV (see llm.ts), so MOCK=0 without Google still triages and drafts with the real model.
 * This is a live ESM binding: refreshMode() re-evaluates it (each sync, and right after the OAuth callback).
 */
export let MOCK = MOCK_ENV || !googleReady();
export function refreshMode(): boolean {
  MOCK = MOCK_ENV || !googleReady();
  return MOCK;
}

export const AUTO_APPROVE_CALENDAR = (process.env.AUTO_APPROVE_CALENDAR ?? "0") === "1";
export const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 5 * 60 * 1000);
export const TIMEZONE = process.env.TZ_NAME ?? "America/Los_Angeles";
