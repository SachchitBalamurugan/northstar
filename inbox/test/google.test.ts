// The real-Google path end to end with googleapis stubbed (no network): mode logic, OAuth url/callback/token storage,
// refresh, sync, approve -> draft/send/insert, disconnect. MOCK=0 with a (fake) OAuth client configured.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const env = await vi.hoisted(async () => {
  const os = await import("node:os");
  const p = await import("node:path");
  const fsp = await import("node:fs");
  const dir = fsp.mkdtempSync(p.join(os.tmpdir(), "northstar-google-test-"));
  process.env.MOCK = "0";
  process.env.INBOX_DATA_DIR = dir;
  process.env.MEMORY_URL = "http://127.0.0.1:1";
  process.env.OPENAI_API_KEY = ""; // triage falls back to rules: no model calls
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.AUTO_APPROVE_CALENDAR = "0";
  delete process.env.GOOGLE_REDIRECT_URI;
  delete process.env.PORT;
  delete process.env.INBOX_PORT;
  return { dir };
});

// ---- googleapis stub ----
const g = vi.hoisted(() => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const message = (id: string, subject: string, from: string, body: string) => ({
    id,
    threadId: `t-${id}`,
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(Date.now() - 3_600_000),
    snippet: body.slice(0, 80),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: "student@uni.edu" },
        { name: "Subject", value: subject },
        { name: "Date", value: new Date(Date.now() - 3_600_000).toUTCString() },
        { name: "Message-ID", value: `<${id}@mail.example>` },
      ],
      body: { data: b64(body) },
    },
  });
  const messages: Record<string, ReturnType<typeof message>> = {
    "real-1": message("real-1", "Lab report feedback", "Prof. Ada Park <park@uni.edu>", "Please send your revised lab report by Friday."),
    "real-2": message("real-2", "Robotics kickoff", "Robotics Club <club@uni.edu>", "Kickoff is this week, snacks provided."),
  };
  const idToken = (email: string) => `${b64("{}")}.${b64(JSON.stringify({ email }))}.sig`;
  const fn = vi.fn;
  const SCOPES = ["gmail.readonly", "gmail.compose", "calendar.events", "userinfo.email"].map((s) => `https://www.googleapis.com/auth/${s}`).join(" ");
  const state = {
    clients: [] as any[],
    authUrlOpts: undefined as any,
    idToken,
    getToken: fn(async (_o: any) => ({
      tokens: { access_token: "access-1", refresh_token: "refresh-1", expiry_date: Date.now() + 3_600_000, id_token: idToken("student@uni.edu"), scope: SCOPES },
    })),
    getAccessToken: fn(async (_client: any) => ({ token: "access-1" })),
    revokeToken: fn(async (_t: string) => ({})),
    gmail: {
      users: {
        getProfile: fn(async () => ({ data: { emailAddress: "student@uni.edu", historyId: "100" } })),
        history: { list: fn(async () => ({ data: { history: [] } })) },
        messages: {
          list: fn(async () => ({ data: { messages: Object.keys(messages).map((id) => ({ id })) } })),
          get: fn(async ({ id }: { id: string }) => ({ data: messages[id] })),
          send: fn(async () => ({ data: { id: "direct-send" } })),
          trash: fn(async () => ({ data: {} })),
          delete: fn(async () => ({ data: {} })),
          modify: fn(async () => ({ data: {} })),
        },
        drafts: {
          create: fn(async (_o: any) => ({ data: { id: "draft-1", message: { id: "draft-msg-1" } } })),
          send: fn(async (_o: any) => ({ data: { id: "sent-1" } })),
        },
      },
    },
    calendar: {
      events: {
        list: fn(async (_o: any) => ({
          data: {
            items: [
              {
                id: "gcal-1",
                summary: "CS 201 lecture",
                start: { dateTime: new Date(Date.now() + 2 * 3_600_000).toISOString() },
                end: { dateTime: new Date(Date.now() + 3 * 3_600_000).toISOString() },
              },
            ],
          },
        })),
        insert: fn(async (_o: any) => ({ data: { id: "gcal-new", htmlLink: "https://calendar.google.com/event?eid=gcal-new" } })),
        delete: fn(async () => ({ data: {} })),
      },
    },
  };
  return state;
});

