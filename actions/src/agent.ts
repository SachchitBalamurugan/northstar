// The task agent behind the orb popup. One approval per task, not per step:
//   1. look at the open tabs and make a short plan → ONE "plan" checkpoint (Run / Run & submit / Cancel)
//   2. work through the student's own signed-in Chrome on its own (click, type, read, navigate, Docs)
//   3. pause only for real final moments (submit/send not pre-approved, payment, password sign-in,
//      a fact it does not know). The student answers in the popup and the same run continues.
import { z } from "zod";
import { classifyAction, type ActionTarget } from "./sidekick/safety.js";
import { getDriver, type Driver, type SnapEl, type Snapshot, type Tab } from "./driver.js";
import { complete } from "./llm.js";
import { getContext } from "./memory.js";
import { readProfile } from "./profile.js";
import { openCheckpoint, waitCheckpoint, type Checkpoint, type CheckpointKind, type CheckpointResult } from "./checkpoints.js";

const MAX_STEPS = 45;
const INBOX_URL = process.env.INBOX_URL ?? "http://127.0.0.1:7702";

export interface TaskFrame {
  action: string;
  detail: string;
  screenshot?: string;
  checkpoint?: Pick<Checkpoint, "id" | "kind" | "title" | "detail" | "steps" | "finalAction">;
}
export interface TaskRun {
  id: string;
  instruction: string;
  emit: (f: TaskFrame) => void;
  closed: () => boolean;
}

const PlanSchema = z.object({
  summary: z.string(),
  steps: z.array(z.string()),
  finalAction: z.string().nullable(),
  startUrl: z.string().nullable(),
  useCurrentTab: z.boolean(),
});

const StepSchema = z.object({
  action: z.enum(["goto", "click", "type", "select", "scroll", "key", "write", "read_tab", "switch_tab", "ask", "done"]),
  index: z.number().nullable(),
  text: z.string().nullable(),
  url: z.string().nullable(),
  reason: z.string(),
});
type Step = z.infer<typeof StepSchema>;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function describeEl(e: SnapEl): string {
  return `${e.tag}${e.type ? `[${e.type}]` : ""} "${clip(e.text || e.label || e.name || "?", 50)}"`;
}

function renderSnapshot(s: Snapshot): string {
  const lines = s.elements.map((e) => {
    const bits = [`[${e.index}] <${e.tag}${e.type ? ` type=${e.type}` : ""}${e.role ? ` role=${e.role}` : ""}>`];
    if (e.text) bits.push(`"${e.text}"`);
    if (e.label) bits.push(`label="${e.label}"`);
    if (e.name) bits.push(`name=${e.name}`);
    if (e.value) bits.push(`value="${e.value}"`);
    if (e.required) bits.push("required");
    if (e.options?.length) bits.push(`options=${JSON.stringify(e.options)}`);
    if (e.href) bits.push(`href=${e.href}`);
    if (e.inView === false) bits.push("(off-screen)");
    return bits.join(" ");
  });
  const sc = s.scroll ? `\nScroll: ${s.scroll.y}/${s.scroll.max}px` : "";
  return `URL: ${s.url}\nTitle: ${s.title}${sc}\nInteractive elements:\n${lines.join("\n") || "(none)"}\n\nVisible text:\n${s.text}`;
}

function toTarget(action: "click" | "type", el: SnapEl, typedText?: string | null): ActionTarget {
  return { action, tag: el.tag, type: el.type, role: el.role, text: el.text, label: el.label, name: el.name, autocomplete: el.autocomplete, href: el.href, typedText };
}

const STOP = new Set(
  "this that with from have what when where which there their them they your yours about into onto over under please could would should then than just also make find open check look show tell give need want does done the and for are was were will can our out all any get got let its continue".split(" "),
);
function keywords(s: string): string[] {
  const out: string[] = [];
  for (const w of s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []) if (w.length > 2 && !STOP.has(w) && !out.includes(w)) out.push(w);
  return out.slice(0, 5);
}

async function ask(run: TaskRun, kind: CheckpointKind, title: string, detail: string, extra: Partial<Checkpoint> = {}, screenshot?: string): Promise<CheckpointResult> {
  const cp = openCheckpoint({ runId: run.id, kind, title, detail, ...extra });
  run.emit({
    action: "checkpoint",
    detail: title,
    screenshot,
    checkpoint: { id: cp.id, kind, title, detail, steps: cp.steps, finalAction: cp.finalAction },
  });
  const r = await waitCheckpoint(cp);
  run.emit({ action: "info", detail: answeredText(kind, r) });
  return r;
}

