// Application filler: POST /fill (extract → map → fill → STOP) and POST /submit (approve → click submit).
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { ElementHandle, Page } from "playwright";
import { z } from "zod";
import { newPage, screenshotB64 } from "../browser.js";
import { complete, llmAvailable } from "../llm.js";
import { getContext, postEvent, type MemoryContext } from "../memory.js";
import { readProfile } from "../profile.js";
import { approveProposal, createProposal, getProposal, onApprove, parseApproveInput, updateProposal } from "../proposals.js";
import { addRunStep, createRun, finishRun, isCancelled, RunCancelled } from "../runs.js";
import type { Profile, Proposal } from "../types.js";

// ---------- types ----------

interface FieldOption {
  label: string;
  value: string;
}
interface FieldSchema {
  selector: string;
  label: string;
  name: string;
  id: string;
  tag: string;
  /** text, email, tel, url, number, date, textarea, select, radio, checkbox, file, … */
  type: string;
  required: boolean;
  options: FieldOption[];
}
interface Answer {
  value: string;
  confidence: number;
  source: string;
}
interface FilledField {
  selector: string;
  label: string;
  type: string;
  value: string;
  confidence: number;
  source: string;
  flagged: boolean;
}
interface OpenField {
  selector: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
  reason: string;
}

const MAX_PAGES = 10;
const FLAG_BELOW = 0.7;

/** proposalId → the tab that holds the filled form, kept open until submit/reject. */
const openPages = new Map<string, Page>();

/** True for a tab that holds a filled form still waiting for approval; closing it would lose the student's answers. */
export function isPendingFormPage(page: Page): boolean {
  for (const [id, p] of openPages) if (p === page && getProposal(id)?.status === "pending") return true;
  return false;
}

// ---------- in-page scripts (strings, so tsx/esbuild helpers never leak into the browser) ----------