vi.mock("googleapis", () => {
  class FakeOAuth2 {
    credentials: any = {};
    listeners: ((t: any) => void)[] = [];
    constructor(public clientId: string, public clientSecret: string, public redirectUri: string) {
      g.clients.push(this);
    }
    on(_ev: string, f: (t: any) => void) {
      this.listeners.push(f);
      return this;
    }
    emit(_ev: string, t: any) {
      this.listeners.forEach((f) => f(t));
    }
    setCredentials(c: any) {
      this.credentials = c;
    }
    generateAuthUrl(opts: any) {
      g.authUrlOpts = opts;
      return `https://accounts.google.com/o/oauth2/v2/auth?state=${opts.state}`;
    }
    getToken(o: any) {
      return g.getToken(o);
    }
    getAccessToken() {
      return g.getAccessToken(this);
    }
    revokeToken(t: string) {
      return g.revokeToken(t);
    }
  }
  return { google: { auth: { OAuth2: FakeOAuth2 }, gmail: () => g.gmail, calendar: () => g.calendar } };
});

import { buildServer, runSync } from "../src/app.js";
import * as config from "../src/config.js";
import { getAuthedClient } from "../src/google/auth.js";
import { authStatus } from "../src/google/status.js";
import { approveProposal } from "../src/proposals.js";
import { getCache, listProposals, newProposal } from "../src/store.js";
import { syncGmail } from "../src/gmail/sync.js";
import { syncCalendar } from "../src/calendar/sync.js";

const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
let app: Awaited<ReturnType<typeof buildServer>>;

const writes = () => ({
  draftsCreate: g.gmail.users.drafts.create.mock.calls.length,
  draftsSend: g.gmail.users.drafts.send.mock.calls.length,
  messagesSend: g.gmail.users.messages.send.mock.calls.length,
  trash: g.gmail.users.messages.trash.mock.calls.length + g.gmail.users.messages.delete.mock.calls.length + g.gmail.users.messages.modify.mock.calls.length,
  insert: g.calendar.events.insert.mock.calls.length,
  calDelete: g.calendar.events.delete.mock.calls.length,
});
const NO_WRITES = { draftsCreate: 0, draftsSend: 0, messagesSend: 0, trash: 0, insert: 0, calDelete: 0 };
const idle = async () => {
  await runSync(); // joins a sync already in flight (or runs one)
};
async function connect(): Promise<void> {
  const { url } = (await app.inject({ method: "GET", url: "/auth/url" })).json();
  const state = new URL(url).searchParams.get("state");
  const cb = await app.inject({ method: "GET", url: `/auth/callback?code=the-code&state=${state}` });
  expect(cb.statusCode).toBe(200);
  await idle();
}
const readTokens = () => JSON.parse(fs.readFileSync(config.TOKENS_PATH, "utf8"));

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchMock);
  app = await buildServer({ logger: false });
});
afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
  fs.rmSync(env.dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const f of [g.gmail.users.drafts.create, g.gmail.users.drafts.send, g.gmail.users.messages.send, g.calendar.events.insert, g.revokeToken, g.getToken, g.getAccessToken]) f.mockClear();
});

