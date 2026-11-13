// Offline tests for the Gmail sub-agent: parsing, merge/dedupe, MOCK sync, drafts and the send_reply approve handler.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

// Runs before any import: isolate data dir, force MOCK, point memory at a dead port, hide any real Google client id.
const env = await vi.hoisted(async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const fsp = await import("node:fs");
  const dir = fsp.mkdtempSync(path.join(os.tmpdir(), "northstar-gmail-test-"));
  process.env.MOCK = "1";
  process.env.INBOX_DATA_DIR = dir;
  process.env.MEMORY_URL = "http://127.0.0.1:1";
  process.env.GOOGLE_CLIENT_ID = "";
  process.env.GOOGLE_CLIENT_SECRET = "";
  return { dir };
});

// Deterministic fixture so the MOCK sync test doesn't depend on fixtures/emails.json existing yet.
vi.mock("../src/fixtures.js", () => ({
  loadFixture: vi.fn(() => [
    {
      id: "fx-1", threadId: "t-1", from: "Prof. Lee", fromEmail: "lee@uni.edu", to: "me@uni.edu",
      subject: "Syllabus change", receivedAt: "2026-11-12T10:00:00.000Z", snippet: "hi", bodyText: "hi",
      labels: ["INBOX", "UNREAD"], opened: false,
    },
    {
      id: "fx-2", threadId: "t-2", from: "Robotics Club", fromEmail: "club@uni.edu", to: "me@uni.edu",
      subject: "Meeting", receivedAt: "2026-11-13T09:00:00.000Z", snippet: "yo", bodyText: "yo",
      labels: ["INBOX"], opened: true,
    },
  ]),
}));

import {
  decodeBody, decodeEntities, extractListUnsubscribe, htmlToText, isSignOffLine, normalizeMessage,
  parseAddress, stripQuotedReplies, stripSignature,
} from "../src/gmail/parse.js";
import { mapLimit, mergeEmails, syncGmail } from "../src/gmail/sync.js";
import { buildReplyMime, createReplyDraft, readMockOutbox, replySubject, sendDraft, MOCK_OUTBOX_PATH } from "../src/gmail/drafts.js";
import { handleSendReply, summarizeEdit } from "../src/gmail/routes.js";
import { approveProposal, registerApproveHandler } from "../src/proposals.js";
import { getCache, newProposal, resetCache, resetProposals } from "../src/store.js";
import { getAuthUrl, isAuthed } from "../src/google/auth.js";
import { buildServer } from "../src/app.js";
import type { CachedEmail } from "../src/types.js";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

// fetch mock: memory.ts posts events here. Records every call so tests can inspect them.
const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
const postedEvents = () =>
  fetchMock.mock.calls
    .map((c) => c as unknown as [string, { body?: string }])
    .filter(([url]) => String(url).endsWith("/events"))
    .map(([, init]) => JSON.parse(init?.body ?? "{}") as { kind: string; text: string; tags?: string[]; refs?: { emailId?: string } });

beforeAll(() => vi.stubGlobal("fetch", fetchMock));
afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(env.dir, { recursive: true, force: true });
});
beforeEach(() => {
  fetchMock.mockClear();
  resetProposals();
  fs.rmSync(MOCK_OUTBOX_PATH, { force: true });
});

// ---------------------------------------------------------------- parse.ts
describe("decodeBody", () => {
  it("prefers text/plain inside nested multipart and base64url-decodes it", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("Hello there — ü ok?\r\nSecond line") } },
            { mimeType: "text/html", body: { data: b64url("<p>Hello <b>there</b></p>") } },
          ],
        },
        { mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "x" } },
      ],
    };
    expect(decodeBody(payload)).toBe("Hello there — ü ok?\nSecond line");
  });

  it("handles base64url characters (- and _) without padding", () => {
    const text = "???>>>"; // base64 of this contains + and /
    const std = Buffer.from(text).toString("base64");
    expect(std).toMatch(/[+/]/);
    const url = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeBody({ mimeType: "text/plain", body: { data: url } })).toBe(text);
  });

  it("falls back to text/html stripped to text with entities decoded", () => {
    const html =
      "<html><head><style>p{color:red}</style></head><body><div>Hi&nbsp;Sam,</div>" +
      "<p>Form is due <b>Friday</b> &amp; it&#39;s &lt;important&gt;.</p><br><ul><li>one</li><li>two</li></ul>" +
      "<script>alert(1)</script></body></html>";
    const payload = { mimeType: "multipart/alternative", parts: [
      { mimeType: "text/plain", body: { data: b64url("   ") } },
      { mimeType: "text/html", body: { data: b64url(html) } },
    ] };
    expect(decodeBody(payload)).toBe("Hi Sam,\n\nForm is due Friday & it's <important>.\n\none\ntwo");
  });

  it("returns empty string for missing payload", () => {
    expect(decodeBody(undefined)).toBe("");
    expect(htmlToText("")).toBe("");
    expect(decodeEntities("&amp;lt; &#x41;&#66;")).toBe("&lt; AB");
  });
});

