// Gmail HTTP routes + the `send_reply` approve handler.
import type { FastifyInstance } from "fastify";
import { MOCK } from "../config.js";
import { getAuthUrl, handleCallback, isAuthed } from "../google/auth.js";
import { postEvent } from "../memory.js";
import { registerApproveHandler } from "../proposals.js";
import { getCache } from "../store.js";
import type { Proposal } from "../types.js";
import { createReplyDraft, sendDraft } from "./drafts.js";
import { isSignOffLine } from "./parse.js";
import { sortNewestFirst } from "./sync.js";

export { syncGmail } from "./sync.js";

/** Payload of a `send_reply` Proposal. The draft creator should set originalBody = body so edits can be detected. */
export interface SendReplyPayload {
  emailId: string;
  threadId: string;
  to: string;
  subject: string;
  body: string;
  originalBody?: string;
  autoSend?: boolean;
}

// ---- edit heuristics (exported for tests) ----
const wordCount = (s: string) => (s.trim().match(/\S+/g) ?? []).length;
const count = (s: string, ch: string) => s.split(ch).length - 1;
function greetingOf(s: string): string {
  const first = s.trim().split("\n").find((l) => l.trim()) ?? "";
  return /^(hi|hello|hey|dear|good (morning|afternoon|evening)|greetings|yo)\b/i.test(first.trim()) ? first.trim().replace(/[,!:]+$/, "") : "";
}
function signOffOf(s: string): string {
  const lines = s.trim().split("\n");
  for (let i = Math.max(0, lines.length - 8); i < lines.length; i++) {
    if (isSignOffLine(lines[i])) return lines[i].trim();
  }
  return "";
}

/** One short, human sentence fragment describing how the user changed the draft (for memory). */
export function summarizeEdit(original: string, edited: string): string {
  const notes: string[] = [];
  const ow = wordCount(original);
  const ew = wordCount(edited);
  if (ow > 0) {
    const pct = Math.round(((ew - ow) / ow) * 100);
    if (pct <= -15) notes.push(`prefers shorter replies (${Math.abs(pct)}% shorter)`);
    else if (pct >= 15) notes.push(`prefers longer replies (${pct}% longer)`);
  }
  const og = greetingOf(original);
  const eg = greetingOf(edited);
  if (og.toLowerCase() !== eg.toLowerCase()) {
    if (/^dear\b/i.test(eg)) notes.push(`prefers a formal greeting ("${eg}")`);
    else if (/^dear\b/i.test(og) && eg) notes.push(`prefers a casual greeting ("${eg}")`);
    else if (eg && !og) notes.push(`adds a greeting ("${eg}")`);
    else if (!eg && og) notes.push("skips the greeting");
    else notes.push(`prefers the greeting "${eg}"`);
  }
  const os = signOffOf(original);
  const es = signOffOf(edited);
  if (os.toLowerCase() !== es.toLowerCase()) {
    if (es && os) notes.push(`prefers signing off with "${es}"`);
    else if (es) notes.push(`adds the sign-off "${es}"`);
    else notes.push("drops the sign-off");
  }
  const oe = count(original, "!");
  const ee = count(edited, "!");
  if (ee < oe) notes.push("fewer exclamation marks");
  else if (ee > oe) notes.push("more exclamation marks");
  if (!notes.length) notes.push("small wording changes");
  return notes.join("; ");
}

// ---- approve handler ----
export async function handleSendReply(p: Proposal): Promise<Record<string, unknown>> {
  const payload = (p.payload ?? {}) as Partial<SendReplyPayload>;
  const { to, body } = payload;
  if (!to || !body) throw new Error("send_reply payload needs { to, subject, body }");
  const emailId = payload.emailId ?? "";
  const subject = payload.subject ?? "";
  const refs = emailId ? { emailId } : undefined;

  const draft = await createReplyDraft({ emailId, threadId: payload.threadId ?? "", to, subject, body });
  const sent = payload.autoSend === true ? await sendDraft(draft.draftId) : undefined;

  if (typeof payload.originalBody === "string" && payload.originalBody.trim() !== body.trim()) {
    await postEvent({
      source: "gmail",
      kind: "preference",
      text: `Edited draft before approving: ${summarizeEdit(payload.originalBody, body)}`,
      tags: ["draft", "edit"],
      refs,
    });
  }
  await postEvent({
    source: "gmail",
    kind: "observation",
    text: `${sent ? "Sent" : "Drafted"} reply to ${to}: ${subject}`,
    tags: ["draft", ...(sent ? ["sent"] : [])],
    refs,
  });

  return {
    draftId: draft.draftId,
    ...(draft.messageId ? { messageId: draft.messageId } : {}),
    ...(sent ? { sent: true, sentMessageId: sent.messageId } : {}),
  };
}

// ---- routes ----
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (msg: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Northstar</title></head>` +
  `<body style="font-family:system-ui;padding:2rem"><h2>Northstar</h2><p>${escapeHtml(msg)}</p></body></html>`;

export async function gmailRoutes(app: FastifyInstance): Promise<void> {
  registerApproveHandler("send_reply", handleSendReply);

  app.get("/auth/url", async (_req, reply) => {
    try {
      return { url: getAuthUrl() };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.get<{ Querystring: { code?: string; error?: string } }>("/auth/callback", async (req, reply) => {
    if (req.query.error) return reply.code(400).type("text/html").send(page(`Google sign-in failed: ${req.query.error}`));
    if (!req.query.code) return reply.code(400).send({ error: "missing ?code=" });
    try {
      await handleCallback(req.query.code);
      return reply.type("text/html").send(page("Signed in. You can close this tab."));
    } catch (err) {
      return reply.code(500).type("text/html").send(page(`Sign-in failed: ${(err as Error).message}`));
    }
  });

  app.get("/auth/status", async () => ({ authed: isAuthed(), mock: MOCK }));

  app.get("/emails", async () => sortNewestFirst(getCache().emails));

  app.get<{ Params: { id: string } }>("/emails/:id", async (req, reply) => {
    const email = getCache().emails.find((e) => e.id === req.params.id);
    if (!email) return reply.code(404).send({ error: "email not found" });
    return email;
  });
}