describe("configured, MOCK=0, not signed in yet", () => {
  it("serves fixtures and says why on /auth/status and /health", async () => {
    await syncGmail();
    await syncCalendar();
    expect(getCache().emails.length).toBeGreaterThan(2); // demo mail
    const status = (await app.inject({ method: "GET", url: "/auth/status" })).json();
    expect(status).toMatchObject({ authed: false, configured: true, mock: false, source: "fixtures" });
    expect(status.reason).toMatch(/not connected/i);
    expect(status.email).toBeUndefined();
    const health = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(health).toMatchObject({ ok: true, service: "inbox", llm: false, authed: false, configured: true, mock: false, source: "fixtures" });
    expect(health.reason).toBe(status.reason);
  });

  it("builds the consent URL with minimum scopes, offline access, forced consent, loopback redirect and a state", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/url" });
    expect(res.statusCode).toBe(200);
    expect(res.json().configured).toBe(true);
    expect(g.clients[0].redirectUri).toBe("http://127.0.0.1:7702/auth/callback");
    expect(g.authUrlOpts).toMatchObject({ access_type: "offline", prompt: "consent", redirect_uri: "http://127.0.0.1:7702/auth/callback" });
    expect([...g.authUrlOpts.scope].sort()).toEqual([
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
    expect(g.authUrlOpts.state).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects a callback with a wrong or missing state without exchanging the code", async () => {
    await app.inject({ method: "GET", url: "/auth/url" });
    for (const url of ["/auth/callback?code=x", "/auth/callback?code=x&state=nope"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toContain("text/html");
    }
    const denied = await app.inject({ method: "GET", url: "/auth/callback?error=access_denied" });
    expect(denied.statusCode).toBe(400);
    expect(denied.body).toContain("nothing changed");
    expect(g.getToken).not.toHaveBeenCalled();
    expect(fs.existsSync(config.TOKENS_PATH)).toBe(false);
  });
});

describe("sign-in", () => {
  it("stores tokens in the data dir, shows a friendly page, drops demo data and kicks off the first real sync", async () => {
    const demoCard = newProposal({ type: "send_reply", title: "Reply to a demo email", why: "demo", urgency: 2, payload: { to: "demo@example.com", subject: "x", body: "y" } });
    const { url } = (await app.inject({ method: "GET", url: "/auth/url" })).json();
    const state = new URL(url).searchParams.get("state")!;

    const cb = await app.inject({ method: "GET", url: `/auth/callback?code=the-code&state=${state}` });
    expect(cb.statusCode).toBe(200);
    expect(cb.headers["content-type"]).toContain("text/html");
    expect(cb.body).toContain("Connected. You can close this tab.");
    expect(cb.body).toContain("student@uni.edu");
    expect(g.getToken).toHaveBeenCalledWith({ code: "the-code", redirect_uri: "http://127.0.0.1:7702/auth/callback" });

    // tokens: inside the git-ignored data dir, refresh token persisted, owner-only file
    expect(path.dirname(fs.realpathSync(config.TOKENS_PATH))).toBe(fs.realpathSync(env.dir));
    expect(readTokens()).toMatchObject({ refresh_token: "refresh-1", access_token: "access-1", email: "student@uni.edu" });
    if (process.platform !== "win32") expect(fs.statSync(config.TOKENS_PATH).mode & 0o777).toBe(0o600);

    // the demo card can no longer be approved against the real account
    expect(listProposals().find((p) => p.id === demoCard.id)).toBeUndefined();

    // the state is single use
    expect((await app.inject({ method: "GET", url: `/auth/callback?code=again&state=${state}` })).statusCode).toBe(400);

    // first sync was kicked off by the callback: real mail + calendar only, no fixtures mixed in
    await idle();
    expect(getCache().emails.map((e) => e.id).sort()).toEqual(["real-1", "real-2"]);
    expect(getCache().events.map((e) => e.id)).toEqual(["gcal-1"]);
    expect(getCache().historyId).toBe("100");

    const status = (await app.inject({ method: "GET", url: "/auth/status" })).json();
    expect(status).toEqual({ authed: true, configured: true, mock: false, source: "google", email: "student@uni.edu" });
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ ok: true, service: "inbox", source: "google", authed: true, email: "student@uni.edu" });
  });

  it("POST /sync reads from Google and never writes: no drafts, sends, deletes or calendar inserts", async () => {
    const res = (await app.inject({ method: "POST", url: "/sync" })).json();
    expect(res).toMatchObject({ source: "google", emails: 2, events: 1, triaged: true });
    expect(g.gmail.users.history.list).toHaveBeenCalled(); // incremental after the first full sync
    // calendar: primary calendar, from the start of today so earlier events still show in /calendar/today
    const listed = g.calendar.events.list.mock.calls.at(-1)![0];
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    expect(listed).toMatchObject({ calendarId: "primary", timeMin: dayStart.toISOString(), singleEvents: true });
    await app.inject({ method: "GET", url: "/triage" });
    const draft = await app.inject({ method: "POST", url: "/draft", payload: { emailId: "real-1" } });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ type: "send_reply", status: "pending" });
    await app.inject({ method: "POST", url: "/schedule/plan" });
    await app.inject({ method: "POST", url: "/calendar/suggest", payload: { query: "robotics kickoff" } });
    expect(writes()).toEqual(NO_WRITES);
  });
});

