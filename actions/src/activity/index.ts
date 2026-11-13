// Computer activity, strictly opt-in: while the user has switched it on, Northstar notices WHICH app, site and
// document is in front (never the contents, never keystrokes, never screenshots) and tells memory in short
// summaries, so the dashboard, resume-work prompts and Discover reflect what the student actually works on.
//   GET  /activity            → ActivityStatus
//   POST /activity/enable     {enabled: boolean} → ActivityStatus
// Off by default. Only the site's host name is kept (no paths or queries). Private windows, password managers and
// anything that looks like banking, health or sign-in pages are skipped entirely.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { DATA_DIR, MOCK } from "../config.js";
import { postEvent } from "../memory.js";

const FILE = path.join(DATA_DIR, "activity.json");
const SAMPLE_MS = Number(process.env.ACTIVITY_SAMPLE_MS ?? 20_000);
const FLUSH_MS = Number(process.env.ACTIVITY_FLUSH_MS ?? 10 * 60_000);
const IDLE_SECONDS = 120;

export interface Sample { app: string; title?: string; host?: string }
export interface ActivityItem { label: string; detail?: string; minutes: number; kind: "app" | "site" | "document" }
interface Bucket { label: string; detail?: string; seconds: number; kind: ActivityItem["kind"] }
interface State { enabled: boolean; since?: string; days: Record<string, Record<string, Bucket>> }

const BROWSERS: Record<string, "chromium" | "safari"> = {
  "Google Chrome": "chromium", "Brave Browser": "chromium", "Microsoft Edge": "chromium", Arc: "chromium", Chromium: "chromium", Safari: "safari",
};
const SKIP_APPS = /^(1Password|Bitwarden|LastPass|Dashlane|Keychain Access|Passwords|loginwindow|ScreenSaverEngine|System Settings|System Preferences)/i;
const SENSITIVE = /(incognito|private brows|inprivate|password|passcode|sign ?in|log ?in|two-factor|verification code|bank|chase|wells fargo|paypal|venmo|credit card|billing|payment|checkout|ssn|social security|health|patient|medical|therapy|pharmacy|porn|xxx)/i;
const SENSITIVE_HOST = /(^|\.)(accounts\.google\.com|login\.|auth\.|signin\.|.*bank.*|paypal\.com|venmo\.com|chase\.com|mychart\.|.*health.*|.*pharmacy.*)$/i;

const run = (cmd: string, args: string[], timeout = 4000): Promise<string> =>
  new Promise((resolve) => execFile(cmd, args, { timeout, encoding: "utf8" }, (err, out) => resolve(err ? "" : String(out).trim())));

let titleBlockedUntil = 0; // macOS Accessibility not granted: stop asking for window titles for a while

async function sampleMac(): Promise<Sample | null> {
  const idle = /"HIDIdleTime"\s*=\s*(\d+)/.exec(await run("ioreg", ["-c", "IOHIDSystem", "-d", "4"]));
  if (idle && Number(idle[1]) / 1e9 > IDLE_SECONDS) return null;
  const front = await run("lsappinfo", ["front"]);
  if (!front) return null;
  const info = await run("lsappinfo", ["info", "-only", "name", front]);
  const app = /"(?:LSDisplayName|name)"\s*=\s*"([^"]+)"/.exec(info)?.[1];
  if (!app) return null;
  const kind = BROWSERS[app];
  if (kind) {
    const script = kind === "safari"
      ? `tell application "Safari" to if (count of windows) > 0 then return (URL of current tab of front window) & "\\n" & (name of current tab of front window)`
      : `tell application "${app}"\nif (count of windows) is 0 then return ""\nif mode of front window is "incognito" then return "PRIVATE"\nreturn (URL of active tab of front window) & "\\n" & (title of active tab of front window)\nend tell`;
    const out = await run("osascript", ["-e", script]);
    if (out === "PRIVATE") return null;
    const [url, title] = out.split("\n");
    let host: string | undefined;
    try { host = url ? new URL(url).hostname.replace(/^www\./, "") : undefined; } catch { /* not a URL */ }
    return { app, host, title: title || undefined };
  }
  let title: string | undefined;
  if (Date.now() > titleBlockedUntil) {
    title = await run("osascript", ["-e", `tell application "System Events" to get name of front window of (first application process whose frontmost is true)`]) || undefined;
    if (!title) titleBlockedUntil = Date.now() + 10 * 60_000;
  }
  return { app, title };
}