const EXTRACT_JS = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").replace(/\\s*\\*\\s*$/, "").trim();
  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      const tag = cur.tagName.toLowerCase();
      let i = 1, sib = cur;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === cur.tagName) i++;
      parts.unshift(tag + ":nth-of-type(" + i + ")");
      cur = cur.parentElement;
    }
    return "html > " + parts.join(" > ");
  };
  const selectorOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && unique("#" + CSS.escape(el.id))) return "#" + CSS.escape(el.id);
    const name = el.getAttribute("name");
    if (name) {
      const sel = tag + '[name="' + CSS.escape(name) + '"]';
      if (unique(sel)) return sel;
    }
    return pathOf(el);
  };
  const byIds = (ids) => clean((ids || "").split(/\\s+/).map((i) => {
    const n = i && document.getElementById(i); return n ? n.textContent : "";
  }).join(" "));
  const labelOf = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l && clean(l.textContent)) return clean(l.textContent);
    }
    const wrap = el.closest("label");
    if (wrap && clean(wrap.textContent)) return clean(wrap.textContent);
    return clean(el.getAttribute("aria-label")) || byIds(el.getAttribute("aria-labelledby")) ||
      clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title")) || "";
  };
  const groupLabel = (el) => {
    const fs = el.closest("fieldset");
    const lg = fs && fs.querySelector("legend");
    if (lg && clean(lg.textContent)) return clean(lg.textContent);
    const rg = el.closest('[role="radiogroup"], [role="group"]');
    if (rg) {
      const t = clean(rg.getAttribute("aria-label")) || byIds(rg.getAttribute("aria-labelledby"));
      if (t) return t;
    }
    return "";
  };
  const SKIP = new Set(["hidden", "submit", "button", "reset", "image", "password"]);
  const out = [];
  const groups = new Map();
  for (const el of document.querySelectorAll("input, select, textarea")) {
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : tag;
    if (SKIP.has(type) || el.disabled || el.readOnly || !visible(el)) continue;
    const name = el.getAttribute("name") || "";
    if (type === "radio" && name) {
      let g = groups.get(name);
      if (!g) {
        g = { selector: 'input[type="radio"][name="' + CSS.escape(name) + '"]', label: groupLabel(el) || name,
              name, id: "", tag, type: "radio", required: false, options: [] };
        groups.set(name, g);
        out.push(g);
      }
      g.required = g.required || el.required || el.getAttribute("aria-required") === "true";
      g.options.push({ label: labelOf(el) || el.value, value: el.value });
      continue;
    }
    const f = { selector: selectorOf(el), label: labelOf(el) || groupLabel(el) || name || el.id || "", name,
                id: el.id || "", tag, type, required: el.required || el.getAttribute("aria-required") === "true",
                options: [] };
    if (tag === "select") {
      for (const o of el.options) {
        if (o.disabled || (!o.value && !clean(o.textContent))) continue;
        if (!o.value) continue; // placeholder like "Select one"
        f.options.push({ label: clean(o.textContent), value: o.value });
      }
    }
    out.push(f);
  }
  return out;
})()`;

/** Returns the first visible button of the given kind ("next" | "submit") or null. */
const FIND_BUTTON_JS = (kind: "next" | "submit") => `(() => {
  const NEXT = /^\\s*(next|continue|proceed|save\\s*(and|&)\\s*continue)\\b/i;
  const SUBMIT = /\\b(submit|apply|send|finish|complete|confirm|pay|place order)\\b/i;
  const NOT_SUBMIT = /\\b(back|previous|cancel|search|sign in|log in|login|upload|add|remove|clear)\\b/i;
  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const textOf = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
  const els = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')]
    .filter((el) => visible(el) && !el.disabled);
  const isNext = (el) => NEXT.test(textOf(el)) && !SUBMIT.test(textOf(el));
  const isSubmitText = (el) => SUBMIT.test(textOf(el)) && !NOT_SUBMIT.test(textOf(el));
  const isSubmitType = (el) => (el.getAttribute("type") || "").toLowerCase() === "submit" &&
    !isNext(el) && !NOT_SUBMIT.test(textOf(el));
  if (${JSON.stringify(kind)} === "next") return els.find(isNext) || null;
  return els.find(isSubmitText) || els.find(isSubmitType) || null;
})()`;

const CONFIRM_JS = `(() => {
  const c = document.querySelector("#confirmation");
  const body = (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim();
  return { confirmation: c && c.getClientRects().length ? (c.innerText || "").replace(/\\s+/g, " ").trim() : "",
           body: body.slice(0, 4000) };
})()`;

const INVALID_JS = `(() => [...document.querySelectorAll("input, select, textarea")]
  .filter((el) => el.willValidate && !el.checkValidity() && el.getClientRects().length)
  .map((el) => el.getAttribute("name") || el.id || el.tagName.toLowerCase()))()`;

async function findButton(page: Page, kind: "next" | "submit"): Promise<ElementHandle<Element> | null> {
  const h = await page.evaluateHandle(FIND_BUTTON_JS(kind));
  const el = h.asElement() as ElementHandle<Element> | null;
  if (!el) await h.dispose();
  return el;
}

// ---------- option matching ----------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const NEG = /\b(no|not|non|never|without|don t|do not)\b/;

function matchOption(f: FieldSchema, value: string): { index: number; exact: boolean } | null {
  const v = norm(value);
  if (!v) return null;
  let i = f.options.findIndex((o) => norm(o.label) === v || norm(o.value) === v);
  if (i >= 0) return { index: i, exact: true };
  i = f.options.findIndex((o) => {
    const l = norm(o.label);
    if (!l || NEG.test(l) !== NEG.test(v)) return false;
    return l.includes(v) || v.includes(l);
  });
  return i >= 0 ? { index: i, exact: false } : null;
}

// ---------- heuristic mapper (MOCK / no key / LLM failure) ----------

const STANDARD_KEYS = new Set([
  "name", "firstName", "lastName", "email", "phone", "school", "major", "gpa", "gradYear",
  "linkedin", "github", "resumePath", "workAuthorization",
]);
/** Labels about someone/something other than the applicant: never answer these from the applicant's own profile. */
const THIRD_PARTY = /\b(reference|referee|referr|recommender|emergency|parent|guardian|supervisor|manager|recruiter|employer|company name|spouse)\b/;
const ESSAY = /\b(why|tell us|describe|explain|interest|about you|about yourself|cover letter|motivat|what makes)\b/;

function splitName(profile: Profile): { first: string; last: string } {
  const parts = (profile.name ?? "").trim().split(/\s+/).filter(Boolean);
  return {
    first: profile.firstName || parts[0] || "",
    last: profile.lastName || (parts.length > 1 ? parts.slice(1).join(" ") : ""),
  };
}

function essayFromContext(profile: Profile, ctx: MemoryContext): string | null {
  const lines = [...ctx.snippets, ...ctx.knowledge];
  if (!lines.length) return null; // nothing in memory to draw on → do not make something up
  const { first } = splitName(profile);
  const firstPerson = (s: string) =>
    !first
      ? s
      : s
          .replace(new RegExp(`\\b${first}(?:\\s+\\w+)?\\s+is\\b`, "g"), "I'm")
          .replace(new RegExp(`\\b${first}'s\\b`, "g"), "my");
  const about = ctx.snippets
    .filter((s) => first && s.includes(first))
    .slice(0, 2)
    .map(firstPerson)
    .map((s) => s.replace(/\.*$/, "."));
  const goals = ctx.knowledge.find((k) => /^goals\.md:/i.test(k))?.replace(/^goals\.md:\s*/i, "").replace(/\.*$/, "");
  const intro = [first && `I'm ${first}`, profile.major && profile.school && `a ${profile.major} student at ${profile.school}`]
    .filter(Boolean)
    .join(", ");
  const out = [
    intro ? `${intro}.` : "",
    ...about,
    goals ? `My goals right now: ${goals.charAt(0).toLowerCase()}${goals.slice(1)}.` : "",
    "This role fits what I'm already working toward, and I'd like to learn from your team while building things people actually use.",
  ].filter(Boolean);
  return out.length > 1 ? out.join(" ") : null;
}

