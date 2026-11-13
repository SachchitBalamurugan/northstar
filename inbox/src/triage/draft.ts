// Draft a reply in the student's voice -> `send_reply` Proposal. The Gmail agent's approve handler
// consumes payload { emailId, threadId, to, subject, body, originalBody, autoSend }.
import { getCache, listProposals, newProposal } from "../store.js";
import { getContext } from "../memory.js";
import { complete } from "../llm.js";
import type { CachedEmail, ContextResponse, Proposal, SenderRole, TriagedEmail } from "../types.js";
import { DraftSchema } from "./schemas.js";
import { DRAFT_SYSTEM, draftUserPrompt } from "./prompts.js";
import { fmtWhen, heuristicTriage, memoryMention } from "./heuristics.js";

export class NotFoundError extends Error {
  status = 404;
}

// ---------- writing style ----------

export interface WritingStyle { name: string; greeting: string; signOff: string; notes: string }

const DEFAULT_STYLE: WritingStyle = { name: "Maya", greeting: "Hi", signOff: "Thanks!\nMaya", notes: "" };

/** Pull the bits we need out of writingstyle.md. Lines like `Sign-off: Thanks! Maya` / `Greeting: Hey` / `Name: Maya`. */
export function parseWritingStyle(md: string): WritingStyle {
  const pick = (key: string) => {
    const m = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?(?:${key})(?:\\*\\*)?\\s*[:=]\\s*["“]?(.+?)["”]?\\s*$`, "im").exec(md);
    return m?.[1]?.trim();
  };
  const signOff = (pick("sign-?off|closing|signature") ?? DEFAULT_STYLE.signOff).replace(/\\n/g, "\n");
  const name = pick("name|signs? as") ?? signOff.split(/\s+/).pop() ?? DEFAULT_STYLE.name;
  const greeting = pick("greeting|opens? with|opener") ?? DEFAULT_STYLE.greeting;
  return { name, greeting, signOff, notes: md.trim() };
}

function salutation(email: CachedEmail, role: SenderRole, style: WritingStyle): string {
  const clean = email.from.replace(/\(.*?\)/g, "").replace(/[",]/g, "").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  let name: string;
  if (role === "prof" && words.length > 1) name = `${/^prof/i.test(words[0]) ? "Prof." : words[0]} ${words[words.length - 1]}`;
  else if (/\b(office|team|staff|center|hall|services|registrar|aid)\b/i.test(clean) || words.length === 0) name = "there";
  else name = words[0].replace(/^(dr|prof)\.?$/i, "") || words[words.length - 1];
  const g = style.greeting;
  return g.includes("{name}") ? g.replace("{name}", name) : `${g} ${name},`;
}

function ensureSignOff(body: string, style: WritingStyle): string {
  const trimmed = body.trimEnd();
  if (trimmed.endsWith(style.signOff)) return trimmed;
  // the model may have written a near-miss sign-off ("Thanks, Maya"); replace the last short lines
  const lines = trimmed.split("\n");
  while (lines.length > 1 && /^(thanks|thank you|best|cheers|sincerely|regards|[-–—]?\s*maya|\s*)[,!.]?\s*(maya)?\s*$/i.test(lines[lines.length - 1])) lines.pop();
  return `${lines.join("\n").trimEnd()}\n\n${style.signOff}`;
}

function replySubject(subject: string): string {
  return /^\s*re\s*:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`;
}

// ---------- MOCK / fallback draft ----------

/** "reply to confirm you've seen the change" -> "reply to confirm I've seen the change" */
function flipPronouns(s: string): string {
  return s
    .replace(/\byou've\b/gi, "I've").replace(/\byou're\b/gi, "I'm").replace(/\byou'll\b/gi, "I'll")
    .replace(/\byour\b/gi, "my").replace(/\byourself\b/gi, "myself").replace(/\byou\b/gi, "I")
    .replace(/\bme\b/gi, "you").replace(/\bmy (office|end)\b/gi, "your $1");
}

function answerAsk(ask: string): string {
  const a = ask.trim().replace(/\s+/g, " ");
  if (a.endsWith("?")) {
    if (/\b(can|could|would|will) you\b/i.test(a)) return `Yes, I can do that${/\bby\b|\bbefore\b/i.test(a) ? " by then" : ""}; I'll confirm the details shortly.`;
    if (/\b(which|what|when|where)\b/i.test(a)) return `On "${a.replace(/\?$/, "")}" - let me check my calendar and I'll get back to you today.`;
    return `On "${a.replace(/\?$/, "")}" - yes, that works for me.`;
  }
  if (/^let me know\b/i.test(a)) return `I'll let you know ${a.replace(/^let me know\s*/i, "").replace(/[.!]$/, "")} as soon as I can.`.replace(/\s+as soon/, " as soon");
  const confirm = /^(?:please\s+)?reply to confirm\s+(.+?)(?:\s+if\b.*)?[.!]?$/i.exec(a);
  if (confirm) return `Confirming ${flipPronouns(confirm[1])}.`;
  const action = a.replace(/^(please|make sure to|be sure to|remember to|don't forget to)\s+/i, "").replace(/[.!]$/, "");
  const flipped = flipPronouns(action);
  return `I'll ${flipped.charAt(0).toLowerCase()}${flipped.slice(1)}.`;
}

export function mockDraft(email: CachedEmail, triaged: TriagedEmail, style: WritingStyle): { subject: string; body: string } {
  const topic = email.subject
    .replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/i, "")
    .replace(/^[A-Z]{1,6}\s?\d{1,3}[A-Z]?\s*[:—-]\s*/, "")
    .replace(/[?!.:\s]+$/, "")
    .trim();
  const lines: string[] = [salutation(email, triaged.senderRole, style), ""];
  lines.push(`Thanks for the note about ${topic.charAt(0).toLowerCase()}${topic.slice(1)}.`);
  // "let me know if you need X" is an offer, not something to answer
  const asks = triaged.asks.filter((a) => !/^\s*(please\s+)?(let me know|reply here|reach out|email me) if\b/i.test(a)).slice(0, 3);
  if (asks.length) lines.push(...asks.map(answerAsk));
  else lines.push("Got it - appreciate you letting me know.");
  const due = [...triaged.deadlines].sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
  if (due) lines.push(`I have ${fmtWhen(due.dueAt)} on my calendar for it.`);
  lines.push("", style.signOff);
  return { subject: replySubject(email.subject), body: lines.join("\n") };
}

// ---------- entry point ----------

const ROLE_LABEL: Record<SenderRole, string> = {
  prof: "your professor", ta: "your TA", recruiter: "a recruiter", club: "your club", admin: "the university",
  promo: "a promotional sender", peer: "a classmate", other: "a contact",
};

function findTriaged(emailId: string): TriagedEmail | undefined {
  const t = getCache().triage;
  return t ? [...t.needsYou, ...t.fyi].find((x) => x.emailId === emailId) : undefined;
}

function shortName(from: string): string {
  const clean = from.replace(/\(.*?\)/g, "").replace(/[",]/g, "").trim();
  const words = clean.split(/\s+/);
  if (/^(prof\.?|professor|dr\.?)$/i.test(words[0]) && words.length > 1) return `${words[0].replace(/^professor$/i, "Prof.")} ${words[words.length - 1]}`;
  return words.slice(0, 2).join(" ");
}

export async function draftReply(emailId: string): Promise<Proposal> {
  const email = getCache().emails.find((e) => e.id === emailId);
  if (!email) throw new NotFoundError(`email ${emailId} not in cache`);
  // Opening the same email twice in the UI must not queue two replies.
  const existing = listProposals("pending").find((p) => p.type === "send_reply" && p.payload?.emailId === emailId);
  if (existing) return existing;

  const ctx: ContextResponse = await getContext(`writingstyle ${email.from}`, 6);
  const style = parseWritingStyle(ctx.knowledge.find((k) => /writingstyle/i.test(k.file))?.content ?? "");
  const triaged = findTriaged(emailId) ?? heuristicTriage(email, ctx);
  const senderContext = ctx.knowledge
    .filter((k) => !/writingstyle/i.test(k.file))
    .map((k) => `## ${k.file}\n${k.content}`)
    .concat(ctx.snippets.map((s) => `- [${s.kind}] ${s.text}`))
    .join("\n")
    .slice(0, 1500);

  let draft: { subject: string; body: string };
  try {
    const out = await complete({
      tier: "fast",
      system: `${DRAFT_SYSTEM}\nMaya's exact sign-off is:\n${style.signOff}`,
      input: draftUserPrompt({
        styleNotes: style.notes, senderContext, from: email.from, fromEmail: email.fromEmail,
        subject: email.subject, receivedAt: email.receivedAt, body: email.bodyText.slice(0, 4000), asks: triaged.asks,
      }),
      schema: DraftSchema,
      schemaName: "draft_reply",
    });
    draft = { subject: replySubject(out.subject || email.subject), body: ensureSignOff(out.body, style) };
  } catch {
    draft = mockDraft(email, triaged, style);
  }

  const due = triaged.deadlines.map((d) => d.dueAt).sort()[0];
  const mention = memoryMention(ctx, email);
  const who = mention ? `${mention.line} (per ${mention.file})` : `${email.from} is ${ROLE_LABEL[triaged.senderRole]}`;
  const because = due
    ? ` and needs this by ${fmtWhen(due)}`
    : triaged.asks[0]
      ? ` and asked: "${triaged.asks[0].slice(0, 70)}"`
      : "";
  const topic = email.subject.replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/i, "").trim();
  const base = `Reply to ${shortName(email.from)} about `;
  const title = `${base}${topic.slice(0, Math.max(8, 60 - base.length))}`.trim();

  return newProposal({
    type: "send_reply",
    title,
    why: `${who}${because}.`,
    urgency: triaged.urgency,
    ...(due ? { dueAt: due } : {}),
    payload: {
      emailId: email.id,
      threadId: email.threadId,
      to: email.fromEmail,
      subject: draft.subject,
      body: draft.body,
      originalBody: draft.body,
      autoSend: false,
    },
  });
}
