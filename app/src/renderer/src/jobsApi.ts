// LinkedIn import (actions :7703), job matching (memory :7701) and batch auto-apply (actions :7703).
// See contracts/jobs.md. Calls return friendly errors instead of throwing.
import { SERVICES } from "./api";

export interface LinkedInProfile {
  url: string; name: string; headline: string; location: string; about: string;
  experience: { title: string; company: string; dates: string; summary: string }[];
  education: { school: string; degree: string; dates: string }[];
  skills: string[];
  importedAt: string;
}
export type ImportResult =
  | { ok: true; profile: LinkedInProfile }
  | { ok: false; needsLogin: true; message: string }
  | { ok: false; needsLogin?: false; error: string };

export interface Job {
  id: string; title: string; company: string; location: string; url: string;
  summary: string; why: string; skills: string[]; matchScore: number;
  postedAt?: string; deadline?: string; remote?: boolean;
}
export interface JobsResponse { generatedAt: string | null; basedOn: string[]; jobs: Job[] }
export type JobsResult = JobsResponse & { error?: string };

export interface ApplyResult { url: string; title: string; company: string; ok: boolean; proposalId?: string; filled?: number; needsYou?: number; error?: string }
export type ApplyBatchResult = { results: ApplyResult[]; error?: string };

const EMPTY_JOBS: JobsResponse = { generatedAt: null, basedOn: [], jobs: [] };

function friendly(e: unknown, what: string, svc: string): string {
  if (e instanceof Error && e.name === "TimeoutError") return `${what} took too long and was stopped.`;
  if (e instanceof Error && e.message.startsWith("HTTP")) return `${what} failed (${e.message}).`;
  return `The ${svc} service isn't reachable, so ${what.toLowerCase()} couldn't run.`;
}

async function call<T>(base: string, path: string, init: RequestInit | undefined, timeoutMs: number): Promise<T> {
  const r = await fetch(base + path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = body && typeof body === "object" && (body as any).error;
    throw new Error(msg ? String(msg) : `HTTP ${r.status}`);
  }
  return body as T;
}
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export async function importLinkedIn(url: string): Promise<ImportResult> {
  try {
    const r = await call<any>(SERVICES.actions, "/linkedin/import", post({ url }), 120_000);
    if (r?.ok && r.profile) return { ok: true, profile: r.profile as LinkedInProfile };
    if (r?.needsLogin) return { ok: false, needsLogin: true, message: r.message ?? "Sign in to LinkedIn, then try again." };
    return { ok: false, error: r?.error ?? "Couldn't read that LinkedIn profile." };
  } catch (e) {
    const serverMsg = e instanceof Error && e.name === "Error" && !e.message.startsWith("HTTP");
    return { ok: false, error: serverMsg ? (e as Error).message : friendly(e, "LinkedIn import", "actions") };
  }
}

export async function getLinkedIn(): Promise<LinkedInProfile | null> {
  try { return await call<LinkedInProfile | null>(SERVICES.actions, "/linkedin", undefined, 4000); } catch { return null; }
}

const normJobs = (r: any): JobsResponse => ({
  generatedAt: r?.generatedAt ?? null,
  basedOn: Array.isArray(r?.basedOn) ? r.basedOn : [],
  jobs: Array.isArray(r?.jobs) ? r.jobs : [],
});

export async function getJobs(): Promise<JobsResult> {
  try { return normJobs(await call<any>(SERVICES.memory, "/jobs", undefined, 4000)); }
  catch (e) { return { ...EMPTY_JOBS, error: friendly(e, "Loading jobs", "memory") }; }
}

export async function searchJobs(focus?: string): Promise<JobsResult> {
  try { return normJobs(await call<any>(SERVICES.memory, "/jobs/search", post(focus ? { focus } : {}), 180_000)); }
  catch (e) { return { ...EMPTY_JOBS, error: friendly(e, "Job search", "memory") }; }
}

export async function applyBatch(jobs: { url: string; title: string; company: string }[]): Promise<ApplyBatchResult> {
  try {
    const r = await call<any>(SERVICES.actions, "/apply/batch", post({ jobs: jobs.slice(0, 5).map(j => ({ url: j.url, title: j.title, company: j.company })) }), 600_000);
    return { results: Array.isArray(r?.results) ? r.results : [] };
  } catch (e) { return { results: [], error: friendly(e, "Auto-fill", "actions") }; }
}
