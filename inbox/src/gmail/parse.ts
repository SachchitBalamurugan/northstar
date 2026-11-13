// Pure parsing helpers for Gmail messages: body decoding, quoted-reply + signature stripping,
// header parsing, and normalization into CachedEmail. No I/O here, so everything is unit-testable.
import type { CachedEmail } from "../types.js";

// Minimal structural types so tests don't need googleapis. gmail_v1.Schema$Message is assignable.
export interface HeaderLike { name?: string | null; value?: string | null }
export interface MessagePartLike {
  mimeType?: string | null;
  filename?: string | null;
  headers?: HeaderLike[] | null;
  body?: { data?: string | null; size?: number | null; attachmentId?: string | null } | null;
  parts?: MessagePartLike[] | null;
}
export interface GmailMessageLike {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
  snippet?: string | null;
  internalDate?: string | null;
  payload?: MessagePartLike | null;
}

const normalizeNewlines = (s: string) => s.replace(/\r\n?/g, "\n");

// ---- encoding ----
export function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·",
};
/** Decode numeric and common named HTML entities in a single pass (so "&amp;lt;" stays "&lt;"). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    const e = ent.toLowerCase();
    if (e.startsWith("#x")) return safeChar(parseInt(e.slice(2), 16), whole);
    if (e.startsWith("#")) return safeChar(parseInt(e.slice(1), 10), whole);
    return NAMED_ENTITIES[e] ?? whole;
  });
}
function safeChar(code: number, fallback: string): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/** Very small HTML -> text: drop script/style, turn block tags into newlines, strip tags, decode entities. */
export function htmlToText(html: string): string {
  if (!html) return "";
  let s = normalizeNewlines(html);
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, ""); // list items: one line each, no blank line between
  s = s.replace(/<\/?(p|div|li|tr|h[1-6]|blockquote|pre|table|section|article|header|footer|ul|ol|hr)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Walk `parts` recursively; prefer text/plain, fall back to text/html converted to text. */
export function decodeBody(payload: MessagePartLike | null | undefined): string {
  if (!payload) return "";
  let plain = "";
  let html = "";
  const walk = (p: MessagePartLike): void => {
    const mime = (p.mimeType ?? "").toLowerCase();
    const data = p.body?.data;
    if (data && !p.filename) {
      if (mime.startsWith("text/plain") && !plain.trim()) plain = decodeBase64Url(data);
      else if (mime.startsWith("text/html") && !html.trim()) html = decodeBase64Url(data);
    }
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);
  const text = plain.trim() ? plain : htmlToText(html);
  return normalizeNewlines(text).replace(/[ \t]+\n/g, "\n").trim();
}

// ---- quoted replies ----
const QUOTE_HEADERS: RegExp[] = [
  /^On .{0,200}?(\n.{0,200}?)?wrote:[ \t]*$/m,          // Gmail / Apple Mail, possibly wrapped onto 2 lines
  /^-{2,}\s*Original Message\s*-{2,}[ \t]*$/im,          // Outlook
  /^-{2,}\s*Forwarded message\s*-{2,}[ \t]*$/im,         // Gmail forward
  /^_{10,}[ \t]*\n\s*From: /m,                           // Outlook separator + header block
  /^From: .+\n(Sent|Date): .+\n(To: .+\n)?(Cc: .+\n)?Subject: /m, // top-posted header block
];
/** Remove everything from the first quote header onward and drop "> " quoted lines. */
export function stripQuotedReplies(text: string): string {
  let s = normalizeNewlines(text ?? "");
  for (const re of QUOTE_HEADERS) {
    const m = re.exec(s);
    if (m) s = s.slice(0, m.index);
  }
  s = s.split("\n").filter((line) => !/^\s*>/.test(line)).join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

// ---- signatures ----
const SIGNOFFS = [
  "best regards", "kind regards", "warm regards", "warmest regards", "best wishes", "best", "regards",
  "thanks so much", "thank you so much", "thanks again", "thanks a lot", "many thanks", "thanks", "thank you", "thx", "ty",
  "cheers", "sincerely yours", "yours sincerely", "sincerely", "yours truly", "yours", "take care", "talk soon",
  "all the best", "warmly", "cordially", "respectfully", "gratefully", "see you soon", "see you", "later",
];
/** A line like "Thanks,", "Best regards", "Cheers, Sam" or "Sent from my iPhone". */
export function isSignOffLine(line: string): boolean {
  const t = (line ?? "").trim();
  if (!t) return false;
  if (/^(sent from my |sent via |get outlook for )/i.test(t)) return true;
  const lower = t.toLowerCase();
  for (const s of SIGNOFFS) {
    if (!lower.startsWith(s)) continue;
    const rest = t.slice(s.length);
    if (rest === "") return true;
    const m = /^\s*[,!.–—-]+\s*(.*)$/.exec(rest);
    if (!m) continue;
    const name = m[1].trim();
    // Either bare ("Thanks,") or followed by a short capitalized name ("Thanks, Sam Lee" / "Best, Prof. Lee").
    if (!name || /^[A-Z][\w.'-]*(\s+[A-Z][\w.'-]*){0,3}$/.test(name)) return true;
  }
  return false;
}

/** Cut at the "-- " delimiter, or at a sign-off line within the last ~8 lines. */
export function stripSignature(text: string): string {
  const original = normalizeNewlines(text ?? "").trim();
  const lines = original.split("\n");
  const delim = lines.findIndex((l) => /^--\s?$/.test(l));
  let cutAt = delim >= 0 ? delim : lines.length;
  for (let i = Math.max(0, cutAt - 8); i < cutAt; i++) {
    if (isSignOffLine(lines[i])) {
      cutAt = i;
      break;
    }
  }
  const out = lines.slice(0, cutAt).join("\n").trim();
  return out || original; // never reduce a one-line "Thanks!" email to nothing
}

// ---- headers ----
export function getHeader(headers: HeaderLike[] | null | undefined, name: string): string | undefined {
  const n = name.toLowerCase();
  return headers?.find((h) => (h.name ?? "").toLowerCase() === n)?.value ?? undefined;
}

/** First http(s) URL from a List-Unsubscribe header; mailto: entries are ignored. */
export function extractListUnsubscribe(headerValue: string | null | undefined): string | undefined {
  if (!headerValue) return undefined;
  const m = /<\s*(https?:\/\/[^>\s]+)\s*>/i.exec(headerValue) ?? /(https?:\/\/[^\s,<>]+)/i.exec(headerValue);
  return m?.[1];
}

/** "Anna Lee <anna@x.edu>" -> { name: "Anna Lee", email: "anna@x.edu" }. Name is "" when absent. */
export function parseAddress(raw: string | null | undefined): { name: string; email: string } {
  const s = decodeEntities((raw ?? "").trim());
  if (!s) return { name: "", email: "" };
  const angle = /^(?:"?([^"<]*?)"?\s*)?<\s*([^<>\s]+)\s*>$/.exec(s);
  if (angle) return { name: (angle[1] ?? "").trim(), email: angle[2].trim().toLowerCase() };
  const bare = /^([^\s@()<>,]+@[^\s@()<>,]+)\s*(?:\(([^)]*)\))?$/.exec(s);
  if (bare) return { name: (bare[2] ?? "").trim(), email: bare[1].toLowerCase() };
  return { name: s, email: "" };
}