describe("stripQuotedReplies", () => {
  it("cuts at a wrapped 'On ... wrote:' header and drops > lines", () => {
    const text = [
      "Sure, Tuesday works.",
      "",
      "> earlier quoted line",
      "On Mon, Nov 10, 2025 at 3:14 PM Prof. Lee",
      "<lee@uni.edu> wrote:",
      "> Can we meet Tuesday?",
      "> -Lee",
    ].join("\n");
    expect(stripQuotedReplies(text)).toBe("Sure, Tuesday works.");
  });

  it("cuts at -----Original Message----- and Outlook header blocks", () => {
    expect(stripQuotedReplies("Yes please.\r\n\r\n-----Original Message-----\r\nFrom: x\r\nSent: y")).toBe("Yes please.");
    expect(stripQuotedReplies("Got it.\n\nFrom: TA <ta@uni.edu>\nSent: Monday\nTo: me\nSubject: hw\n\nold stuff")).toBe("Got it.");
  });

  it("leaves ordinary sentences starting with 'On' alone", () => {
    const t = "On Monday I will submit the form.\nThanks for the heads up.";
    expect(stripQuotedReplies(t)).toBe(t);
  });
});

describe("stripSignature", () => {
  it("cuts at the '-- ' delimiter", () => {
    expect(stripSignature("Body text\nmore\n-- \nSam Lee\nCS '27")).toBe("Body text\nmore");
  });
  it("cuts at a sign-off in the last 8 lines", () => {
    expect(stripSignature("See you at 3.\n\nThanks,\nSam")).toBe("See you at 3.");
    expect(stripSignature("Can you send it?\n\nBest regards\nProf. Lee\nDept of CS")).toBe("Can you send it?");
    expect(stripSignature("ok will do\n\nSent from my iPhone")).toBe("ok will do");
  });
  it("does not cut sign-off-looking lines deep in the body, or empty everything", () => {
    const long = ["Thanks,", ...Array.from({ length: 12 }, (_, i) => `line ${i}`)].join("\n");
    expect(stripSignature(long)).toBe(long);
    expect(stripSignature("Thanks!")).toBe("Thanks!");
    expect(isSignOffLine("Thanks for your help")).toBe(false);
    expect(isSignOffLine("Thanks, Sam Lee")).toBe(true);
    expect(isSignOffLine("Bestie, come over")).toBe(false);
  });
});

describe("headers", () => {
  it("extractListUnsubscribe picks the first http(s) URL and ignores mailto", () => {
    expect(extractListUnsubscribe("<mailto:unsub@promo.com?subject=x>, <https://promo.com/u?id=1>")).toBe("https://promo.com/u?id=1");
    expect(extractListUnsubscribe("<mailto:unsub@promo.com>")).toBeUndefined();
    expect(extractListUnsubscribe("http://a.com/u, <https://b.com/u>")).toBe("https://b.com/u");
    expect(extractListUnsubscribe(undefined)).toBeUndefined();
  });
  it("parseAddress splits display name and address", () => {
    expect(parseAddress('"Lee, Anna" <Anna@Uni.edu>')).toEqual({ name: "Lee, Anna", email: "anna@uni.edu" });
    expect(parseAddress("Anna Lee <anna@uni.edu>")).toEqual({ name: "Anna Lee", email: "anna@uni.edu" });
    expect(parseAddress("<anna@uni.edu>")).toEqual({ name: "", email: "anna@uni.edu" });
    expect(parseAddress("anna@uni.edu")).toEqual({ name: "", email: "anna@uni.edu" });
    expect(parseAddress("")).toEqual({ name: "", email: "" });
  });
});

