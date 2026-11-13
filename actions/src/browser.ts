// One shared browser for the whole service. Every task gets its pages from here and REUSES
// the same signed-in Chrome and its open tabs instead of opening a new browser each time.
// Order: (1) attach over CDP to a Chrome already listening on CHROME_CDP_URL (survives
// service restarts), (2) else spawn a real detached Chrome on the Northstar profile with a
// debugging port and attach to it, (3) HEADLESS=true keeps a headless persistent context (tests).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { DATA_DIR, HEADLESS } from "./config.js";

const CDP_URL = process.env.CHROME_CDP_URL ?? "http://127.0.0.1:9222";
const PROFILE_DIR = path.join(DATA_DIR, "browser-profile");

let ctx: Promise<BrowserContext> | null = null;
/** Set when attached over CDP: we never kill that Chrome, only disconnect. */
let cdpBrowser: Browser | null = null;

async function cdpAvailable(timeoutMs = 800): Promise<boolean> {
  try {
    const r = await fetch(new URL("/json/version", CDP_URL), { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

function cdpPort(): string {
  try {
    return new URL(CDP_URL).port || "9222";
  } catch {
    return "9222";
  }
}

function chromePath(): string {
  const env = process.env;
  const candidates = [
    env.ProgramFiles && path.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"] as string, "Google", "Chrome", "Application", "chrome.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ].filter((p): p is string => !!p);
  return candidates.find((p) => fs.existsSync(p)) ?? chromium.executablePath();
}

/** Start a real Chrome that outlives this process, so later tasks attach to the same window. */
function spawnChrome(): void {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(
    chromePath(),
    [
      `--remote-debugging-port=${cdpPort()}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--start-maximized",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.on("error", (err) => console.warn(`[browser] could not start Chrome: ${err.message}`));
  child.unref();
}

async function attach(): Promise<BrowserContext> {
  const browser = await chromium.connectOverCDP(CDP_URL);
  cdpBrowser = browser;
  browser.on("disconnected", () => {
    if (cdpBrowser === browser) cdpBrowser = null;
    ctx = null;
  });
  console.log(`[browser] attached to Chrome over CDP at ${CDP_URL}`);
  return browser.contexts()[0] ?? (await browser.newContext({ viewport: null }));
}

async function launch(): Promise<BrowserContext> {
  if (HEADLESS) {
    return chromium.launchPersistentContext(PROFILE_DIR, { headless: true, viewport: { width: 1280, height: 900 } });
  }
  if (await cdpAvailable()) return attach();
  spawnChrome();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await cdpAvailable(500)) return attach();
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `Chrome did not open a debugging port at ${CDP_URL}. If an old Northstar Chrome window is still open on this profile (started without a debugging port), close it and try again.`,
  );
}

function track(p: Promise<BrowserContext>): Promise<BrowserContext> {
  const tracked = p
    .then((c) => {
      c.on("close", () => {
        ctx = null;
      });
      return c;
    })
    .catch((err) => {
      ctx = null;
      throw err;
    });
  ctx = tracked;
  return tracked;
}

export function getContext(): Promise<BrowserContext> {
  return ctx ?? track(launch());
}

/** The shared context if it is already open, else null. Never launches a browser. */
export async function peekContext(): Promise<BrowserContext | null> {
  if (!ctx) return null;
  return ctx.catch(() => null);
}

/** The open context, attaching to an already-running Chrome if one answers on CDP. Never spawns one. */
export async function attachedContext(): Promise<BrowserContext | null> {
  if (ctx) return ctx.catch(() => null);
  if (HEADLESS || !(await cdpAvailable())) return null;
  return track(attach()).catch(() => null);
}

export function isAttachedOverCdp(): boolean {
  return cdpBrowser !== null;
}

/** A fresh tab. Prefer openOrReuse(); this is only for genuinely temporary scratch pages. */
export async function newPage(): Promise<Page> {
  const c = await getContext();
  const page = await c.newPage();
  page.setDefaultTimeout(10_000);
  await page.bringToFront().catch(() => {});
  return page;
}

const isInternal = (u: string) => /^(devtools|chrome|chrome-extension|edge|chrome-search):/i.test(u) && !isBlank(u);
function isBlank(u: string): boolean {
  return u === "" || u === "about:blank" || /^chrome:\/\/(newtab|new-tab-page)/i.test(u) || /^chrome-search:\/\/local-ntp/i.test(u);
}

function usablePages(c: BrowserContext): Page[] {
  return c.pages().filter((p) => !p.isClosed() && !isInternal(p.url()));
}

function parse(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

const norm = (u: URL) => `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}`;
const normPath = (u: URL) => `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
const titleOf = (p: Page) => Promise.race([p.title().catch(() => ""), new Promise<string>((r) => setTimeout(() => r(""), 800))]);

async function bestKeywordPage(pages: Page[], keywords: string[]): Promise<{ page: Page; title: string; score: number } | null> {
  const kws = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (!kws.length) return null;
  let best: { page: Page; title: string; score: number } | null = null;
  for (const page of pages) {
    if (!/^https?:/i.test(page.url())) continue;
    const title = await titleOf(page);
    const hay = `${title} ${page.url()}`.toLowerCase();
    const score = kws.filter((k) => hay.includes(k)).length;
    if (score > 0 && (!best || score > best.score)) best = { page, title: title.trim() || page.url(), score };
  }
  // "Most" keywords: at least half of them (and at least one).
  return best && best.score >= Math.max(1, Math.ceil(kws.length / 2)) ? best : null;
}

/**
 * Bring an existing tab for `url` to the front, or open it (reusing a blank tab when possible).
 * Preference: exact URL, then same origin+pathname, then (match "origin") same origin, then keywords.
 */
export async function openOrReuse(
  url: string,
  opts: { match?: "exact" | "path" | "origin"; keywords?: string[] } = {},
): Promise<{ page: Page; reused: boolean }> {
  const match = opts.match ?? "path";
  const c = await getContext();
  const pages = usablePages(c).filter((p) => !isBlank(p.url()));
  const want = parse(url);
  const urlOf = (p: Page) => parse(p.url());

  let found: Page | undefined;
  let exact = false;
  if (want) {
    found = pages.find((p) => {
      const u = urlOf(p);
      return !!u && norm(u) === norm(want);
    });
    exact = !!found;
    if (!found && match !== "exact")
      found = pages.find((p) => {
        const u = urlOf(p);
        return !!u && normPath(u) === normPath(want);
      });
    if (!found && match === "origin")
      found = pages.find((p) => {
        const u = urlOf(p);
        return !!u && /^https?:$/.test(u.protocol) && u.origin === want.origin;
      });
  }
  if (!found && opts.keywords?.length) found = (await bestKeywordPage(pages, opts.keywords))?.page;

  if (found) {
    found.setDefaultTimeout(10_000);
    await found.bringToFront().catch(() => {});
    // A same-path tab is already the right page; only an origin/keyword match on a specific URL navigates.
    const specific = !!want && (want.pathname.replace(/\/+$/, "") !== "" || want.search !== "");
    const samePath = !!want && !!urlOf(found) && normPath(urlOf(found)!) === normPath(want);
    if (!exact && !samePath && specific) await found.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return { page: found, reused: true };
  }

  const blank = c.pages().find((p) => !p.isClosed() && isBlank(p.url()));
  const page = blank ?? (await c.newPage());
  page.setDefaultTimeout(10_000);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.bringToFront().catch(() => {});
  return { page, reused: false };
}

/** Titles and URLs of the open web tabs (attaches to a running Chrome; never spawns one). */
export async function listOpenTabs(): Promise<{ title: string; url: string }[]> {
  const c = await attachedContext();
  if (!c) return [];
  const pages = usablePages(c).filter((p) => /^https?:/i.test(p.url()));
  return Promise.all(pages.map(async (p) => ({ url: p.url(), title: (await titleOf(p)).trim() })));
}

/** The open tab whose title+url contains most of the keywords, if any. */
export async function findTab(keywords: string[]): Promise<{ page: Page; title: string; url: string } | null> {
  const c = await attachedContext();
  if (!c) return null;
  const best = await bestKeywordPage(usablePages(c), keywords);
  return best ? { page: best.page, title: best.title, url: best.page.url() } : null;
}

/** Viewport PNG as base64 (no data: prefix). */
export async function screenshotB64(page: Page, fullPage = false): Promise<string> {
  return (await page.screenshot({ type: "png", fullPage })).toString("base64");
}

export async function closeBrowser(): Promise<void> {
  if (!ctx) return;
  const c = await ctx.catch(() => null);
  ctx = null;
  if (cdpBrowser) {
    // Attached Chrome: close() on a connectOverCDP browser only disconnects; Chrome keeps running.
    const b = cdpBrowser;
    cdpBrowser = null;
    await b.close().catch(() => {});
    return;
  }
  await c?.close().catch(() => {});
}
