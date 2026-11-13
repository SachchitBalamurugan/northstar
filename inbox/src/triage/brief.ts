import { fixSignOff, signerName, signRule } from "../signer.js";
// Inbox briefing (contracts/brief.md): a short, LLM-written overview of the triaged inbox with per-email
// one-liners and suggested replies. Regenerated in the background after every sync. Nothing is sent
// without the user approving a Proposal.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { complete, llmAvailable } from "../llm.js";
import { contextToText, getContext } from "../memory.js";
import { getCache, newProposal } from "../store.js";
import { authStatus } from "../google/status.js";
import type { CachedEmail, TriagedEmail } from "../types.js";

export interface BriefItem {
  emailId: string;
  threadId?: string;
  from: string;
  fromEmail?: string;
  subject: string;
  receivedAt: string;
  importance: "high" | "medium" | "low";
  oneLine: string;
  why: string;
  suggestedReply: string | null;
}
export interface Brief {
  generatedAt: string | null;
  summary: string;
  items: BriefItem[];
  source: "google" | "fixtures";
  stale?: boolean;
}

const MAX_ITEMS = 8;
const STALE_MS = 10 * 60_000;

let brief: Brief = { generatedAt: null, summary: "", items: [], source: authStatus().source };
let running: Promise<Brief> | undefined;

const LlmBrief = z.object({
  summary: z.string(),
  items: z.array(
    z.object({
      emailId: z.string(),
      oneLine: z.string(),
      why: z.string(),
      importance: z.enum(["high", "medium", "low"]),
      suggestedReply: z.string().nullable(),
    }),
  ),
});

type Picked = { t: TriagedEmail; e?: CachedEmail; needsYou: boolean };

function selectEmails(): Picked[] {
  const cache = getCache();
  const tri = cache.triage;
  if (!tri) return [];
  const byId = new Map(cache.emails.map((e) => [e.id, e]));
  const seen = new Set<string>();
  const out: Picked[] = [];
  const add = (t: TriagedEmail, needsYou: boolean) => {
    if (seen.has(t.emailId)) return;
    seen.add(t.emailId);
    out.push({ t, e: byId.get(t.emailId), needsYou });
  };
  tri.needsYou.forEach((t) => add(t, true));
  [...tri.fyi].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).forEach((t) => add(t, false));
  out.sort((a, b) => a.t.urgency - b.t.urgency || b.t.receivedAt.localeCompare(a.t.receivedAt));
  return out.slice(0, MAX_ITEMS);
}

const importanceOf = (p: Picked): BriefItem["importance"] =>
  p.needsYou ? (p.t.urgency === 1 ? "high" : "medium") : "low";

function baseItem(p: Picked): Omit<BriefItem, "importance" | "oneLine" | "why" | "suggestedReply"> {
  return {
    emailId: p.t.emailId,
    ...(p.e?.threadId ? { threadId: p.e.threadId } : {}),
    from: p.t.from,
    ...(p.e?.fromEmail ? { fromEmail: p.e.fromEmail } : {}),
    subject: p.t.subject,
    receivedAt: p.t.receivedAt,
  };
}