function heuristicAnswer(f: FieldSchema, profile: Profile, ctx: MemoryContext): Answer | null {
  const text = norm(`${f.label} ${f.name} ${f.id}`);
  const ans = (value: string | undefined, source: string, confidence = 0.95): Answer | null =>
    value && value.trim() ? { value: value.trim(), confidence, source } : null;

  if (f.type === "file") {
    if (!/\b(resume|cv|curriculum)\b/.test(text)) return null;
    return profile.resumePath && fs.existsSync(profile.resumePath)
      ? ans(profile.resumePath, "profile.resumePath")
      : null;
  }
  if (f.type === "checkbox") return null; // consent / attestations are the student's call

  // Extra profile keys (e.g. PUT /profile {"reference": "..."}): every word of the key must appear in the label.
  for (const [key, value] of Object.entries(profile)) {
    if (STANDARD_KEYS.has(key) || typeof value !== "string" || !value.trim()) continue;
    const words = norm(key.replace(/([a-z])([A-Z])/g, "$1 $2")).split(" ").filter(Boolean);
    if (words.length && words.every((w) => new RegExp(`\\b${w}`).test(text))) return ans(value, `profile.${key}`, 0.9);
  }
  if (THIRD_PARTY.test(text)) return null;

  const { first, last } = splitName(profile);
  const has = (re: RegExp) => re.test(text);
  if (has(/\b(first|given)\s*name\b|\bfname\b|\bfirstname\b/)) return ans(first, "profile.firstName");
  if (has(/\b(last|family)\s*name\b|\bsurname\b|\blname\b|\blastname\b/)) return ans(last, "profile.lastName");
  if (has(/\blinkedin\b/)) return ans(profile.linkedin, "profile.linkedin");
  if (has(/\bgithub\b/)) return ans(profile.github, "profile.github");
  if (f.type === "email" || has(/\be ?mail\b/)) return ans(profile.email, "profile.email");
  if (f.type === "tel" || has(/\b(phone|mobile|telephone|cell)\b/)) return ans(profile.phone, "profile.phone");
  if (has(/\bgpa\b|grade point/)) return ans(profile.gpa, "profile.gpa");
  if (has(/\bgrad(uation)?\b.*\b(year|date)\b|\bgrad ?year\b|\bclass of\b|\bgraduat/)) return ans(profile.gradYear, "profile.gradYear");
  if (has(/\b(major|field of study|degree program|area of study|concentration)\b/)) return ans(profile.major, "profile.major");
  if (has(/\b(school|university|college|institution)\b/)) return ans(profile.school, "profile.school");
  if (has(/\b(work authori[sz]ation|authori[sz]ed to work|legally (authori[sz]ed|eligible)|work eligibility|right to work)\b/) || has(/\bwork ?auth/))
    return ans(profile.workAuthorization, "profile.workAuthorization", 0.85);
  if (has(/\b(full|your|legal|applicant)?\s*name\b/) && !has(/\b(user ?name|school|company|file|project|team)\b/))
    return ans(profile.name || `${first} ${last}`.trim(), "profile.name", 0.9);
  if (f.type === "textarea" && ESSAY.test(text)) {
    const essay = essayFromContext(profile, ctx);
    return essay ? { value: essay, confidence: 0.6, source: "memory context (draft: please review)" } : null;
  }
  return null;
}

