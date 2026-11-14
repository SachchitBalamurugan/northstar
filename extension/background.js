// Northstar Bridge: connects your own Chrome to the Northstar actions service on this computer.
// The service sends commands (list tabs, open a page, read it, click, type, screenshot) over a
// local WebSocket; this worker runs them in your normal, signed-in tabs and sends back results.
// It only ever connects to 127.0.0.1. Nothing here talks to the internet.

const WS_URL = "ws://127.0.0.1:7703/bridge";
const VERSION = chrome.runtime.getManifest().version;

let ws = null;
let pingTimer = null;
let connected = false;

function setState(on) {
  connected = on;
  chrome.action.setBadgeText({ text: on ? "" : "off" });
  chrome.action.setBadgeBackgroundColor({ color: "#5B6B75" });
  chrome.storage.session?.set({ connected: on }).catch(() => {});
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    return;
  }
  ws.onopen = () => {
    setState(true);
    ws.send(JSON.stringify({ type: "hello", version: VERSION }));
    clearInterval(pingTimer);
    // Regular traffic keeps the service worker alive while Northstar is running.
    pingTimer = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 20_000);
  };
  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg.id !== "string" || typeof msg.cmd !== "string") return;
    try {
      const result = await handle(msg.cmd, msg.args || {});
      ws?.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (err) {
      ws?.send(JSON.stringify({ id: msg.id, ok: false, error: String((err && err.message) || err) }));
    }
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    setState(false);
    ws = null;
  };
  ws.onerror = () => {};
}

chrome.alarms.create("northstar-reconnect", { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m === "status") reply({ connected });
  if (m === "reconnect") { connect(); reply({ ok: true }); }
});
setState(false);
connect();

// ---------------- helpers ----------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBlank = (u) => !u || u === "about:blank" || /^chrome:\/\/(newtab|new-tab-page)/i.test(u) || /^chrome-search:/i.test(u);
const isWeb = (u) => /^https?:/i.test(u || "");

function tabInfo(t) {
  return { tabId: t.id, windowId: t.windowId, active: t.active, title: t.title || "", url: t.url || t.pendingUrl || "" };
}

async function waitLoad(tabId, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  await sleep(150);
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error("The tab was closed");
    if (t.status === "complete") return t;
    await sleep(200);
  }
  return chrome.tabs.get(tabId);
}

async function focusTab(tabId) {
  const t = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  return t;
}

function parse(u) {
  try { return new URL(u); } catch { return null; }
}
const normFull = (u) => `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}`;
const normPath = (u) => `${u.origin}${u.pathname.replace(/\/+$/, "")}`;

async function lastWindowId() {
  const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  return w?.id;
}

/** Bring an already-open tab for this URL to the front, or open it in your current window. */
async function openTab(url, match = "path") {
  const want = parse(url);
  if (!want || !isWeb(url)) throw new Error(`Not a web address: ${url}`);
  const tabs = (await chrome.tabs.query({})).filter((t) => isWeb(t.url));
  let found =
    tabs.find((t) => { const u = parse(t.url); return u && normFull(u) === normFull(want); }) ||
    (match !== "exact" && tabs.find((t) => { const u = parse(t.url); return u && normPath(u) === normPath(want); })) ||
    (match === "origin" && tabs.find((t) => { const u = parse(t.url); return u && u.origin === want.origin; })) ||
    null;
  if (found) {
    await focusTab(found.id);
    const u = parse(found.url);
    if (match === "origin" && u && normPath(u) !== normPath(want)) await chrome.tabs.update(found.id, { url });
    return { ...tabInfo(await waitLoad(found.id)), reused: true };
  }
  const windowId = await lastWindowId();
  const [active] = await chrome.tabs.query({ active: true, windowId });
  let t;
  if (active && isBlank(active.url)) t = await chrome.tabs.update(active.id, { url });
  else t = await chrome.tabs.create({ url, active: true, ...(windowId ? { windowId } : {}) });
  await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  return { ...tabInfo(await waitLoad(t.id)), reused: false };
}

async function inPage(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  if (!res) throw new Error("Could not run on this page");
  const out = res.result;
  if (out && out.__error) throw new Error(out.__error);
  return out;
}

// ---------------- page functions (run inside the tab; must be self-contained) ----------------

