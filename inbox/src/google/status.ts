// Which data source is live (real Google vs fixtures), why, and keeping the cache from mixing the two.
import { MOCK_ENV, googleConfigured, refreshMode } from "../config.js";
import { dropPending, getCache, updateCache } from "../store.js";
import type { Cache } from "../types.js";
import { authError, authedEmail, isAuthed, missingScopes } from "./auth.js";

export type DataSource = "google" | "fixtures";

export interface AuthStatus {
  /** Tokens are saved (the user finished Google sign-in). */
  authed: boolean;
  /** GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set. */
  configured: boolean;
  /** MOCK=1 in the environment. */
  mock: boolean;
  source: DataSource;
  email?: string;
  /** Plain-language explanation whenever the source is fixtures (or Google is only partly usable). */
  reason?: string;
}

/** Real Google whenever MOCK != 1 AND the client is configured AND the user is signed in; fixtures otherwise. */
export function authStatus(): AuthStatus {
  const configured = googleConfigured();
  const authed = isAuthed();
  const source: DataSource = refreshMode() ? "fixtures" : "google";
  const email = authed ? authedEmail() : undefined;
  let reason: string | undefined;
  if (MOCK_ENV) reason = "MOCK=1 is set, so Northstar is showing demo data. Set MOCK=0 in .env and restart to use your real Gmail and Calendar.";
  else if (!configured) reason = "Google is not set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env and restart. Your inbox and calendar stay empty until then.";
  else if (!authed) reason = authError() ?? "Google is not connected yet. Choose Connect Google to sign in. Your inbox and calendar stay empty until then.";
  else {
    const missing = missingScopes();
    if (missing.length) {
      reason = `Connected, but some permissions were not ticked on Google's screen (${missing.map((s) => s.split("/").pop()).join(", ")}). Connect Google again and tick every box.`;
    } else if (authError()) reason = authError();
  }
  return { authed, configured, mock: MOCK_ENV, source, ...(email ? { email } : {}), ...(reason ? { reason } : {}) };
}

/** True when fixtures should be used right now (re-checked on every call, so sign-in/disconnect apply at once). */
export function useFixtures(): boolean {
  return refreshMode();
}

type StampedCache = Cache & { source?: DataSource };

/**
 * Make sure the cache holds data from `source` only. On a switch (demo -> real account, or back after a
 * disconnect) it empties mail, events, triage and the Gmail cursor, and drops pending proposals, so demo mail is
 * never mixed into the real inbox and a card built from demo data can never act on the real account (or vice versa).
 * `force` resets even without a switch (a new sign-in may be a different Google account). Returns true when it reset.
 */
export function ensureCacheSource(source: DataSource = useFixtures() ? "fixtures" : "google", opts: { force?: boolean } = {}): boolean {
  const cache = getCache() as StampedCache;
  const current: DataSource = cache.source ?? (cache.historyId ? "google" : "fixtures");
  if (current === source && !opts.force) {
    if (!cache.source) updateCache({ source } as Partial<StampedCache>);
    return false;
  }
  updateCache({ emails: [], events: [], historyId: undefined, lastSyncAt: undefined, triage: undefined, triagedAt: undefined, sentEmails: undefined, notices: undefined, followupSeen: undefined, userEmail: undefined, source } as Partial<StampedCache>);
  dropPending("send_reply");
  dropPending("create_event");
  dropPending("unsubscribe");
  return true;
}
