// Desktop agent: sees the real screen and drives the real mouse/keyboard with the vision model.
// Opt-in only (DESKTOP_CONTROL=1 + an LLM). Every action passes desktop/safety.ts first.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MOCK } from "../config.js";
import { complete, llmAvailable } from "../llm.js";
import { getContext } from "../memory.js";
import { createProposal } from "../proposals.js";
import type { SidekickStep } from "../types.js";
import { checkDesktopPermissions } from "./permissions.js";
import { classifyDesktopAction, looksLikeSecret, type DesktopAction } from "./safety.js";

export const DESKTOP_MAX_STEPS = 20;
const SETTLE_MS = 700;
const TAKEOVER_PX = 40;
const MOCK_DELAY_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Frame = SidekickStep & { proposalId?: string };
/** Same shape as Sidekick's Run; `runStatus`/`runDetail` override what the run registry records for a final frame. */
export interface DesktopRun {
  instruction: string;
  emit: (f: Omit<Frame, "step"> & { runStatus?: "done" | "stopped" | "error"; runDetail?: string }) => void;
  closed: () => boolean;
}

/** Guard rail 1: desktop control is opt-in through the environment (read at call time; dotenv has loaded by then). */
export function desktopEnabled(): boolean {
  return process.env.DESKTOP_CONTROL === "1";
}
/** True only when the real desktop agent may run. */
export function desktopAllowed(): boolean {
  return desktopEnabled() && llmAvailable();
}

export const DesktopStepSchema = z.object({
  action: z.enum(["click", "double_click", "right_click", "type", "key", "scroll", "open_app", "wait", "done"]),
  x: z.number().nullable(),
  y: z.number().nullable(),
  text: z.string().nullable(),
  keys: z.string().nullable(),
  app: z.string().nullable(),
  scrollDy: z.number().nullable(),
  target: z.string().nullable(),
  frontApp: z.string().nullable(),
  reason: z.string(),
});
type Decision = z.infer<typeof DesktopStepSchema>;

const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

function describe(d: Decision): string {
  const t = d.target ? short(d.target, 60) : "";
  switch (d.action) {
    case "click": return `click ${t || "on screen"}`;
    case "double_click": return `double-click ${t || "on screen"}`;
    case "right_click": return `right-click ${t || "on screen"}`;
    case "type": return `type into ${t || "the focused field"}`;
    case "key": return `press ${d.keys ?? "a key"}`;
    case "scroll": return "scroll";
    case "open_app": return `open ${d.app ?? "an app"}`;
    default: return d.action;
  }
}