function pageSnapshot(maxEls) {
  document.querySelectorAll("[data-sk-idx]").forEach((e) => e.removeAttribute("data-sk-idx"));
  const sel =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=option],[role=combobox],[role=textbox],[onclick],.kix-appview-editor,canvas';
  const out = [];
  const clip = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  // Long pages: prefer controls on or near the screen, then fill up with the rest in page order.
  const all = [];
  for (const el of document.querySelectorAll(sel)) {
    if (all.length >= 1500) break;
    const r0 = el.getBoundingClientRect();
    if (r0.width < 1 || r0.height < 1) continue;
    all.push(el);
  }
  const near = all.filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > -150 && r.top < innerHeight * 1.6; });
  const pick = new Set(near.slice(0, maxEls));
  for (const el of all) { if (pick.size >= maxEls) break; pick.add(el); }
  for (const el of all) {
    if (!pick.has(el)) continue;
    if (out.length >= maxEls) break;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === "hidden" || cs.display === "none") continue;
    const tag = el.tagName.toLowerCase();
    if (tag === "canvas" && (r.width < 200 || r.height < 150)) continue;
    const isDocArea = el.classList.contains("kix-appview-editor");
    const idx = out.length;
    el.setAttribute("data-sk-idx", String(idx));
    const lab =
      el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || el.getAttribute("title") || "";
    const isField = tag === "input" || tag === "textarea" || tag === "select";
    const type = (el.getAttribute("type") || "").toLowerCase();
    let txt = isField ? (type === "submit" || type === "button" || type === "reset" ? el.value : "") : el.innerText || el.textContent;
    let value = "";
    if (isField && !["submit", "button", "reset", "password"].includes(type)) {
      value = tag === "select" ? (el.selectedOptions[0]?.text || "") : type === "checkbox" || type === "radio" ? (el.checked ? "checked" : "unchecked") : el.value;
    } else if (el.isContentEditable) value = el.innerText;
    const options = tag === "select" ? [...el.options].slice(0, 15).map((o) => clip(o.text, 40)) : undefined;
    out.push({
      index: idx, tag, type,
      role: el.getAttribute("role") || (el.isContentEditable || isDocArea ? "textbox" : tag === "canvas" ? "canvas" : ""),
      text: isDocArea || tag === "canvas" ? "" : clip(txt, 80),
      label: isDocArea ? "Document editing area (click here, then use write/key)" : tag === "canvas" ? clip(lab || "Drawing/editor canvas", 80) : clip(lab, 80),
      name: clip(el.getAttribute("name") || el.id || "", 40),
      autocomplete: el.getAttribute("autocomplete") || "",
      href: tag === "a" ? clip(el.getAttribute("href"), 120) : "",
      value: clip(value, 120),
      required: !!el.required || el.getAttribute("aria-required") === "true",
      inView: r.bottom > 0 && r.top < innerHeight,
      ...(options ? { options } : {}),
    });
  }
  return {
    url: location.href,
    title: document.title,
    elements: out,
    // The text around where the page is scrolled to (not always the top), so scrolling shows new content.
    text: (() => {
      if (!document.body) return "";
      const parts = [];
      let len = 0, lastCell = null;
      const top = -innerHeight * 0.3, bot = innerHeight * 2.2;
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = w.nextNode()) && len < 4500) {
        const t = node.nodeValue.replace(/\s+/g, " ").trim();
        const p = node.parentElement;
        if (!t || !p || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
        const r = p.getBoundingClientRect();
        if (r.height === 0 || r.bottom < top || r.top > bot) continue;
        const cell = p.closest("td,th,li,p,h1,h2,h3,h4,tr");
        parts.push((cell !== lastCell && parts.length ? (cell && cell.tagName === "TD" ? " | " : "\n") : " ") + t);
        lastCell = cell;
        len += t.length + 2;
      }
      return parts.join("").trim().slice(0, 4500);
    })(),
    scroll: { y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight) },
  };
}

function pageClick(index) {
  const el = document.querySelector(`[data-sk-idx="${index}"]`);
  if (!el) return { __error: `Element ${index} is gone; take a new look at the page` };
  if (el.tagName === "A") el.removeAttribute("target");
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent("pointerdown", o));
  el.dispatchEvent(new MouseEvent("mousedown", o));
  if (el.focus) el.focus();
  el.dispatchEvent(new PointerEvent("pointerup", o));
  el.dispatchEvent(new MouseEvent("mouseup", o));
  el.click();
  return true;
}

function pageType(index, text, enter) {
  const el = document.querySelector(`[data-sk-idx="${index}"]`);
  if (!el) return { __error: `Element ${index} is gone; take a new look at the page` };
  el.scrollIntoView({ block: "center" });
  el.focus();
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") {
    const proto = tag === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
    document.execCommand("insertText", false, text);
  } else return { __error: "That element is not a text field" };
  if (enter) {
    const k = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const notCancelled = el.dispatchEvent(new KeyboardEvent("keydown", k));
    el.dispatchEvent(new KeyboardEvent("keypress", k));
    el.dispatchEvent(new KeyboardEvent("keyup", k));
    if (notCancelled && el.form && tag === "INPUT") {
      try { el.form.requestSubmit(); } catch { el.form.submit(); }
    }
  }
  return true;
}

