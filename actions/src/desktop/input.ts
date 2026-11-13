// Synthetic mouse / keyboard input for desktop control (nut-js; macOS and Windows).
// All coordinates here are REAL input coordinates (see ScreenCapture.scaleX/scaleY).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadNut } from "./nut.js";

const run = promisify(execFile);
const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

export interface Point {
  x: number;
  y: number;
}
export type MouseButton = "left" | "right" | "middle";

export async function mousePosition(): Promise<Point> {
  const nut = await loadNut();
  const p = await nut.mouse.getPosition();
  return { x: p.x, y: p.y };
}

export async function moveMouse(x: number, y: number): Promise<void> {
  const nut = await loadNut();
  await nut.mouse.setPosition(new nut.Point(Math.round(x), Math.round(y)));
}

export async function click(x: number, y: number, button: MouseButton = "left", double = false): Promise<void> {
  const nut = await loadNut();
  await moveMouse(x, y);
  await new Promise((r) => setTimeout(r, 60));
  const b = button === "right" ? nut.Button.RIGHT : button === "middle" ? nut.Button.MIDDLE : nut.Button.LEFT;
  if (double) await nut.mouse.doubleClick(b);
  else await nut.mouse.click(b);
}

export async function typeText(text: string): Promise<void> {
  const nut = await loadNut();
  await nut.keyboard.type(text);
}

const ALIASES: Record<string, string> = {
  cmd: "LeftCmd", command: "LeftCmd", meta: "LeftCmd", super: "LeftSuper", win: "LeftWin", windows: "LeftWin",
  ctrl: "LeftControl", control: "LeftControl", alt: "LeftAlt", option: "LeftAlt", opt: "LeftAlt", shift: "LeftShift",
  enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", space: "Space", spacebar: "Space",
  backspace: "Backspace", delete: "Delete", del: "Delete", up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", pgup: "PageUp", pgdn: "PageDown",
  ",": "Comma", ".": "Period", "/": "Slash", "-": "Minus", "=": "Equal", ";": "Semicolon", "'": "Quote",
  "[": "LeftBracket", "]": "RightBracket", "\\": "Backslash", "`": "Grave",
};
const MODIFIERS = new Set(["cmd", "command", "meta", "super", "win", "windows", "ctrl", "control", "alt", "option", "opt", "shift"]);

/** "Cmd + Shift+S" → ["cmd","shift","s"]. */
export function parseCombo(combo: string): string[] {
  return combo.toLowerCase().replace(/\s+/g, "").replace(/\+\+/g, "+plus").split("+").filter(Boolean);
}

/**
 * Maps the primary shortcut modifier to the platform: on Windows "cmd" becomes "ctrl";
 * on macOS "ctrl+<letter>" (the Windows spelling of a common shortcut) becomes "cmd+<letter>".
 */
export function platformCombo(parts: string[], platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return parts.map((p) => (p === "cmd" || p === "command" || p === "meta" ? "ctrl" : p));
  if (platform === "darwin") {
    const hasCmd = parts.some((p) => p === "cmd" || p === "command" || p === "meta");
    const main = parts.filter((p) => !MODIFIERS.has(p));
    if (!hasCmd && main.length === 1 && /^[a-z]$/.test(main[0])) return parts.map((p) => (p === "ctrl" || p === "control" ? "cmd" : p));
  }
  return parts;
}

/** Presses a combo such as "cmd+a", "enter", "ctrl+c". */
export async function pressKeys(combo: string): Promise<void> {
  const nut = await loadNut();
  const keys = platformCombo(parseCombo(combo)).map((part) => {
    const name =
      ALIASES[part] ??
      (/^[a-z]$/.test(part) ? part.toUpperCase() : /^[0-9]$/.test(part) ? `Num${part}` : /^f([1-9]|1[0-9]|2[0-4])$/.test(part) ? part.toUpperCase() : "");
    const key = name ? (nut.Key as unknown as Record<string, number>)[name] : undefined;
    if (key === undefined) throw new Error(`unknown key "${part}" in "${combo}"`);
    return key;
  });
  if (!keys.length) throw new Error(`empty key combo "${combo}"`);
  await nut.keyboard.pressKey(...keys);
  await nut.keyboard.releaseKey(...keys.slice().reverse());
}

/** Scrolls the wheel: positive dy scrolls down, negative up. */
export async function scroll(dy: number): Promise<void> {
  const nut = await loadNut();
  const n = Math.min(2000, Math.abs(Math.round(dy)));
  if (!n) return;
  if (dy > 0) await nut.mouse.scrollDown(n);
  else await nut.mouse.scrollUp(n);
}

const APP_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._+&()'-]{0,59}$/u;

/** Opens an application by name. No shell interpolation; names with path or shell characters are refused. */
export async function openApp(name: string): Promise<void> {
  const app = name.trim();
  if (!APP_NAME_RE.test(app)) throw new Error(`"${name.slice(0, 40)}" is not a plain application name`);
  if (IS_MAC) await run("open", ["-a", app], { timeout: 15_000 });
  else if (IS_WIN) await run("cmd.exe", ["/d", "/s", "/c", "start", "", app], { timeout: 15_000, windowsHide: true });
  else throw new Error(`opening apps is not supported on ${process.platform}`);
}

/**
 * Best-effort name of the app that really is frontmost (not what the model says it sees).
 * macOS: lsappinfo (needs no permission). Elsewhere: the active window title. "" when unknown.
 */
export async function frontmostApp(): Promise<string> {
  try {
    if (IS_MAC) {
      const { stdout: asn } = await run("lsappinfo", ["front"], { timeout: 3000 });
      const { stdout } = await run("lsappinfo", ["info", "-only", "name", asn.trim()], { timeout: 3000 });
      return /"LSDisplayName"="([^"]*)"/.exec(stdout)?.[1] ?? "";
    }
    const nut = await loadNut();
    return (await (await nut.getActiveWindow()).title) ?? "";
  } catch {
    return "";
  }
}