function heuristicMap(fields: FieldSchema[], profile: Profile, ctx: MemoryContext): Map<string, Answer> {
  const out = new Map<string, Answer>();
  for (const f of fields) {
    const a = heuristicAnswer(f, profile, ctx);
    if (a) out.set(f.selector, a);
  }
  return out;
}

// ---------- LLM mapper ----------

const MappingSchema = z.object({
  fields: z.array(
    z.object({
      selector: z.string(),
      value: z.string(),
      confidence: z.number(),
      source: z.string(),
    }),
  ),
});

const SYSTEM = `You fill out application forms for a student. You get the form fields, the student's profile, and context from their memory.
Return one entry per field you were given: {selector (copied exactly), value, confidence 0-1, source}.
Rules:
- Only use facts present in the profile or memory context. NEVER invent facts (references, GPA, citizenship, demographics, dates, IDs, how they heard about the company, etc.). If you do not know, return value "" with confidence 0 and source "unknown".
- For select and radio fields, value must be exactly one of the listed option labels.
- For long-answer / essay fields, write 3-6 sentences in the student's own first-person voice, following their writing style from the context, grounded only in the profile and context. Give essays confidence 0.6 so the student reviews them.
- Never tick consent, agreement, or attestation checkboxes: return "" for them.
- source names where the value came from, e.g. "profile.email" or "memory: goals.md".`;

async function llmMap(
  fields: FieldSchema[],
  profile: Profile,
  ctx: MemoryContext,
  pageTitle: string,
): Promise<Map<string, Answer>> {
  const askable = fields.filter((f) => f.type !== "file");
  const { resumePath: _omit, ...profileForModel } = profile;
  const res = await complete({
    tier: "fast",
    system: SYSTEM,
    schema: MappingSchema,
    schemaName: "form_mapping",
    input: JSON.stringify({
      pageTitle,
      fields: askable.map((f) => ({
        selector: f.selector,
        label: f.label,
        name: f.name,
        type: f.type,
        required: f.required,
        options: f.options.map((o) => o.label),
      })),
      profile: profileForModel,
      memory: ctx,
    }),
  });
  const known = new Map(askable.map((f) => [f.selector, f]));
  const out = new Map<string, Answer>();
  for (const r of res.fields) {
    const f = known.get(r.selector);
    const value = (r.value ?? "").trim();
    const confidence = Math.max(0, Math.min(1, Number(r.confidence) || 0));
    if (!f || !value || confidence < 0.3 || /^unknown$/i.test(r.source.trim())) continue;
    out.set(f.selector, { value, confidence, source: r.source || "llm" });
  }
  // File uploads are never left to the model.
  for (const f of fields) {
    if (f.type !== "file") continue;
    const a = heuristicAnswer(f, profile, ctx);
    if (a) out.set(f.selector, a);
  }
  return out;
}

