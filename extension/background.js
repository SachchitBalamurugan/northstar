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
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=option],[role=combobox],[role=textbox],[onclick]';
  const out = [];
  const clip = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= maxEls) break;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === "hidden" || cs.display === "none") continue;
    const tag = el.tagName.toLowerCase();
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
      role: el.getAttribute("role") || (el.isContentEditable ? "textbox" : ""),
      text: clip(txt, 80), label: clip(lab, 80),
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
    text: clip(document.body ? document.body.innerText : "", 3000),
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
    case "page.snapshot":
      return inPage(a.tabId, pageSnapshot, [a.maxEls || 80]);
    case "page.click":
      return inPage(a.tabId, pageClick, [a.index]);
    case "page.type":
      return inPage(a.tabId, pageType, [a.index, String(a.text ?? ""), !!a.enter]);
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
