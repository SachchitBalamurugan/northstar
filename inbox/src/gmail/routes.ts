// Gmail HTTP routes + the `send_reply` approve handler.
import type { FastifyInstance } from "fastify";
import { googleConfigured } from "../config.js";
import { NOT_CONFIGURED, consumeState, disconnect, getAuthUrl, handleCallback } from "../google/auth.js";
import { authStatus, ensureCacheSource } from "../google/status.js";
import { syncCalendar } from "../calendar/sync.js";
import { postEvent } from "../memory.js";
import { registerApproveHandler } from "../proposals.js";
import { getCache } from "../store.js";
import type { Proposal } from "../types.js";
import { createReplyDraft, sendDraft } from "./drafts.js";
import { isSignOffLine } from "./parse.js";
import { sortNewestFirst, syncGmail } from "./sync.js";

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
  fresh?: boolean;
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

  const draft = await createReplyDraft({ emailId, threadId: payload.threadId ?? "", to, subject, body, fresh: payload.fresh === true });
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
/** Small friendly page shown in the browser tab after Google redirects back. */
const page = (title: string, msg: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Northstar</title></head>` +
  `<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5f1;color:#1f2430;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">` +
  `<main style="max-width:26rem;margin:1rem;padding:2rem;background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center">` +
  `<div style="font-size:1.6rem;margin-bottom:.5rem">◎</div><h1 style="font-size:1.25rem;margin:0 0 .5rem">${escapeHtml(title)}</h1>` +
  `<p style="margin:0;line-height:1.5;color:#4b5263">${escapeHtml(msg)}</p></main></body></html>`;

export async function gmailRoutes(app: FastifyInstance): Promise<void> {
  registerApproveHandler("send_reply", handleSendReply);

  // The link the user opens to connect Google. 400 with a plain-language message until the OAuth client is in .env.
  app.get("/auth/url", async (_req, reply) => {
    if (!googleConfigured()) return reply.code(400).send({ url: "", configured: false, error: NOT_CONFIGURED });
    return { url: getAuthUrl(), configured: true };
  });

  app.get<{ Querystring: { code?: string; error?: string; state?: string } }>("/auth/callback", async (req, reply) => {
    const html = (code: number, title: string, msg: string) => reply.code(code).type("text/html; charset=utf-8").send(page(title, msg));
    if (req.query.error) {
      const denied = req.query.error === "access_denied";
      return html(400, "Not connected", denied ? "You chose not to give access, so nothing changed. You can close this tab and try again from Northstar any time." : `Google sign-in did not finish (${req.query.error}). Close this tab and try again from Northstar.`);
    }
    if (!req.query.code) return html(400, "Not connected", "This page is where Google sends you back after sign-in. Start from Connect Google in Northstar.");
    if (!consumeState(req.query.state)) return html(400, "Not connected", "This sign-in link is old or was already used. Go back to Northstar and choose Connect Google again.");
    try {
      await handleCallback(req.query.code);
    } catch (err) {
      return html(500, "Not connected", `Sign-in failed: ${(err as Error).message}`);
    }
    // Clear the demo data (and any cards built from it) before anything can act on the real account.
    // app.ts kicks off the first real sync as soon as this 200 response is sent.
    ensureCacheSource(undefined, { force: true });
    const st = authStatus();
    const who = st.email ? ` as ${st.email}` : "";
    if (st.source !== "google") return html(200, "Signed in", `Signed in${who}, but Northstar is still showing demo data. ${st.reason ?? ""} You can close this tab.`);
    return html(200, "Connected. You can close this tab.", `Northstar is signed in${who} and is reading your mail and calendar now. Nothing is sent or added without your OK.`);
  });

  app.get("/auth/status", async () => authStatus());

  // Revoke Northstar's access at Google, delete the saved tokens, and go back to demo data.
  app.post("/auth/disconnect", async () => {
    const { revoked } = await disconnect();
    ensureCacheSource("fixtures"); // wipes the real mail/events/cards from the local cache
    try {
      await syncGmail();
      await syncCalendar();
    } catch (err) {
      app.log.warn({ err }, "could not reload demo data after disconnect");
    }
    return { ok: true as const, revoked, ...authStatus() };
  });

  app.get("/emails", async () => sortNewestFirst(getCache().emails));

  app.get<{ Params: { id: string } }>("/emails/:id", async (req, reply) => {
    const email = getCache().emails.find((e) => e.id === req.params.id);
    if (!email) return reply.code(404).send({ error: "email not found" });
    return email;
  });
}