async function mapFields(
  fields: FieldSchema[],
  profile: Profile,
  ctx: MemoryContext,
  pageTitle: string,
): Promise<{ answers: Map<string, Answer>; mapper: "llm" | "heuristic" }> {
  if (llmAvailable()) {
    try {
      return { answers: await llmMap(fields, profile, ctx, pageTitle), mapper: "llm" };
    } catch {
      /* fall through to heuristics */
    }
  }
  return { answers: heuristicMap(fields, profile, ctx), mapper: "heuristic" };
}

// ---------- filling ----------

/** Fills one field. Returns the value actually entered (option label for select/radio), or throws. */
async function fillField(page: Page, f: FieldSchema, a: Answer): Promise<{ value: string; confidence: number }> {
  const loc = page.locator(f.selector);
  if (f.type === "select" || f.type === "radio") {
    const m = matchOption(f, a.value);
    if (!m) throw new Error("no matching option");
    const opt = f.options[m.index]!;
    if (f.type === "select") await loc.selectOption({ value: opt.value });
    else await loc.nth(m.index).check({ force: true });
    return { value: opt.label, confidence: m.exact ? a.confidence : Math.min(a.confidence, 0.8) };
  }
  if (f.type === "file") {
    if (!fs.existsSync(a.value)) throw new Error("file not found");
    await loc.setInputFiles(a.value);
    return { value: a.value, confidence: a.confidence };
  }
  if (f.type === "checkbox") {
    if (!/^(true|yes|on|checked|1)$/i.test(a.value)) throw new Error("not a yes value");
    await loc.check({ force: true });
    return { value: "checked", confidence: a.confidence };
  }
  await loc.fill(a.value);
  return { value: a.value, confidence: a.confidence };
}

async function closeStalePages(): Promise<void> {
  for (const [id, page] of openPages) {
    if (page.isClosed() || getProposal(id)?.status !== "pending") {
      openPages.delete(id);
      await page.close().catch(() => {});
    }
  }
}

function parseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Progress hook for fillForm. It may throw (for example RunCancelled) to abort the fill; the tab is then closed. */
export type FillProgress = (action: string, detail: string) => void;

