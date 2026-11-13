import type { Page } from "playwright";

export interface SnapEl {
  index: number;
  tag: string;
  type: string;
  role: string;
  text: string;
  label: string;
  name: string;
  autocomplete: string;
  href: string;
}
export interface Snapshot {
  url: string;
  title: string;
  elements: SnapEl[];
  text: string;
}

// Kept as a string so tsx/esbuild never injects helpers (__name) into browser-side code.
const SNAP_JS = `(() => {
  document.querySelectorAll('[data-sk-idx]').forEach((e) => e.removeAttribute('data-sk-idx'));
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[onclick]';
  const out = [];
  const clip = (s, n) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= 60) break;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') el.removeAttribute('target');
    const idx = out.length;
    el.setAttribute('data-sk-idx', String(idx));
    const lab = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('placeholder') || el.getAttribute('title') || '';
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    const type = (el.getAttribute('type') || '').toLowerCase();
    const txt = isField ? ((type === 'submit' || type === 'button' || type === 'reset') ? el.value : '') : el.innerText || el.textContent;
    out.push({
      index: idx, tag, type,
      role: el.getAttribute('role') || '',
      text: clip(txt, 80), label: clip(lab, 80),
      name: clip(el.getAttribute('name') || el.id || '', 40),
      autocomplete: el.getAttribute('autocomplete') || '',
      href: tag === 'a' ? clip(el.getAttribute('href'), 120) : '',
    });
  }
  return { url: location.href, title: document.title, elements: out, text: clip(document.body ? document.body.innerText : '', 1500) };
})()`;

export async function takeSnapshot(page: Page): Promise<Snapshot> {
  return (await page.evaluate(SNAP_JS)) as Snapshot;
}

export function renderSnapshot(s: Snapshot): string {
  const lines = s.elements.map((e) => {
    const bits = [`[${e.index}] <${e.tag}${e.type ? ` type=${e.type}` : ""}${e.role ? ` role=${e.role}` : ""}>`];
    if (e.text) bits.push(`"${e.text}"`);
    if (e.label) bits.push(`label="${e.label}"`);
    if (e.name) bits.push(`name=${e.name}`);
    if (e.href) bits.push(`href=${e.href}`);
    return bits.join(" ");
  });
  return `URL: ${s.url}\nTitle: ${s.title}\nInteractive elements:\n${lines.join("\n") || "(none)"}\n\nVisible text:\n${s.text}`;
}

export const elLocator = (page: Page, index: number) => page.locator(`[data-sk-idx="${index}"]`).first();

export function describeEl(e: SnapEl): string {
  return `${e.tag}${e.type ? `[${e.type}]` : ""} "${e.text || e.label || e.name || "?"}"`;
}
