// Shared configuration. Import this first; it loads the repo-root .env.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const INBOX_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(INBOX_DIR, "..");
dotenv.config({ path: path.join(REPO_ROOT, ".env") });
dotenv.config({ path: path.join(INBOX_DIR, ".env"), override: true });

export const MOCK = (process.env.MOCK ?? "1") === "1";
export const PORT = Number(process.env.INBOX_PORT ?? 7702);
export const HOST = "127.0.0.1";
export const MEMORY_URL = process.env.MEMORY_URL ?? "http://127.0.0.1:7701";
export const DATA_DIR = process.env.INBOX_DATA_DIR ?? path.join(INBOX_DIR, "data");
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
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export const AUTO_APPROVE_CALENDAR = (process.env.AUTO_APPROVE_CALENDAR ?? "0") === "1";
export const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 5 * 60 * 1000);
export const TIMEZONE = process.env.TZ_NAME ?? "America/Los_Angeles";
