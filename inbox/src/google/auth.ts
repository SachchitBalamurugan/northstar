// Google OAuth (loopback redirect http://127.0.0.1:7702/auth/callback). Tokens live in data/tokens.json (gitignored).
// Interface is fixed; other modules import these names.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import type { Credentials, OAuth2Client } from "google-auth-library";
import {
  DATA_DIR,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  GOOGLE_SCOPES,
  TOKENS_PATH,
  googleConfigured,
} from "../config.js";

export const NOT_SIGNED_IN = "Not signed in to Google: open GET /auth/url first";
export const NOT_CONFIGURED =
  "Google is not set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the .env file in the project folder, then restart Northstar.";

const STATE_PATH = path.join(DATA_DIR, "oauth_state.json");
const STATE_TTL_MS = 15 * 60 * 1000;

/** What is stored in data/tokens.json: Google's credentials plus the account's address. */
type SavedTokens = Credentials & { email?: string };

let client: OAuth2Client | undefined;
let lastAuthError: string | undefined;

// ---- token file ----
function readTokens(): SavedTokens | undefined {
  try {
    const t = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")) as SavedTokens;
    return t && typeof t === "object" ? t : undefined;
  } catch {
    return undefined;
  }
}
function credentialsOf(t: SavedTokens): Credentials {
  const { email: _email, ...creds } = t;
  return creds;
}

