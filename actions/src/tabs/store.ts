// Saved work sessions (sets of tabs), persisted as JSON so closing tabs never loses anything.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../config.js";
import type { Tab, TabSession } from "./types.js";

const FILE = path.join(DATA_DIR, "tab-sessions.json");

function read(): TabSession[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(raw) ? (raw as TabSession[]) : [];
  } catch {
    return [];
  }
}

function write(all: TabSession[]) {
  // Write-then-rename so a crash mid-write cannot corrupt earlier sessions.
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, FILE);
}

/** Newest first. */
export function listSessions(): TabSession[] {
  return read().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getSession(id: string): TabSession | undefined {
  return read().find((s) => s.id === id);
}

/** Saves and returns the session. Throws if the write fails, so callers never act on an unsaved session. */
export function saveSession(name: string, tabs: Tab[]): TabSession {
  const session: TabSession = {
    id: randomUUID(),
    name: name.trim().slice(0, 80) || "Work session",
    createdAt: new Date().toISOString(),
    tabs: tabs.map(({ id, title, url }) => ({ id, title, url })),
  };
  write([...read(), session]);
  return session;
}

export function deleteSession(id: string): boolean {
  const all = read();
  const next = all.filter((s) => s.id !== id);
  if (next.length === all.length) return false;
  write(next);
  return true;
}
