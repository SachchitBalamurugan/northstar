// POST /linkedin/import, GET /linkedin, POST /apply/batch (contracts/jobs.md).
// LinkedIn is read in the user's own logged-in Northstar Chrome; no credentials ever pass through here.
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Page } from "playwright";
import { z } from "zod";
import { openOrReuse } from "../browser.js";
import { DATA_DIR, MEMORY_URL } from "../config.js";
import { fillForm, fillSummary } from "../fill/index.js";
import { complete, llmAvailable } from "../llm.js";
import { readProfile, writeProfile } from "../profile.js";
import { addRunStep, createRun, finishRun, isCancelled, RunCancelled } from "../runs.js";
import type { Profile } from "../types.js";

export interface LinkedInProfile {
  url: string;
  name: string;
  headline: string;
  location: string;
  about: string;
  experience: { title: string; company: string; dates: string; summary: string }[];
  education: { school: string; degree: string; dates: string }[];
  skills: string[];
  importedAt: string;
}

const FILE = path.join(DATA_DIR, "linkedin.json");
const NEEDS_LOGIN_MSG = "Sign in to LinkedIn in the Northstar Chrome window, then import again.";

const Schema = z.object({
  name: z.string(),
  headline: z.string(),
  location: z.string(),
  about: z.string(),
  experience: z.array(z.object({ title: z.string(), company: z.string(), dates: z.string(), summary: z.string() })),
  education: z.array(z.object({ school: z.string(), degree: z.string(), dates: z.string() })),
  skills: z.array(z.string()),
});
type Extracted = z.infer<typeof Schema>;

export function readLinkedIn(): LinkedInProfile | null {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return j && typeof j === "object" ? (j as LinkedInProfile) : null;
  } catch {
    return null;
  }
}

/** Normalised https://www.linkedin.com/in/<slug>/ or null. */
function parseLinkedInUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    if (!(host === "linkedin.com" || host.endsWith(".linkedin.com"))) return null;
    const m = /^\/in\/([^/?#]+)/.exec(u.pathname);
    if (!m) return null;
    return `https://www.linkedin.com/in/${m[1]}/`;
  } catch {
    return null;
  }
}

async function isAuthWall(page: Page): Promise<boolean> {
  const url = page.url();
  if (/\/(authwall|login|checkpoint|uas\/login|signup)/i.test(url)) return true;
  return page
    .evaluate(() => {
      const h1 = (document.querySelector("main h1, h1")?.textContent ?? "").trim();
      const hasPw = !!document.querySelector('input[type="password"], form[action*="login"], form.join-form');
      const text = (document.body?.innerText ?? "").slice(0, 5000);
      const signIn = /\bSign in\b|Join now|Join LinkedIn/i.test(text);
      return hasPw || (signIn && !h1);
    })
    .catch(() => false);
}

async function scrollSlowly(page: Page, times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, 900).catch(() => {});
    await page.waitForTimeout(600);
  }
}

async function bodyText(page: Page, cap: number): Promise<string> {
  const t = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  return t.slice(0, cap);
}

