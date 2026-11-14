// One way for agents to work a browser tab, whichever browser it is:
//  - "chrome": the student's own signed-in Chrome, through the Northstar Bridge extension (preferred);
//  - "playwright": the separate Northstar Chrome window (fallback when the extension is not installed).
import type { Page } from "playwright";
import { bridgeCall, bridgeConnected } from "./bridge.js";
import { findTab as pwFindTab, getContext, listOpenTabs as pwListTabs, openOrReuse, screenshotB64 } from "./browser.js";
import { elLocator, takeSnapshot } from "./sidekick/snapshot.js";

export interface SnapEl {
  index: number;
  tag: string;
  type: string;
  role: string;
  text: string;
  label: string;
  name: string;
  autocomplete: string;
  href: string;
  value?: string;
  required?: boolean;
  inView?: boolean;
  options?: string[];
}
export interface Snapshot {
  url: string;
  title: string;
  elements: SnapEl[];
  text: string;
  scroll?: { y: number; max: number };
  /** True when `text` is a Google Docs/Sheets/Slides file's own content. */
  docText?: boolean;
}
export interface TabInfo {
  title: string;
  url: string;
}

export interface Tab {
  url(): Promise<string>;
  snapshot(): Promise<Snapshot>;
  click(index: number): Promise<void>;
  type(index: number, text: string, enter: boolean): Promise<void>;
  select(index: number, value: string): Promise<void>;
  scroll(dy: number): Promise<void>;
  goto(url: string): Promise<void>;
  screenshot(): Promise<string | undefined>;
  settle(): Promise<void>;
  focus(): Promise<void>;
  /** Insert text at the cursor (Google Docs and other editors). */
  write(text: string): Promise<void>;
  /** Press a key or combo: "Enter", "Tab", "ctrl+End". */
  key(combo: string): Promise<void>;
  /** The full readable content (a Google Doc/Sheet/Slide's own text, or the page text). */
  readText(): Promise<{ title: string; text: string; kind: string }>;
}

export interface Driver {
  kind: "chrome" | "playwright";
  /** Bring an open tab for this URL forward, or open it. */
  open(url: string, match?: "exact" | "path" | "origin"): Promise<Tab>;
  /** The tab the student is looking at right now, if it is a web page. */
  active(): Promise<(TabInfo & { tab: Tab }) | null>;
  /** An empty tab to start from. */
  blank(): Promise<Tab>;
  /** The open tab whose title/url contains most of the keywords. */
  find(keywords: string[]): Promise<(TabInfo & { tab: Tab }) | null>;
  list(): Promise<TabInfo[]>;
  /** Let go of anything held during a task (the extension's debugger connection). */
  release(): Promise<void>;
}

// ---------------- the student's own Chrome (extension) ----------------

interface ExtTab {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
}

class ChromeTab implements Tab {
  constructor(private id: number) {}
  async url() {
    return (await bridgeCall<ExtTab>("tabs.get", { tabId: this.id })).url;
  }
  snapshot() {
    return bridgeCall<Snapshot>("page.snapshot", { tabId: this.id, maxEls: 80 });
  }
  async click(index: number) {
    await bridgeCall("page.click", { tabId: this.id, index });
  }
  async type(index: number, text: string, enter: boolean) {
    await bridgeCall("page.type", { tabId: this.id, index, text, enter });
  }
  async select(index: number, value: string) {
    await bridgeCall("page.select", { tabId: this.id, index, value });
  }
  async scroll(dy: number) {
    await bridgeCall("page.scroll", { tabId: this.id, dy });
  }
  async goto(url: string) {
    await bridgeCall("tabs.goto", { tabId: this.id, url }, 45_000);
  }
  screenshot() {
    return bridgeCall<string>("page.screenshot", { tabId: this.id }).catch(() => undefined);
  }
  async settle() {
    await new Promise((r) => setTimeout(r, 300));
    await bridgeCall("tabs.waitLoad", { tabId: this.id, timeoutMs: 8000 }, 12_000).catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
  }
  async focus() {
    await bridgeCall("tabs.focus", { tabId: this.id }).catch(() => {});
  }
  async write(text: string) {
    await bridgeCall("page.write", { tabId: this.id, text });
  }
  async key(combo: string) {
    await bridgeCall("page.key", { tabId: this.id, key: combo });
  }
  readText() {
    return bridgeCall<{ title: string; text: string; kind: string }>("page.text", { tabId: this.id, maxLen: 20000 });
  }
}

const words = (s: string) => s.toLowerCase();

