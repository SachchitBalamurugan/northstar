// Triage pipeline: cache.emails -> (memory context) -> fast model in batches of 20 (heuristics as fallback)
// -> needsYou (max 5) / fyi / ignored -> deadlines + asks written to memory -> unsubscribe proposals.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { getCache, listProposals, newProposal, updateCache } from "../store.js";
import { contextToText, getContext, postEvent } from "../memory.js";
import { complete, llmAvailable, LLMUnavailable } from "../llm.js";
import { registerApproveHandler } from "../proposals.js";
import type { CachedEmail, ContextResponse, Deadline, TriageResponse, TriagedEmail } from "../types.js";
import { TriageBatchSchema, type TriageItem } from "./schemas.js";
import { TRIAGE_SYSTEM, triageUserPrompt } from "./prompts.js";
import { heuristicTriage } from "./heuristics.js";

export const BATCH_SIZE = 20;
export const NEEDS_YOU_CAP = 5;
const MAX_NEW_UNSUBSCRIBE_PER_RUN = 3;
const STATE_PATH = path.join(DATA_DIR, "triage_state.json");

// ---------- small persisted state: which emails we already wrote to memory ----------

interface TriageState { postedEmailIds: string[] }

function loadState(): TriageState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Partial<TriageState>;
    return { postedEmailIds: Array.isArray(raw.postedEmailIds) ? raw.postedEmailIds : [] };
  } catch {
    return { postedEmailIds: [] };
  }
}
function saveState(state: TriageState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------- context ----------

async function contextFor(email: CachedEmail): Promise<ContextResponse> {
  try {
    return await getContext(`${email.from} ${email.subject}`.slice(0, 120), 4);
  } catch {
    return { snippets: [], knowledge: [] };
  }
}

// ---------- model path ----------

function isIso(s: string): boolean {
  return !Number.isNaN(new Date(s).getTime());
}

/** Merge a model item with the cached email; drop malformed deadlines rather than failing the batch. */
function fromItem(item: TriageItem, email: CachedEmail): TriagedEmail {
  const deadlines: Deadline[] = item.deadlines
    .filter((d) => isIso(d.dueAt))
    .map((d) => ({
      title: d.title,
      dueAt: new Date(d.dueAt).toISOString(),
      course: d.course ?? undefined,
      effortMinutes: Math.max(5, Math.round(d.effortMinutes)),
      emailId: email.id,
    }));
  return {
    emailId: email.id, from: email.from, subject: email.subject, receivedAt: email.receivedAt, snippet: email.snippet,
    bucket: item.bucket, urgency: item.urgency, senderRole: item.senderRole, deadlines, asks: item.asks,
    why: firstSentence(item.why),
  };
}

/** First sentence only, without cutting at "Prof." / "Dr." style abbreviations. */
export function firstSentence(text: string): string {
  return text.trim().split(/(?<!\b(?:Prof|Dr|Mr|Ms|Mrs|St|vs|etc|e\.g|i\.e)\.)(?<=[.!?])\s+(?=[A-Z"'(])/)[0] ?? text;
}

async function triageBatchWithModel(batch: CachedEmail[], ctxs: ContextResponse[], now: Date): Promise<Map<string, TriagedEmail>> {
  const payload = batch.map((e, i) => ({
    emailId: e.id,
    from: e.from,
    fromEmail: e.fromEmail,
    subject: e.subject,
    receivedAt: e.receivedAt,
    opened: e.opened ?? true,
    hasUnsubscribeLink: Boolean(e.listUnsubscribe),
    body: e.bodyText.slice(0, 1500),
    context: contextToText(ctxs[i], 400),
  }));
  const result = await complete({
    tier: "fast",
    system: TRIAGE_SYSTEM,
    input: triageUserPrompt(JSON.stringify(payload, null, 1), now.toISOString()),
    schema: TriageBatchSchema,
    schemaName: "triage_batch",
  });
  const byId = new Map<string, TriagedEmail>();
  for (const item of result.items) {
    const email = batch.find((e) => e.id === item.emailId);
    if (email && !byId.has(email.id)) byId.set(email.id, fromItem(item, email));
  }
  return byId;
}

/** Classify every email (model when available, heuristics otherwise). Exported for tests. */
export async function triageEmails(emails: CachedEmail[], now: Date = new Date()): Promise<TriagedEmail[]> {
  const batches: CachedEmail[][] = [];
  for (let i = 0; i < emails.length; i += BATCH_SIZE) batches.push(emails.slice(i, i + BATCH_SIZE));
  // batches run concurrently (a 7-day inbox is a handful of calls); order of the result matches `emails`
  const results = await Promise.all(
    batches.map(async (batch) => {
      const ctxs = await Promise.all(batch.map(contextFor));
      let modelled = new Map<string, TriagedEmail>();
      try {
        modelled = await triageBatchWithModel(batch, ctxs, now);
      } catch (err) {
        if (!(err instanceof LLMUnavailable)) console.warn("[triage] model failed, using heuristics:", (err as Error).message);
      }
      return batch.map((email, j) => modelled.get(email.id) ?? heuristicTriage(email, ctxs[j], now));
    }),
  );
  return results.flat();
}

// ---------- ordering ----------

function earliestDue(t: TriagedEmail): number {
  const ts = t.deadlines.map((d) => new Date(d.dueAt).getTime()).filter((n) => !Number.isNaN(n));
  return ts.length ? Math.min(...ts) : Number.POSITIVE_INFINITY;
}
export function byUrgencyThenDue(a: TriagedEmail, b: TriagedEmail): number {
  return a.urgency - b.urgency || earliestDue(a) - earliestDue(b) || b.receivedAt.localeCompare(a.receivedAt);
}

export function buildResponse(triaged: TriagedEmail[]): TriageResponse {
  const needsAll = triaged.filter((t) => t.bucket === "needsYou").sort(byUrgencyThenDue);
  const needsYou = needsAll.slice(0, NEEDS_YOU_CAP);
  const overflow = needsAll.slice(NEEDS_YOU_CAP).map((t) => ({ ...t, bucket: "fyi" as const }));
  const fyi = [...overflow, ...triaged.filter((t) => t.bucket === "fyi")].sort(byUrgencyThenDue);
  const ignored = triaged.filter((t) => t.bucket === "ignore").length;
  return { needsYou, fyi, ignored };
}

/** Flattened, de-duplicated deadlines for GET /deadlines (future ones unless includePast). */
export function collectDeadlines(triage: TriageResponse, opts: { includePast?: boolean; now?: Date } = {}): Required<Deadline>[] {
  const cutoff = (opts.now ?? new Date()).getTime() - 60 * 60 * 1000;
  const seen = new Set<string>();
  const out: Required<Deadline>[] = [];
  for (const t of [...triage.needsYou, ...triage.fyi]) {
    for (const d of t.deadlines) {
      const key = `${d.title.toLowerCase()}|${d.dueAt}`;
      if (seen.has(key)) continue;
      if (!opts.includePast && new Date(d.dueAt).getTime() < cutoff) continue;
      seen.add(key);
      out.push({ title: d.title, dueAt: d.dueAt, course: d.course ?? "", effortMinutes: d.effortMinutes, emailId: d.emailId ?? t.emailId });
    }
  }
  return out.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

// ---------- memory writes ----------

async function writeToMemory(triage: TriageResponse): Promise<void> {
  const state = loadState();
  const posted = new Set(state.postedEmailIds);
  for (const t of [...triage.needsYou, ...triage.fyi]) {
    if (posted.has(t.emailId)) continue;
    for (const d of t.deadlines) {
      await postEvent({
        source: "gmail", kind: "deadline",
        text: `${d.title} due ${d.dueAt}${d.course ? ` (${d.course})` : ""}`,
        tags: [`due:${d.dueAt}`, ...(d.course ? [`course:${d.course}`] : []), `effort:${d.effortMinutes}`, `role:${t.senderRole}`],
        refs: { emailId: t.emailId },
      });
    }
    if (t.bucket === "needsYou" && t.asks.length) {
      await postEvent({
        source: "gmail", kind: "task",
        text: `${t.from}: ${t.asks[0]}`,
        tags: [`role:${t.senderRole}`, "ask", `urgency:${t.urgency}`],
        refs: { emailId: t.emailId },
      });
    }
    posted.add(t.emailId);
  }
  saveState({ postedEmailIds: [...posted].slice(-2000) });
}

// ---------- unsubscribe proposals ----------

/** First http(s) URL in a List-Unsubscribe value ("<mailto:..>, <https://..>" or a bare URL); mailto-only => undefined. */
export function httpUrl(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(",")) {
    const raw = part.trim().replace(/^<|>$/g, "");
    try {
      const u = new URL(raw);
      if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    } catch { /* not a URL */ }
  }
  return undefined;
}

// Approving an unsubscribe only records the decision; payload.url is there for Machine 4's Sidekick to act on.
registerApproveHandler("unsubscribe", async (p) => {
  const url = httpUrl(p.payload?.url);
  if (!url) throw new Error("unsubscribe payload needs an http(s) url");
  await postEvent({
    source: "gmail", kind: "preference",
    text: `Approved unsubscribing from ${p.payload?.senderName ?? p.payload?.sender ?? "a sender"}`,
    tags: ["unsubscribe"], refs: { url },
  });
  return { confirmation: "Marked for unsubscribe" };
});

function proposeUnsubscribes(emails: CachedEmail[], triaged: TriagedEmail[]): void {
  const promoIds = new Set(triaged.filter((t) => t.senderRole === "promo" || t.bucket === "ignore").map((t) => t.emailId));
  const bySender = new Map<string, CachedEmail[]>();
  for (const e of emails) {
    if (!promoIds.has(e.id)) continue;
    const key = e.fromEmail.toLowerCase();
    bySender.set(key, [...(bySender.get(key) ?? []), e]);
  }
  // any earlier proposal for this sender (pending, done or rejected) means: don't ask again
  const existing = listProposals().filter((p) => p.type === "unsubscribe");
  const candidates = [...bySender.entries()]
    .map(([sender, list]) => ({
      sender,
      name: list[0].from,
      unopened: list.filter((e) => e.opened === false),
      everOpened: list.some((e) => e.opened !== false),
      url: list.map((e) => httpUrl(e.listUnsubscribe)).find(Boolean),
    }))
    .filter((c) => c.url && !c.everOpened && c.unopened.length > 0)
    .filter((c) => !existing.some((p) => (p.payload?.sender ?? "").toLowerCase() === c.sender))
    .sort((a, b) => b.unopened.length - a.unopened.length)
    // keep the Approve queue short: never more than 3 unsubscribe cards waiting at once
    .slice(0, Math.max(0, MAX_NEW_UNSUBSCRIBE_PER_RUN - existing.filter((p) => p.status === "pending").length));
  for (const c of candidates) {
    newProposal({
      type: "unsubscribe",
      title: `Unsubscribe from ${c.name}`,
      why: `You never open these (${c.unopened.length} unopened).`,
      urgency: 3,
      payload: { url: c.url, sender: c.sender, senderName: c.name, emailIds: c.unopened.map((e) => e.id) },
    });
  }
}

// ---------- entry point ----------

/** Run the full triage over the cached emails. Used by GET /triage, POST /triage/run and the sync loop. */
export async function runTriage(now: Date = new Date()): Promise<TriageResponse> {
  const emails = getCache().emails;
  // First run with a model: the calls take a while, so serve a rules-based triage until they land.
  if (!getCache().triage && llmAvailable()) {
    updateCache({ triage: buildResponse(emails.map((e) => heuristicTriage(e, undefined, now))), triagedAt: now.toISOString() });
  }
  const triaged = await triageEmails(emails, now);
  const triage = buildResponse(triaged);
  await writeToMemory(triage);
  proposeUnsubscribes(emails, triaged);
  updateCache({ triage, triagedAt: now.toISOString() });
  return triage;
}
