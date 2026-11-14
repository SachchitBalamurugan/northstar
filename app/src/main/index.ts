// Electron main. The "Shell" sub-agent owns this file (tray, hotkeys, notifications).
import { app, BrowserWindow, shell, Tray, Menu, nativeImage, globalShortcut, ipcMain, Notification, screen, systemPreferences } from "electron";
import { join } from "path";
import { readFileSync, writeFileSync } from "fs";
import { deflateSync } from "zlib";
import { execFileSync } from "child_process";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

// ---------- tiny PNG encoder (orange circle on transparent) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function circlePng(size: number, radiusFrac = 0.42, rgb: [number, number, number] = [0xe2, 0x6d, 0x45]): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2, cy = size / 2, r = size * radiusFrac;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      // 4x4 supersampling for smooth edges
      let cover = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const dx = x + (sx + 0.5) / 4 - cx, dy = y + (sy + 0.5) / 4 - cy;
        if (dx * dx + dy * dy <= r * r) cover++;
      }
      const o = row + 1 + x * 4;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
      raw[o + 3] = Math.round((cover / 16) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function trayIcon(): Electron.NativeImage {
  const img = nativeImage.createFromBuffer(circlePng(16), { scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, buffer: circlePng(32) });
  return img;
}
let overlayDot: Electron.NativeImage | null = null;
function badgeDot(): Electron.NativeImage {
  if (!overlayDot) overlayDot = nativeImage.createFromBuffer(circlePng(16, 0.45), { scaleFactor: 1 });
  return overlayDot;
}

// ---------- window ----------
// Smooth window opacity tween (Windows/macOS support setOpacity). Paired with a renderer scale animation.
let fadeTimer: NodeJS.Timeout | null = null;
function fadeWindow(w: BrowserWindow, from: number, to: number, ms: number, done?: () => void) {
  if (fadeTimer) clearInterval(fadeTimer);
  const start = Date.now();
  w.setOpacity(from);
  fadeTimer = setInterval(() => {
    if (w.isDestroyed()) { clearInterval(fadeTimer!); fadeTimer = null; return; }
    const t = Math.min(1, (Date.now() - start) / ms);
    const e = to > from ? 1 - Math.pow(1 - t, 3) : t * t * t; // easeOutCubic in, easeInCubic out
    w.setOpacity(from + (to - from) * e);
    if (t >= 1) { clearInterval(fadeTimer!); fadeTimer = null; done?.(); }
  }, 8);
}

// Zoom origin = the floating orb's center, in main-window coordinates (so the window grows out of / shrinks into the orb).
function orbOrigin() {
  if (!win || !bubble || bubble.isDestroyed()) return { x: 0, y: 0 };
  const w = win.getBounds(), b = bubble.getBounds();
  return { x: b.x + b.width / 2 - w.x, y: b.y + b.height / 2 - w.y };
}

let hiding = false;
let hideTimer: NodeJS.Timeout | null = null;
function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  hiding = false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.webContents.send("ns:pop-in", orbOrigin());
  win.show();
  win.focus();
}

function finishHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (hiding && win && !win.isDestroyed()) win.hide();
  hiding = false;
}

function hideWindow() {
  const w = win;
  if (!w || w.isDestroyed() || !w.isVisible() || hiding) return;
  hiding = true;
  w.webContents.send("ns:pop-out", orbOrigin());
  hideTimer = setTimeout(finishHide, 450); // fallback if the renderer never reports back
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 620,
    // Transparent + frameless so the UI can zoom out of the orb with the desktop visible around it.
    frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false, show: false,
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: false, backgroundThrottling: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { openSafe(url); return { action: "deny" }; });
  win.on("close", (e) => {
    if (!quitting) { e.preventDefault(); hideWindow(); }
  });
  win.on("closed", () => { win = null; });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, "../renderer/index.html"));
}

// ---------- floating bubble (Clicky-style: lives at the top of the screen, drag to move, click to open) ----------
let bubble: BrowserWindow | null = null;
const BUBBLE = 88;

function rendererUrl(hash = "") {
  return process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL + hash : null;
}

function createBubble() {
  const wa = screen.getPrimaryDisplay().workArea;
  bubble = new BrowserWindow({
    width: BUBBLE, height: BUBBLE,
    // Clear of the camera notch even when it is expanded (half its width + margin).
    x: Math.round(wa.x + wa.width / 2 + NOTCH_EXPANDED.width / 2 + 24), y: wa.y + 8,
    frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: false, backgroundThrottling: false },
  });
  bubble.setAlwaysOnTop(true, "screen-saver");
  bubble.setVisibleOnAllWorkspaces(true);
  const url = rendererUrl("#bubble");
  if (url) bubble.loadURL(url);
  else bubble.loadFile(join(__dirname, "../renderer/index.html"), { hash: "bubble" });
  bubble.on("closed", () => { bubble = null; });
}

