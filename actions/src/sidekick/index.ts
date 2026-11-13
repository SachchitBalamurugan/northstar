// POST /sidekick {instruction} → SSE stream of SidekickStep frames.
import type { FastifyInstance } from "fastify";
import type { Page } from "playwright";
import { z } from "zod";
import { BASE_URL } from "../config.js";
import { fillForm, fillSummary } from "../fill/index.js";
import { addRunStep, createRun, finishRun, isCancelled, RunCancelled } from "../runs.js";
import { newPage, screenshotB64 } from "../browser.js";
import { complete, llmAvailable } from "../llm.js";
import { getContext, postEvent } from "../memory.js";
import { createProposal, onApprove } from "../proposals.js";
import type { SidekickStep } from "../types.js";
import { classifyAction, needsDesktop, type ActionTarget } from "./safety.js";
import { desktopAllowed, mockDesktop, runDesktopAgent } from "../desktop/agent.js";
import { MOCK } from "../config.js";
import { describeEl, elLocator, renderSnapshot, takeSnapshot, type SnapEl } from "./snapshot.js";

const MAX_STEPS = 25;
const MOCK_DELAY_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Frame = SidekickStep & { proposalId?: string };
interface Run {
  instruction: string;
  /** Emits one frame; step numbers are assigned automatically. */
  emit: (f: Omit<Frame, "step"> & { runStatus?: "done" | "stopped" | "error"; runDetail?: string }) => void;
  closed: () => boolean;
}
/** Every runner returns a one-line outcome for the memory event. */
type Outcome = string;

const StepSchema = z.object({
  action: z.enum(["click", "type", "goto", "scroll", "done"]),
  index: z.number().nullable(),
  text: z.string().nullable(),
  url: z.string().nullable(),
  reason: z.string(),
});

function toTarget(action: "click" | "type", el: SnapEl, typedText?: string | null): ActionTarget {
  return { action, tag: el.tag, type: el.type, role: el.role, text: el.text, label: el.label, name: el.name, autocomplete: el.autocomplete, href: el.href, typedText };
}

/** Safety hard stop: do not act; create a task Proposal and emit the final "stopped" frame. */
async function hardStop(run: Run, page: Page | null, what: string, why: string, pendingAction: unknown): Promise<Outcome> {
  const url = page ? page.url() : "";
  const proposal = createProposal({
    type: "task",
    title: `Confirm: ${what}`,
    why: `${why} Sidekick stopped so you can decide.`,
    payload: { instruction: run.instruction, url, pendingAction },
    urgency: 3,
  });
  const screenshot = page ? await screenshotB64(page).catch(() => undefined) : undefined;
  run.emit({
    action: "stopped",
    detail: `Stopped before: ${what}. ${why} I made a proposal for you to approve (proposal ${proposal.id}).`,
    proposalId: proposal.id,
    screenshot,
  });
  return `stopped for approval before ${what}`;
}

async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(350);
}