describe("approval is the only way anything is written", () => {
  it("approving a reply creates a Gmail draft in the thread and does not send it", async () => {
    const p = newProposal({ type: "send_reply", title: "Reply to Prof. Park", why: "She asked for the report", urgency: 1, payload: { emailId: "real-1", threadId: "t-real-1", to: "park@uni.edu", subject: "Lab report feedback", body: "Will do, thanks.", autoSend: false } });
    expect(writes()).toEqual(NO_WRITES);
    const done = await approveProposal(p.id);
    expect(done).toMatchObject({ status: "done", payload: { draftId: "draft-1" } });
    expect(writes()).toEqual({ ...NO_WRITES, draftsCreate: 1 });
    const body = g.gmail.users.drafts.create.mock.calls[0][0].requestBody.message;
    expect(body.threadId).toBe("t-real-1");
    const mime = Buffer.from(body.raw, "base64url").toString("utf8");
    expect(mime).toContain("To: park@uni.edu");
    expect(mime).toContain("In-Reply-To: <real-1@mail.example>");
    // approving twice never runs the handler again
    await approveProposal(p.id);
    expect(writes()).toEqual({ ...NO_WRITES, draftsCreate: 1 });
  });

  it("sends only when the approved payload has autoSend: true, and a rejected card does nothing", async () => {
    const rejected = newProposal({ type: "send_reply", title: "Reply (rejected)", why: "w", urgency: 2, payload: { to: "a@b.c", subject: "s", body: "b", autoSend: true } });
    await app.inject({ method: "POST", url: `/proposals/${rejected.id}/reject` });
    await app.inject({ method: "POST", url: `/proposals/${rejected.id}/approve` });
    expect(writes()).toEqual(NO_WRITES);

    const p = newProposal({ type: "send_reply", title: "Reply and send", why: "w", urgency: 2, payload: { emailId: "real-1", threadId: "t-real-1", to: "park@uni.edu", subject: "s", body: "b", autoSend: true } });
    const done = await approveProposal(p.id);
    expect(done).toMatchObject({ status: "done", payload: { sent: true, sentMessageId: "sent-1" } });
    expect(g.gmail.users.drafts.send).toHaveBeenCalledWith({ userId: "me", requestBody: { id: "draft-1" } });
    expect(writes()).toEqual({ ...NO_WRITES, draftsCreate: 1, draftsSend: 1 });
  });

  it("approving a focus block inserts one calendar event with a 10 minute popup", async () => {
    const start = new Date(Date.now() + 26 * 3_600_000).toISOString();
    const end = new Date(Date.now() + 27 * 3_600_000).toISOString();
    const p = newProposal({ type: "create_event", title: "◎ Lab report", why: "Due Friday", urgency: 2, payload: { block: { title: "◎ Lab report", start, end, minutes: 50, deadlineTitle: "Lab report", dueAt: end } } });
    expect(writes()).toEqual(NO_WRITES);
    const done = await approveProposal(p.id);
    expect(done).toMatchObject({ status: "done", payload: { eventId: "gcal-new" } });
    expect(writes()).toEqual({ ...NO_WRITES, insert: 1 });
    expect(g.calendar.events.insert.mock.calls[0][0]).toMatchObject({
      calendarId: "primary",
      requestBody: { summary: "◎ Lab report", start: { dateTime: start }, end: { dateTime: end }, reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] } },
    });
  });

  it("approving an unsubscribe card only records the decision: no mail is sent, trashed or deleted", async () => {
    const p = newProposal({ type: "unsubscribe", title: "Unsubscribe from Deals", why: "Never opened", urgency: 3, payload: { url: "https://deals.example/unsub", sender: "deals@example.com", emailIds: ["real-2"] } });
    const done = await approveProposal(p.id);
    expect(done?.status).toBe("done");
    expect(writes()).toEqual(NO_WRITES);
    expect(getCache().emails.some((e) => e.id === "real-2")).toBe(true);
  });

  it("POST /calendar/add (the user's Add click) inserts on the real calendar and returns the Google link", async () => {
    const start = new Date(Date.now() + 50 * 3_600_000).toISOString();
    const end = new Date(Date.now() + 51 * 3_600_000).toISOString();
    const candidate = { id: "you", title: "Career fair", start, end, location: "Student Union", details: "Bring resumes", source: "you", sourceLabel: "From what you typed", confidence: 0.9 };
    const res = await app.inject({ method: "POST", url: "/calendar/add", payload: { candidate } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, eventId: "gcal-new", htmlLink: "https://calendar.google.com/event?eid=gcal-new" });
    expect(g.calendar.events.insert.mock.calls[0][0].requestBody).toMatchObject({ summary: "Career fair", location: "Student Union", description: "Bring resumes", start: { dateTime: start }, end: { dateTime: end } });
    // a double click does not create a second event
    const again = await app.inject({ method: "POST", url: "/calendar/add", payload: { candidate } });
    expect(again.json()).toMatchObject({ ok: true, eventId: "gcal-new", duplicate: true });
    expect(writes()).toEqual({ ...NO_WRITES, insert: 1 });
  });
});

