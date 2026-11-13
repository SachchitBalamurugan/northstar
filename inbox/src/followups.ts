// Follow-up detection: runs after every sync (and POST /followups/scan). Creates `send_reply` Proposals
// (nothing is sent until approved) plus a Notice for each new detection. Dedupe keys persist in the cache.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { complete, llmAvailable } from "./llm.js";
import { fixSignOff, signerName, signRule } from "./signer.js";
import { getCache, newProposal, updateCache } from "./store.js";
import { draftReply } from "./triage/draft.js";
import type { CachedEmail, Proposal } from "./types.js";

export interface Notice {
  id: string;
  kind: "followup_in" | "followup_needed";
  title: string;
  body: string;
  emailId?: string;
  threadId?: string;
  proposalId?: string;
  createdAt: string;
  read: boolean;
}

const DAY = 24 * 60 * 60 * 1000;
const FOLLOWUP_RE = /\b(following up|follow(?:ing)?[- ]up|checking in|circling back|any updates?|gentle reminder|friendly reminder|bumping this)\b/i;
const PROMO_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "SPAM"]);
const NOREPLY_RE = /(no-?reply|donotreply|do-not-reply|newsletter|notifications?@|mailer|marketing|digest)/i;
const CLOSER_RE = /^\s*(thanks|thank you|thx|ty|great|perfect|awesome|sounds good|got it|ok(ay)?|will do|cheers)[\s!.,:)]*([\p{L}.\s]{0,30})?$/iu;