const WIN_PS = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class NSWin { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }
"@
$h=[NSWin]::GetForegroundWindow(); $sb=New-Object System.Text.StringBuilder 512; [void][NSWin]::GetWindowText($h,$sb,512)
$procId=0; [void][NSWin]::GetWindowThreadProcessId($h,[ref]$procId); $p=Get-Process -Id $procId -ErrorAction SilentlyContinue
Write-Output ($p.ProcessName + "|" + $sb.ToString())`;

async function sampleWindows(): Promise<Sample | null> {
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_PS], 8000);
  const i = out.indexOf("|");
  if (i <= 0) return null;
  const app = out.slice(0, i), title = out.slice(i + 1) || undefined;
  return { app, title };
}

/** Drop anything private; keep the host and a short title only. Exported for the smoke checks. */
export function sanitize(s: Sample | null): Sample | null {
  if (!s || SKIP_APPS.test(s.app)) return null;
  if (s.host && SENSITIVE_HOST.test(s.host)) return null;
  if (s.title && SENSITIVE.test(s.title)) return null;
  const title = s.title?.replace(/\s+/g, " ").replace(/\s[-–—|]\s(Google Chrome|Brave|Microsoft.? Edge|Safari|Arc|Mozilla Firefox)$/i, "").trim().slice(0, 80);
  return { app: s.app, ...(s.host ? { host: s.host } : {}), ...(title ? { title } : {}) };
}

const supported = () => !MOCK && process.env.DESKTOP_CONTROL !== "0" && (process.platform === "darwin" || process.platform === "win32");
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function load(): State {
  try { return { enabled: false, days: {}, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { return { enabled: false, days: {} }; }
}
let state = load();
const save = () => {
  const keep = Object.keys(state.days).sort().slice(-7); // one week is plenty
  state.days = Object.fromEntries(keep.map((k) => [k, state.days[k]]));
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(state)); } catch { /* best effort */ }
};

let timer: NodeJS.Timeout | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let pending: Record<string, Bucket> = {}; // since the last summary sent to memory
let pendingFrom = Date.now();
let lastSeen: { label: string; at: string } | undefined;

/** Add one sample's worth of time. Exported for the smoke checks. */
export function record(s: Sample, seconds = SAMPLE_MS / 1000, at = new Date()): void {
  const kind: Bucket["kind"] = s.host ? "site" : s.title ? "document" : "app";
  const label = s.host ?? s.app;
  const key = `${kind}:${label}`;
  for (const store of [(state.days[dayKey(at)] ??= {}), pending]) {
    const b = (store[key] ??= { label, kind, seconds: 0 });
    b.seconds += seconds;
    if (s.title) b.detail = s.title;
  }
  lastSeen = { label: s.title ? `${label}: ${s.title}` : label, at: at.toISOString() };
}

const top = (buckets: Record<string, Bucket>, n: number): ActivityItem[] =>
  Object.values(buckets).filter((b) => b.seconds >= 60).sort((a, b) => b.seconds - a.seconds).slice(0, n)
    .map((b) => ({ label: b.label, ...(b.detail ? { detail: b.detail } : {}), minutes: Math.round(b.seconds / 60), kind: b.kind }));

/** Tell memory what the last stretch was spent on, in one plain sentence. */
export async function flush(now = new Date()): Promise<string | null> {
  const items = top(pending, 4);
  const from = new Date(pendingFrom);
  pending = {}; pendingFrom = now.getTime();
  save();
  if (!items.length) return null;
  const t = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const text = `Computer use ${t(from)}–${t(now)}: ` + items.map((i) => `${i.minutes} min ${i.kind === "site" ? "on" : "in"} ${i.label}${i.detail ? ` ("${i.detail}")` : ""}`).join(", ");
  await postEvent({ source: "screen", kind: "observation", text, tags: ["activity", ...items.map((i) => `${i.kind}:${i.label.toLowerCase()}`)] });
  return text;
}

async function tick() {
  const raw = process.platform === "darwin" ? await sampleMac() : process.platform === "win32" ? await sampleWindows() : null;
  const s = sanitize(raw);
  if (s) record(s);
}

function start() {
  if (timer || !supported()) return;
  pending = {}; pendingFrom = Date.now();
  timer = setInterval(() => void tick().catch(() => {}), SAMPLE_MS);
  flushTimer = setInterval(() => void flush().catch(() => {}), FLUSH_MS);
  timer.unref?.(); flushTimer.unref?.();
  void tick().catch(() => {});
}
async function stop() {
  if (timer) clearInterval(timer);
  if (flushTimer) clearInterval(flushTimer);
  timer = flushTimer = null;
  await flush().catch(() => {});
}

function status() {
  const today = state.days[dayKey()] ?? {};
  const note = !supported()
    ? MOCK ? "Off in demo mode." : "Not available on this computer."
    : process.platform === "darwin"
      ? "macOS may ask once to let Northstar see which browser tab is open. Window names of other apps need Accessibility access; without it only the app name is noted."
      : undefined;
  return {
    enabled: state.enabled, supported: supported(), running: timer !== null, ...(note ? { note } : {}),
    ...(state.since ? { since: state.since } : {}),
    todayMinutes: Math.round(Object.values(today).reduce((n, b) => n + b.seconds, 0) / 60),
    today: top(today, 5), ...(lastSeen ? { lastSeen } : {}),
  };
}

export default async function activityRoutes(app: FastifyInstance) {
  if (state.enabled) start();
  app.addHook("onClose", async () => { await stop(); });

  app.get("/activity", async () => status());
  app.post<{ Body: { enabled?: unknown } | null }>("/activity/enable", async (req, reply) => {
    if (typeof req.body?.enabled !== "boolean") return reply.code(400).send({ error: "body must be { enabled: true | false }" });
    state.enabled = req.body.enabled;
    if (state.enabled) { state.since = new Date().toISOString(); start(); } else { await stop(); }
    save();
    return status();
  });
  // Forget everything noticed so far (the switch itself stays as it is).
  app.delete("/activity", async () => { state.days = {}; pending = {}; lastSeen = undefined; save(); return status(); });
}