describe("token refresh", () => {
  it("refreshes an expired access token, keeps the refresh token and saves the new one", async () => {
    fs.writeFileSync(config.TOKENS_PATH, JSON.stringify({ ...readTokens(), access_token: "stale", expiry_date: Date.now() - 1000 }));
    g.getAccessToken.mockImplementationOnce(async (client: any) => {
      expect(client.credentials).toMatchObject({ refresh_token: "refresh-1", access_token: "stale" });
      expect(client.credentials.email).toBeUndefined(); // our own field never goes to the Google client
      client.emit("tokens", { access_token: "access-2", expiry_date: Date.now() + 3_600_000 }); // what google-auth-library does on refresh
      return { token: "access-2" };
    });
    await getAuthedClient();
    expect(g.getAccessToken).toHaveBeenCalledTimes(1);
    expect(readTokens()).toMatchObject({ refresh_token: "refresh-1", access_token: "access-2", email: "student@uni.edu" });
    expect(authStatus().source).toBe("google");
  });

  it("falls back to demo data with a clear reason when Google says the refresh token is dead (invalid_grant)", async () => {
    g.getAccessToken.mockImplementationOnce(async () => {
      throw new Error("invalid_grant");
    });
    const res = (await app.inject({ method: "POST", url: "/sync" })).json();
    expect(res.error).toMatch(/Not signed in/);
    expect(fs.existsSync(config.TOKENS_PATH)).toBe(false);
    const status = authStatus();
    expect(status).toMatchObject({ authed: false, configured: true, source: "fixtures" });
    expect(status.reason).toMatch(/expired or was removed/);
    // the next sync swaps the real mail for demo data rather than leaving it behind
    await runSync();
    expect(getCache().emails.some((e) => e.id.startsWith("real-"))).toBe(false);
    expect(getCache().emails.length).toBeGreaterThan(2);
  });
});

describe("POST /auth/disconnect", () => {
  it("revokes at Google, deletes the tokens, clears the real data and goes back to fixtures", async () => {
    await connect();
    expect(authStatus()).toMatchObject({ authed: true, source: "google" });
    expect(getCache().emails.map((e) => e.id).sort()).toEqual(["real-1", "real-2"]);
    const card = newProposal({ type: "send_reply", title: "Reply to Prof. Park", why: "w", urgency: 1, payload: { to: "park@uni.edu", subject: "s", body: "b" } });
    g.revokeToken.mockClear();

    const res = await app.inject({ method: "POST", url: "/auth/disconnect" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, revoked: true, authed: false, configured: true, mock: false, source: "fixtures" });
    expect(res.json().email).toBeUndefined();
    expect(g.revokeToken).toHaveBeenCalledWith("refresh-1");
    expect(fs.existsSync(config.TOKENS_PATH)).toBe(false);
    expect(getCache().emails.some((e) => e.id.startsWith("real-"))).toBe(false);
    expect(getCache().historyId).toBeUndefined();
    expect(listProposals().find((p) => p.id === card.id)).toBeUndefined();
    await expect(getAuthedClient()).rejects.toThrow(/Not signed in/);
  });

  it("still disconnects locally when the revoke call fails, and is safe to call when not connected", async () => {
    await connect();
    g.revokeToken.mockImplementationOnce(async () => {
      throw new Error("network down");
    });
    expect((await app.inject({ method: "POST", url: "/auth/disconnect" })).json()).toMatchObject({ ok: true, revoked: false, authed: false, source: "fixtures" });
    expect(fs.existsSync(config.TOKENS_PATH)).toBe(false);
    expect((await app.inject({ method: "POST", url: "/auth/disconnect" })).json()).toMatchObject({ ok: true, revoked: false, authed: false });
  });

  it("reports permissions the user did not tick on Google's consent screen", async () => {
    g.getToken.mockImplementationOnce(async () => ({
      tokens: { access_token: "a", refresh_token: "r", expiry_date: Date.now() + 3_600_000, id_token: g.idToken("student@uni.edu"), scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email" },
    }));
    await connect();
    const status = authStatus();
    expect(status.source).toBe("google");
    expect(status.reason).toMatch(/gmail\.compose, calendar\.events/);
    await app.inject({ method: "POST", url: "/auth/disconnect" });
  });
});
