// Electron main. The "Shell" sub-agent owns this file (tray, hotkeys, notifications).
import { app, BrowserWindow, shell, Tray, Menu, nativeImage, globalShortcut, ipcMain, Notification, screen } from "electron";
import { join } from "path";
import { deflateSync } from "zlib";

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

let hiding = false;
function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  hiding = false;
  if (win.isMinimized()) win.restore();
  const wasVisible = win.isVisible() && win.getOpacity() > 0.99;
  if (!wasVisible) { win.setOpacity(0); win.webContents.send("ns:pop-in"); }
  win.show();
  win.focus();
  if (!wasVisible) fadeWindow(win, 0, 1, 220);
}

function hideWindow() {
  const w = win;
  if (!w || w.isDestroyed() || !w.isVisible() || hiding) return;
  hiding = true;
  w.webContents.send("ns:pop-out");
  fadeWindow(w, w.getOpacity(), 0, 170, () => { if (hiding) { w.hide(); hiding = false; } });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 620,
    backgroundColor: "#000000",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#00000000", symbolColor: "#A5A5AD", height: 44 },
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: false },
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
    x: Math.round(wa.x + wa.width / 2 - BUBBLE / 2), y: wa.y + 10,
    frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: false },
  });
  bubble.setAlwaysOnTop(true, "screen-saver");
  bubble.setVisibleOnAllWorkspaces(true);
  const url = rendererUrl("#bubble");
  if (url) bubble.loadURL(url);
  else bubble.loadFile(join(__dirname, "../renderer/index.html"), { hash: "bubble" });
  bubble.on("closed", () => { bubble = null; });
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

// ---------- tray ----------
function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("Northstar");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Northstar", click: showWindow },
    { label: "Hand off a task", accelerator: "Ctrl+Space", click: () => send("ns:command-bar") },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showWindow);
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.on("ns:badge", (_e, n: unknown) => {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    tray?.setToolTip(count > 0 ? `Northstar · ${count} to approve` : "Northstar");
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
  });
  ipcMain.on("ns:bubble-click", () => toggleMain());
  ipcMain.on("ns:bubble-command", () => send("ns:command-bar"));
}

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.setAppUserModelId("com.northstar.app");

  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    win?.once("ready-to-show", () => win?.hide());
    win?.hide();
    createBubble();
    createTray();
    globalShortcut.register("Control+Space", () => send("ns:command-bar"));
    globalShortcut.register("Control+Shift+D", () => send("ns:draft"));
  });

  app.on("before-quit", () => { quitting = true; });
  app.on("activate", showWindow);
  // Keep running in the tray when all windows are closed.
  app.on("window-all-closed", () => { /* stay alive in tray */ });
  app.on("will-quit", () => { globalShortcut.unregisterAll(); });
}