// ---------- camera notch (Dynamic Island-style strip at the very top-center, under the webcam) ----------
let notch: BrowserWindow | null = null;
let notchExpanded = false;
let notchEnabled = true;
// Touch to open: the widget watches the camera and opens when it goes dark (a finger over the lens). Tray switch.
let touchEnabled = true;
const NOTCH_COLLAPSED = { width: 220, height: 10 };
const NOTCH_EXPANDED = { width: 460, height: 340 };

// On a MacBook with a camera housing the widget lives in the real notch: collapsed it sits exactly behind the
// hardware cutout (invisible, hover to open), expanded it grows down out of it. Everywhere else it draws its own pill.
interface HwNotch { x: number; y: number; width: number; height: number } // screen coordinates
let hwNotch: HwNotch | null = null;
// AppKit reports the menu-bar strips left and right of the cutout; the gap between them is the notch.
const NOTCH_JXA = 'ObjC.import("AppKit");var o=[],ss=$.NSScreen.screens;for(var i=0;i<ss.count;i++){var s=ss.objectAtIndex(i),f=s.frame,' +
  'l=s.auxiliaryTopLeftArea,r=s.auxiliaryTopRightArea;o.push({w:f.size.width,h:f.size.height,lw:l.size.width,lh:l.size.height,' +
  'rx:r.origin.x-f.origin.x,rw:r.size.width})}JSON.stringify(o)';

function readHwNotch(): HwNotch | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", NOTCH_JXA], { encoding: "utf8", timeout: 3000 });
    const screens = JSON.parse(out) as { w: number; h: number; lw: number; lh: number; rx: number; rw: number }[];
    const s = screens.find((v) => v.lw > 0 && v.rw > 0 && v.rx > v.lw); // screens without a cutout report empty strips
    if (!s) return null;
    const sameSize = (d: Electron.Display) => d.bounds.width === Math.round(s.w) && d.bounds.height === Math.round(s.h);
    const displays = screen.getAllDisplays();
    const d = displays.find((v) => v.internal && sameSize(v)) ?? displays.find(sameSize);
    if (!d) return null;
    return { x: d.bounds.x + Math.round(s.lw), y: d.bounds.y, width: Math.round(s.rx - s.lw), height: Math.round(s.lh) };
  } catch { return null; }
}

/** What the notch renderer needs to draw itself: the collapsed size, and whether it is hiding behind real hardware. */
function notchGeometry() {
  return {
    hardware: !!hwNotch, width: hwNotch?.width ?? NOTCH_COLLAPSED.width, height: hwNotch?.height ?? NOTCH_COLLAPSED.height,
    touch: touchEnabled && notchEnabled, // the camera only runs while the widget is on
  };
}
function sendNotchGeometry() {
  if (notch && !notch.isDestroyed()) notch.webContents.send("ns:notch-geometry", notchGeometry());
}

/** macOS asks the user once (the prompt names the app Northstar was started from); later calls just report the answer. */
async function cameraAccess(): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("camera");
  if (status === "granted") return true;
  if (status !== "not-determined") return false;
  try { return await systemPreferences.askForMediaAccess("camera"); } catch { return false; }
}

function notchBounds(expanded: boolean) {
  if (hwNotch) {
    if (!expanded) return { ...hwNotch };
    // The panel hangs from the top edge, centered on the cutout, with the cutout's height added on top of the content.
    const width = NOTCH_EXPANDED.width, height = NOTCH_EXPANDED.height + hwNotch.height;
    return { x: Math.round(hwNotch.x + hwNotch.width / 2 - width / 2), y: hwNotch.y, width, height };
  }
  const d = screen.getPrimaryDisplay();
  const s = expanded ? NOTCH_EXPANDED : NOTCH_COLLAPSED;
  return { x: Math.round(d.workArea.x + d.workArea.width / 2 - s.width / 2), y: d.bounds.y, width: s.width, height: s.height };
}

