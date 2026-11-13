// Inbox briefing tests. Offline: MOCK=1, no OpenAI key (heuristic path), fetch stubbed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CachedEmail, CachedEvent, Proposal } from "../src/types.js";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-inbox-brief-"));
process.env.INBOX_DATA_DIR = DATA_DIR;
process.env.MOCK = "1";
process.env.OPENAI_API_KEY = "";
process.env.MEMORY_URL = "http://127.0.0.1:1";

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/events")) return json({ ok: true, id: "ev-1" });
    if (u.endsWith("/context")) return json({ snippets: [], knowledge: [] });
    throw new Error(`unexpected network call in test: ${u}`);
  }),
);

let app: Awaited<ReturnType<typeof import("../src/app.js")["buildServer"]>>;
let emails: CachedEmail[];

beforeAll(async () => {
  const [fixtures, store, triage, appMod] = await Promise.all([
    import("../src/fixtures.js"), import("../src/store.js"), import("../src/triage/triage.js"), import("../src/app.js"),
  ]);
  emails = fixtures.loadFixture<CachedEmail>("emails.json");
  store.updateCache({ emails, events: fixtures.loadFixture<CachedEvent>("events.json"), triage: undefined, triagedAt: undefined });
  store.resetProposals();
  app = await appMod.buildServer({ logger: false });
  await app.inject({ method: "POST", url: "/triage/run" });
  void triage;
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("inbox brief", () => {
  it("refresh + GET return a Brief with at most 8 items", async () => {
    const r = await app.inject({ method: "POST", url: "/inbox/brief/refresh" });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.generatedAt).toBeTruthy();
    expect(typeof b.summary).toBe("string");
    expect(b.summary.length).toBeGreaterThan(0);
    expect(b.source).toBe("fixtures");
    expect(b.items.length).toBeGreaterThan(0);
    expect(b.items.length).toBeLessThanOrEqual(8);
    expect(new Set(b.items.map((i: any) => i.emailId)).size).toBe(b.items.length);
    for (const i of b.items) {
      expect(["high", "medium", "low"]).toContain(i.importance);
      expect(typeof i.oneLine).toBe("string");
      expect(typeof i.why).toBe("string");
      expect(i.suggestedReply === null || typeof i.suggestedReply === "string").toBe(true);
      expect(i.fromEmail).toContain("@");
    }
    const g = await app.inject({ method: "GET", url: "/inbox/brief" });
    expect(g.statusCode).toBe(200);
    expect(g.json().items).toHaveLength(b.items.length);
  });

  it("reply endpoint creates a threaded send_reply proposal", async () => {
    const b = (await app.inject({ method: "GET", url: "/inbox/brief" })).json();
    const item = b.items[0];
    const r = await app.inject({ method: "POST", url: `/inbox/brief/${item.emailId}/reply`, payload: { body: "Sounds good, thanks!" } });
    expect(r.statusCode).toBe(200);
    const p = r.json() as Proposal;
    expect(p.type).toBe("send_reply");
    expect(p.urgency).toBe(3);
    const pl = p.payload as any;
    expect(pl.emailId).toBe(item.emailId);
    expect(pl.to).toBe(item.fromEmail);
    expect(pl.threadId).toBe(emails.find((e) => e.id === item.emailId)!.threadId);
    expect(pl.body).toBe("Sounds good, thanks!");
    expect(pl.autoSend).toBe(true);
    expect(pl.fresh).toBeUndefined();

    const bad = await app.inject({ method: "POST", url: `/inbox/brief/${item.emailId}/reply`, payload: {} });
    expect(bad.statusCode).toBe(400);
  });
});
