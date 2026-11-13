// Pure safety classifier for Sidekick. Checked in code before every click/type; never left to the model.

export interface ActionTarget {
  action: "click" | "type";
  tag?: string | null;
  /** input type attribute */
  type?: string | null;
  role?: string | null;
  /** visible text / value of the element */
  text?: string | null;
  /** aria-label / <label> / placeholder / title */
  label?: string | null;
  /** name or id attribute */
  name?: string | null;
  autocomplete?: string | null;
  href?: string | null;
  /** text about to be typed (type actions) */
  typedText?: string | null;
}

export type StopCategory = "payment" | "password" | "submit";

export interface SafetyVerdict {
  stop: boolean;
  category?: StopCategory;
  reason?: string;
}

const PAYMENT_RE =
  /\b(card\s*(number|no|num)|credit\s*card|debit\s*card|cvv|cvc|security\s*code|pay|pay\s*now|payment|checkout|check\s*out|purchase|place\s*(your\s*|my\s*)?order|buy\s*now|billing)\b/i;
const PASSWORD_RE = /\b(pass\s*word|passcode|passphrase)\b/i;
const SUBMIT_RE = /\b(submit|send|apply|confirm\s*(your\s*|my\s*)?order)\b/i;
const UNSUBSCRIBE_RE = /unsubscrib|opt[\s-]?out/i;

const norm = (s?: string | null) => (s ?? "").replace(/[_\-./]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();

/** Decide whether a click/type must be hard-stopped and turned into a Proposal. */
export function classifyAction(t: ActionTarget): SafetyVerdict {
  const tag = (t.tag ?? "").toLowerCase();
  const type = (t.type ?? "").toLowerCase();
  let text = norm(t.text);
  if (!text && tag === "input" && type === "submit") text = "Submit";
  const label = norm(t.label);
  const name = norm(t.name);
  const visible = `${text} ${label}`.trim();
  const all = `${visible} ${name}`.trim();

  // 1. Password fields
  if (type === "password" || (tag !== "a" && PASSWORD_RE.test(all) && (t.action === "type" || tag === "input")))
    return { stop: true, category: "password", reason: "This step involves a password field." };

  // 2. Payments
  const ac = (t.autocomplete ?? "").toLowerCase();
  let hrefPath = "";
  try {
    if (t.href) hrefPath = norm(new URL(t.href, "http://x").pathname);
  } catch {
    /* ignore bad hrefs */
  }
  if (ac.startsWith("cc-") || PAYMENT_RE.test(all) || /\b(checkout|payment|pay)\b/i.test(hrefPath))
    return { stop: true, category: "payment", reason: "This step looks like a payment." };
  if (t.action === "type" && /^\s*(?:\d[ -]?){13,19}\s*$/.test(t.typedText ?? ""))
    return { stop: true, category: "payment", reason: "This looks like typing a card number." };

  // 3. Final submit / send (clicks only). Confirming an unsubscribe is explicitly allowed.
  if (t.action === "click" && SUBMIT_RE.test(all)) {
    if (UNSUBSCRIBE_RE.test(all)) return { stop: false };
    return { stop: true, category: "submit", reason: "This looks like a final submit/send step." };
  }

  return { stop: false };
}

const DESKTOP_RE =
  /\b(microsoft\s+(word|office)|ms\s+word|(open|in|launch|start|using)\s+word\b|word\s+doc(ument)?|excel|powerpoint|file\s+explorer|finder|spotify|notepad|photoshop|on\s+my\s+desktop|desktop\s+app|open\s+the\s+app|install(ing|s)?|uninstall)\b/i;

/** True when the instruction clearly needs a non-browser desktop app. */
export function needsDesktop(instruction: string): boolean {
  return DESKTOP_RE.test(instruction);
}
