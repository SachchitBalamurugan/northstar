import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the actions/ folder, independent of cwd. */
export const ROOT = path.resolve(here, "..");

// actions/.env wins; the repo-root .env (shared by all services) fills in anything it does not set.
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
dotenv.config({ path: path.join(ROOT, "..", ".env"), quiet: true });
export const DATA_DIR = process.env.ACTIONS_DATA_DIR
  ? path.resolve(process.env.ACTIONS_DATA_DIR)
  : path.join(ROOT, "data");
export const FIXTURES_DIR = path.join(ROOT, "fixtures");

export const PORT = Number(process.env.PORT ?? 7703);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const MEMORY_URL = process.env.MEMORY_URL ?? "http://127.0.0.1:7701";

/** MOCK=1 → no LLM calls and no memory service required; fixture/heuristic answers only. */
export const MOCK = process.env.MOCK === "1";
/** HEADLESS=1 → run Chromium headless (tests/CI). Default is a visible window. */
export const HEADLESS = process.env.HEADLESS === "1";

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
export const MODEL_FAST = process.env.OPENAI_MODEL_FAST ?? "";
export const MODEL_SMART = process.env.OPENAI_MODEL_SMART ?? "";

fs.mkdirSync(DATA_DIR, { recursive: true });