const chromeDriver: Driver = {
  kind: "chrome",
  async open(url, match = "path") {
    const t = await bridgeCall<ExtTab>("tabs.open", { url, match }, 45_000);
    return new ChromeTab(t.tabId);
  },
  async active() {
    const t = await bridgeCall<ExtTab | null>("tabs.active");
    if (!t || !/^https?:/i.test(t.url)) return null;
    return { title: t.title, url: t.url, tab: new ChromeTab(t.tabId) };
  },
  async blank() {
    const t = await bridgeCall<ExtTab>("tabs.newBlank");
    return new ChromeTab(t.tabId);
  },
  async find(keywords) {
    const kws = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (!kws.length) return null;
    const tabs = await bridgeCall<ExtTab[]>("tabs.list");
    let best: { t: ExtTab; score: number } | null = null;
    for (const t of tabs) {
      const hay = words(`${t.title} ${t.url}`);
      const score = kws.filter((k) => hay.includes(k)).length;
      if (score > 0 && (!best || score > best.score)) best = { t, score };
    }
    if (!best || best.score < Math.max(1, Math.ceil(kws.length / 2))) return null;
    await bridgeCall("tabs.focus", { tabId: best.t.tabId });
    return { title: best.t.title, url: best.t.url, tab: new ChromeTab(best.t.tabId) };
  },
  async list() {
    return (await bridgeCall<ExtTab[]>("tabs.list")).map((t) => ({ title: t.title, url: t.url }));
  },
  async release() {
    await bridgeCall("debugger.release").catch(() => {});
  },
};

// ---------------- fallback: the separate Northstar Chrome (Playwright) ----------------

class PwTab implements Tab {
  constructor(public page: Page) {}
  async url() {
    return this.page.url();
  }
  snapshot() {
    return takeSnapshot(this.page) as Promise<Snapshot>;
  }
  async click(index: number) {
    await elLocator(this.page, index).click({ timeout: 8000 });
  }
  async type(index: number, text: string, enter: boolean) {
    const loc = elLocator(this.page, index);
    await loc.fill(text, { timeout: 8000 });
    if (enter) await loc.press("Enter");
  }
  async select(index: number, value: string) {
    const loc = elLocator(this.page, index);
    const tag = await loc.evaluate((e) => e.tagName.toLowerCase());
    if (tag === "select") await loc.selectOption({ label: value }).catch(() => loc.selectOption(value));
    else await loc.setChecked(/^(true|yes|on|checked|1)$/i.test(value));
  }
  async scroll(dy: number) {
    await this.page.mouse.wheel(0, dy);
    await this.page.waitForTimeout(250);
  }
  async goto(url: string) {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  screenshot() {
    return screenshotB64(this.page).catch(() => undefined);
  }
  async settle() {
    await this.page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    await this.page.waitForTimeout(350);
  }
  async focus() {
    await this.page.bringToFront().catch(() => {});
  }
  async write(text: string) {
    await this.page.keyboard.insertText(text);
  }
  async key(combo: string) {
    const map: Record<string, string> = { ctrl: "Control", control: "Control", alt: "Alt", shift: "Shift", meta: "Meta", cmd: "Meta", esc: "Escape", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };
    const keys = combo.split("+").map((k) => k.trim()).filter(Boolean).map((k) => map[k.toLowerCase()] ?? (k.length === 1 ? k : k[0].toUpperCase() + k.slice(1)));
    await this.page.keyboard.press(keys.join("+"));
  }
  async readText() {
    const title = await this.page.title().catch(() => "");
    const text = await this.page.evaluate(() => (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 20000));
    return { title, text, kind: "page" };
  }
}

const pwDriver: Driver = {
  kind: "playwright",
  async open(url, match = "path") {
    return new PwTab((await openOrReuse(url, { match })).page);
  },
  async active() {
    return null;
  },
  async blank() {
    const c = await getContext();
    const blank = c.pages().find((p) => !p.isClosed() && /^(about:blank|chrome:\/\/new-?tab)/i.test(p.url() || "about:blank"));
    const page = blank ?? (await c.newPage());
    page.setDefaultTimeout(10_000);
    await page.bringToFront().catch(() => {});
    return new PwTab(page);
  },
  async find(keywords) {
    const hit = await pwFindTab(keywords).catch(() => null);
    if (!hit) return null;
    await hit.page.bringToFront().catch(() => {});
    return { title: hit.title, url: hit.url, tab: new PwTab(hit.page) };
  },
  list: () => pwListTabs(),
  async release() {},
};

/** Your own Chrome when the extension is connected, else the separate Northstar window. */
export function getDriver(): Driver {
  return bridgeConnected() ? chromeDriver : pwDriver;
}