function createNotch() {
  notchExpanded = false;
  hwNotch = readHwNotch();
  const mac = process.platform === "darwin";
  notch = new BrowserWindow({
    ...notchBounds(false), show: false,
    // macOS: allow the window over the menu bar (y = 0), and make it a panel so opening it on hover
    // takes keyboard focus for the hand-off box without pulling the user out of the app they are in.
    ...(mac ? { enableLargerThanScreen: true, type: "panel" } : {}),
    frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: true,
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: false, backgroundThrottling: false },
  });
  notch.setAlwaysOnTop(true, "screen-saver");
  notch.setVisibleOnAllWorkspaces(true);
  notch.setIgnoreMouseEvents(false);
  if (mac) notch.setBounds(notchBounds(false)); // the constructor clamps y below the menu bar; setBounds does not
  notch.webContents.setWindowOpenHandler(({ url }) => { openSafe(url); return { action: "deny" }; });
  notch.once("ready-to-show", () => { if (notch && !notch.isDestroyed() && notchEnabled) notch.showInactive(); });
  const url = rendererUrl("#notch");
  if (url) notch.loadURL(url);
  else notch.loadFile(join(__dirname, "../renderer/index.html"), { hash: "notch" });
  notch.on("closed", () => { notch = null; });
}

// Safety net: if the notch is expanded but the cursor has left it for ~1.2s, shrink the window back to the thin
// strip. Otherwise an invisible 460x340 window can sit over the top of the screen (and over the orb).
let notchWatch: NodeJS.Timeout | null = null;
function watchNotchHover() {
  if (notchWatch) clearInterval(notchWatch);
  let outside = 0;
  notchWatch = setInterval(() => {
    if (!notch || notch.isDestroyed() || !notchExpanded) { if (notchWatch) clearInterval(notchWatch); notchWatch = null; return; }
    const p = screen.getCursorScreenPoint(), b = notch.getBounds();
    const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    outside = inside ? 0 : outside + 1;
    if (outside >= 4) { notch.webContents.send("ns:notch-force-collapse"); setNotchExpanded(false); }
  }, 300);
}

function setNotchExpanded(expanded: boolean) {
  if (!notch || notch.isDestroyed()) return;
  notchExpanded = expanded;
  notch.setBounds(notchBounds(expanded));
  if (expanded) { notch.focus(); watchNotchHover(); }
}

function setNotchEnabled(on: boolean) {
  notchEnabled = on;
  if (on) {
    if (!notch || notch.isDestroyed()) createNotch();
    else { setNotchExpanded(false); notch.showInactive(); }
  } else if (notch && !notch.isDestroyed()) notch.hide();
  sendNotchGeometry();
}

// ---------- Ask window (small text window anchored under the bubble) ----------
let ask: BrowserWindow | null = null;
const ASK_W = 520, ASK_MIN_H = 60, ASK_MAX_H = 520;
let askH = 76;
const MAIN_SCREENS = ["dashboard", "now", "activity", "approve", "inbox", "knowledge"];

function placeAsk() {
  if (!ask || ask.isDestroyed()) return;
  const b = bubble && !bubble.isDestroyed() ? bubble.getBounds() : null;
  const wa = (b ? screen.getDisplayMatching(b) : screen.getPrimaryDisplay()).workArea;
  const anchor = b ?? { x: wa.x + wa.width / 2 - BUBBLE / 2, y: wa.y + 10, width: BUBBLE, height: BUBBLE };
  let x = Math.round(anchor.x + anchor.width / 2 - ASK_W / 2);
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - ASK_W - 8));
  let y = anchor.y + anchor.height - 6;
  // Not enough room below the bubble: sit above it instead (and grow upward).
  if (y + ASK_MAX_H > wa.y + wa.height - 8) y = anchor.y - askH + 6;
  y = Math.max(wa.y + 8, y);
  ask.setBounds({ x, y: Math.round(y), width: ASK_W, height: askH });
}

function createAsk() {
  ask = new BrowserWindow({
    width: ASK_W, height: askH, show: false,
    frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: true,
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: false, backgroundThrottling: false },
  });
  ask.setAlwaysOnTop(true, "floating"); // above normal windows, below the bubble, still takes keyboard focus
  ask.setVisibleOnAllWorkspaces(true);
  ask.webContents.setWindowOpenHandler(({ url }) => { openSafe(url); return { action: "deny" }; });
  const url = rendererUrl("#ask");
  if (url) ask.loadURL(url);
  else ask.loadFile(join(__dirname, "../renderer/index.html"), { hash: "ask" });
  // Losing focus hides it, unless the click went to the bubble (its own click toggles) or a task is running
  // (the renderer decides: it only hides when idle).
  ask.on("blur", () => {
    setTimeout(() => {
      if (!ask || ask.isDestroyed() || !ask.isVisible()) return;
      if (bubble && !bubble.isDestroyed() && bubble.isFocused()) return;
      ask.webContents.send("ns:ask-blur");
    }, 80);
  });
  ask.on("closed", () => { ask = null; });
}

