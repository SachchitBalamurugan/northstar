// Tab organizer: list tabs, group them by task, and save/restore/archive work sessions.
// Only sees tabs in Northstar's own Playwright browser. A browser extension can send the student's
// everyday tabs in the request body (`tabs`), which is why organize/sessions/archive accept them.
import type { FastifyInstance } from "fastify";
import type { Page } from "playwright";
import { attachedContext, getContext as launchContext, peekContext } from "../browser.js";
import { MOCK } from "../config.js";
import { isPendingFormPage } from "../fill/index.js";
import { postEvent } from "../memory.js";
import { organizeTabs } from "./organize.js";
import { deleteSession, getSession, listSessions, saveSession } from "./store.js";
import { sanitizeTabs, type Tab } from "./types.js";

/** Fixture tabs for MOCK=1 when no real tabs are open. */
export const MOCK_TABS: Tab[] = [
  { id: "mock-1", title: "English R1B Essay 2 draft - Google Docs", url: "https://docs.google.com/document/d/mock-r1b-essay/edit", active: true },
  { id: "mock-2", title: "ChatGPT - Essay outline feedback", url: "https://chatgpt.com/c/mock-essay-outline" },
  { id: "mock-3", title: "English R1B: Essay 2 prompt and rubric - bCourses", url: "https://bcourses.berkeley.edu/courses/1500001/assignments/8800002" },
  { id: "mock-4", title: "CS 61A Homework 5 | Gradescope", url: "https://www.gradescope.com/courses/600001/assignments/4000005" },
  { id: "mock-5", title: "CS 61A - Piazza: hw5 q3 recursion hint", url: "https://piazza.com/class/mock61a/post/412" },
  { id: "mock-6", title: "Software Engineering Intern, Summer 2027 - Acme Robotics", url: "https://boards.greenhouse.io/acmerobotics/jobs/5550001" },
  { id: "mock-7", title: "Internships | Handshake", url: "https://app.joinhandshake.com/stu/postings?job_type=internship" },
  { id: "mock-8", title: "lofi hip hop radio - beats to relax/study to - YouTube", url: "https://www.youtube.com/watch?v=mock-lofi" },
  { id: "mock-9", title: "Built-in Functions - Python 3 documentation", url: "https://docs.python.org/3/library/functions.html" },
  { id: "mock-10", title: "how to cite a website mla - Google Search", url: "https://www.google.com/search?q=how+to+cite+a+website+mla" },
  { id: "mock-11", title: "CS 61A Homework 5 | Gradescope", url: "https://www.gradescope.com/courses/600001/assignments/4000005" },
];

// ---------- live tabs ----------

const pageIds = new WeakMap<Page, string>();
let nextId = 1;
const idOf = (page: Page) => {
  let id = pageIds.get(page);
  if (!id) pageIds.set(page, (id = `t${nextId++}`));
  return id;
};
const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

interface Live {
  tab: Tab;
  page: Page;
}

/** Tabs of the persistent browser, if it is open. Never launches one. Blank tabs are left out. */
async function liveTabs(): Promise<Live[]> {
  // Attaches to the shared signed-in Chrome if it is running (never spawns one), so its tabs show up.
  const ctx = MOCK ? await peekContext() : await attachedContext();
  if (!ctx) return [];
  const pages = ctx.pages().filter((p) => !p.isClosed() && /^https?:/i.test(p.url()));
  const out = await Promise.all(
    pages.map(async (page) => {
      const url = page.url();
      const [title, visible] = await Promise.all([
        within(page.title(), 1000, ""),
        within(page.evaluate("document.visibilityState === 'visible'") as Promise<boolean>, 500, false),
      ]);
      return { page, visible, tab: { id: idOf(page), title: title.trim() || url, url } as Tab };
    }),
  );
  // Only trust "active" when exactly one tab claims it (headless reports every tab as visible).
  const visible = out.filter((o) => o.visible);
  if (visible.length === 1) visible[0]!.tab.active = true;
  return out.map(({ tab, page }) => ({ tab, page }));
}

async function currentTabs(): Promise<{ tabs: Tab[]; live: Live[]; source: "browser" | "mock" | "none" }> {
  const live = await liveTabs();
  if (live.length) return { tabs: live.map((l) => l.tab), live, source: "browser" };
  if (MOCK) return { tabs: MOCK_TABS, live: [], source: "mock" };
  return { tabs: [], live: [], source: "none" };
}

function observe(text: string, tags: string[]) {
  void postEvent({ source: "screen", kind: "observation", text, tags }).catch(() => false);
}

const names = (tabs: Tab[]) =>
  tabs.slice(0, 4).map((t) => `"${t.title.slice(0, 50)}"`).join(", ") + (tabs.length > 4 ? `, and ${tabs.length - 4} more` : "");

// ---------- routes ----------