async function heuristic(page: Page): Promise<Extracted> {
  const r = await page
    .evaluate(() => {
      const h1 = document.querySelector("main h1, h1");
      const name = (h1?.textContent ?? "").trim();
      let headline = "";
      const lines = (document.body?.innerText ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      const i = lines.indexOf(name);
      if (i >= 0) headline = lines.slice(i + 1).find((l) => l.length > 3 && !/^(he|she|they)\/|·/i.test(l)) ?? "";
      return { name, headline };
    })
    .catch(() => ({ name: "", headline: "" }));
  return { name: r.name, headline: r.headline, location: "", about: "", experience: [], education: [], skills: [] };
}

function toMarkdown(p: LinkedInProfile): string {
  const out = ["# LinkedIn", "", `- URL: ${p.url}`];
  if (p.name) out.push(`- Name: ${p.name}`);
  if (p.headline) out.push(`- Headline: ${p.headline}`);
  if (p.location) out.push(`- Location: ${p.location}`);
  if (p.about) out.push(`- About: ${p.about.replace(/\s+/g, " ").trim()}`);
  if (p.experience.length) {
    out.push("", "## Experience");
    for (const e of p.experience)
      out.push(`- ${[e.title, e.company].filter(Boolean).join(" at ")}${e.dates ? ` (${e.dates})` : ""}${e.summary ? `: ${e.summary.replace(/\s+/g, " ").trim()}` : ""}`);
  }
  if (p.education.length) {
    out.push("", "## Education");
    for (const e of p.education) out.push(`- ${[e.school, e.degree].filter(Boolean).join(", ")}${e.dates ? ` (${e.dates})` : ""}`);
  }
  if (p.skills.length) out.push("", `- Skills: ${p.skills.join(", ")}`);
  out.push("", `_Imported ${p.importedAt}_`, "");
  return out.join("\n");
}

async function putMemory(md: string): Promise<void> {
  try {
    await fetch(`${MEMORY_URL}/knowledge/linkedin.md`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: md }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // memory service down: the local data/linkedin.json is still saved
  }
}

async function mergeProfile(p: LinkedInProfile): Promise<void> {
  const cur: Profile = await readProfile();
  const patch: Partial<Profile> = { linkedin: p.url };
  if (!cur.name && p.name) {
    const parts = p.name.trim().split(/\s+/);
    patch.name = p.name;
    if (!cur.firstName) patch.firstName = parts[0];
    if (!cur.lastName) patch.lastName = parts.slice(1).join(" ");
  }
  if (p.location) patch.location = p.location;
  const role = p.headline || p.experience[0]?.title;
  if (role) patch.currentRole = role;
  const ed = p.education[0];
  if (ed) {
    if (!cur.school && ed.school) patch.school = ed.school;
    if (!cur.major && ed.degree) patch.major = ed.degree;
  }
  await writeProfile(patch);
}

export async function importLinkedIn(
  url: string,
): Promise<{ ok: true; profile: LinkedInProfile } | { ok: false; needsLogin: true; message: string }> {
  const { page, reused } = await openOrReuse(url, { match: "path" });
  // Tabs the student already had open always stay open.
  let keepOpen = reused;
  try {
    await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1_500);
    if (await isAuthWall(page)) {
      keepOpen = true;
      await page.bringToFront().catch(() => {});
      return { ok: false, needsLogin: true, message: NEEDS_LOGIN_MSG };
    }
    await scrollSlowly(page);
    const main = await bodyText(page, 30_000);

    let skillsText = "";
    try {
      await page.goto(url.replace(/\/?$/, "/") + "details/skills/", { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForTimeout(1_500);
      if (!(await isAuthWall(page))) {
        await scrollSlowly(page, 4);
        skillsText = await bodyText(page, 10_000);
      }
    } catch {
      // best-effort
    }

    let data: Extracted;
    if (llmAvailable()) {
      try {
        data = await complete({
          tier: "fast",
          schemaName: "linkedin_profile",
          schema: Schema,
          system:
            "Extract a LinkedIn profile from the page text. Use only facts present in the text; use empty strings/arrays when absent. " +
            "experience is most-recent first; summary is one short sentence. Ignore navigation, ads, 'People also viewed' and other people's profiles.",
          input: `PROFILE PAGE:\n${main}\n\nSKILLS PAGE:\n${skillsText || "(not available)"}`,
        });
      } catch {
        await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
        data = await heuristic(page);
      }
    } else {
      await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      data = await heuristic(page);
    }

    const profile: LinkedInProfile = { url, ...data, importedAt: new Date().toISOString() };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(profile, null, 2));
    await putMemory(toMarkdown(profile));
    await mergeProfile(profile);
    return { ok: true, profile };
  } finally {
    if (!keepOpen) await page.close().catch(() => {});
  }
}

interface BatchJob {
  url: string;
  title: string;
  company: string;
}
interface BatchResult extends BatchJob {
  ok: boolean;
  proposalId?: string;
  filled?: number;
  needsYou?: number;
  error?: string;
}

export default async function linkedinRoutes(app: FastifyInstance) {
  app.get("/linkedin", async () => readLinkedIn());

  app.post<{ Body: { url?: unknown } }>("/linkedin/import", async (req, reply) => {
    const url = parseLinkedInUrl(req.body && typeof req.body === "object" ? req.body.url : undefined);
    if (!url) return reply.code(400).send({ ok: false, error: "url must be a linkedin.com/in/... profile URL" });
    try {
      return await importLinkedIn(url);
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ ok: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    }
  });

  // Never submits: each job only produces a fill_form Proposal the user must approve.
  app.post<{ Body: { jobs?: unknown } }>("/apply/batch", async (req, reply) => {
    const raw = req.body && typeof req.body === "object" ? req.body.jobs : undefined;
    if (!Array.isArray(raw) || raw.length === 0) return reply.code(400).send({ error: "jobs must be a non-empty array" });
    if (raw.length > 5) return reply.code(400).send({ error: "at most 5 jobs per batch" });
    const results: BatchResult[] = [];
    for (const j of raw as Record<string, unknown>[]) {
      const job: BatchJob = {
        url: typeof j?.url === "string" ? j.url.trim() : "",
        title: typeof j?.title === "string" ? j.title : "",
        company: typeof j?.company === "string" ? j.company : "",
      };
      if (!/^https?:\/\//i.test(job.url)) {
        results.push({ ...job, ok: false, error: "url must be an http(s) URL" });
        continue;
      }
      const run = createRun("fill", `Fill ${job.title || job.url}`, job.url);
      try {
        const p = await fillForm(job.url, {}, (action, detail) => {
          if (isCancelled(run.id)) throw new RunCancelled();
          addRunStep(run.id, action, detail);
        });
        finishRun(run.id, "stopped", { step: { action: "stopped", detail: fillSummary(p) }, proposalId: p.id });
        results.push({
          ...job,
          ok: true,
          proposalId: p.id,
          filled: Number(p.payload?.filledCount ?? 0),
          needsYou: Array.isArray(p.payload?.unknown) ? p.payload.unknown.length : 0,
        });
      } catch (err) {
        const msg = err instanceof RunCancelled ? "Cancelled" : err instanceof Error ? err.message.split("\n")[0] : String(err);
        finishRun(run.id, "error", { step: { action: "error", detail: msg } });
        results.push({ ...job, ok: false, error: msg });
      }
    }
    return { results };
  });
}
