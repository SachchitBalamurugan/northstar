// One shared browser context for the whole service (a profile dir can only be opened once).
// Both the form filler and Sidekick MUST get pages from here, never launch their own browser.
// Order: (1) attach to the user's own Chrome over CDP if it is listening (keeps their logins),
// (2) else a visible persistent Chrome window on the Northstar profile, (3) bundled Chromium.
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { DATA_DIR, HEADLESS } from "./config.js";

const CDP_URL = process.env.CHROME_CDP_URL ?? "http://127.0.0.1:9222";

let ctx: Promise<BrowserContext> | null = null;
/** Set when attached to the user's own Chrome: we must never close it, only disconnect. */
let cdpBrowser: Browser | null = null;

async function cdpAvailable(): Promise<boolean> {
  try {
    const r = await fetch(new URL("/json/version", CDP_URL), { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

async function launch(): Promise<BrowserContext> {
  const profileDir = path.join(DATA_DIR, "browser-profile");
  if (HEADLESS) {
    return chromium.launchPersistentContext(profileDir, { headless: true, viewport: { width: 1280, height: 900 } });
  }
  if (await cdpAvailable()) {
    const browser = await chromium.connectOverCDP(CDP_URL);
    cdpBrowser = browser;
    browser.on("disconnected", () => {
      cdpBrowser = null;
      ctx = null;
    });
    return browser.contexts()[0] ?? (await browser.newContext({ viewport: null }));
  }
  const opts = { headless: false, viewport: null, args: ["--start-maximized"] };
  try {
    return await chromium.launchPersistentContext(profileDir, { ...opts, channel: "chrome" });
  } catch {
    return chromium.launchPersistentContext(profileDir, opts);
  }
}

export function getContext(): Promise<BrowserContext> {
  if (!ctx) {
    ctx = launch()
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
  }
  return ctx;
}

/** The shared context if it is already open, else null. Never launches a browser. */
export async function peekContext(): Promise<BrowserContext | null> {
  if (!ctx) return null;
  return ctx.catch(() => null);
}

/** A fresh tab. Caller owns it and should close it when the task is finished. */
export async function newPage(): Promise<Page> {
  const c = await getContext();
  const page = await c.newPage();
  page.setDefaultTimeout(10_000);
  await page.bringToFront().catch(() => {});
  return page;
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
    // User's own Chrome: Playwright's close() on a connectOverCDP browser only disconnects.
    const b = cdpBrowser;
    cdpBrowser = null;
    await b.close().catch(() => {});
    return;
  }
  await c?.close().catch(() => {});
}