function pageSelect(index, value) {
  const el = document.querySelector(`[data-sk-idx="${index}"]`);
  if (!el) return { __error: `Element ${index} is gone; take a new look at the page` };
  if (el.tagName === "SELECT") {
    const want = String(value).trim().toLowerCase();
    const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) ||
      [...el.options].find((o) => o.text.trim().toLowerCase().includes(want));
    if (!opt) return { __error: `No option "${value}"` };
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.text;
  }
  if (el.type === "checkbox" || el.type === "radio") {
    const want = /^(true|yes|on|checked|1)$/i.test(String(value));
    if (el.checked !== want) el.click();
    return el.checked;
  }
  return { __error: "That element is not a dropdown or checkbox" };
}

function pageScroll(dy) {
  window.scrollBy({ top: dy, behavior: "instant" });
  return Math.round(scrollY);
}

// Google Docs / Sheets / Slides draw on a canvas, so their text is not in the page. Ask the open file for
// its own plain-text export instead (same origin, your existing login; no API or extra permission).
async function pageDocText(maxLen) {
  const m = location.pathname.match(/\/(document|spreadsheets|presentation)\/d\/([\w-]+)/);
  if (!m || location.hostname !== "docs.google.com") return null;
  const kind = m[1], id = m[2];
  const gid = (location.hash.match(/gid=(\d+)/) || location.search.match(/gid=(\d+)/) || [])[1];
  const url =
    kind === "document" ? `/document/d/${id}/export?format=txt` :
    kind === "spreadsheets" ? `/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}` :
    `/presentation/d/${id}/export/txt`;
  try {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) return { __error: `Could not export this file (HTTP ${r.status})` };
    const t = (await r.text()).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    return { kind, title: document.title.replace(/ - Google (Docs|Sheets|Slides)$/, ""), text: t.slice(0, maxLen), truncated: t.length > maxLen };
  } catch (e) {
    return { __error: String((e && e.message) || e) };
  }
}

function pageRect(index) {
  const el = document.querySelector(`[data-sk-idx="${index}"]`);
  if (!el) return { __error: `Element ${index} is gone; take a new look at the page` };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  // Big areas (a document canvas): click near the top-left of the text, not the middle of the page.
  const big = r.height > innerHeight * 0.6;
  const x = big ? r.left + Math.min(r.width / 2, 200) : r.left + r.width / 2;
  const y = big ? Math.max(r.top, 0) + 120 : r.top + r.height / 2;
  return { x: Math.round(x), y: Math.round(y), tag: el.tagName, editable: el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable };
}

function pageSelectAll(index) {
  const el = document.querySelector(`[data-sk-idx="${index}"]`);
  if (!el) return false;
  if (el.select) { el.focus(); el.select(); return true; }
  if (el.isContentEditable) {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return true;
  }
  return false;
}

// ---- real input through chrome.debugger (attached only while a Northstar task runs) ----
const attached = new Set();
chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));

async function attachDbg(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
}
async function cdp(tabId, method, params = {}) {
  await attachDbg(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
async function detachAll() {
  for (const tabId of [...attached]) await chrome.debugger.detach({ tabId }).catch(() => {});
  attached.clear();
}

async function realClick(tabId, x, y) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

const KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 }, esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 }, delete: { key: "Delete", code: "Delete", vk: 46 },
  home: { key: "Home", code: "Home", vk: 36 }, end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 }, pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 }, arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 }, down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
};

/** "ctrl+End", "Enter", "shift+Tab", "ctrl+a" */
async function realKey(tabId, combo) {
  const parts = String(combo).split("+").map((p) => p.trim()).filter(Boolean);
  const keyName = parts.pop() || "";
  let mods = 0;
  for (const m of parts.map((p) => p.toLowerCase()))
    mods |= m === "alt" ? 1 : m === "ctrl" || m === "control" ? 2 : m === "meta" || m === "cmd" ? 4 : m === "shift" ? 8 : 0;
  let k = KEYS[keyName.toLowerCase()];
  if (!k && keyName.length === 1) {
    const up = keyName.toUpperCase();
    k = { key: keyName, code: /[A-Z]/.test(up) ? `Key${up}` : /[0-9]/.test(up) ? `Digit${up}` : "", vk: up.charCodeAt(0), text: mods & ~8 ? undefined : keyName };
  }
  if (!k) throw new Error(`Unknown key "${keyName}"`);
  const base = { modifiers: mods, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk };
  await cdp(tabId, "Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text } : {}) });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function realType(tabId, index, text, enter) {
  const r = await inPage(tabId, pageRect, [index]);
  await realClick(tabId, r.x, r.y);
  await sleep(60);
  if (r.editable) {
    // Replace what is there: select it all, then insert (Delete clears it when the new text is empty).
    if (!(await inPage(tabId, pageSelectAll, [index]))) await realKey(tabId, "ctrl+a");
    if (!text) await realKey(tabId, "Delete");
  }
  if (text) await cdp(tabId, "Input.insertText", { text });
  if (enter) await realKey(tabId, "Enter");
}

/** Real input when possible; the synthetic events if the debugger can't attach (e.g. DevTools is open on the tab). */
async function tryReal(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    if (!fallback) throw err;
    return fallback();
  }
}