/** Merge new tokens into the saved ones (a refresh usually omits refresh_token) and persist. */
function saveTokens(tokens: SavedTokens, opts: { newSignIn?: boolean } = {}): void {
  const prev = readTokens() ?? {};
  const merged: SavedTokens = { ...prev, ...tokens };
  if (!tokens.refresh_token && prev.refresh_token) merged.refresh_token = prev.refresh_token;
  if (opts.newSignIn) {
    // Possibly a different account than before: never carry the old address over.
    if (tokens.email) merged.email = tokens.email;
    else delete merged.email;
  } else if (!tokens.email && prev.email) merged.email = prev.email;
  fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
  const tmp = `${TOKENS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKENS_PATH);
}
function deleteTokens(): void {
  fs.rmSync(TOKENS_PATH, { force: true });
  client = undefined;
}

function assertConfigured(): void {
  if (!googleConfigured()) throw new Error(NOT_CONFIGURED);
}

/** The email claim of an id_token. It came straight from Google's token endpoint over TLS, so it is only decoded. */
function emailFromIdToken(idToken: string | null | undefined): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from((idToken ?? "").split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof payload.email === "string" && payload.email ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

// ---- public API ----
/** Singleton OAuth2 client. Refreshed tokens are persisted via the "tokens" event. */
export function getOAuthClient(): OAuth2Client {
  if (!client) {
    const c: OAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
    c.on("tokens", (tokens: Credentials) => {
      if (client !== c) return; // disconnected meanwhile: do not write the token file back
      try {
        saveTokens(tokens);
      } catch (err) {
        console.warn("[auth] could not persist refreshed tokens:", (err as Error).message);
      }
    });
    const saved = readTokens();
    if (saved) c.setCredentials(credentialsOf(saved));
    client = c;
  }
  return client;
}

/**
 * URL the user opens in a browser to grant access. Throws if the client id/secret are missing.
 * A random `state` is saved in the data dir (so it survives a dev-server restart) and checked on the way back.
 */
export function getAuthUrl(): string {
  assertConfigured();
  const state = randomBytes(16).toString("hex");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ state, at: Date.now() }), { mode: 0o600 });
  return getOAuthClient().generateAuthUrl({
    access_type: "offline", // ask for a refresh token ...
    prompt: "consent", // ... and make Google issue one every time, not only on the first grant
    scope: GOOGLE_SCOPES,
    redirect_uri: GOOGLE_REDIRECT_URI,
    state,
  });
}

/** True when `state` is the one the last getAuthUrl() issued (within 15 minutes). One use only. */
export function consumeState(state: string | undefined): boolean {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as { state?: string; at?: number };
    const ok = Boolean(state) && saved.state === state && Date.now() - (saved.at ?? 0) < STATE_TTL_MS;
    if (ok) fs.rmSync(STATE_PATH, { force: true });
    return ok;
  } catch {
    return false;
  }
}

/** Exchange the ?code= from the loopback redirect for tokens and persist them (with the account's address). */
export async function handleCallback(code: string): Promise<void> {
  assertConfigured();
  if (!code) throw new Error("missing OAuth code");
  const c = getOAuthClient();
  const { tokens } = await c.getToken({ code, redirect_uri: GOOGLE_REDIRECT_URI });
  const prev = readTokens();
  if (!tokens.refresh_token && !prev?.refresh_token) {
    throw new Error("Google did not return a refresh token. Remove Northstar at myaccount.google.com/permissions, then connect again.");
  }
  c.setCredentials({ ...tokens, refresh_token: tokens.refresh_token ?? prev?.refresh_token });
  let email = emailFromIdToken(tokens.id_token);
  if (!email) {
    try {
      email = (await google.gmail({ version: "v1", auth: c }).users.getProfile({ userId: "me" })).data.emailAddress ?? undefined;
    } catch {
      /* the address is only for display */
    }
  }
  saveTokens({ ...tokens, email }, { newSignIn: true }); // the "tokens" event also fires, but be explicit
  lastAuthError = undefined;
}

/** True when a token file with a usable token exists (no network check). */
export function isAuthed(): boolean {
  const t = readTokens();
  return Boolean(t?.refresh_token || t?.access_token);
}

/** Address of the connected Google account, if known. */
export function authedEmail(): string | undefined {
  const t = readTokens();
  return (t?.refresh_token || t?.access_token) && t.email ? t.email : undefined;
}

/** Scopes we need that the user did not grant (Google lets people untick boxes on the consent screen). */
export function missingScopes(): string[] {
  const t = readTokens();
  if (!t || typeof t.scope !== "string" || !t.scope.trim()) return [];
  const granted = new Set(t.scope.split(/\s+/));
  return GOOGLE_SCOPES.filter((s) => !granted.has(s));
}

/** Why the last Google call could not authenticate (cleared by the next successful sign-in). */
export function authError(): string | undefined {
  return lastAuthError;
}

/** Returns an OAuth2 client with tokens loaded, or throws a clear error telling the user to visit /auth/url. */
export async function getAuthedClient(): Promise<OAuth2Client> {
  const saved = readTokens();
  if (!saved || (!saved.refresh_token && !saved.access_token)) throw new Error(NOT_SIGNED_IN);
  assertConfigured();
  const c = getOAuthClient();
  c.setCredentials(credentialsOf(saved));
  // getAccessToken() refreshes only when the token is missing/expiring and emits "tokens" -> saveTokens.
  const expiring = !saved.access_token || !saved.expiry_date || saved.expiry_date <= Date.now() + 60_000;
  if (expiring && !saved.refresh_token) {
    lastAuthError = "Your Google sign-in expired. Connect Google again.";
    deleteTokens();
    throw new Error(`Google session expired and no refresh token saved. ${NOT_SIGNED_IN}`);
  }
  try {
    await c.getAccessToken();
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // invalid_grant = the refresh token was revoked or expired (after 7 days while the OAuth app is in "Testing").
    // It will never work again, so drop it and fall back to demo data until the user reconnects.
    if (/invalid_grant|invalid_client|unauthorized_client/i.test(msg)) {
      lastAuthError = /invalid_grant/i.test(msg)
        ? "Your Google sign-in expired or was removed. Connect Google again."
        : "Google rejected GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Check them in .env, restart, and connect again.";
      if (/invalid_grant/i.test(msg)) deleteTokens();
    }
    throw new Error(`Google token refresh failed (${msg}). ${NOT_SIGNED_IN}`);
  }
  return c;
}

/** Revoke Northstar's access at Google (best effort) and delete the saved tokens. */
export async function disconnect(): Promise<{ revoked: boolean }> {
  const saved = readTokens();
  const token = saved?.refresh_token ?? saved?.access_token;
  let revoked = false;
  if (token) {
    try {
      await getOAuthClient().revokeToken(token);
      revoked = true;
    } catch (err) {
      console.warn("[auth] could not revoke the Google token (deleting it locally anyway):", (err as Error).message);
    }
  }
  deleteTokens();
  fs.rmSync(STATE_PATH, { force: true });
  lastAuthError = undefined;
  return { revoked };
}