function showAsk() {
  if (!ask || ask.isDestroyed()) createAsk();
  const a = ask!;
  const reveal = () => { if (a.isDestroyed()) return; placeAsk(); a.show(); a.focus(); a.webContents.send("ns:ask-shown"); };
  if (a.webContents.isLoading()) a.webContents.once("did-finish-load", reveal);
  else reveal();
}
function hideAsk() { if (ask && !ask.isDestroyed() && ask.isVisible()) ask.hide(); }
function toggleAsk() {
  if (ask && !ask.isDestroyed() && ask.isVisible()) hideAsk();
  else showAsk();
}

/** Maximize: show the main window and tell its renderer which screen to land on. */
function openMain(name: unknown) {
  const target = MAIN_SCREENS.includes(String(name)) ? String(name) : "activity";
  hideAsk();
  showWindow();
  const w = win;
  if (!w) return;
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", () => w.webContents.send("ns:navigate", target));
  else w.webContents.send("ns:navigate", target);
}

function toggleMain() {
  if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && !hiding) hideWindow();
  else showWindow();
}

function send(channel: string) {
  showWindow();
  const w = win;
  if (!w) return;
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", () => w.webContents.send(channel));
  else w.webContents.send(channel);
}

function openSafe(url: unknown) {
  if (typeof url !== "string") return;
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") shell.openExternal(url);
  } catch { /* ignore invalid urls */ }
}