// ---------- real mode: LLM agent loop ----------
async function runAgent(run: Run): Promise<Outcome> {
  const ctx = await getContext(run.instruction);
  const system = [
    "You are Sidekick, a careful browser agent helping a student. You control one browser tab.",
    "Each turn you get a snapshot of the page (URL, title, indexed interactive elements, visible text) and pick exactly ONE action:",
    '- goto: set "url" (absolute). Use a search engine URL if you do not know where to go.',
    '- click: set "index" of the element.',
    '- type: set "index" of an input and "text" to type (search fields are submitted with Enter automatically).',
    "- scroll: scroll down one screen.",
    '- done: the task is complete or impossible; put the answer/outcome for the student in "reason".',
    'Unused fields must be null. "reason" is one short friendly sentence shown to the student.',
    "A safety layer outside you checks every click and type. If the next step the task needs is a final submit/send, a payment, or a password field, still pick that action: the safety layer will pause it and ask the student to approve. Do not answer \"done\" just because the next step is sensitive, or the student never gets asked.",
    "Clicking an Unsubscribe / confirm-unsubscribe button is allowed and is not a final submit; do it when the task is to unsubscribe.",
    "Never invent personal facts (names, contact details, grades, references). If the task needs facts you were not given, finish with \"done\" and say what is missing.",
    "",
    "What we know about the student (from memory):",
    ...[...ctx.snippets, ...ctx.knowledge].map((s) => `- ${s}`),
  ].join("\n");

  const page = await newPage();
  const history: string[] = [];
  try {
    for (let i = 1; i <= MAX_STEPS; i++) {
      if (run.closed()) return "cancelled";
      const snap = await takeSnapshot(page);
      const decision = await complete({
        tier: "fast",
        system,
        schema: StepSchema,
        schemaName: "sidekick_step",
        input: `Task: ${run.instruction}\n\nSteps so far:\n${history.join("\n") || "(none)"}\n\nStep ${i} of ${MAX_STEPS}. Current page:\n${renderSnapshot(snap)}`,
      });
      const wantShot = i === 1 || i % 4 === 0;
      const shot = async () => (wantShot ? await screenshotB64(page).catch(() => undefined) : undefined);

      if (decision.action === "done") {
        run.emit({ action: "done", detail: decision.reason, screenshot: await screenshotB64(page).catch(() => undefined) });
        return decision.reason;
      }

      let detail = decision.reason;
      try {
        if (decision.action === "goto") {
          if (!decision.url || !/^https?:\/\//i.test(decision.url)) throw new Error(`invalid url "${decision.url}"`);
          await page.goto(decision.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
          await settle(page);
          detail = `Opened ${decision.url}. ${decision.reason}`;
        } else if (decision.action === "scroll") {
          await page.mouse.wheel(0, 700);
          await page.waitForTimeout(250);
        } else {
          const el = decision.index == null ? undefined : snap.elements[decision.index];
          if (!el) throw new Error(`no element with index ${decision.index}`);
          const verdict = classifyAction(toTarget(decision.action, el, decision.text));
          if (verdict.stop)
            return await hardStop(run, page, `${decision.action} ${describeEl(el)}`.slice(0, 50), verdict.reason ?? "Safety stop.", {
              action: decision.action, index: decision.index, text: verdict.category === "password" || verdict.category === "payment" ? null : decision.text, element: el, category: verdict.category,
            });
          const loc = elLocator(page, el.index);
          if (decision.action === "click") {
            await loc.click({ timeout: 8000 });
            detail = `Clicked ${describeEl(el)}. ${decision.reason}`;
          } else {
            const text = decision.text ?? "";
            if (el.tag === "select") await loc.selectOption({ label: text }).catch(() => loc.selectOption(text));
            else {
              await loc.fill(text, { timeout: 8000 });
              if (el.type === "search" || /search|combobox/i.test(el.role) || /^(q|query|search)$/i.test(el.name) || /search/i.test(el.label))
                await loc.press("Enter");
            }
            detail = `Typed "${text}" into ${describeEl(el)}. ${decision.reason}`;
          }
          await settle(page);
        }
        history.push(`${i}. ${decision.action} ${decision.url ?? ""}${decision.index ?? ""} ${decision.text ?? ""} → ok (${decision.reason})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
        history.push(`${i}. ${decision.action} FAILED: ${msg}`);
        detail = `That did not work (${msg}). Trying something else.`;
      }
      run.emit({ action: decision.action, detail, screenshot: await shot() });
    }
    run.emit({
      action: "done",
      detail: `I ran out of steps (${MAX_STEPS}) before finishing. Here is where I got to.`,
      screenshot: await screenshotB64(page).catch(() => undefined),
    });
    return `ran out of steps after ${MAX_STEPS}`;
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- MOCK mode ----------
async function mockFixture(run: Run, kind: "unsubscribe" | "syllabus"): Promise<Outcome> {
  const page = await newPage();
  const pause = () => sleep(MOCK_DELAY_MS);
  try {
    const url = `${BASE_URL}/fixtures/${kind === "unsubscribe" ? "newsletter-unsubscribe.html" : "syllabus.html"}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    run.emit({ action: "goto", detail: `Opened ${url}`, screenshot: await screenshotB64(page) });
    await pause();
    if (run.closed()) return "cancelled";

    const snap = await takeSnapshot(page);
    const want = kind === "unsubscribe" ? /unsubscribe/i : /syllabus/i;
    const el = snap.elements.find((e) => (e.tag === "button" || e.tag === "a") && want.test(e.text));
    if (!el) throw new Error(`could not find a "${kind}" control on the page`);
    const verdict = classifyAction(toTarget("click", el));
    if (verdict.stop) return await hardStop(run, page, `click ${describeEl(el)}`, verdict.reason ?? "Safety stop.", { action: "click", element: el });
    await elLocator(page, el.index).click();
    run.emit({ action: "click", detail: `Clicked ${describeEl(el)}` });
    await pause();
    if (run.closed()) return "cancelled";

    const resultSel = kind === "unsubscribe" ? "#result" : "#syllabus";
    await page.locator(resultSel).waitFor({ state: "visible", timeout: 5000 });
    const text = ((await page.locator(resultSel).innerText()) || "").replace(/\s+/g, " ").trim();
    if (kind === "unsubscribe" && !/unsubscribed/i.test(text)) throw new Error(`unexpected confirmation text: "${text}"`);
    run.emit({ action: "verify", detail: kind === "unsubscribe" ? `Page confirms: "${text}"` : `Found the syllabus section: "${text.slice(0, 160)}"` });
    await pause();

    const outcome = kind === "unsubscribe" ? "Done. You are unsubscribed from that newsletter." : `Found the CS 101 syllabus at ${page.url()}`;
    run.emit({ action: "done", detail: outcome, screenshot: await screenshotB64(page) });
    return outcome;
  } finally {
    await page.close().catch(() => {});
  }
}

async function mockCanned(run: Run): Promise<Outcome> {
  const frames: Array<Omit<Frame, "step">> = [
    { action: "think", detail: `Got it: "${run.instruction}". Planning the steps (demo mode, no live browser).` },
    { action: "goto", detail: "Opened a search for what you asked." },
    { action: "click", detail: "Opened the most relevant result and read through it." },
    { action: "done", detail: "Demo mode: this is a canned run. Connect an API key to let me do this for real." },
  ];
  for (const f of frames) {
    if (run.closed()) return "cancelled";
    run.emit(f);
    await sleep(MOCK_DELAY_MS);
  }
  return "canned demo run (mock mode)";
}

// ---------- desktop fallback ----------
async function desktopFallback(run: Run): Promise<Outcome> {
  run.emit({
    action: "info",
    detail: "That needs a desktop app, which I can't control yet. I can do this in the browser instead (for example Google Sheets/Docs or the web version), so I saved it as a task for you to confirm.",
  });
  const proposal = createProposal({
    type: "task",
    title: `Do in browser: ${run.instruction}`,
    why: "Sidekick only works in the browser, so this desktop request needs your go-ahead to try a web version.",
    payload: { instruction: run.instruction, reason: "desktop_app_required", suggestion: "Use a browser-based equivalent" },
  });
  await sleep(MOCK_DELAY_MS);
  run.emit({ action: "done", detail: `Saved as a task for you to review (proposal ${proposal.id}).`, proposalId: proposal.id });
  return "needs a desktop app; created a task proposal";
}

// ---------- unsubscribe proposals (from the inbox service) ----------
onApprove("unsubscribe", async (p) => {
  const url: unknown = p.payload?.url ?? p.payload?.listUnsubscribeUrl;
  if (typeof url !== "string" || !url.trim()) throw new Error("Unsubscribe proposal has no url (expected payload.url or payload.listUnsubscribeUrl)");
  if (!/^https?:\/\//i.test(url.trim())) throw new Error(`Unsubscribe url must be http(s); got "${url.slice(0, 80)}"`);
  const page = await newPage();
  try {
    await page.goto(url.trim(), { waitUntil: "domcontentloaded", timeout: 20_000 });
    await settle(page);
    const snap = await takeSnapshot(page);
    const el =
      snap.elements.find((e) => e.tag !== "a" && /unsubscrib|opt[\s-]?out/i.test(`${e.text} ${e.label}`)) ??
      snap.elements.find((e) => /unsubscrib|opt[\s-]?out/i.test(`${e.text} ${e.label}`)) ??
      snap.elements.find((e) => e.tag !== "a" && /^(confirm|yes)\b/i.test(e.text));
    let clicked: string | null = null;
    if (el && !classifyAction(toTarget("click", el)).stop) {
      await elLocator(page, el.index).click({ timeout: 8000 });
      await settle(page);
      clicked = el.text || el.label;
    }
    return { unsubscribed: true, finalUrl: page.url(), clicked };
  } finally {
    await page.close().catch(() => {});
  }
});

// ---------- form fill from the command bar ----------
const FILL_RE = /\bfill(ing)?\b/i;
const FORM_RE = /\b(form|application|apply|sign[\s-]?up|questionnaire|survey)\b/i;

/** The form URL when the instruction is a "fill this form" request this service should route to the filler. */
export function fillTarget(instruction: string, mock: boolean): string | null {
  if (!FILL_RE.test(instruction)) return null;
  const m = /https?:\/\/[^\s"'<>]+/i.exec(instruction);
  if (m) {
    try {
      return new URL(m[0].replace(/[.,;:!?)\]]+$/, "")).toString();
    } catch {
      return null;
    }
  }
  // No URL: in demo mode use the local fixture; in real mode the agent loop finds the form itself.
  return mock && FORM_RE.test(instruction) ? `${BASE_URL}/fixtures/internship.html` : null;
}

async function runFillTask(run: Run, url: string): Promise<Outcome> {
  const proposal = await fillForm(url, {}, (action, detail) => {
    if (run.closed()) throw new RunCancelled();
    run.emit({ action, detail });
  });
  const detail = fillSummary(proposal);
  const screenshot = typeof proposal.payload?.screenshot === "string" ? proposal.payload.screenshot : undefined;
  run.emit({ action: "stopped", detail, proposalId: proposal.id, screenshot });
  return `filled ${url}; ${detail}`;
}

// ---------- route ----------
export default async function sidekickRoutes(app: FastifyInstance) {
  app.post<{ Body: { instruction?: unknown; mode?: unknown } }>("/sidekick", async (req, reply) => {
    const raw0 = req.body?.instruction;
    const instruction = typeof raw0 === "string" ? raw0.trim() : "";
    if (!instruction) return reply.code(400).send({ error: "instruction is required" });

    // Optional mode: "desktop" asks for real desktop control, "browser" keeps Sidekick in the browser.
    const mode = req.body?.mode === "desktop" || req.body?.mode === "browser" ? req.body.mode : undefined;
    const wantsDesktop = mode === "desktop" || (mode === undefined && needsDesktop(instruction));
    // Guard rail: the real desktop agent runs only with DESKTOP_CONTROL=1 and an LLM (never in MOCK).
    const useDesktop = wantsDesktop && desktopAllowed();
    const demoDesktop = mode === "desktop" && MOCK;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": req.headers.origin ?? "*",
      Vary: "Origin",
    });

    // The client may go away (the ask window closes) while the task keeps running; the run registry keeps
    // recording it. Only POST /runs/:id/cancel or the step limit stops a run.
    let gone = false;
    raw.on("close", () => {
      gone = true;
    });
    raw.on("error", () => {
      gone = true;
    });
    const fillUrl = needsDesktop(instruction) || wantsDesktop ? null : fillTarget(instruction, !llmAvailable());
    const record = createRun(fillUrl ? "fill" : "sidekick", instruction, fillUrl ?? undefined);
    const runId = record.id;
    let step = 0;
    let final = false;
    const run: Run = {
      instruction,
      closed: () => isCancelled(runId),
      emit: (f) => {
        if (final || isCancelled(runId)) return;
        const { runStatus, runDetail, ...rest } = f;
        const frame: Frame & { runId: string } = { step: ++step, ...rest, runId };
        if (frame.screenshot === undefined) delete frame.screenshot;
        if (frame.proposalId === undefined) delete frame.proposalId;
        if (f.action === "done" || f.action === "stopped" || f.action === "error") {
          final = true;
          finishRun(runId, runStatus ?? f.action, { step: { action: runStatus ?? f.action, detail: runDetail ?? f.detail }, proposalId: f.proposalId });
        } else addRunStep(runId, f.action, f.detail);
        write(frame);
      },
    };
    const write = (frame: unknown) => {
      if (gone || raw.destroyed || raw.writableEnded) return;
      try {
        raw.write(`data: ${JSON.stringify(frame)}\n\n`);
      } catch {
        gone = true;
      }
    };

    let outcome: Outcome;
    try {
      if (demoDesktop) outcome = await mockDesktop(run);
      else if (useDesktop) outcome = await runDesktopAgent(run);
      else if (wantsDesktop || needsDesktop(instruction)) outcome = await desktopFallback(run);
      else if (fillUrl) outcome = await runFillTask(run, fillUrl);
      else if (llmAvailable()) outcome = await runAgent(run);
      else if (/unsubscribe/i.test(instruction)) outcome = await mockFixture(run, "unsubscribe");
      else if (/syllabus/i.test(instruction)) outcome = await mockFixture(run, "syllabus");
      else outcome = await mockCanned(run);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      if (!(err instanceof RunCancelled)) {
        req.log.error({ err }, "sidekick failed");
        run.emit({ action: "error", detail: `Something went wrong: ${msg}` });
      }
      outcome = `error: ${msg}`;
    }
    if (isCancelled(runId)) {
      // The registry already ended the run as "Cancelled"; tell a client that is still listening.
      write({ step: ++step, action: "error", detail: "Cancelled", runId });
      outcome = "cancelled";
    } else if (!final) {
      // A runner returned without a final frame; never leave the run "running".
      run.emit({ action: "error", detail: `Stopped unexpectedly: ${outcome}` });
    }
    try {
      if (!raw.writableEnded && !raw.destroyed) raw.end();
    } catch {
      /* client already gone */
    }
    void postEvent({ source: "screen", kind: "observation", text: `Sidekick: ${instruction} → ${outcome}`, tags: ["sidekick"] }).catch(() => {});
  });
}
