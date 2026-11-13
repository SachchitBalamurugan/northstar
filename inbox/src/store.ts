// Persistent state: data/cache.json (mail + calendar cache) and data/proposals.json.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { CACHE_PATH, DATA_DIR, PROPOSALS_PATH } from "./config.js";
import type { Cache, Proposal, ProposalStatus } from "./types.js";

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---- cache ----
let cache: Cache = readJson<Cache>(CACHE_PATH, { emails: [], events: [] });
export function getCache(): Cache {
  return cache;
}
export function updateCache(patch: Partial<Cache>): Cache {
  cache = { ...cache, ...patch };
  writeJson(CACHE_PATH, cache);
  return cache;
}
export function resetCache(): void {
  cache = { emails: [], events: [] };
  writeJson(CACHE_PATH, cache);
}

// ---- proposals ----
let proposals: Proposal[] = readJson<Proposal[]>(PROPOSALS_PATH, []);
const persist = () => writeJson(PROPOSALS_PATH, proposals);

type NewProposal = Omit<Proposal, "id" | "agent" | "createdAt" | "status"> & Partial<Pick<Proposal, "id" | "status">>;

export function newProposal(p: NewProposal): Proposal {
  const full: Proposal = {
    ...p,
    id: p.id ?? randomUUID(),
    agent: "inbox",
    createdAt: new Date().toISOString(),
    status: p.status ?? "pending",
  };
  if (full.title.length > 60) full.title = full.title.slice(0, 57) + "...";
  proposals = [full, ...proposals.filter((x) => x.id !== full.id)];
  persist();
  return full;
}
export function listProposals(status?: ProposalStatus): Proposal[] {
  return status ? proposals.filter((p) => p.status === status) : [...proposals];
}
export function getProposal(id: string): Proposal | undefined {
  return proposals.find((p) => p.id === id);
}
export function setProposalStatus(id: string, status: ProposalStatus, payloadPatch?: Record<string, unknown>): Proposal | undefined {
  const p = proposals.find((x) => x.id === id);
  if (!p) return undefined;
  p.status = status;
  if (payloadPatch) p.payload = { ...(p.payload ?? {}), ...payloadPatch };
  persist();
  return p;
}
/** Drop all pending proposals of one type (e.g. before re-planning). */
export function dropPending(type: Proposal["type"]): void {
  proposals = proposals.filter((p) => !(p.type === type && p.status === "pending"));
  persist();
}
/** Test helper. */
export function resetProposals(): void {
  proposals = [];
  persist();
}