function answeredText(kind: CheckpointKind, r: CheckpointResult): string {
  if (r.decision === "cancel") return "Cancelled.";
  if (kind === "plan") return r.decision === "run_submit" ? "Running. You allowed the final submit too." : "Running. I'll ask before the final submit.";
  if (r.decision === "skip") return "Skipped that step.";
  if (kind === "signin") return "Thanks, carrying on.";
  if (kind === "question") return "Got it, carrying on.";
  return "Approved. Doing it now.";
}

// ---------------- reading other open tabs (Docs, Sheets, any page) ----------------

/**
 * Text of an open tab that matches `ref` (a URL, or words from its title). Google Docs/Sheets/Slides come
 * back as their real content through the extension, using the student's own login: no Google API needed.
 * Only when nothing is open does it fall back to the optional Docs API (if Google Docs was connected).
 */
async function readOpenTab(d: Driver, ref: string, back: Tab): Promise<string> {
  const r = ref.trim();
  let hit: Awaited<ReturnType<Driver["find"]>> = null;
  const tabs = await d.list().catch(() => []);
  const byUrl = /^https?:\/\//i.test(r) ? tabs.find((t) => t.url.split("#")[0] === r.split("#")[0] || t.url.startsWith(r)) : undefined;
  if (byUrl) hit = await d.find([byUrl.url]).catch(() => null);
  if (!hit) hit = await d.find(keywords(r)).catch(() => null);
  if (hit) {
    const t = await hit.tab.readText();
    await back.focus();
    return `Tab "${clip(t.title || hit.title, 80)}" (${t.kind === "page" ? "page text" : `Google ${t.kind} content`}):\n${clip(t.text, 8000)}`;
  }
  try {
    return await readDocApi(r);
  } catch {
    return `Nothing open matches "${clip(r, 60)}". Open it first (goto its link, or https://drive.google.com/drive/search?q=${encodeURIComponent(r)} to find a Google Doc), then read it.`;
  }
}

async function readDocApi(ref: string): Promise<string> {
  const m = /\/document\/d\/([\w-]{20,})/.exec(ref) ?? /^([\w-]{25,})$/.exec(ref.trim());
  let id = m?.[1];
  let name = "";
  if (!id) {
    const r = await fetch(`${INBOX_URL}/docs/search?q=${encodeURIComponent(ref)}`, { signal: AbortSignal.timeout(15_000) });
    const j = (await r.json().catch(() => ({}))) as { files?: { id: string; name: string }[]; error?: string };
    if (!r.ok) throw new Error(j.error ?? `Docs search failed (HTTP ${r.status})`);
    if (!j.files?.length) return `No Google Doc matched "${ref}".`;
    id = j.files[0].id;
    name = j.files[0].name;
    if (j.files.length > 1) name += ` (other matches: ${j.files.slice(1, 5).map((f) => f.name).join("; ")})`;
  }
  const r = await fetch(`${INBOX_URL}/docs/${encodeURIComponent(id)}/text`, { signal: AbortSignal.timeout(20_000) });
  const j = (await r.json().catch(() => ({}))) as { title?: string; text?: string; error?: string };
  if (!r.ok) throw new Error(j.error ?? `Could not read that doc (HTTP ${r.status})`);
  return `Google Doc "${j.title ?? name}":\n${clip(j.text ?? "", 6000)}`;
}

// ---------------- the run ----------------

async function pickStartTab(d: Driver, run: TaskRun, plan: z.infer<typeof PlanSchema>, active: Awaited<ReturnType<Driver["active"]>>): Promise<Tab> {
  if (plan.useCurrentTab && active) {
    await active.tab.focus();
    run.emit({ action: "info", detail: `Working in your current tab: ${clip(active.title || active.url, 60)}` });
    return active.tab;
  }
  if (plan.startUrl && /^https?:\/\//i.test(plan.startUrl)) {
    const tab = await d.open(plan.startUrl, "path");
    run.emit({ action: "goto", detail: `Opened ${clip(plan.startUrl, 70)}` });
    return tab;
  }
  const hit = await d.find(keywords(run.instruction)).catch(() => null);
  if (hit) {
    run.emit({ action: "info", detail: `Found it in your open tabs: ${clip(hit.title, 60)}` });
    return hit.tab;
  }
  return d.blank();
}