// ---------- follow-up notifications (inbox :7702) ----------
const INBOX = "http://127.0.0.1:7702";
interface Notice { id: string; kind: string; title: string; body: string; proposalId?: string; createdAt: string; read: boolean }
let shownIds: Set<string> | null = null;
let unreadCount = 0;
let pendingApprove = 0;
function shownFile() { return join(app.getPath("userData"), "shown-notices.json"); }
function loadShown(): Set<string> {
  if (shownIds) return shownIds;
  try { const a = JSON.parse(readFileSync(shownFile(), "utf8")); shownIds = new Set(Array.isArray(a) ? a.map(String) : []); }
  catch { shownIds = new Set(); }
  return shownIds;
}
function saveShown() {
  try { writeFileSync(shownFile(), JSON.stringify([...loadShown()].slice(-500))); } catch { /* ignore */ }
}
async function inboxFetch(path: string, method = "GET"): Promise<unknown> {
  const res = await fetch(INBOX + path, { method, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}
function updateTooltip() {
  if (!tray) return;
  const parts: string[] = [];
  if (pendingApprove > 0) parts.push(`${pendingApprove} to approve`);
  if (unreadCount > 0) parts.push(`${unreadCount} follow-up${unreadCount === 1 ? "" : "s"}`);
  tray.setToolTip(parts.length ? `Northstar · ${parts.join(" · ")}` : "Northstar");
}
async function pollNotices() {
  try {
    const list = await inboxFetch("/notifications?unread=1");
    if (!Array.isArray(list)) return;
    const notices = list as Notice[];
    unreadCount = notices.length;
    updateTooltip();
    const shown = loadShown();
    let changed = false;
    for (const n of notices) {
      if (!n?.id || shown.has(n.id)) continue;
      shown.add(n.id); changed = true;
      if (!Notification.isSupported()) continue;
      const toast = new Notification({
        title: String(n.title ?? "Northstar"),
        body: String(n.body ?? "") + (n.proposalId ? " · Draft ready to review" : ""),
        silent: false,
      });
      toast.on("click", () => {
        openMain("approve");
        inboxFetch(`/notifications/${encodeURIComponent(n.id)}/read`, "POST").catch(() => {});
      });
      toast.show();
    }
    if (changed) saveShown();
  } catch { /* inbox service down: stay quiet */ }
}
async function scanFollowups() {
  try { await inboxFetch("/followups/scan", "POST"); } catch { /* ignore */ }
  await pollNotices();
}
function startNoticePoller() {
  setTimeout(() => { pollNotices(); setInterval(pollNotices, 30000); }, 10000);
}

// ---------- tray ----------
function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("Northstar");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Northstar", click: showWindow },
    { label: "Hand off a task", accelerator: "Ctrl+Space", click: () => send("ns:command-bar") },
    { label: "Camera notch widget", type: "checkbox", checked: notchEnabled, click: (item) => setNotchEnabled(item.checked) },
    { label: "Check for follow-ups now", click: () => { scanFollowups(); } },
    { label: "Touch the camera to open it", type: "checkbox", checked: touchEnabled, click: (item) => { touchEnabled = item.checked; sendNotchGeometry(); } },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showWindow);
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.on("ns:badge", (_e, n: unknown) => {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    pendingApprove = count;
    updateTooltip();
    if (process.platform === "win32" && win && !win.isDestroyed()) {
      win.setOverlayIcon(count > 0 ? badgeDot() : null, `${count} pending`);
    }
  });
  ipcMain.on("ns:notify", (_e, payload: { title?: string; body?: string } | undefined) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: String(payload?.title ?? "Northstar"), body: String(payload?.body ?? "") });
    n.on("click", showWindow);
    n.show();
  });
  ipcMain.on("ns:open", (_e, url: unknown) => openSafe(url));
  ipcMain.on("ns:bubble-move", (_e, x: unknown, y: unknown) => {
    if (!bubble || bubble.isDestroyed()) return;
    const nx = Math.round(Number(x)), ny = Math.round(Number(y));
    if (Number.isFinite(nx) && Number.isFinite(ny)) bubble.setBounds({ x: nx, y: ny, width: BUBBLE, height: BUBBLE });
    if (ask && !ask.isDestroyed() && ask.isVisible()) placeAsk(); // the Ask window follows the bubble
  });
  ipcMain.on("ns:bubble-click", () => toggleAsk());
  ipcMain.on("ns:ask-toggle", () => toggleAsk());
  ipcMain.on("ns:ask-hide", () => hideAsk());
  ipcMain.on("ns:ask-show", (_e, title: unknown) => {
    const wasHidden = !ask || ask.isDestroyed() || !ask.isVisible();
    showAsk();
    if (wasHidden && Notification.isSupported())
      new Notification({ title: "Northstar needs your OK", body: typeof title === "string" && title ? title.slice(0, 120) : "A task is waiting for you.", silent: false }).show();
  });
  ipcMain.on("ns:ask-resize", (_e, h: unknown) => {
    const n = Math.round(Number(h));
    if (!Number.isFinite(n)) return;
    askH = Math.max(ASK_MIN_H, Math.min(ASK_MAX_H, n));
    if (ask && !ask.isDestroyed()) placeAsk();
  });
  ipcMain.on("ns:open-main", (_e, name: unknown) => openMain(name));
  ipcMain.on("ns:popped-out", () => finishHide());
  ipcMain.on("ns:win-close", () => hideWindow());
  ipcMain.on("ns:win-min", () => hideWindow());
  ipcMain.on("ns:win-max", () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
  ipcMain.on("ns:bubble-command", () => showAsk());
  ipcMain.on("ns:notch-geometry", (e) => { e.returnValue = notchGeometry(); });
  ipcMain.handle("ns:camera-access", () => cameraAccess());
  ipcMain.on("ns:notch-expand", () => setNotchExpanded(true));
  ipcMain.on("ns:notch-collapse", () => setNotchExpanded(false));
  ipcMain.on("ns:notch-open-main", (_e, name: unknown) => { setNotchExpanded(false); openMain(name); });
}

// ---------- lifecycle ----------
// Dev only: NS_DEBUG_PORT=9333 exposes the renderers on 127.0.0.1 for inspection.
if (process.env.NS_DEBUG_PORT) { app.commandLine.appendSwitch("remote-debugging-port", process.env.NS_DEBUG_PORT); app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1"); }

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.setAppUserModelId("com.northstar.app");

  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    createBubble();
    createNotch();
    createTray();
    startNoticePoller();
    // Resolution change, lid closed, external display plugged in: the cutout may have moved or gone.
    const refreshNotch = () => {
      hwNotch = readHwNotch();
      if (!notch || notch.isDestroyed()) return;
      notch.setBounds(notchBounds(notchExpanded));
      sendNotchGeometry();
    };
    screen.on("display-metrics-changed", refreshNotch);
    screen.on("display-added", refreshNotch);
    screen.on("display-removed", refreshNotch);
    globalShortcut.register("Control+Space", () => toggleAsk());
    globalShortcut.register("Control+Shift+D", () => send("ns:draft"));
  });

  app.on("before-quit", () => { quitting = true; });
  app.on("activate", showWindow);
  // Keep running in the tray when all windows are closed.
  app.on("window-all-closed", () => { /* stay alive in tray */ });
  app.on("will-quit", () => { globalShortcut.unregisterAll(); });
}
