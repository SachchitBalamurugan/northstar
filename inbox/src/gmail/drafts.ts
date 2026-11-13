// Gmail drafts: build an RFC 2822 reply, create it as a draft in the original thread, optionally send it.
// MOCK mode appends to data/mock_outbox.json instead of touching the network.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { DATA_DIR } from "../config.js";
import { useFixtures } from "../google/status.js";
import { getAuthedClient } from "../google/auth.js";
import { getHeader } from "./parse.js";

export interface ReplyDraftInput {
  emailId: string;
  threadId: string;
  to: string;
  subject: string;
  body: string;
  /** A brand-new email (not a reply): keep the subject as-is, no "Re:". */
  fresh?: boolean;
}
export interface DraftResult {
  draftId: string;
  messageId?: string;
}

export const MOCK_OUTBOX_PATH = path.join(DATA_DIR, "mock_outbox.json");
export interface MockOutboxEntry {
  kind: "draft" | "send";
  draftId: string;
  at: string;
  emailId?: string;
  threadId?: string;
  to?: string;
  subject?: string;
  body?: string;
}

// ---- pure helpers (exported for tests) ----
export function replySubject(subject: string): string {
  const s = (subject ?? "").trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** RFC 2047 encode a header value when it has non-ASCII characters. */
function encodeHeaderWord(value: string): string {
  return /[^\x20-\x7e]/.test(value) ? `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=` : value;
}

export function buildReplyMime(opts: { to: string; subject: string; body: string; inReplyTo?: string; references?: string }): string {
  const headers = [
    `To: ${opts.to.replace(/[\r\n]+/g, " ")}`,
    `Subject: ${encodeHeaderWord(opts.subject.replace(/[\r\n]+/g, " "))}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  // Header values read back from Gmail can be folded across lines; a raw CR/LF here would end the header block.
  const inReplyTo = (opts.inReplyTo ?? "").replace(/\s+/g, " ").trim();
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    const refs = (opts.references ?? "").split(/\s+/).filter(Boolean);
    if (!refs.includes(inReplyTo)) refs.push(inReplyTo);
    headers.push(`References: ${refs.join(" ")}`);
  }
  const body = Buffer.from(opts.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

export const encodeRaw = (mime: string): string => Buffer.from(mime, "utf8").toString("base64url");

// ---- mock outbox ----
export function readMockOutbox(): MockOutboxEntry[] {
  try {
    const v = JSON.parse(fs.readFileSync(MOCK_OUTBOX_PATH, "utf8"));
    return Array.isArray(v) ? (v as MockOutboxEntry[]) : [];
  } catch {
    return [];
  }
}
function appendMockOutbox(entry: MockOutboxEntry): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MOCK_OUTBOX_PATH, JSON.stringify([...readMockOutbox(), entry], null, 2));
}

// ---- API ----
/** Create a reply draft in the original thread. Never sends. */
export async function createReplyDraft(input: ReplyDraftInput): Promise<DraftResult> {
  const subject = input.fresh ? input.subject : replySubject(input.subject);
  if (useFixtures()) {
    const draftId = `mock-${randomUUID()}`;
    appendMockOutbox({ kind: "draft", draftId, at: new Date().toISOString(), ...input, subject });
    return { draftId };
  }

  const gmail = google.gmail({ version: "v1", auth: await getAuthedClient() });

  // Message-ID/References of the original make the reply thread correctly in other clients too.
  let inReplyTo: string | undefined;
  let references: string | undefined;
  if (input.emailId) {
    try {
      const meta = await gmail.users.messages.get({
        userId: "me",
        id: input.emailId,
        format: "metadata",
        metadataHeaders: ["Message-ID", "References"],
      });
      const hs = meta.data.payload?.headers ?? [];
      inReplyTo = getHeader(hs, "Message-ID");
      references = getHeader(hs, "References");
    } catch (err) {
      console.warn("[gmail] could not read original Message-ID; drafting without In-Reply-To:", (err as Error).message);
    }
  }

  const raw = encodeRaw(buildReplyMime({ to: input.to, subject, body: input.body, inReplyTo, references }));
  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw, ...(input.threadId ? { threadId: input.threadId } : {}) } },
  });
  if (!res.data.id) throw new Error("Gmail returned no draft id");
  return { draftId: res.data.id, messageId: res.data.message?.id ?? undefined };
}

/** Send an existing draft. Only called when the approved payload has autoSend === true. */
export async function sendDraft(draftId: string): Promise<DraftResult> {
  // A draft id minted in demo mode is never sent for real, even if Google was connected in between.
  if (useFixtures() || draftId.startsWith("mock-")) {
    appendMockOutbox({ kind: "send", draftId, at: new Date().toISOString() });
    return { draftId, messageId: `mock-sent-${randomUUID()}` };
  }
  const gmail = google.gmail({ version: "v1", auth: await getAuthedClient() });
  const res = await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
  return { draftId, messageId: res.data.id ?? undefined };
}