const ts = (e: CachedEmail) => Date.parse(e.receivedAt) || 0;
const topic = (s: string) => s.replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/i, "").trim() || "(no subject)";
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3).trimEnd() + "..." : s);
const firstSentence = (text: string) => short((text.replace(/\s+/g, " ").trim().match(/^.*?[.!?](\s|$)/)?.[0] ?? text).trim(), 160);
const addr = (raw: string) => (raw.match(/<([^>]+)>/)?.[1] ?? raw.split(",")[0] ?? "").trim().toLowerCase();
const displayName = (raw: string) => {
  const first = raw.split(",")[0] ?? "";
  const n = first.replace(/<[^>]*>/, "").replace(/"/g, "").trim();
  return n || addr(raw) || "them";
};

function isPromo(e: CachedEmail): boolean {
  return !!e.listUnsubscribe || e.labels.some((l) => PROMO_LABELS.has(l)) || NOREPLY_RE.test(e.fromEmail);
}

interface Detection {
  kind: Notice["kind"];
  key: string;
  email: CachedEmail;
}

/** Pure detection over the cache (exported for tests). */
export function detectFollowups(now: Date = new Date()): Detection[] {
  const cache = getCache();
  const inbox = cache.emails.filter((e) => !e.sent);
  const sent = cache.sentEmails ?? [];
  const me = (cache.userEmail ?? "").toLowerCase();
  const lastSentInThread = new Map<string, number>();
  for (const s of sent) lastSentInThread.set(s.threadId, Math.max(lastSentInThread.get(s.threadId) ?? 0, ts(s)));
  const out: Detection[] = [];
  const t = now.getTime();

  // followup_in: keyword, or 2nd+ unanswered message from the same sender in a thread.
  const byThreadSender = new Map<string, CachedEmail[]>();
  for (const e of inbox) {
    const k = `${e.threadId}|${e.fromEmail.toLowerCase()}`;
    byThreadSender.set(k, [...(byThreadSender.get(k) ?? []), e]);
  }
  for (const e of inbox) {
    if (t - ts(e) > 7 * DAY || ts(e) > t + DAY) continue;
    if (isPromo(e) || (me && e.fromEmail.toLowerCase() === me)) continue;
    const lastSent = lastSentInThread.get(e.threadId) ?? 0;
    if (lastSent > ts(e)) continue; // already replied
    const keyword = FOLLOWUP_RE.test(`${e.subject}\n${e.bodyText.slice(0, 1500)}`);
    const unanswered = (byThreadSender.get(`${e.threadId}|${e.fromEmail.toLowerCase()}`) ?? [])
      .filter((x) => ts(x) > lastSent)
      .sort((a, b) => ts(a) - ts(b));
    const repeat = unanswered.length >= 2 && unanswered[unanswered.length - 1].id === e.id;
    if (keyword || repeat) out.push({ kind: "followup_in", key: `followup_in:${e.id}`, email: e });
  }

  // followup_needed: the latest message the user sent in a thread, 3-10 days old, nothing back since.
  const latestSent = new Map<string, CachedEmail>();
  for (const s of sent) if (!latestSent.has(s.threadId) || ts(s) > ts(latestSent.get(s.threadId)!)) latestSent.set(s.threadId, s);
  for (const s of latestSent.values()) {
    const age = t - ts(s);
    if (age < 3 * DAY || age > 10 * DAY) continue;
    const to = addr(s.to);
    if (!to || (me && to === me)) continue;
    const text = s.bodyText.trim();
    if (text.length < 3 || CLOSER_RE.test(text)) continue;
    if (inbox.some((e) => e.threadId === s.threadId && ts(e) > ts(s))) continue;
    out.push({ kind: "followup_needed", key: `followup_needed:${s.id}`, email: s });
  }
  return out;
}

const FollowupSchema = z.object({ body: z.string() });

async function draftFollowup(s: CachedEmail, now: Date): Promise<Proposal> {
  const signer = await signerName();
  const days = Math.max(1, Math.round((now.getTime() - ts(s)) / DAY));
  const subj = topic(s.subject);
  const name = displayName(s.to);
  const greet = name.includes("@") ? "Hi there," : `Hi ${name.split(/\s+/)[0]},`;
  let body: string | undefined;
  if (llmAvailable()) {
    try {
      const out = await complete({
        tier: "fast",
        system: `You write a short, polite follow-up email in the user's voice: 2-4 sentences, warm and concise, no corporate speak. Reference the original subject. Start with "${greet}". Return JSON {body}.${signRule(signer)}`,
        input: `Original subject: ${s.subject}\nSent ${days} days ago to ${s.to}\nWhat the user wrote:\n${s.bodyText.slice(0, 2000)}`,
        schema: FollowupSchema,
        schemaName: "followup",
      });
      body = fixSignOff(out.body.trim(), signer);
    } catch {
      body = undefined;
    }
  }
  body ??= fixSignOff(
    `${greet}\n\nI wanted to gently follow up on my email about "${subj}" from ${days} days ago. Whenever you have a moment, I'd really appreciate hearing back. Thank you!\n\n${signer ? `Best,\n${signer}` : "Best,"}`,
    signer,
  );
  return newProposal({
    type: "send_reply",
    title: `Follow up with ${short(name, 20)} about ${subj}`,
    why: `You emailed ${name} ${days} days ago and haven't heard back.`,
    urgency: 2,
    payload: {
      emailId: s.id,
      threadId: s.threadId,
      to: addr(s.to),
      subject: /^re:/i.test(s.subject) ? s.subject : `Re: ${subj}`,
      body,
      originalBody: body,
      autoSend: true,
      followup: true,
    },
  } as Parameters<typeof newProposal>[0]);
}

async function draftIncoming(e: CachedEmail): Promise<Proposal | undefined> {
  try {
    const p = await draftReply(e.id);
    if (p.status !== "pending") return p;
    const { id, agent: _a, createdAt: _c, status: _s, urgency: _u, ...rest } = p;
    return newProposal({ ...rest, id, urgency: 1 });
  } catch {
    return undefined;
  }
}

type ScanResult = { found: number; notices: Notice[] };
let scanning: Promise<ScanResult> | undefined;
/** Detect new follow-ups, draft replies, record Notices. A detection never re-fires. */
export function scanFollowups(now: Date = new Date()): Promise<ScanResult> {
  scanning ??= doScan(now).finally(() => (scanning = undefined));
  return scanning;
}

async function doScan(now: Date): Promise<ScanResult> {
  const seen = new Set(getCache().followupSeen ?? []);
  const fresh = detectFollowups(now).filter((d) => !seen.has(d.key));
  const created: Notice[] = [];
  for (const d of fresh) {
    seen.add(d.key);
    updateCache({ followupSeen: [...seen] }); // persist before drafting so a crash can't re-fire it
    const e = d.email;
    let notice: Notice;
    if (d.kind === "followup_in") {
      const p = await draftIncoming(e);
      notice = {
        id: randomUUID(), kind: d.kind,
        title: short(`${e.from} followed up: ${topic(e.subject)}`, 90),
        body: firstSentence(e.bodyText || e.snippet),
        emailId: e.id, threadId: e.threadId, ...(p ? { proposalId: p.id } : {}),
        createdAt: new Date().toISOString(), read: false,
      };
    } else {
      const days = Math.max(1, Math.round((now.getTime() - ts(e)) / DAY));
      let p: Proposal | undefined;
      try {
        p = await draftFollowup(e, now);
      } catch {
        p = undefined;
      }
      notice = {
        id: randomUUID(), kind: d.kind,
        title: short(`No reply from ${displayName(e.to)} in ${days} days`, 90),
        body: short(`You wrote about "${topic(e.subject)}": ${firstSentence(e.bodyText || e.snippet)}`, 200),
        emailId: e.id, threadId: e.threadId, ...(p ? { proposalId: p.id } : {}),
        createdAt: new Date().toISOString(), read: false,
      };
    }
    created.push(notice);
    updateCache({ notices: [notice, ...(getCache().notices ?? [])].slice(0, 200) });
  }
  return { found: created.length, notices: created };
}

export function listNotices(unreadOnly = false): Notice[] {
  return (getCache().notices ?? []).filter((n) => !unreadOnly || !n.read).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function followupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/notifications", async (req) => {
    const q = req.query as { unread?: string };
    return listNotices(q.unread === "1" || q.unread === "true");
  });
  app.post("/notifications/read-all", async () => {
    updateCache({ notices: (getCache().notices ?? []).map((n) => ({ ...n, read: true })) });
    return { ok: true as const };
  });
  app.post("/notifications/:id/read", async (req, reply) => {
    const { id } = req.params as { id: string };
    const notices = getCache().notices ?? [];
    if (!notices.some((n) => n.id === id)) return reply.code(404).send({ error: "notice not found" });
    updateCache({ notices: notices.map((n) => (n.id === id ? { ...n, read: true } : n)) });
    return { ok: true as const };
  });
  app.post("/followups/scan", async () => scanFollowups());
}