// ---------------- commands ----------------

async function handle(cmd, a) {
  switch (cmd) {
    case "tabs.list":
      return (await chrome.tabs.query({})).filter((t) => isWeb(t.url)).map(tabInfo);
    case "tabs.active": {
      const windowId = await lastWindowId();
      const [t] = await chrome.tabs.query({ active: true, ...(windowId ? { windowId } : { lastFocusedWindow: true }) });
      return t ? tabInfo(t) : null;
    }
    case "tabs.open":
      return openTab(a.url, a.match);
    case "tabs.newBlank": {
      const windowId = await lastWindowId();
      const [active] = await chrome.tabs.query({ active: true, windowId });
      if (active && isBlank(active.url)) return tabInfo(active);
      const t = await chrome.tabs.create({ active: true, ...(windowId ? { windowId } : {}) });
      return tabInfo(t);
    }
    case "tabs.focus":
      return tabInfo(await focusTab(a.tabId));
    case "tabs.goto":
      await chrome.tabs.update(a.tabId, { url: a.url });
      return tabInfo(await waitLoad(a.tabId));
    case "tabs.get":
      return tabInfo(await chrome.tabs.get(a.tabId));
    case "tabs.waitLoad":
      return tabInfo(await waitLoad(a.tabId, a.timeoutMs));
    case "page.snapshot": {
      const snap = await inPage(a.tabId, pageSnapshot, [a.maxEls || 80]);
      // Google Docs/Sheets/Slides: the real content comes from the file's own text export.
      const doc = await inPage(a.tabId, pageDocText, [8000]).catch(() => null);
      if (doc && doc.text !== undefined) {
        snap.docText = true;
        snap.text = `[Google ${doc.kind} content${doc.truncated ? ", first part" : ""}]\n${doc.text}`;
      }
      return snap;
    }
    case "page.text": {
      const doc = await inPage(a.tabId, pageDocText, [a.maxLen || 20000]).catch(() => null);
      if (doc && doc.text !== undefined) return { title: doc.title, kind: doc.kind, text: doc.text, truncated: doc.truncated };
      const page = await inPage(a.tabId, (n) => ({ title: document.title, text: (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").trim().slice(0, n) }), [a.maxLen || 20000]);
      return { ...page, kind: "page" };
    }
    case "page.click":
      if (a.real === false) return inPage(a.tabId, pageClick, [a.index]);
      return tryReal(async () => {
        await inPage(a.tabId, (i) => { const el = document.querySelector(`[data-sk-idx="${i}"]`); if (el && el.tagName === "A") el.removeAttribute("target"); return true; }, [a.index]);
        const r = await inPage(a.tabId, pageRect, [a.index]);
        await realClick(a.tabId, r.x, r.y);
        return true;
      }, () => inPage(a.tabId, pageClick, [a.index]));
    case "page.type":
      if (a.real === false) return inPage(a.tabId, pageType, [a.index, String(a.text ?? ""), !!a.enter]);
      return tryReal(
        () => realType(a.tabId, a.index, String(a.text ?? ""), !!a.enter).then(() => true),
        () => inPage(a.tabId, pageType, [a.index, String(a.text ?? ""), !!a.enter]),
      );
    case "page.write":
      // Insert text wherever the cursor is (Google Docs and other editors). Real input only.
      await cdp(a.tabId, "Input.insertText", { text: String(a.text ?? "") });
      return true;
    case "page.key":
      await realKey(a.tabId, a.key);
      return true;
    case "ext.reload":
      // Lets Northstar pick up a new version of this extension without a trip to chrome://extensions.
      setTimeout(() => chrome.runtime.reload(), 200);
      return true;
    case "debugger.release":
      await detachAll();
      return true;
    case "page.select":
      return inPage(a.tabId, pageSelect, [a.index, String(a.value ?? "")]);
    case "page.scroll":
      return inPage(a.tabId, pageScroll, [a.dy || 700]);
    case "page.screenshot": {
      const t = await focusTab(a.tabId);
      await sleep(120);
      const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" });
      return dataUrl.replace(/^data:image\/\w+;base64,/, "");
    }
    default:
      throw new Error(`Unknown command ${cmd}`);
  }
}