export async function runTask(run: TaskRun): Promise<string> {
  const d = getDriver();
  run.emit({ action: "info", detail: d.kind === "chrome" ? "Looking at your Chrome tabs…" : "Opening the Northstar browser (install the Northstar Bridge extension to use your own Chrome)…" });

  const [mem, profile, tabs, active] = await Promise.all([
    getContext(run.instruction).catch(() => ({ snippets: [] as string[], knowledge: [] as string[] })),
    readProfile().catch(() => null),
    d.list().catch(() => []),
    d.active().catch(() => null),
  ]);
  const profileLines = profile
    ? Object.entries(profile)
        .filter(([, v]) => typeof v === "string" && v.trim())
        .map(([k, v]) => `- ${k}: ${clip(String(v), 300)}`)
    : [];
  const about = [
    "About the student (use these facts when a form asks; never invent others):",
    ...profileLines,
    ...[...mem.snippets, ...mem.knowledge].slice(0, 12).map((s) => `- ${clip(s, 400)}`),
  ].join("\n");

  // 1. Plan → one approval
  const plan = await complete({
    tier: "smart",
    schema: PlanSchema,
    schemaName: "task_plan",
    system: [
      "You plan a browser task for a student's assistant that works in their own signed-in Chrome.",
      "Return: summary (one sentence), steps (3-6 short plain steps, at most 12 words each),",
      'finalAction: the one irreversible step at the end if there is one (e.g. "Submit the application", "Send the message"), else null,',
      "startUrl: where to start if no open tab fits (absolute URL) else null,",
      "useCurrentTab: true when the task is about the page the student has in front of them or an open tab already fits.",
      "Prefer an already-open tab: the student is usually signed in there.",
    ].join("\n"),
    input: `Task: ${run.instruction}\n\nCurrent tab: ${active ? `${active.title} — ${active.url}` : "(none)"}\nOpen tabs:\n${tabs
      .slice(0, 30)
      .map((t) => `- ${clip(t.title, 80)} — ${clip(t.url, 100)}`)
      .join("\n") || "(none)"}`,
  });
  const go = await ask(run, "plan", clip(plan.summary, 140), plan.finalAction ? `Ends with: ${plan.finalAction}` : "No final submit needed.", {
    steps: plan.steps.slice(0, 6),
    finalAction: plan.finalAction,
  });
  if (go.decision === "cancel") {
    run.emit({ action: "done", detail: "Cancelled. Nothing was changed." });
    return "cancelled at plan";
  }
  let allowSubmit = go.decision === "run_submit";

  // 2. Work
  let tab = await pickStartTab(d, run, plan, active);
  try {
    return await work(run, d, plan, tab, allowSubmit, about);
  } finally {
    await d.release(); // drops Chrome's "being debugged" bar as soon as the task ends
  }
}