// ---- normalization ----
const MAX_BODY_CHARS = 10_000;

/** Turn a `users.messages.get format=full` response into our cache shape. */
export function normalizeMessage(msg: GmailMessageLike): CachedEmail {
  const headers = msg.payload?.headers ?? [];
  const h = (name: string) => getHeader(headers, name);
  const from = parseAddress(h("From"));
  const labels = msg.labelIds ?? [];

  let received = h("Date") ? new Date(h("Date")!) : undefined;
  if (!received || Number.isNaN(received.getTime())) {
    received = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date();
  }

  const bodyText = stripSignature(stripQuotedReplies(decodeBody(msg.payload))).slice(0, MAX_BODY_CHARS);
  const snippet = (decodeEntities(msg.snippet ?? "").replace(/\s+/g, " ").trim() || bodyText.replace(/\s+/g, " ")).slice(0, 200);
  const listUnsubscribe = extractListUnsubscribe(h("List-Unsubscribe"));

  const id = msg.id ?? "";
  return {
    id,
    threadId: msg.threadId ?? id,
    from: from.name || from.email,
    fromEmail: from.email,
    to: h("To") ?? "",
    subject: (h("Subject") ?? "").trim() || "(no subject)",
    receivedAt: received.toISOString(),
    snippet,
    bodyText,
    labels,
    ...(listUnsubscribe ? { listUnsubscribe } : {}),
    opened: !labels.includes("UNREAD"),
  };
}
