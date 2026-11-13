// Follow-up detection tests. Offline: MOCK=1, fetch stubbed (memory :7701 never reached).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CachedEmail } from "../src/types.js";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-inbox-fu-"));
process.env.INBOX_DATA_DIR = DATA_DIR;
process.env.MOCK = "1";
process.env.OPENAI_API_KEY = "";
process.env.MEMORY_URL = "http://127.0.0.1:1";

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/events")) return json({ ok: true, id: "ev" });
    if (u.endsWith("/context")) return json({ snippets: [], knowledge: [] });
    return new Response("{}", { status: 404 });
  }),
);

type Store = typeof import("../src/store.js");
type FU = typeof import("../src/followups.js");
type App = typeof import("../src/app.js");
let store: Store, fu: FU, appMod: App;

const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();
const mail = (p: Partial<CachedEmail>): CachedEmail => ({
  id: "x", threadId: "x", from: "Someone", fromEmail: "someone@example.edu", to: "me@example.edu",
  subject: "Hello", receivedAt: daysAgo(1), snippet: "", bodyText: "", labels: ["INBOX"], opened: true, ...p,
});

beforeAll(async () => {
  [store, fu, appMod] = await Promise.all([import("../src/store.js"), import("../src/followups.js"), import("../src/app.js")]);
  store.resetCache();
  store.resetProposals();
  store.updateCache({
    userEmail: "me@example.edu",
    emails: [
      mail({ id: "in1", threadId: "t1", from: "Prof. Daniel Lee", fromEmail: "dlee@example.edu", subject: "CS 61B extension",
        bodyText: "Hi, just following up on my last note. Can you confirm the new deadline works for you?" }),
      mail({ id: "promo", threadId: "t2", from: "Shop", fromEmail: "deals@shop.com", subject: "Just checking in!", bodyText: "Following up on your cart.", listUnsubscribe: "https://x" }),
      mail({ id: "plain", threadId: "t3", subject: "Lunch", bodyText: "Want to grab lunch?" }),
    ],
    sentEmails: [
      mail({ id: "s1", threadId: "t9", from: "Me", fromEmail: "me@example.edu", to: "Stripe Recruiting <recruiting@stripe.com>",
        subject: "Internship application", receivedAt: daysAgo(4), bodyText: "Hi, I applied last week and wanted to share my portfolio.", labels: ["SENT"], sent: true }),
      mail({ id: "s2", threadId: "t8", fromEmail: "me@example.edu", to: "bob@example.edu", subject: "Re: notes", receivedAt: daysAgo(5), bodyText: "Thanks!", labels: ["SENT"], sent: true }),
    ],
  });
});
afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

describe("follow-ups", () => {
  it("creates a notice + send_reply proposal once per detection", async () => {
    const first = await fu.scanFollowups();
    const kinds = first.notices.map((n) => `${n.kind}:${n.emailId}`).sort();
    expect(kinds).toEqual(["followup_in:in1", "followup_needed:s1"]);
    const replies = store.listProposals("pending").filter((p) => p.type === "send_reply");
    expect(replies).toHaveLength(2);
    const inP = replies.find((p) => p.payload.emailId === "in1")!;
    expect(inP.urgency).toBe(3); // triage 1 -> contract 3
    const outP = replies.find((p) => p.payload.emailId === "s1")!;
    expect(outP.payload).toMatchObject({ threadId: "t9", to: "recruiting@stripe.com", subject: "Re: Internship application", autoSend: true });
    expect(outP.payload.body).toMatch(/Internship application/);
    expect(first.notices.every((n) => n.proposalId)).toBe(true);

    const second = await fu.scanFollowups();
    expect(second.found).toBe(0);
    expect(store.listProposals("pending").filter((p) => p.type === "send_reply")).toHaveLength(2);
  });

  it("serves the notification endpoints", async () => {
    const app = await appMod.buildServer({ logger: false });
    const all = (await app.inject({ method: "GET", url: "/notifications?unread=1" })).json();
    expect(all).toHaveLength(2);
    expect((await app.inject({ method: "POST", url: `/notifications/${all[0].id}/read` })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: "/notifications?unread=1" })).json()).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: "/notifications/read-all" })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: "/notifications?unread=1" })).json()).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/notifications" })).json()).toHaveLength(2);
    const scan = (await app.inject({ method: "POST", url: "/followups/scan" })).json();
    expect(scan).toEqual({ found: 0, notices: [] });
    await app.close();
  });
});