/** Opens the form, fills what it can, and STOPS before submit. Returns the pending fill_form proposal. */
export async function fillForm(url: string, override: Record<string, string> = {}, progress: FillProgress = () => {}): Promise<Proposal> {
  await closeStalePages();
  const profile = { ...readProfile(), ...override } as Profile;
  const page = await newPage();
  try {
    progress("goto", `Opening ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
    const pageTitle = (await page.title().catch(() => "")).trim() || new URL(url).hostname;

    const filled: FilledField[] = [];
    const open: OpenField[] = [];
    const seen = new Set<string>();
    let total = 0;
    let pages = 0;
    let mapper: "llm" | "heuristic" = "heuristic";

    for (let i = 0; i < MAX_PAGES; i++) {
      const all = (await page.evaluate(EXTRACT_JS)) as FieldSchema[];
      const fields = all.filter((f) => !seen.has(f.selector));
      if (i > 0 && fields.length === 0) break; // "Next" did not reveal anything new (validation blocked, or the end)
      pages++;
      for (const f of fields) seen.add(f.selector);
      total += fields.length;
      progress("read", `Reading ${fields.length} field${fields.length === 1 ? "" : "s"} on page ${pages} of "${pageTitle}"`);

      if (fields.length) {
        const ctx = await getContext(`${pageTitle} ${fields.map((f) => f.label).join(", ")}`);
        const mapped = await mapFields(fields, profile, ctx, pageTitle);
        mapper = mapped.mapper;
        progress("fill", `Filling page ${pages} from your profile and memory (${mapped.answers.size} of ${fields.length} answers found)`);
        for (const f of fields) {
          const a = mapped.answers.get(f.selector);
          let reason = "no confident answer in profile or memory";
          if (a) {
            try {
              const done = await fillField(page, f, a);
              filled.push({
                selector: f.selector,
                label: f.label,
                type: f.type,
                value: done.value,
                confidence: done.confidence,
                source: a.source,
                flagged: done.confidence < FLAG_BELOW,
              });
              continue;
            } catch (err) {
              reason = `could not fill: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
            }
          }
          open.push({
            selector: f.selector,
            label: f.label,
            type: f.type,
            required: f.required,
            options: f.options.map((o) => o.label),
            reason,
          });
        }
      }

      // Advance only via an explicit Next/Continue, and only when no submit button is on screen.
      const submit = await findButton(page, "submit");
      if (submit) {
        await submit.dispose();
        break;
      }
      const next = await findButton(page, "next");
      if (!next) break;
      progress("click", `Page ${pages} is filled. Going to page ${pages + 1}`);
      await next.click();
      await next.dispose().catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(400);
    }

    const unknown = open.filter((f) => f.required);
    const skipped = open.filter((f) => !f.required);
    const screenshot = await screenshotB64(page, true);
    progress("verify", `Checking the filled form: ${filled.length} of ${total} fields are in`);

    const task = unknown.length
      ? createProposal({
          type: "task",
          title: `Answer ${unknown.length} question${unknown.length === 1 ? "" : "s"} for ${pageTitle}`,
          why: `The form requires ${unknown.map((f) => `"${f.label}"`).join(", ")} and I won't guess facts that aren't in your profile or memory.`,
          payload: { url, pageTitle, questions: unknown },
          urgency: 2,
        })
      : undefined;

    const flaggedCount = filled.filter((f) => f.flagged).length;
    const proposal = createProposal({
      type: "fill_form",
      title: `Submit application: ${pageTitle}`,
      why:
        `Filled ${filled.length} of ${total} fields from your profile and memory` +
        (unknown.length ? `; ${unknown.length} required field${unknown.length === 1 ? "" : "s"} still need${unknown.length === 1 ? "s" : ""} you` : "") +
        (flaggedCount ? `; ${flaggedCount} to double-check` : "") +
        ". Nothing is submitted until you approve.",
      payload: {
        url,
        pageTitle,
        fields: filled,
        unknown,
        skipped,
        filledCount: filled.length,
        totalCount: total,
        pages,
        mapper,
        taskProposalId: task?.id,
        screenshot,
      },
      urgency: 2,
    });
    openPages.set(proposal.id, page);
    return proposal;
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

/** One line for the Activity screen and the final Sidekick frame. */
export function fillSummary(p: Proposal): string {
  const need = Array.isArray(p.payload?.unknown) ? p.payload.unknown.length : 0;
  return (
    `Filled ${p.payload?.filledCount ?? "?"} of ${p.payload?.totalCount ?? "?"} fields.` +
    (need ? ` ${need} required answer${need === 1 ? "" : "s"} still need${need === 1 ? "s" : ""} you.` : "") +
    " Waiting for your OK in Approve."
  );
}

// ---------- submit (runs only when the fill_form proposal is approved) ----------