async function work(run: TaskRun, d: Driver, plan: z.infer<typeof PlanSchema>, startTab: Tab, allowSubmitAtStart: boolean, about: string): Promise<string> {
  let tab = startTab;
  let allowSubmit = allowSubmitAtStart;
  const history: string[] = [];
  const notes: string[] = [];
  let lastFail = "";
  let fails = 0;
  let warnedOld = false;
  const recent: string[] = [];
  const system = [
    "You are Northstar, a careful browser agent working in the student's own signed-in Chrome. The student approved this plan:",
    ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "Each turn you get the current page (URL, title, indexed interactive elements with their current values, visible text) and pick ONE action:",
    '- goto: "url" absolute. - click: "index". - type: "index" + "text" (replaces the field\'s content). - select: "index" + "text" (option label, or true/false for a checkbox).',
    '- scroll: "text" = "down" or "up". - key: "text" = a key or combo ("Enter", "Tab", "Escape", "ctrl+End", "ctrl+a").',
    '- write: "text" inserted at the cursor. Use it in Google Docs/Sheets and other editors after clicking into the document area (ctrl+End first to add at the end).',
    '- read_tab: "text" = words from another open tab\'s title, or its URL. You get that tab\'s full content back without leaving this tab (Google Docs/Sheets/Slides included).',
    '- switch_tab: "text" = words from an open tab\'s title, or its URL. Continue working in that tab.',
    "Google Docs/Sheets/Slides: the page's \"Visible text\" already holds the file's real content.",
    "\"Visible text\" is only the part of the page around the screen. For long pages (lists, tables, READMEs, articles) use read_tab with the current page's URL once to get the whole text, instead of scrolling many times.",
    '- ask: "text" = a short question when you need a fact about the student you were not given (never guess personal facts).',
    '- done: finished or impossible; "reason" is the outcome for the student.',
    'Unused fields are null. "reason" is one short friendly sentence the student sees.',
    "Work quickly: do not re-type fields that already hold the right value. Off-screen elements can still be clicked or typed.",
    "Write long answers (essays, application questions) in the student's own voice from the facts below and anything you read.",
    "A safety layer checks each click: final submit/send, payments and passwords may pause for the student. When the next step is the final submit, still choose it.",
    "",
    about,
  ].join("\n");

  for (let i = 1; i <= MAX_STEPS; i++) {
    if (run.closed()) return "cancelled";
    let snap: Snapshot;
    try {
      snap = await tab.snapshot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      history.push(`${i}. could not read the page: ${msg}`);
      if (/closed|No tab/i.test(msg)) tab = await d.blank();
      await new Promise((r) => setTimeout(r, 800));
      snap = await tab.snapshot().catch(() => ({ url: "", title: "", elements: [], text: "(unreadable page)" }));
    }
    const step: Step = await complete({
      tier: "fast",
      system,
      schema: StepSchema,
      schemaName: "task_step",
      input: `Task: ${run.instruction}\n${notes.length ? `\nNotes you gathered:\n${notes.join("\n")}\n` : ""}\nRecent steps:\n${history.slice(-14).join("\n") || "(none)"}\n\nStep ${i} of ${MAX_STEPS}. Current page:\n${renderSnapshot(snap)}`,
    });

    if (step.action === "done") {
      run.emit({ action: "done", detail: step.reason, screenshot: await tab.screenshot() });
      return step.reason;
    }

    let detail = step.reason;
    // Going in circles (the same step again and again, even when it "works"): nudge, then stop.
    const sig = `${step.action}|${step.index ?? ""}|${step.url ?? ""}|${step.text ?? ""}`;
    recent.push(sig);
    const repeats = recent.slice(-6).filter((x) => x === sig).length;
    if (repeats === 3) notes.push(`You already did "${step.action} ${clip(step.url ?? step.text ?? String(step.index ?? ""), 60)}" several times. Try something different, or finish with what you have.`);
    if (repeats >= 5) {
      run.emit({ action: "done", detail: "I was going in circles, so I stopped. Your tab is left as is." });
      return "stopped: repeating itself";
    }
    try {
      switch (step.action) {
        case "goto": {
          if (!step.url || !/^https?:\/\//i.test(step.url)) throw new Error(`invalid url "${step.url}"`);
          const same = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, "").replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
          if (snap.url && same(snap.url) === same(step.url)) {
            notes.push(`You are already on ${step.url}. Do not goto it again: scroll, click, or read_tab "${step.url}" to get the whole page's text at once.`);
            detail = "Already on that page";
            break;
          }
          tab = await d.open(step.url, "exact");
          await tab.settle();
          detail = `Opened ${clip(step.url, 70)}`;
          break;
        }
        case "scroll":
          await tab.scroll(step.text === "up" ? -700 : 700);
          detail = "Scrolled";
          break;
        case "key": {
          // Enter on a form page can submit it: same rule as clicking the submit button.
          const combo = step.text ?? "Enter";
          const formHasSubmit = !snap.docText && snap.elements.some((e) => classifyAction(toTarget("click", e)).category === "submit");
          if (/enter/i.test(combo) && !allowSubmit && formHasSubmit) {
            const r = await ask(run, "submit", "Ready to submit?", `Pressing Enter may submit ${clip(snap.title || snap.url, 60)}`, {}, await tab.screenshot());
            if (r.decision !== "approve") { run.emit({ action: "done", detail: "Stopped before the final step. Everything is filled in and waiting in your tab." }); return "stopped before final step"; }
            allowSubmit = true;
          }
          await tab.key(combo);
          await tab.settle();
          detail = `Pressed ${clip(step.text ?? "Enter", 20)}`;
          break;
        }
        case "write": {
          const text = step.text ?? "";
          await tab.write(text);
          await tab.settle();
          detail = `Wrote ${text.length > 60 ? `${text.length} characters` : `"${text}"`}`;
          break;
        }
        case "switch_tab": {
          const ref = (step.text ?? "").trim();
          const hit = /^https?:\/\//i.test(ref) ? { tab: await d.open(ref, "path"), title: ref } : await d.find(keywords(ref));
          if (!hit) throw new Error(`no open tab matches "${ref}"`);
          tab = hit.tab;
          await tab.settle();
          detail = `Switched to ${clip(hit.title, 60)}`;
          break;
        }
        case "read_tab": {
          const text = await readOpenTab(d, step.text ?? "", tab);
          notes.push(clip(text, 6000));
          detail = `Read ${clip(text.split("\n")[0], 70)}`;
          break;
        }
        case "ask": {
          const r = await ask(run, "question", clip(step.text ?? "I need one detail", 160), step.reason);
          if (r.decision === "answer" && r.answer) notes.push(`Student answered "${step.text}": ${r.answer}`);
          else notes.push(`Student skipped the question "${step.text}". Leave that field empty.`);
          detail = "Got your answer";
          break;
        }
        default: {
          const el = step.index == null ? undefined : snap.elements[step.index];
          if (!el) throw new Error(`no element with index ${step.index}`);
          const verdict = step.action === "select" ? { stop: false as const } : classifyAction(toTarget(step.action, el, step.text));
          if (verdict.stop) {
            const what = `${step.action === "type" ? "Type into" : "Click"} ${describeEl(el)}`;
            if (verdict.category === "password") {
              const r = await ask(run, "signin", "Please sign in yourself", `This page wants your password (${clip(snap.title || snap.url, 60)}). Sign in in Chrome, then press Continue.`, {}, await tab.screenshot());
              if (r.decision === "skip") { run.emit({ action: "done", detail: "Stopped at the sign-in. Nothing was submitted." }); return "stopped at sign-in"; }
              history.push(`${i}. paused for the student to sign in → they did`);
              await tab.settle();
              continue;
            }
            if (verdict.category === "payment" || !allowSubmit) {
              const kind = verdict.category === "payment" ? "payment" : "submit";
              const r = await ask(run, kind, kind === "payment" ? `Approve payment step: ${clip(el.text || el.label, 40)}?` : `Ready to ${clip(el.text || el.label || "submit", 40)}?`, `${what} on ${clip(snap.title || snap.url, 60)}`, {}, await tab.screenshot());
              if (r.decision !== "approve") { run.emit({ action: "done", detail: "Stopped before the final step. Everything is filled in and waiting in your tab." }); return "stopped before final step"; }
              if (kind === "submit") allowSubmit = true;
            }
          }
          if (step.action === "click") {
            await tab.click(el.index);
            detail = `Clicked ${describeEl(el)}`;
          } else if (step.action === "select") {
            await tab.select(el.index, step.text ?? "");
            detail = `Chose "${clip(step.text ?? "", 40)}" for ${describeEl(el)}`;
          } else {
            const text = step.text ?? "";
            const searchy = el.type === "search" || /search|combobox/i.test(el.role) || /^(q|query|search)$/i.test(el.name) || /search/i.test(el.label);
            await tab.type(el.index, text, searchy);
            detail = `Typed ${text.length > 60 ? `${text.length} characters` : `"${text}"`} into ${describeEl(el)}`;
          }
          await tab.settle();
        }
      }
      history.push(`${i}. ${step.action} ${step.url ?? ""}${step.index ?? ""} ${clip(step.text ?? "", 80)} → ok (${step.reason})`);
      lastFail = "";
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      history.push(`${i}. ${step.action} ${step.index ?? ""} FAILED: ${msg}`);
      detail = `That didn't work (${clip(msg, 80)}). Trying another way.`;
      if (/Unknown command/i.test(msg) && !warnedOld) {
        warnedOld = true;
        run.emit({ action: "info", detail: "Your Northstar Bridge extension is out of date. Reload it in chrome://extensions to unlock this." });
      }
      // Never hammer the same failing step: nudge, then give up on it.
      const key = `${step.action}|${step.index ?? ""}|${step.text ?? ""}|${msg}`;
      fails = key === lastFail ? fails + 1 : 1;
      lastFail = key;
      if (fails === 2) notes.push(`"${step.action}" keeps failing (${clip(msg, 100)}). Do NOT try it again; use a different action or finish with what you have.`);
      if (fails >= 4) {
        run.emit({ action: "done", detail: `I got stuck: ${clip(msg, 120)}. Your tab is left as is.` });
        return `stuck: ${msg}`;
      }
    }
    run.emit({ action: step.action, detail });
  }
  run.emit({ action: "done", detail: `I used all ${MAX_STEPS} steps. Here's where I got to; your tab is left as is.`, screenshot: await tab.screenshot() });
  return `ran out of steps after ${MAX_STEPS}`;
}