export default async function tabRoutes(app: FastifyInstance) {
  app.get("/tabs", async () => {
    const { tabs, source } = await currentTabs();
    return { tabs, source };
  });

  app.post<{ Body: { tabs?: unknown } | null }>("/tabs/organize", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    let tabs: Tab[];
    const keep = new Set<string>();
    if (body.tabs !== undefined) {
      const given = sanitizeTabs(body.tabs);
      if (!given) return reply.code(400).send({ error: "tabs must be an array of {id, title, url}" });
      tabs = given;
    } else {
      const cur = await currentTabs();
      tabs = cur.tabs;
      // A filled form waiting for approval must stay open, or the student's answers are lost.
      for (const l of cur.live) if (isPendingFormPage(l.page)) keep.add(l.tab.id);
    }
    return organizeTabs(tabs, keep);
  });

  app.get("/tabs/sessions", async () => ({ sessions: listSessions() }));

  app.post<{ Body: { name?: unknown; tabs?: unknown } | null }>("/tabs/sessions", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (typeof body.name !== "string" || !body.name.trim()) return reply.code(400).send({ error: "name is required" });
    let tabs: Tab[];
    if (body.tabs !== undefined) {
      const given = sanitizeTabs(body.tabs);
      if (!given) return reply.code(400).send({ error: "tabs must be an array of {id, title, url}" });
      tabs = given;
    } else tabs = (await currentTabs()).tabs;
    if (!tabs.length) return reply.code(400).send({ error: "there are no tabs to save" });
    const session = saveSession(body.name, tabs);
    observe(`Saved work session "${session.name}" with ${tabs.length} tab${tabs.length === 1 ? "" : "s"}: ${names(tabs)}.`, ["tabs", "session", "saved"]);
    return session;
  });

  app.post<{ Params: { id: string } }>("/tabs/sessions/:id/restore", async (req, reply) => {
    const session = getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const urls = session.tabs.map((t) => t.url).filter((u) => /^https?:\/\//i.test(u));
    // MOCK never launches a browser for this; it reuses one only if a task already opened it.
    const ctx = (await peekContext()) ?? (MOCK ? null : await launchContext().catch(() => null));
    let opened = 0;
    if (ctx) {
      await Promise.all(
        urls.map(async (url) => {
          try {
            const page = await ctx.newPage();
            opened++;
            // The tab exists even if the site is slow or offline; the student can reload it.
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
          } catch {
            /* could not open this tab; its url is still returned */
          }
        }),
      );
    }
    observe(`Restored work session "${session.name}" (${opened} of ${urls.length} tabs reopened).`, ["tabs", "session", "restored"]);
    return { ok: true, opened, urls };
  });

  app.delete<{ Params: { id: string } }>("/tabs/sessions/:id", async (req, reply) => {
    if (!deleteSession(req.params.id)) return reply.code(404).send({ error: "session not found" });
    return { ok: true };
  });

  // Undoable (restore the returned session), so no Proposal. A tab is only ever closed AFTER it is on disk.
  app.post<{ Body: { tabIds?: unknown; tabs?: unknown } | null }>("/tabs/archive", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (!Array.isArray(body.tabIds) || !body.tabIds.length || !body.tabIds.every((x) => typeof x === "string" || typeof x === "number"))
      return reply.code(400).send({ error: "tabIds must be a non-empty array of tab ids" });
    const wanted = new Set(body.tabIds.map(String));

    const cur = await currentTabs();
    const pool = new Map<string, Tab>(cur.tabs.map((t) => [t.id, t]));
    // Tabs from an extension can be archived too: they are saved here and the extension closes them itself.
    if (body.tabs !== undefined) {
      const given = sanitizeTabs(body.tabs);
      if (!given) return reply.code(400).send({ error: "tabs must be an array of {id, title, url}" });
      for (const t of given) if (!pool.has(t.id)) pool.set(t.id, t);
    }
    const liveById = new Map(cur.live.map((l) => [l.tab.id, l.page]));
    const skipped: { tabId: string; why: string }[] = [];
    const toSave: Tab[] = [];
    for (const id of wanted) {
      const t = pool.get(id);
      if (!t) skipped.push({ tabId: id, why: "No open tab with this id." });
      else if (liveById.has(id) && isPendingFormPage(liveById.get(id)!))
        skipped.push({ tabId: id, why: "This tab holds a filled form waiting for your approval, so it stays open." });
      else toSave.push(t);
    }
    if (!toSave.length) return reply.code(400).send({ error: "none of those tabs can be archived", skipped });

    const stamp = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const session = saveSession(`Archived ${stamp}`, toSave); // throws → nothing is closed
    const saved = new Set((getSession(session.id)?.tabs ?? []).map((t) => t.url)); // read back from disk

    let closed = 0;
    for (const t of toSave) {
      const page = liveById.get(t.id);
      if (!page || page.isClosed()) continue;
      // The tab may have navigated since it was listed; only close it if the page it shows now is the saved one.
      if (!saved.has(t.url) || page.url() !== t.url) {
        skipped.push({ tabId: t.id, why: "This tab changed while I was saving it, so I left it open." });
        continue;
      }
      await page.close().then(() => closed++, () => {});
    }
    observe(`Archived ${toSave.length} tab${toSave.length === 1 ? "" : "s"} into "${session.name}" (${closed} closed): ${names(toSave)}.`, ["tabs", "session", "saved", "archived"]);
    return { ok: true, closed, sessionId: session.id, sessionName: session.name, saved: toSave.length, skipped };
  });
}
