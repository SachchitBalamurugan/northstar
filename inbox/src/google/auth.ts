// Google OAuth ("Desktop app" client with a loopback redirect). Tokens live in data/tokens.json (gitignored).
// Interface is fixed; other modules import these names.
import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import type { Credentials, OAuth2Client } from "google-auth-library";
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  GOOGLE_SCOPES,
  TOKENS_PATH,
} from "../config.js";

export const NOT_SIGNED_IN = "Not signed in to Google: open GET /auth/url first";
const NOT_CONFIGURED = "GOOGLE_CLIENT_ID/SECRET not set in .env";

let client: OAuth2Client | undefined;

// ---- token file ----
function readTokens(): Credentials | undefined {
  try {
    const t = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")) as Credentials;
    return t && typeof t === "object" ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Merge new tokens into the saved ones (a refresh usually omits refresh_token) and persist. */
function saveTokens(tokens: Credentials): void {
  const merged: Credentials = { ...(readTokens() ?? {}), ...tokens };
  if (!tokens.refresh_token && readTokens()?.refresh_token) merged.refresh_token = readTokens()!.refresh_token;
  fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
  const tmp = `${TOKENS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKENS_PATH);
}

function assertConfigured(): void {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error(NOT_CONFIGURED);
}

// ---- public API ----
/** Singleton OAuth2 client. Refreshed tokens are persisted via the "tokens" event. */
export function getOAuthClient(): OAuth2Client {
  if (!client) {
    client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
    client.on("tokens", (tokens: Credentials) => {
      try {
        saveTokens(tokens);
      } catch (err) {
        console.warn("[auth] could not persist refreshed tokens:", (err as Error).message);
      }
    });
    const saved = readTokens();
    if (saved) client.setCredentials(saved);
  }
  return client;
}

/** URL the user opens in a browser to grant access. Throws if the client id/secret are missing. */
export function getAuthUrl(): string {
  assertConfigured();
  return getOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    redirect_uri: GOOGLE_REDIRECT_URI,
  });
}

/** Exchange the ?code= from the loopback redirect for tokens and persist them. */
export async function handleCallback(code: string): Promise<void> {
  assertConfigured();
  if (!code) throw new Error("missing OAuth code");
  const c = getOAuthClient();
  const { tokens } = await c.getToken({ code, redirect_uri: GOOGLE_REDIRECT_URI });
  c.setCredentials(tokens);
  saveTokens(tokens); // the "tokens" event also fires, but be explicit
}

/** True when a token file with a usable token exists (no network check). */
export function isAuthed(): boolean {
  const t = readTokens();
  return Boolean(t?.refresh_token || t?.access_token);
}

/** Returns an OAuth2 client with tokens loaded, or throws a clear error telling the user to visit /auth/url. */
export async function getAuthedClient(): Promise<OAuth2Client> {
  const saved = readTokens();
  if (!saved || (!saved.refresh_token && !saved.access_token)) throw new Error(NOT_SIGNED_IN);
  assertConfigured();
  const c = getOAuthClient();
  c.setCredentials(saved);
  // getAccessToken() refreshes only when the token is missing/expiring and emits "tokens" -> saveTokens.
  const expiring = !saved.access_token || !saved.expiry_date || saved.expiry_date <= Date.now() + 60_000;
  if (expiring && !saved.refresh_token) throw new Error(`Google session expired and no refresh token saved. ${NOT_SIGNED_IN}`);
  try {
    await c.getAccessToken();
  } catch (err) {
    throw new Error(`Google token refresh failed (${(err as Error).message}). ${NOT_SIGNED_IN}`);
  }
  return c;
}
