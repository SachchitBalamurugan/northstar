// Pure safety classifier for desktop control. Checked in code before every desktop action;
// never left to the model. No imports, no I/O: unit tested from scripts/smoke.ts.

export type DesktopActionKind = "click" | "double_click" | "right_click" | "type" | "key" | "scroll" | "open_app" | "wait" | "done";

export interface DesktopAction {
  action: DesktopActionKind;
  /** What is being clicked or typed into, as described by the model. */
  target?: string | null;
  /** Text about to be typed. */
  text?: string | null;
  /** Key combo about to be pressed, e.g. "cmd+a". */
  keys?: string | null;
  /** App about to be opened. */
  app?: string | null;
  /** Frontmost app as the model sees it. */
  frontApp?: string | null;
  /** Frontmost app as reported by the OS (when known). */
  realFrontApp?: string | null;
}

export type DesktopStopCategory =
  | "password" | "payment" | "send" | "delete" | "power" | "settings" | "install" | "terminal" | "secret" | "system_keys";

export interface DesktopVerdict {
  stop: boolean;
  category?: DesktopStopCategory;
  reason?: string;
}

const norm = (s?: string | null) => (s ?? "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();

const PASSWORD_RE = /\b(pass\s*word|passcode|passphrase|pin\s*code|log\s*in|login|sign\s*in|signin|credentials?|user\s*name|username|two[\s-]?factor|2fa|verification\s*code|one[\s-]?time\s*code|otp|touch\s*id|face\s*id|authenticat\w*)\b/i;
const PAYMENT_RE = /\b(pay|pays|paying|pay\s*now|payments?|purchase\w*|buy|buy\s*now|check\s*out|checkout|place\s*(your\s*|my\s*)?order|order\s*now|billing|credit\s*card|debit\s*card|card\s*number|cvv|cvc|wallet|bank\w*|wire\s*transfer|transfer\s*(money|funds)|venmo|paypal|zelle|cash\s*app|apple\s*pay|google\s*pay|stripe|crypto\w*|bitcoin|ethereum|coinbase|binance|metamask|robinhood|subscribe\s*now|add\s*to\s*cart|in[\s-]?app\s*purchase)\b/i;
const SEND_RE = /\b(send|sends|sending|submit\w*|post|publish\w*|tweet|reply\s*all|share\s*now|confirm\s*(your\s*|my\s*|the\s*)?(order|purchase|payment|booking))\b/i;
const DELETE_RE = /\b(delete\w*|remove\s*(file|folder|account|app)\w*|move\s*to\s*(the\s*)?(trash|bin|recycle\s*bin)|empty\s*(the\s*)?(trash|bin|recycle\s*bin)|erase\w*|wipe\w*|(re)?format(ting)?\s*(the\s*|this\s*|my\s*)?(disk|drive|volume|usb|sd\s*card|partition)\w*|factory\s*reset|reset\s*(this\s*)?(pc|mac|computer)|uninstall\w*|discard\s*changes|don'?t\s*save)\b/i;
const POWER_RE = /\b(shut\s*down|shutdown|power\s*off|restart\w*|reboot\w*|log\s*out|logout|log\s*off|sign\s*out|lock\s*(screen|computer|pc|mac)|sleep\s*(now|computer|mac|pc)|hibernate|switch\s*user|force\s*quit)\b/i;
const SETTINGS_RE = /\b(system\s*(settings|preferences)|settings\s*app|control\s*panel|windows\s*(settings|security|defender)|keychain(\s*access)?|passwords?\s*app|1password|lastpass|bitwarden|dashlane|keepass\w*|password\s*manager|privacy\s*(&|and)\s*security|security\s*(settings|&\s*privacy)|firewall|file\s*vault|filevault|gatekeeper|registry\s*editor|regedit|group\s*policy|device\s*manager|disk\s*utility|activity\s*monitor|task\s*manager|users\s*(&|and)\s*groups|user\s*accounts?|administrator|admin\s*(password|rights|prompt)|uac|screen\s*recording|accessibility\s*(settings|permission\w*)|sharing\s*settings|remote\s*(login|desktop)|migration\s*assistant)\b/i;
const INSTALL_RE = /\b(install\w*|installer|setup\s*wizard|setup\.exe|\w+\.(pkg|dmg|msi|exe|bat|cmd|ps1|sh|command)|app\s*store|microsoft\s*store|software\s*update|allow\s*this\s*app|run\s*anyway|open\s*anyway)\b/i;
const TERMINAL_RE = /\b(terminal|iterm\d?|power\s*shell|powershell|pwsh|cmd(\.exe)?|command\s*(prompt|line)|warp|kitty|alacritty|hyper|wezterm|ghostty|console|shell|bash|zsh|tty|wsl|ubuntu|git\s*bash|script\s*editor|automator|run\s*dialog)\b/i;
const MESSAGING_RE = /\b(mail|outlook|gmail|messages|imessage|slack|discord|whatsapp|telegram|signal|teams|messenger|wechat|thunderbird|spark|superhuman|zoom\s*chat|compose|new\s*message|reply)\b/i;
const FILE_MANAGER_RE = /\b(finder|file\s*explorer|explorer|files|desktop|trash|recycle\s*bin)\b/i;

// Typed text that is unmistakably a shell command.
const SHELL_SURE_RE = /^\s*(sudo|su|rm|rmdir|chmod|chown|curl|wget|ssh|scp|sftp|npm|npx|pnpm|yarn|pip3?|brew|apt|apt-get|dnf|yum|powershell|pwsh|diskutil|launchctl|osascript|defaults|taskkill|winget|choco|shutdown|reboot|killall|pkill|mkfs\S*|dd|reg|schtasks|netsh|icacls|bcdedit|csrutil|spctl|tccutil|xattr|crontab|systemctl|docker|kubectl)\s+\S/i;
// Words that are also plain English: only a shell command when followed by something shell-shaped.
const SHELL_MAYBE_RE = /^\s*(open|start|cat|echo|cd|ls|dir|node|python3?|net|format|del|kill|source|export|set|sh|bash|zsh|cmd|cp|mv|git|make|touch|mkdir|find|grep|sed|awk|tar|unzip|exec|eval|chmod|ping|nc)\s+(-{1,2}[a-z]|\/|~|\.{1,2}\/|[a-z]:\\|\$|\S+\.(sh|py|js|exe|bat|ps1)\b|\S*[|;&><])/i;
const SHELL_ANY_RE = /(\|\s*(sh|bash|zsh|sudo|iex)\b|&&|\|\||\$\(|`[^`\n]+`|;\s*(rm|sudo|curl)\b|\brm\s+-[a-z]*[rf]|2>&1|>\s*\/dev\/|\b(Invoke-(Expression|WebRequest|RestMethod)|Remove-Item|Start-Process|Set-ExecutionPolicy|New-Object\s+Net)\b|\biex\s*\(|^\s*#!\/|^\s*\.\/\S+|\bchmod\s+[0-7+]|:\(\)\s*\{)/im;

const SECRET_RES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI-style keys
  /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b(pass\s*word|passwd|pwd|passcode|api[\s_-]?key|secret|token|access[\s_-]?key|private[\s_-]?key)\s*(is|[:=])\s*\S+/i,
];

/** True when text looks like a password, API key or token. Such text is never typed. */
export function looksLikeSecret(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (SECRET_RES.some((re) => re.test(t))) return true;
  for (const tok of t.split(/\s+/)) {
    if (/^https?:\/\//i.test(tok) || /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(tok)) continue; // URLs and emails are fine
    const lower = /[a-z]/.test(tok), upper = /[A-Z]/.test(tok), digit = /\d/.test(tok);
    const symbol = /[^A-Za-z0-9]/.test(tok.replace(/[.,;:!?'")(]+$/g, "").replace(/^['"(]+/, ""));
    // Long opaque token: 24+ chars of mixed letters and digits, no spaces.
    if (tok.length >= 24 && digit && (lower || upper) && /^[A-Za-z0-9_\-+/=.]+$/.test(tok) && !/^[\d.,/-]+$/.test(tok)) return true;
    // Hex blob.
    if (/^[0-9a-f]{32,}$/i.test(tok)) return true;
    // Password-shaped: one word mixing lower, upper, digit and symbol.
    if (tok.length >= 8 && tok.length <= 64 && lower && upper && digit && symbol && !/[/\\]/.test(tok)) return true;
  }
  return false;
}

/** True when typed text looks like a shell command. */
export function looksLikeShellCommand(text: string): boolean {
  return text.split(/\r?\n/).some((line) => SHELL_SURE_RE.test(line) || SHELL_MAYBE_RE.test(line)) || SHELL_ANY_RE.test(text);
}

const MOD: Record<string, string> = {
  command: "cmd", meta: "cmd", "⌘": "cmd", control: "ctrl", "⌃": "ctrl", option: "alt", opt: "alt", "⌥": "alt", "⇧": "shift",
  windows: "win", super: "win", del: "delete", return: "enter", esc: "escape", back: "backspace",
};
/** Normalised parts of a key combo: "Cmd + Shift+Delete" → ["cmd","shift","delete"]. */
export function comboParts(keys: string): string[] {
  return keys.toLowerCase().replace(/\s+/g, "").split(/[+]/).filter(Boolean).map((p) => MOD[p] ?? p);
}

function classifyKeys(keys: string, context: string): DesktopVerdict {
  const p = new Set(comboParts(keys));
  const has = (...k: string[]) => k.every((x) => p.has(x));
  const del = p.has("delete") || p.has("backspace");
  if (has("ctrl", "alt") && del) return { stop: true, category: "system_keys", reason: "Ctrl+Alt+Delete is a system shortcut." };
  if (del && (p.has("cmd") || p.has("shift") || p.has("win")))
    return { stop: true, category: "delete", reason: "That shortcut deletes files or empties the trash." };
  if (del && FILE_MANAGER_RE.test(context)) return { stop: true, category: "delete", reason: "Pressing Delete in a file manager deletes files." };
  if (has("cmd", "ctrl", "q") || has("win", "l") || has("cmd", "shift", "q") || has("cmd", "alt", "shift", "q") || p.has("power") || has("cmd", "alt", "eject") || has("ctrl", "cmd", "eject"))
    return { stop: true, category: "power", reason: "That shortcut locks, logs out or shuts down the computer." };
  if (has("alt", "f4")) return { stop: true, category: "system_keys", reason: "Alt+F4 can close apps or shut down the computer." };
  if (has("cmd", "alt", "escape") || has("ctrl", "shift", "escape") || has("win", "r") || has("win", "x") || has("cmd", "space") && p.has("alt"))
    return { stop: true, category: "system_keys", reason: "That is a system shortcut I do not use." };
  // Cmd/Ctrl+Enter sends in most mail and chat apps; plain Enter sends in chat apps.
  if (p.has("enter") && (p.has("cmd") || p.has("ctrl"))) return { stop: true, category: "send", reason: "That shortcut sends or submits in most apps." };
  if (p.has("enter") && MESSAGING_RE.test(context)) return { stop: true, category: "send", reason: "Pressing Enter here would send a message." };
  return { stop: false };
}

/** Decide whether a desktop action must be hard-stopped and turned into a Proposal. */
export function classifyDesktopAction(a: DesktopAction): DesktopVerdict {
  if (a.action === "wait" || a.action === "done") return { stop: false };

  const target = norm(a.target);
  const app = norm(a.app);
  // open_app does not interact with whatever is frontmost (Northstar itself is often started from a terminal),
  // so only the app being opened is judged for it.
  const front = a.action === "open_app" ? "" : `${norm(a.frontApp)} ${norm(a.realFrontApp)}`.trim();
  const acts = a.action !== "scroll"; // scrolling never activates the thing under the pointer
  const where = `${target} ${app} ${front}`.trim();
  const text = a.text ?? "";
  const keys = a.action === "key" ? (a.keys ?? "") : "";

  // Terminals and shells: any interaction at all, including scrolling one into view to use it.
  if (TERMINAL_RE.test(front) || TERMINAL_RE.test(app) || (acts && TERMINAL_RE.test(target)))
    return { stop: true, category: "terminal", reason: "This step involves a terminal or shell, which I never control." };
  // System and security settings, password managers.
  if (SETTINGS_RE.test(app) || SETTINGS_RE.test(front) || (acts && SETTINGS_RE.test(target)))
    return { stop: true, category: "settings", reason: "This step involves system or security settings (or a password manager)." };

  // On Windows the system settings app is simply called "Settings".
  if ((a.action === "open_app" ? [a.app] : [a.app, a.frontApp, a.realFrontApp]).some((x) => /^\s*(settings|preferences)\s*$/i.test(x ?? "")))
    return { stop: true, category: "settings", reason: "This step involves system settings." };

  if (a.action === "type") {
    // Launching a terminal or system settings through Spotlight / Start search.
    if (/\b(spotlight|start\s*menu|launcher|search|run)\b/i.test(target) && (TERMINAL_RE.test(text) || SETTINGS_RE.test(text)))
      return { stop: true, category: TERMINAL_RE.test(text) ? "terminal" : "settings", reason: "This would open a terminal or system settings through search." };
    if (looksLikeSecret(text)) return { stop: true, category: "secret", reason: "The text looks like a password, API key or token, which I never type." };
    if (/(?:\d[ -]?){13,19}/.test(text) && /^\s*(?:\d[ -]?){13,19}\s*$/.test(text))
      return { stop: true, category: "payment", reason: "This looks like typing a card number." };
    if (looksLikeShellCommand(text)) return { stop: true, category: "terminal", reason: "The text looks like a shell command." };
    if (/[\r\n]/.test(text) && MESSAGING_RE.test(where))
      return { stop: true, category: "send", reason: "Typing a line break here would send a message." };
  }
  if (!acts) return { stop: false };

  if (PASSWORD_RE.test(where)) return { stop: true, category: "password", reason: "This step involves a password, login or credential field." };
  if (PAYMENT_RE.test(where)) return { stop: true, category: "payment", reason: "This step looks like a payment, purchase, banking or crypto action." };
  if (POWER_RE.test(where) || POWER_RE.test(keys)) return { stop: true, category: "power", reason: "This step would shut down, restart, log out or lock the computer." };
  if (DELETE_RE.test(`${target} ${app}`)) return { stop: true, category: "delete", reason: "This step would delete, erase, format or uninstall something." };
  if (INSTALL_RE.test(where)) return { stop: true, category: "install", reason: "This step would install software or run an installer." };
  // Send / submit / post / publish: clicks and keys on such a control (typing INTO a field is checked above).
  if (a.action !== "type" && a.action !== "open_app" && SEND_RE.test(target))
    return { stop: true, category: "send", reason: "This looks like a final send, submit, post or publish step." };

  if (keys) return classifyKeys(keys, where);
  return { stop: false };
}
