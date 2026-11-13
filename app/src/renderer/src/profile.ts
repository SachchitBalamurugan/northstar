// User profile: who the user is, so every AI output is personalized.
// Saved locally (instant) and synced to the memory service as Knowledge/profile.md, which the memory
// service's research (Discover), insights and context endpoints read. Everything the AI does picks it up.
import { create } from "zustand";
import { SERVICES } from "./api";

export type Status = "school" | "working" | "internship" | "job_hunting" | "leisure" | "other";
export const STATUS_LABELS: Record<Status, string> = {
  school: "In school", working: "Working", internship: "Interning", job_hunting: "Job hunting", leisure: "Taking it easy", other: "Other",
};

export interface Profile {
  name: string;
  statuses: Status[];        // can be several, e.g. school + internship
  school: string;            // "UC Berkeley"
  program: string;           // "CS, sophomore"
  work: string;              // "SkyDeck intern"
  location: string;          // "Berkeley, CA"
  interests: string[];       // ["robotics", "hackathons"]
  goals: string;             // free text
  context: string;           // anything else the AI should know
  updatedAt?: string;
}

export const EMPTY_PROFILE: Profile = {
  name: "", statuses: [], school: "", program: "", work: "", location: "", interests: [], goals: "", context: "",
};

const KEY = "ns.profile";
const load = (): Profile => { try { return { ...EMPTY_PROFILE, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return EMPTY_PROFILE; } };

/** First name for greetings ("Maya" fallback keeps the demo copy sensible). */
export const firstName = (p: Profile) => p.name.trim().split(/\s+/)[0] || "there";

/** Short location hint the AI uses to localize searches, e.g. "near UC Berkeley (Berkeley, CA) / San Francisco Bay Area". */
export function locationHint(p: Profile): string {
  const parts = [p.school && `near ${p.school}`, p.location].filter(Boolean);
  const bay = /berkeley|stanford|ucsf|san francisco|sf\b|oakland|palo alto|san jose|skydeck|bay area/i.test(`${p.school} ${p.location} ${p.work}`);
  return [...parts, bay ? "San Francisco Bay Area" : ""].filter(Boolean).join(", ");
}

/** One line of context appended to AI requests (Discover focus, etc.). */
export function contextLine(p: Profile): string {
  const bits = [
    p.statuses.length ? `status: ${p.statuses.map(s => STATUS_LABELS[s]).join(" + ")}` : "",
    p.school && `school: ${p.school}${p.program ? ` (${p.program})` : ""}`,
    p.work && `work: ${p.work}`,
    locationHint(p) && `location: ${locationHint(p)}`,
    p.interests.length ? `interests: ${p.interests.join(", ")}` : "",
  ].filter(Boolean);
  return bits.join("; ");
}

/** Markdown written to Knowledge/profile.md. Bullets so the memory service's profile reader can cite each line. */
export function toMarkdown(p: Profile): string {
  const L: string[] = ["# Profile", "", "_Set by the user in Northstar → Profile. Use this to personalize everything._", ""];
  if (p.name) L.push(`- Name: ${p.name}`);
  if (p.statuses.length) L.push(`- Current status: ${p.statuses.map(s => STATUS_LABELS[s]).join(", ")}`);
  if (p.school) L.push(`- School: ${p.school}${p.program ? `, ${p.program}` : ""}`);
  if (p.work) L.push(`- Work / role: ${p.work}`);
  const loc = locationHint(p); if (loc) L.push(`- Location: ${loc}. Prefer events and opportunities here.`);
  if (p.interests.length) L.push(`- Interests: ${p.interests.join(", ")}`);
  if (p.goals.trim()) L.push(`- Goals: ${p.goals.trim().replace(/\n+/g, " ")}`);
  if (p.context.trim()) for (const line of p.context.trim().split(/\n+/)) L.push(`- ${line.trim().replace(/^[-*]\s*/, "")}`);
  return L.join("\n") + "\n";
}

export type SyncState = "idle" | "saving" | "synced" | "local";

interface ProfileState {
  profile: Profile;
  sync: SyncState;
  open: boolean;
  setOpen: (o: boolean) => void;
  save: (p: Profile) => Promise<void>;
}

export const useProfile = create<ProfileState>((set) => ({
  profile: load(),
  sync: "idle",
  open: false,
  setOpen: (open) => set({ open }),
  save: async (p) => {
    const profile = { ...p, updatedAt: new Date().toISOString() };
    try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* ignore */ }
    set({ profile, sync: "saving" });
    try {
      const r = await fetch(`${SERVICES.memory}/knowledge/profile.md`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: toMarkdown(profile) }), signal: AbortSignal.timeout(5000),
      });
      set({ sync: r.ok ? "synced" : "local" });
    } catch { set({ sync: "local" }); }
  },
}));