export async function runDesktopAgent(run: DesktopRun): Promise<string> {
  // Guard rail 1, re-checked here so no caller can skip it.
  if (!desktopAllowed() || MOCK) {
    run.emit({ action: "error", detail: "Desktop control is turned off. Set DESKTOP_CONTROL=1 and connect an API key to use it." });
    return "desktop control is off";
  }
  // Guard rail 4.
  const perms = await checkDesktopPermissions();
  if (!perms.screen || !perms.input) {
    run.emit({ action: "error", detail: perms.hint || "I do not have permission to see the screen or control the mouse and keyboard." });
    return "missing desktop permissions";
  }

  const { captureScreen } = await import("./screen.js");
  const input = await import("./input.js");
  const mac = process.platform === "darwin";
  const ctx = await getContext(run.instruction);
  const system = [
    `You are Sidekick, a careful desktop agent controlling the user's real ${mac ? "Mac" : "Windows PC"} at their request. They are watching.`,
    "Each turn you get a screenshot of the primary display and pick exactly ONE action:",
    '- open_app: set "app" to the application name (for example "TextEdit", "Calculator", "Notes"). ALWAYS prefer this over hunting for icons, the Dock, the Start menu or Spotlight.',
    `- key: set "keys" to one combo such as "${mac ? "cmd" : "ctrl"}+a", "${mac ? "cmd" : "ctrl"}+n", "enter", "tab", "escape". Prefer keyboard shortcuts over clicking through menus.`,
    '- type: set "text"; it is typed into whatever has keyboard focus (click the field first if it is not focused).',
    '- click / double_click / right_click: set "x" and "y" in SCREENSHOT PIXEL coordinates (origin top-left of the image) at the centre of the thing.',
    '- scroll: set "scrollDy" (positive scrolls down, negative up; about 300 per screenful).',
    "- wait: the screen is still loading or changing.",
    '- done: the task is complete or impossible; put the outcome for the user in "reason".',
    'Always set "target" to a short description of exactly what is being clicked or typed into (e.g. "Save button in TextEdit dialog"), and "frontApp" to the app that appears frontmost in the screenshot. Unused fields must be null. "reason" is one short friendly sentence shown to the user.',
    "Look at the screenshot to check that your last action worked before moving on. If it did not, try a different way; do not repeat the same failing action more than twice.",
    "A safety layer outside you checks every action. It stops for passwords and logins, payments, sending or submitting, deleting, shutdown or log out, system settings, installing software and terminals. If the task needs one of those, still pick that action and describe it honestly: the safety layer pauses and asks the user. Never try to work around it, and never type a password, key or token.",
    "Never invent personal facts. If the task needs facts you were not given, finish with \"done\" and say what is missing.",
    "",
    "What we know about the user (from memory):",
    ...[...ctx.snippets, ...ctx.knowledge].map((s) => `- ${s}`),
  ].join("\n");

  const history: string[] = [];
  /** Where the agent left the mouse after its last action (guard rail 3). */
  let leftAt: { x: number; y: number } | null = null;

  for (let i = 1; i <= DESKTOP_MAX_STEPS; i++) {
    if (run.closed()) return "cancelled";
    const shot = await captureScreen();
    const decision = await complete({
      tier: "smart",
      system,
      schema: DesktopStepSchema,
      schemaName: "desktop_step",
      images: [shot.png],
      input: `Task: ${run.instruction}\n\nSteps so far:\n${history.join("\n") || "(none)"}\n\nStep ${i} of ${DESKTOP_MAX_STEPS}. The screenshot is ${shot.width}x${shot.height} pixels.`,
    });
    if (run.closed()) return "cancelled";

    if (decision.action === "done") {
      run.emit({ action: "done", detail: decision.reason, screenshot: shot.png });
      return decision.reason;
    }

    // Guard rail 3: the user moved the mouse since the agent's last action → they took over.
    if (leftAt) {
      const now = await input.mousePosition();
      if (Math.hypot(now.x - leftAt.x, now.y - leftAt.y) > TAKEOVER_PX) {
        run.emit({ action: "stopped", detail: "You moved the mouse, so I stopped.", screenshot: shot.png, runStatus: "error", runDetail: "Stopped: you took over" });
        return "stopped: the user took over";
      }
    }

    // Guard rails 2 and 5: classify before acting, using the model's description AND the real frontmost app.
    const realFrontApp = await input.frontmostApp();
    const action: DesktopAction = {
      action: decision.action, target: decision.target, text: decision.text, keys: decision.keys, app: decision.app,
      frontApp: decision.frontApp, realFrontApp,
    };
    const verdict = classifyDesktopAction(action);
    if (verdict.stop || (decision.action === "type" && looksLikeSecret(decision.text ?? ""))) {
      const what = describe(decision).slice(0, 50);
      const why = verdict.reason ?? "The text looks like a password, API key or token, which I never type.";
      const hideText = verdict.category === "password" || verdict.category === "payment" || verdict.category === "secret" || !verdict.stop;
      const proposal = createProposal({
        type: "task",
        title: `Confirm: ${what}`,
        why: `${why} Sidekick stopped so you can decide.`,
        payload: {
          instruction: run.instruction,
          mode: "desktop",
          pendingAction: { ...decision, text: hideText ? null : decision.text, realFrontApp, category: verdict.category ?? "secret" },
        },
        urgency: 3,
      });
      run.emit({
        action: "stopped",
        detail: `Stopped before: ${what}. ${why} I made a proposal for you to approve (proposal ${proposal.id}).`,
        proposalId: proposal.id,
        screenshot: shot.png,
      });
      return `stopped for approval before ${what}`;
    }

    let detail = decision.reason;
    try {
      const needsPoint = decision.action === "click" || decision.action === "double_click" || decision.action === "right_click";
      if (needsPoint) {
        const { x, y } = decision;
        if (x == null || y == null || x < 0 || y < 0 || x > shot.width || y > shot.height) throw new Error(`point (${x}, ${y}) is outside the ${shot.width}x${shot.height} screenshot`);
        await input.click(x * shot.scaleX, y * shot.scaleY, decision.action === "right_click" ? "right" : "left", decision.action === "double_click");
        detail = `${decision.action === "click" ? "Clicked" : decision.action === "double_click" ? "Double-clicked" : "Right-clicked"} ${short(decision.target ?? "the screen")}. ${decision.reason}`;
      } else if (decision.action === "type") {
        const text = decision.text ?? "";
        if (!text) throw new Error("nothing to type");
        await input.typeText(text);
        detail = `Typed "${short(text)}"${decision.target ? ` into ${short(decision.target)}` : ""}. ${decision.reason}`;
      } else if (decision.action === "key") {
        if (!decision.keys) throw new Error("no keys given");
        await input.pressKeys(decision.keys);
        detail = `Pressed ${decision.keys}. ${decision.reason}`;
      } else if (decision.action === "scroll") {
        await input.scroll(decision.scrollDy ?? 300);
      } else if (decision.action === "open_app") {
        if (!decision.app) throw new Error("no app name given");
        await input.openApp(decision.app);
        detail = `Opened ${decision.app}. ${decision.reason}`;
      }
      history.push(`${i}. ${describe(decision)}${decision.action === "type" ? ` "${short(decision.text ?? "", 60)}"` : ""} → sent (${decision.reason})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      history.push(`${i}. ${describe(decision)} FAILED: ${msg}`);
      detail = `That did not work (${msg}). Trying something else.`;
    }
    leftAt = await input.mousePosition().catch(() => null);
    await sleep(SETTLE_MS);
    run.emit({ action: decision.action, detail, screenshot: i === 1 || i % 4 === 0 ? shot.png : undefined });
  }

  const last = await captureScreen().catch(() => null);
  run.emit({ action: "done", detail: `I ran out of steps (${DESKTOP_MAX_STEPS}) before finishing. Here is where I got to.`, screenshot: last?.png });
  return `ran out of steps after ${DESKTOP_MAX_STEPS}`;
}

/** MOCK=1 demo: a canned stream. Never touches the real screen, mouse or keyboard. */
export async function mockDesktop(run: DesktopRun): Promise<string> {
  const frames = [
    { action: "think", detail: `Got it: "${run.instruction}". Planning the steps (demo mode, your real desktop is not touched).` },
    { action: "open_app", detail: "Desktop demo: I would open the app you asked for." },
    { action: "type", detail: "Desktop demo: I would click into it and type what you asked." },
    { action: "done", detail: "Demo mode: this is a canned desktop run. Set DESKTOP_CONTROL=1 and connect an API key to let me control the desktop for real." },
  ];
  for (const f of frames) {
    if (run.closed()) return "cancelled";
    run.emit(f);
    await sleep(MOCK_DELAY_MS);
  }
  return "canned desktop demo run (mock mode)";
}

export async function desktopRoutes(app: FastifyInstance) {
  // Probes for real (capture + a 1-pixel mouse move and back) only when desktop control is switched on.
  app.get("/desktop/status", async () => ({
    enabled: desktopEnabled(),
    llm: llmAvailable(),
    platform: process.platform,
    permissions: await checkDesktopPermissions({ probe: desktopEnabled() && !MOCK }),
  }));
}