describe("normalizeMessage", () => {
  it("builds a CachedEmail from a full-format message", () => {
    const e = normalizeMessage({
      id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], internalDate: "1763000000000",
      snippet: "Hi Sam, the form is due Friday &#39;cause reasons",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Financial Aid <aid@uni.edu>" },
          { name: "To", value: "sam@uni.edu" },
          { name: "Subject", value: "Form due Friday" },
          { name: "Date", value: "Wed, 12 Nov 2026 10:00:00 -0800" },
          { name: "List-Unsubscribe", value: "<https://uni.edu/unsub/1>" },
        ],
        body: { data: b64url("Hi Sam,\n\nThe form is due Friday.\n\nThanks,\nAid Office\n\nOn Tue, Nov 11 Sam wrote:\n> what form?") },
      },
    });
    expect(e).toMatchObject({
      id: "m1", threadId: "t1", from: "Financial Aid", fromEmail: "aid@uni.edu", to: "sam@uni.edu",
      subject: "Form due Friday", receivedAt: "2026-11-12T18:00:00.000Z", labels: ["INBOX", "UNREAD"],
      listUnsubscribe: "https://uni.edu/unsub/1", opened: false,
    });
    expect(e.bodyText).toBe("Hi Sam,\n\nThe form is due Friday.");
    expect(e.snippet).toBe("Hi Sam, the form is due Friday 'cause reasons");
  });
  it("falls back to internalDate and marks read mail as opened", () => {
    const e = normalizeMessage({ id: "m2", labelIds: ["INBOX"], internalDate: "1763000000000", payload: { headers: [{ name: "From", value: "x@y.z" }] } });
    expect(e.receivedAt).toBe(new Date(1763000000000).toISOString());
    expect(e.opened).toBe(true);
    expect(e.from).toBe("x@y.z");
    expect(e.subject).toBe("(no subject)");
    expect(e.threadId).toBe("m2");
  });
});

// ---------------------------------------------------------------- sync.ts
const mk = (id: string, receivedAt: string, extra: Partial<CachedEmail> = {}): CachedEmail => ({
  id, threadId: id, from: "a", fromEmail: "a@b.c", to: "me", subject: id, receivedAt, snippet: "", bodyText: "", labels: [], ...extra,
});