onApprove("fill_form", async (p, input) => {
  const page = openPages.get(p.id);
  if (!page || page.isClosed()) {
    openPages.delete(p.id);
    throw new Error("The filled form's tab is no longer open. Run /fill again, then approve the new proposal.");
  }
  const pageTitle: string = p.payload?.pageTitle ?? "application";
  const url: string = p.payload?.url ?? page.url();

  // Answers the user typed in the Approve card for fields we refused to guess.
  // Only selectors this proposal reported as unanswered are accepted.
  const openSelectors = new Set<string>(
    [...(p.payload?.unknown ?? []), ...(p.payload?.skipped ?? [])].map((f: { selector: string }) => f.selector),
  );
  const answered: { selector: string; value: string }[] = [];
  for (const [selector, value] of Object.entries(input?.answers ?? {})) {
    if (!openSelectors.has(selector)) continue;
    const loc = page.locator(selector).first();
    const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
    if (!tag) throw new Error(`Could not find the field for your answer (${selector}).`);
    if (tag === "select") await loc.selectOption({ label: value }).catch(() => loc.selectOption(value));
    else await loc.fill(value);
    answered.push({ selector, value });
  }

  const submit = await findButton(page, "submit");
  if (!submit) throw new Error("Could not find a submit button on the page.");
  const urlBefore = page.url();
  const before = (await page.evaluate(CONFIRM_JS)) as { confirmation: string; body: string };
  const TEXT = /(application|form|response)?\s*(has been |was |successfully )?(submitted|received)|thank you|thanks for/i;
  const hadText = TEXT.test(before.body);

  await submit.click();
  await submit.dispose().catch(() => {});

  let confirmation = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const now = (await page.evaluate(CONFIRM_JS).catch(() => null)) as { confirmation: string; body: string } | null;
    if (!now) continue; // mid-navigation
    if (now.confirmation) confirmation = now.confirmation;
    else if (!hadText && TEXT.test(now.body)) confirmation = now.body.slice(0, 300);
    else if (page.url() !== urlBefore) confirmation = (await page.title().catch(() => "")) || `Navigated to ${page.url()}`;
    if (confirmation) break;
  }
  if (!confirmation) {
    const invalid = ((await page.evaluate(INVALID_JS).catch(() => [])) as string[]).slice(0, 8);
    throw new Error(
      invalid.length
        ? `Clicked submit but the form did not go through: required fields still need an answer (${invalid.join(", ")}). Run /fill again after answering them.`
        : "Clicked submit but saw no confirmation; the application may not have been submitted. Check the tab.",
    );
  }

  const screenshot = await screenshotB64(page, true).catch(() => "");
  openPages.delete(p.id);
  await page.close().catch(() => {});
  await postEvent({
    source: "form",
    kind: "observation",
    text: `Applied to ${pageTitle} (submitted ${new Date().toISOString().slice(0, 10)}; ${p.payload?.filledCount ?? "?"} of ${p.payload?.totalCount ?? "?"} fields filled automatically).`,
    tags: ["application", "submitted"],
    refs: { url },
  }).catch(() => false);
  // The "answer these questions" task is moot once the form is in.
  const taskId: string | undefined = p.payload?.taskProposalId;
  if (taskId && getProposal(taskId)?.status === "pending") updateProposal(taskId, { status: "done" });
  return { submitted: true, confirmation, screenshot, answered };
});

// ---------- routes ----------

export default async function fillRoutes(app: FastifyInstance) {
  app.post<{ Body: { url?: unknown; profile?: unknown } }>("/fill", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const url = parseUrl(body.url);
    if (!url) return reply.code(400).send({ error: "url is required and must be an http(s) URL" });
    const override: Record<string, string> = {};
    if (body.profile !== undefined) {
      if (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile))
        return reply.code(400).send({ error: "profile must be a JSON object" });
      for (const [k, v] of Object.entries(body.profile as Record<string, unknown>))
        if (typeof v === "string" || typeof v === "number") override[k] = String(v);
    }
    const run = createRun("fill", `Fill ${url}`, url);
    try {
      const proposal = await fillForm(url, override, (action, detail) => {
        if (isCancelled(run.id)) throw new RunCancelled();
        addRunStep(run.id, action, detail);
      });
      finishRun(run.id, "stopped", { step: { action: "stopped", detail: fillSummary(proposal) }, proposalId: proposal.id });
      return proposal;
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      finishRun(run.id, "error", { step: { action: "error", detail: msg } });
      if (err instanceof RunCancelled) return reply.code(409).send({ error: "Cancelled" });
      req.log.error(err);
      return reply.code(502).send({ error: msg });
    }
  });

  app.post<{ Body: { proposalId?: unknown } }>("/submit", async (req, reply) => {
    const id = req.body && typeof req.body === "object" ? req.body.proposalId : undefined;
    if (typeof id !== "string" || !id) return reply.code(400).send({ error: "proposalId is required" });
    const existing = getProposal(id);
    if (!existing) return reply.code(404).send({ error: "proposal not found" });
    if (existing.type !== "fill_form") return reply.code(400).send({ error: "proposal is not a fill_form proposal" });
    const p = await approveProposal(id, parseApproveInput(req.body));
    if (!p) return reply.code(404).send({ error: "proposal not found" });
    return p;
  });
}
