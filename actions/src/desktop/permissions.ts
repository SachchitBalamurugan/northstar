// Detects (never changes) whether this process may capture the screen and send synthetic input.
// macOS ties both grants to the app that launched Node (Terminal, the editor, Electron), so the hint names it.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { MOCK } from "../config.js";

export interface DesktopPermissions {
  screen: boolean;
  input: boolean;
  hint: string;
}

const require = createRequire(import.meta.url);

/** The .app (macOS) that owns this process tree: the one the user has to enable in System Settings. */
export function responsibleApp(): string {
  if (process.platform !== "darwin") return process.platform === "win32" ? "Northstar" : "this app";
  try {
    let pid = process.pid;
    let found = "";
    for (let i = 0; i < 25 && pid > 1; i++) {
      const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
      const m = /^(\d+)\s+(.*)$/.exec(out);
      if (!m) break;
      // The outermost .app bundle in the ancestry is the one macOS holds responsible.
      const app = /\/([^/]+)\.app\//.exec(m[2]);
      if (app) found = app[1];
      pid = Number(m[1]);
    }
    return found || "the app you started Northstar from (for example Terminal)";
  } catch {
    return "the app you started Northstar from (for example Terminal)";
  }
}

type Tcc = "authorized" | "denied" | "restricted" | "not determined" | "unknown";
function macStatus(kind: "screen" | "accessibility"): Tcc {
  try {
    // Read-only query (CGPreflightScreenCaptureAccess / AXIsProcessTrusted). Shows no prompt.
    return require("@nut-tree-fork/node-mac-permissions").getAuthStatus(kind) as Tcc;
  } catch {
    return "unknown";
  }
}

function macHint(screen: boolean, input: boolean, app: string): string {
  const parts: string[] = [];
  if (!screen)
    parts.push(`I can't see your screen yet. Open System Settings > Privacy & Security > Screen & System Audio Recording (called "Screen Recording" on older macOS) and turn on "${app}".`);
  if (!input)
    parts.push(`I can't move the mouse or type yet. Open System Settings > Privacy & Security > Accessibility and turn on "${app}".`);
  if (!parts.length) return "";
  parts.push(`If "${app}" is not in the list, add it with the + button. Then quit and reopen ${app} and start Northstar again. I never change these settings myself.`);
  return parts.join(" ");
}

/**
 * `probe: true` additionally verifies with a real capture and a 1-pixel mouse move (and back).
 * The probe is skipped in MOCK mode and whenever the OS already reports a missing grant.
 */
export async function checkDesktopPermissions(opts: { probe?: boolean } = {}): Promise<DesktopPermissions> {
  const probe = (opts.probe ?? true) && !MOCK;
  const mac = process.platform === "darwin";
  const app = responsibleApp();
  let screen = true;
  let input = true;
  let hint = "";

  if (mac) {
    const s = macStatus("screen");
    const a = macStatus("accessibility");
    screen = s === "authorized" || s === "unknown";
    input = a === "authorized" || a === "unknown";
    if (!screen || !input) return { screen, input, hint: macHint(screen, input, app) };
  } else if (process.platform !== "win32") {
    return { screen: false, input: false, hint: `Desktop control supports macOS and Windows only (this is ${process.platform}).` };
  }
  if (!probe) return { screen, input, hint: "" };

  try {
    const { captureScreen } = await import("./screen.js");
    const shot = await captureScreen();
    if (shot.blank) screen = false;
  } catch {
    screen = false;
  }
  try {
    const { mousePosition, moveMouse } = await import("./input.js");
    const before = await mousePosition();
    const nx = before.x >= 1 ? before.x - 1 : before.x + 1;
    await moveMouse(nx, before.y);
    const moved = await mousePosition();
    await moveMouse(before.x, before.y);
    if (moved.x === before.x && moved.y === before.y) input = false;
  } catch {
    input = false;
  }

  if (mac) hint = macHint(screen, input, app);
  else if (!screen || !input)
    hint = [
      !screen ? "I could not capture the screen." : "",
      !input ? "I could not move the mouse." : "",
      "On Windows this usually means Northstar is running in a locked or remote session, or security software is blocking it. Run Northstar in your normal signed-in desktop session and allow it if your security software asks.",
    ].filter(Boolean).join(" ");
  return { screen, input, hint };
}
