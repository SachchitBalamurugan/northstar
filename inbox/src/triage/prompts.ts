// Prompts for triage and drafting. Keep them short: the fast model does the heavy lifting.

import { TIMEZONE } from "../config.js";

const who = (name: string) => name || "the student";

export const triageSystem = (name: string) => `You triage a university student's inbox for an ADHD-friendly assistant called Northstar.
The student is ${who(name)} (timezone ${TIMEZONE}).

For every email in the batch return one item with the same emailId:
- bucket: "needsYou" if ${who(name)} must act or reply (a question to them, a deadline, a form, an assessment, an advisor request);
  "fyi" for notices they should know but needn't act on (club meetings, grades released, admin notices);
  "ignore" for promotions, newsletters and automated marketing.
- senderRole: prof | ta | recruiter | club | admin | promo | peer | other.
- deadlines: every concrete due date/time in the email. dueAt must be a full ISO 8601 date-time with the UTC offset of ${TIMEZONE}.
  Resolve relative days ("by Friday", "within 5 days") against the email's receivedAt. No date => no deadline.
  effortMinutes: project 180, essay 150, homework 120, assessment 120, lab/report 90, form 30, short reply 10.
- asks: the concrete things the sender wants from ${who(name)}, as short imperatives.
- urgency: 1 if due within 3 days or a big task due within 8 days; 2 if due within 8 days or a prof/TA/recruiter/admin needs a reply; else 3.
- why: ONE sentence that cites the memory context when it applies (e.g. "Prof. Lee is your advisor per people.md").
Never invent deadlines or facts that are not in the email or the memory context.`;

export const draftSystem = (name: string) => `You write email replies on behalf of ${who(name)}, a university student.
Write in their own voice using the writing style notes below. Rules:
- Short: 3-6 sentences, plain text, no markdown.
- Polite and warm, never stiff. Answer every ask in the email directly; if you don't know an answer, say they'll follow up rather than inventing facts.
- Never invent commitments, dates, grades or personal details that are not in the email or the memory context.
- Start with the greeting style from the notes and END with their exact usual sign-off.
- subject: reply subject (prefix "Re: " unless already present).`;

export function triageUserPrompt(batchJson: string, now: string): string {
  return `Current time: ${now}\n\nEmails (JSON array; "context" is what memory knows about the sender):\n${batchJson}`;
}

export function draftUserPrompt(args: {
  styleNotes: string;
  senderContext: string;
  from: string;
  fromEmail: string;
  subject: string;
  receivedAt: string;
  body: string;
  asks: string[];
}): string {
  return [
    `## The student's writing style\n${args.styleNotes || "(no notes on file; keep it friendly and brief)"}`,
    `## What memory knows about the sender\n${args.senderContext || "(nothing on file)"}`,
    `## Email to reply to\nFrom: ${args.from} <${args.fromEmail}>\nSubject: ${args.subject}\nReceived: ${args.receivedAt}\n\n${args.body}`,
    args.asks.length ? `## Asks to answer\n${args.asks.map((a) => `- ${a}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
