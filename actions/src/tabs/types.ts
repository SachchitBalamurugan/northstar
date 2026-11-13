export interface Tab {
  id: string;
  title: string;
  url: string;
  active?: boolean;
  /** Optional, sent by a browser extension (chrome.tabs `lastAccessed`, ms since epoch). */
  lastAccessed?: number;
}

export interface TabGroup {
  id: string;
  name: string;
  why: string;
  tabIds: string[];
}

export interface OrganizeResult {
  groups: TabGroup[];
  archive: { tabId: string; why: string }[];
  source: "llm" | "heuristic";
}

export interface TabSession {
  id: string;
  name: string;
  createdAt: string;
  tabs: Tab[];
}

/** Accepts anything from a request body; keeps only well-formed tabs. Returns null when it is not an array. */
export function sanitizeTabs(raw: unknown): Tab[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Tab[] = [];
  const ids = new Set<string>();
  for (const [i, t] of raw.slice(0, 200).entries()) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    if (typeof r.url !== "string" || !r.url.trim()) continue;
    const url = r.url.trim().slice(0, 2000);
    let id = typeof r.id === "string" || typeof r.id === "number" ? String(r.id) : `x${i + 1}`;
    while (ids.has(id)) id = `${id}_${i + 1}`;
    ids.add(id);
    const tab: Tab = { id, title: (typeof r.title === "string" && r.title.trim() ? r.title.trim() : url).slice(0, 300), url };
    if (r.active === true) tab.active = true;
    if (typeof r.lastAccessed === "number" && Number.isFinite(r.lastAccessed)) tab.lastAccessed = r.lastAccessed;
    out.push(tab);
  }
  return out;
}