describe("mergeEmails", () => {
  it("dedupes by id (incoming wins), drops mail older than 7 days, sorts newest first", () => {
    const now = new Date("2026-11-13T12:00:00Z");
    const existing = [mk("a", "2026-11-10T00:00:00Z", { subject: "old a" }), mk("stale", "2026-11-01T00:00:00Z")];
    const incoming = [mk("b", "2026-11-13T08:00:00Z"), mk("a", "2026-11-10T00:00:00Z", { subject: "new a" })];
    const merged = mergeEmails(existing, incoming, now);
    expect(merged.map((e) => e.id)).toEqual(["b", "a"]);
    expect(merged[1].subject).toBe("new a");
  });
  it("mapLimit keeps order and bounds concurrency", async () => {
    let inFlight = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe("syncGmail (MOCK)", () => {
  it("loads the fixture into the cache, newest first, without network calls", async () => {
    resetCache();
    const r = await syncGmail();
    expect(r).toEqual({ emails: 2 });
    expect(getCache().emails.map((e) => e.id)).toEqual(["fx-2", "fx-1"]);
    expect(getCache().lastSyncAt).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- drafts.ts
describe("drafts", () => {
  it("replySubject adds Re: once", () => {
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello")).toBe("RE: Hello");
  });
  it("buildReplyMime sets threading headers and base64 body", () => {
    const mime = buildReplyMime({ to: "a@b.c", subject: "Re: Hi ü", body: "héllo", inReplyTo: "<m1@x>", references: "<m0@x>" });
    expect(mime).toContain("To: a@b.c\r\n");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain("In-Reply-To: <m1@x>\r\n");
    expect(mime).toContain("References: <m0@x> <m1@x>\r\n");
    const body = mime.split("\r\n\r\n")[1].trim();
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("héllo");
  });
  it("MOCK createReplyDraft/sendDraft write to the mock outbox", async () => {
    const d = await createReplyDraft({ emailId: "m1", threadId: "t1", to: "lee@uni.edu", subject: "Hi", body: "ok" });
    expect(d.draftId).toMatch(/^mock-/);
    await sendDraft(d.draftId);
    const out = readMockOutbox();
    expect(out.map((o) => o.kind)).toEqual(["draft", "send"]);
    expect(out[0]).toMatchObject({ draftId: d.draftId, subject: "Re: Hi", to: "lee@uni.edu" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- routes.ts: approve handler
describe("send_reply approve handler", () => {
  // gmailRoutes(app) does this registration in production; the handler is exercised here without an HTTP server.
  beforeAll(() => registerApproveHandler("send_reply", handleSendReply));
  const original = "Hi Prof. Lee,\n\nThank you so much for the detailed feedback on my proposal! I really appreciate it and will revise everything you mentioned by next week.\n\nBest regards,\nSam";

  it("creates a mock draft, posts a preference event when the body was edited, and does not send", async () => {
    const edited = "Hi Prof. Lee,\n\nThanks for the feedback, I'll revise by next week.\n\nThanks,\nSam";
    const p = newProposal({
      type: "send_reply", title: "Reply to Prof. Lee", why: "test", urgency: 2,
      payload: { emailId: "m1", threadId: "t1", to: "lee@uni.edu", subject: "Proposal", body: original, originalBody: original },
    });
    const done = await approveProposal(p.id, { body: edited });
    expect(done?.status).toBe("done");
    expect(done?.payload.draftId).toMatch(/^mock-/);
    expect(done?.payload.sent).toBeUndefined();
    expect(readMockOutbox().map((o) => o.kind)).toEqual(["draft"]);

    const events = postedEvents();
    const pref = events.find((e) => e.kind === "preference");
    expect(pref?.text).toMatch(/^Edited draft before approving: /);
    expect(pref?.text).toContain("shorter");
    expect(pref?.text).toContain('prefers signing off with "Thanks,"');
    expect(pref?.tags).toEqual(["draft", "edit"]);
    expect(pref?.refs).toEqual({ emailId: "m1" });
    const obs = events.find((e) => e.kind === "observation");
    expect(obs?.text).toBe("Drafted reply to lee@uni.edu: Proposal");
    expect(obs?.refs).toEqual({ emailId: "m1" });
  });

  it("posts no preference when unedited, and sends only with autoSend === true", async () => {
    const r = await handleSendReply({
      id: "x", agent: "inbox", createdAt: "", type: "send_reply", title: "t", why: "w", urgency: 3, status: "approved",
      payload: { emailId: "m2", threadId: "t2", to: "ta@uni.edu", subject: "Re: HW", body: original, originalBody: original, autoSend: true },
    });
    expect(r.sent).toBe(true);
    expect(readMockOutbox().map((o) => o.kind)).toEqual(["draft", "send"]);
    const events = postedEvents();
    expect(events.some((e) => e.kind === "preference")).toBe(false);
    expect(events.find((e) => e.kind === "observation")?.text).toBe("Sent reply to ta@uni.edu: Re: HW");
  });

  it("fails the proposal with a readable error when the payload is incomplete", async () => {
    const p = newProposal({ type: "send_reply", title: "bad", why: "w", urgency: 3, payload: { emailId: "m1" } });
    const done = await approveProposal(p.id);
    expect(done?.status).toBe("failed");
    expect(done?.payload.error).toContain("send_reply payload needs");
  });

  it("summarizeEdit describes formality and sign-off changes", () => {
    expect(summarizeEdit("Hey Lee,\n\nsee attached!!\n\nCheers,\nSam", "Dear Prof. Lee,\n\nPlease see the attached file.\n\nSincerely,\nSam"))
      .toContain('prefers a formal greeting ("Dear Prof. Lee")');
    expect(summarizeEdit("a b c\n\nThanks,\nSam", "a b c")).toContain("drops the sign-off");
    expect(summarizeEdit("a b c", "a b d")).toBe("small wording changes");
  });
});

// ---------------------------------------------------------------- auth + HTTP routes
describe("auth + routes (MOCK, no Google client configured)", () => {
  it("getAuthUrl throws a readable error and isAuthed is false", () => {
    expect(() => getAuthUrl()).toThrow("GOOGLE_CLIENT_ID/SECRET not set in .env");
    expect(isAuthed()).toBe(false);
  });

  it("serves /auth/status, /auth/url, /emails and /emails/:id", async () => {
    resetCache();
    await syncGmail();
    const app = await buildServer({ logger: false });
    try {
      expect((await app.inject({ method: "GET", url: "/auth/status" })).json()).toEqual({ authed: false, mock: true });
      const url = await app.inject({ method: "GET", url: "/auth/url" });
      expect(url.statusCode).toBe(500);
      expect(url.json().error).toContain("GOOGLE_CLIENT_ID");
      const cb = await app.inject({ method: "GET", url: "/auth/callback" });
      expect(cb.statusCode).toBe(400);

      const list = await app.inject({ method: "GET", url: "/emails" });
      expect(list.statusCode).toBe(200);
      expect(list.json().map((e: CachedEmail) => e.id)).toEqual(["fx-2", "fx-1"]);
      expect((await app.inject({ method: "GET", url: "/emails/fx-1" })).json().subject).toBe("Syllabus change");
      expect((await app.inject({ method: "GET", url: "/emails/nope" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
