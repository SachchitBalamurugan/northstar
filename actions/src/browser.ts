// One shared persistent Chromium for the whole service (a profile dir can only be opened once).
// Both the form filler and Sidekick MUST get pages from here, never launch their own browser.
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { DATA_DIR, HEADLESS } from "./config.js";

let ctx: Promise<BrowserContext> | null = null;

export function getContext(): Promise<BrowserContext> {
  if (!ctx) {
    ctx = chromium
      .launchPersistentContext(path.join(DATA_DIR, "browser-profile"), {
        headless: HEADLESS,
        viewport: { width: 1280, height: 900 },
      })
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

/** A fresh tab. Caller owns it and should close it when the task is finished. */
export async function newPage(): Promise<Page> {
  const c = await getContext();
  const page = await c.newPage();
  page.setDefaultTimeout(10_000);
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
  await c?.close().catch(() => {});
}
