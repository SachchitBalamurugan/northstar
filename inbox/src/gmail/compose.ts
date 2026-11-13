// POST /compose {instruction}: write a NEW email from a plain-language request, e.g.
//   "send an email to someone@berkeley.edu about the latest news in tech"
// -> pulls fresh, cited research from memory /research/brief when the request needs current info,
// -> writes subject + body in the student's voice (writingstyle.md / profile.md via memory context),
// -> creates a `send_reply` Proposal with autoSend:true. NOTHING is sent until the user approves it.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MEMORY_URL } from "../config.js";
import { complete, llmAvailable } from "../llm.js";
import { contextToText, getContext } from "../memory.js";
import { newProposal } from "../store.js";

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const NEEDS_RESEARCH = /\b(latest|news|recent|today|this week|update|trends?|what'?s new|happening)\b/i;

const Draft = z.object({ subject: z.string().min(1).max(120), body: z.string().min(1) });

async function researchBrief(topic: string): Promise<{ text: string; citations: { url: string; title: string }[] } | null> {
  try {
    const r = await fetch(`${MEMORY_URL}/research/brief`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic }), signal: AbortSignal.timeout(150_000),
    });
    if (!r.ok) return null;
    return (await r.json()) as { text: string; citations: { url: string; title: string }[] };
  } catch { return null; }
}

export async function composeEmail(instruction: string) {
  const to = instruction.match(EMAIL_RE)?.[0];
  if (!to) throw Object.assign(new Error("I couldn't find an email address in that request."), { statusCode: 400 });
  const topic = instruction.replace(EMAIL_RE, "").replace(/\b(send|write|email|an?|to|me|please|about)\b/gi, " ").replace(/\s+/g, " ").trim() || "a quick note";

  const brief = NEEDS_RESEARCH.test(instruction) ? await researchBrief(topic) : null;
  const ctx = await getContext(`writing style, profile, signature, ${topic}`).catch(() => null);

  let subject: string, body: string;
  if (llmAvailable()) {
    const out = await complete({
      tier: "smart", schema: Draft, schemaName: "email",
      system: "You write emails for a busy student. Match their writing style from the context. Short paragraphs, friendly, " +
        "no filler. If research notes are given, summarize the 3-5 most important items clearly and include their source links " +
        "at the end as a short 'Sources' list. Never invent facts beyond the notes. Sign off with the student's name if known.",
      input: [
        `Request: ${instruction}`, `Recipient: ${to}`,
        ctx ? `About the student (context):\n${contextToText(ctx, 1800)}` : "",
        brief ? `Research notes:\n${brief.text}\n\nSources:\n${brief.citations.map((c, i) => `[${i + 1}] ${c.title} ${c.url}`).join("\n")}` : "",
      ].filter(Boolean).join("\n\n"),
    });
    subject = out.subject; body = out.body;
  } else {
    subject = topic.length > 3 ? topic[0].toUpperCase() + topic.slice(1) : "Hello";
    body = `Hi,\n\n${brief?.text ?? `I wanted to reach out about ${topic}.`}\n\nBest,`;
  }

  return newProposal({
    type: "send_reply",
    title: `Email ${to}: ${subject}`,
    why: brief ? `You asked me to email ${to}. I researched current sources first.` : `You asked me to email ${to}.`,
    urgency: 1, // user-requested: show first in Approve (triage scale, 1 = most urgent)
    payload: { emailId: "", threadId: "", to, subject, body, originalBody: body, autoSend: true, fresh: true,
      ...(brief?.citations?.length ? { sources: brief.citations } : {}) },
  });
}

export async function composeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { instruction?: string } | null }>("/compose", async (req, reply) => {
    const instruction = req.body?.instruction?.trim();
    if (!instruction) return reply.code(400).send({ error: "instruction required" });
    try {
      return await composeEmail(instruction);
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });
}
