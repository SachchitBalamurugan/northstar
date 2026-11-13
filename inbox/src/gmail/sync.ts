// Gmail sync: fixtures in MOCK mode, otherwise incremental via historyId (full 7-day sync the first time).
import { google, type gmail_v1 } from "googleapis";
import { loadFixture } from "../fixtures.js";
import { getAuthedClient } from "../google/auth.js";
import { ensureCacheSource, useFixtures } from "../google/status.js";
import { postEvent } from "../memory.js";
import { getCache, updateCache } from "../store.js";
import type { CachedEmail } from "../types.js";
import { normalizeMessage } from "./parse.js";

const WINDOW_DAYS = 7;
const FULL_SYNC_QUERY = `newer_than:${WINDOW_DAYS}d -in:spam -in:trash -in:sent -in:drafts -in:chats`;
const MAX_FULL_SYNC = 100;
const CONCURRENCY = 5;
// SENT: the student's own replies must not come back as mail that needs triage.
const SKIP_LABELS = new Set(["DRAFT", "SPAM", "TRASH", "SENT", "CHAT"]);

// ---- pure helpers (exported for tests) ----
const ts = (e: CachedEmail) => Date.parse(e.receivedAt) || 0;
export const sortNewestFirst = (emails: CachedEmail[]): CachedEmail[] => [...emails].sort((a, b) => ts(b) - ts(a));

/** Dedupe by id (incoming wins), drop anything older than 7 days, newest first. */
export function mergeEmails(existing: CachedEmail[], incoming: CachedEmail[], now: Date = new Date()): CachedEmail[] {
  const byId = new Map<string, CachedEmail>();
  for (const e of existing) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  const cutoff = now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return sortNewestFirst([...byId.values()].filter((e) => ts(e) >= cutoff));
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: number } };
  return e?.status === 404 || e?.code === 404 || e?.code === "404" || e?.response?.status === 404;
}
const isEnoent = (err: unknown) => (err as { code?: string })?.code === "ENOENT";

// ---- MOCK ----
function syncMock(): { emails: number } {
  let items: CachedEmail[];
  try {
    items = loadFixture<CachedEmail>("emails.json");
  } catch (err) {
    if (isEnoent(err)) {
      console.warn("[gmail] MOCK: fixtures/emails.json not found yet, 0 emails");
      return { emails: 0 };
    }
    throw err;
  }
  const emails = sortNewestFirst(items);
  updateCache({ emails, lastSyncAt: new Date().toISOString() });
  return { emails: emails.length };
}

// ---- real ----
type Gmail = gmail_v1.Gmail;

async function listHistoryMessageIds(gmail: Gmail, startHistoryId: string): Promise<string[]> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.history.list({
      userId: "me",
      startHistoryId,
      historyTypes: ["messageAdded"],
      maxResults: 500,
      pageToken,
    });
    for (const h of res.data.history ?? []) {
      for (const added of h.messagesAdded ?? []) {
        const m = added.message;
        if (!m?.id) continue;
        if ((m.labelIds ?? []).some((l) => SKIP_LABELS.has(l))) continue;
        ids.add(m.id);
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return [...ids];
}

async function listRecentMessageIds(gmail: Gmail): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: FULL_SYNC_QUERY,
      maxResults: Math.min(100, MAX_FULL_SYNC - ids.length),
      pageToken,
    });
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < MAX_FULL_SYNC);
  return ids;
}

async function fetchMessages(gmail: Gmail, ids: string[]): Promise<CachedEmail[]> {
  const fetched = await mapLimit(ids, CONCURRENCY, async (id) => {
    try {
      const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      return normalizeMessage(res.data);
    } catch (err) {
      if (isNotFound(err)) return undefined; // deleted since we listed it
      throw err;
    }
  });
  return fetched.filter((e): e is CachedEmail => !!e && !e.labels.some((l) => SKIP_LABELS.has(l)));
}

async function syncReal(): Promise<{ emails: number }> {
  const gmail = google.gmail({ version: "v1", auth: await getAuthedClient() });
  const cache = getCache();

  // Take the cursor BEFORE listing so nothing that arrives mid-sync is skipped next time.
  const profile = await gmail.users.getProfile({ userId: "me" });
  const newHistoryId = profile.data.historyId ?? cache.historyId;

  let ids: string[] | undefined;
  if (cache.historyId) {
    try {
      ids = await listHistoryMessageIds(gmail, cache.historyId);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      console.warn("[gmail] historyId is stale (404); doing a full sync");
    }
  }
  if (!ids) ids = await listRecentMessageIds(gmail);

  const known = new Set(cache.emails.map((e) => e.id));
  const fresh = await fetchMessages(gmail, ids);
  const newCount = fresh.filter((e) => !known.has(e.id)).length;
  const emails = mergeEmails(cache.emails, fresh);
  updateCache({ emails, historyId: newHistoryId, lastSyncAt: new Date().toISOString() });

  console.log(`[gmail] synced ${newCount} new emails (${emails.length} cached)`);
  await postEvent({ source: "gmail", kind: "observation", text: `Synced ${newCount} new emails`, tags: ["sync"] });
  return { emails: emails.length };
}

/** Sync mail into the cache. Returns the number of emails now cached. Read-only: never sends or changes mail. */
export async function syncGmail(): Promise<{ emails: number }> {
  const fixtures = useFixtures();
  ensureCacheSource(fixtures ? "fixtures" : "google"); // never merge demo mail into the real inbox, or the reverse
  return fixtures ? syncMock() : syncReal();
}