function heuristicItem(p: Picked): BriefItem {
  const first = p.t.from.split(/\s+/)[0]?.replace(/[^\p{L}.'-]/gu, "") || "there";
  const reply =
    p.needsYou && p.t.senderRole !== "promo"
      ? `Hi ${first},\n\nThanks for your email. I'll take a look and get back to you soon.\n\nBest,`
      : null;
  return {
    ...baseItem(p),
    importance: importanceOf(p),
    oneLine: p.t.snippet || p.e?.snippet || p.t.subject,
    why: p.t.why,
    suggestedReply: reply,
  };
}

function heuristicSummary(picked: Picked[]): string {
  const need = picked.filter((p) => p.needsYou).length;
  if (!picked.length) return "Your inbox is quiet right now. Nothing needs your attention.";
  const top = picked[0];
  return `${need} email${need === 1 ? "" : "s"} need${need === 1 ? "s" : ""} you and ${picked.length - need} ${picked.length - need === 1 ? "is" : "are"} FYI. ` +
    `Most pressing: "${top.t.subject}" from ${top.t.from}.`;
}

async function build(): Promise<Brief> {
  const picked = selectEmails();
  const source = authStatus().source;
  let summary = heuristicSummary(picked);
  let items = picked.map(heuristicItem);

  if (picked.length && llmAvailable()) {
    const ctx = await getContext("writing style, profile, signature, people, courses").catch(() => null);
    const emailsText = picked
      .map((p) =>
        [
          `emailId: ${p.t.emailId}`,
          `from: ${p.t.from}${p.e?.fromEmail ? ` <${p.e.fromEmail}>` : ""}`,
          `subject: ${p.t.subject}`,
          `receivedAt: ${p.t.receivedAt}`,
          `triage: ${p.needsYou ? "needs you" : "fyi"}, urgency ${p.t.urgency} (1 = most urgent), role ${p.t.senderRole}`,
          `triage why: ${p.t.why}`,
          p.t.asks.length ? `asks: ${p.t.asks.join("; ")}` : "",
          `body: ${(p.e?.bodyText || p.t.snippet || "").slice(0, 1200)}`,
        ].filter(Boolean).join("\n"),
      )
      .join("\n\n---\n\n");
    const signer = await signerName();
    try {
      const out = await complete({
        tier: "smart",
        schema: LlmBrief,
        schemaName: "inbox_brief",
        system:
          "You brief a busy student on their inbox. Write `summary`: 2-4 sentences on what matters right now. For EVERY email give: " +
          "oneLine (one sentence: what it says or asks), why (why it matters to the student; cite their profile/memory when relevant), " +
          "importance (high/medium/low), suggestedReply (a short reply in the student's own voice, matching their writing style and " +
          "sign-off from the context; null when no reply is needed, e.g. newsletters, promos, notifications, FYI). Never invent facts, " +
          "dates, or commitments not in the email or context. Keep the same emailId values." + signRule(signer),
        input: [ctx ? `About the student (context):\n${contextToText(ctx, 2000)}` : "", `Emails:\n\n${emailsText}`]
          .filter(Boolean)
          .join("\n\n"),
      });
      const byId = new Map(out.items.map((i) => [i.emailId, i]));
      summary = out.summary.trim() || summary;
      items = picked.map((p, idx) => {
        const h = items[idx];
        const l = byId.get(p.t.emailId);
        if (!l) return h;
        return {
          ...h,
          importance: l.importance,
          oneLine: l.oneLine.trim() || h.oneLine,
          why: l.why.trim() || h.why,
          suggestedReply: l.suggestedReply && l.suggestedReply.trim() ? fixSignOff(l.suggestedReply.trim(), signer) : null,
        };
      });
    } catch (err) {
      console.warn("[brief] LLM failed, using heuristic brief:", (err as Error).message);
    }
  }
  return { generatedAt: new Date().toISOString(), summary, items, source };
}

/** Regenerate the briefing; overlapping calls share one run. */
export function regenerateBrief(): Promise<Brief> {
  running ??= build()
    .then((b) => (brief = b))
    .finally(() => (running = undefined));
  return running;
}

export function getBrief(): Brief {
  return running ? { ...brief, stale: true } : brief;
}

function briefText(b: Brief): string {
  const lines = [b.summary, ""];
  b.items.forEach((i, n) => {
    lines.push(`${n + 1}. ${i.subject} (from ${i.from}) [${i.importance}]`, `   ${i.oneLine}`, `   Why: ${i.why}`);
    if (i.suggestedReply) lines.push(`   Suggested reply:`, ...i.suggestedReply.split("\n").map((l) => `     ${l}`));
    lines.push("");
  });
  return lines.join("\n").trim();
}

export async function briefRoutes(app: FastifyInstance): Promise<void> {
  app.get("/inbox/brief", async () => {
    const old = !brief.generatedAt || Date.now() - new Date(brief.generatedAt).getTime() > STALE_MS;
    if (old && !running) regenerateBrief().catch(() => {});
    return getBrief();
  });

  app.post("/inbox/brief/refresh", async () => regenerateBrief());

  app.post<{ Params: { emailId: string }; Body: { body?: string } | null }>("/inbox/brief/:emailId/reply", async (req, reply) => {
    const body = req.body?.body?.trim();
    if (!body) return reply.code(400).send({ error: "body required" });
    const { emailId } = req.params;
    const item = brief.items.find((i) => i.emailId === emailId);
    const cached = getCache().emails.find((e) => e.id === emailId);
    const to = item?.fromEmail ?? cached?.fromEmail;
    if (!item && !cached) return reply.code(404).send({ error: "email not found" });
    if (!to) return reply.code(400).send({ error: "no sender address for this email" });
    const rawSubject = item?.subject ?? cached?.subject ?? "";
    const subject = /^re:/i.test(rawSubject) ? rawSubject : `Re: ${rawSubject}`;
    return newProposal({
      type: "send_reply",
      title: `Reply to ${item?.from ?? cached?.from ?? to}: ${rawSubject}`,
      why: "You approved a suggested reply from your inbox briefing.",
      urgency: 1,
      payload: { emailId, threadId: item?.threadId ?? cached?.threadId ?? "", to, subject, body, originalBody: body, autoSend: true },
    });
  });

  app.post("/inbox/brief/email-me", async (_req, reply) => {
    const to = authStatus().email;
    if (!to) return reply.code(400).send({ error: "connected account email unknown; connect Google first" });
    const b = brief.generatedAt ? brief : await regenerateBrief();
    const date = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    const subject = `Your inbox briefing - ${date}`;
    const body = briefText(b);
    return newProposal({
      type: "send_reply",
      title: subject,
      why: "You asked me to email you the inbox briefing.",
      urgency: 1,
      payload: { emailId: "", threadId: "", to, subject, body, originalBody: body, autoSend: true, fresh: true },
    });
  });
}
