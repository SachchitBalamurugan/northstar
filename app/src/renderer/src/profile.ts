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
  // Applications (used by the form filler)
  email: string;
  phone: string;
  gpa: string;
  gradYear: string;
  linkedin: string;
  github: string;
  website: string;
  workAuthorization: string; // one of WORK_AUTH_OPTIONS or ""
  resumePath: string;        // full local path to resume PDF
  /** Mode-specific answers (school / work / job hunting / leisure), keyed by ModeField.key. */
  extra: Record<string, string>;
  updatedAt?: string;
}

export const EMPTY_PROFILE: Profile = {
  name: "", statuses: [], school: "", program: "", work: "", location: "", interests: [], goals: "", context: "",
  email: "", phone: "", gpa: "", gradYear: "", linkedin: "", github: "", website: "", workAuthorization: "", resumePath: "",
  extra: {},
};

/* ---------- Customizable profile: each status unlocks its own questions ---------- */
export interface ModeField {
  key: string; label: string; placeholder: string;
  kind?: "text" | "textarea" | "select";
  options?: string[];
  half?: boolean;            // render two-per-row
  /** Stored on the top-level Profile (school/program/work/gpa/gradYear) instead of `extra`. */
  top?: keyof Profile;
}
export interface Mode { id: "school" | "work" | "jobs" | "leisure"; statuses: Status[]; title: string; blurb: string; fields: ModeField[] }

export const MODES: Mode[] = [
  {
    id: "school", statuses: ["school"], title: "School", blurb: "Your academics, so Northstar can plan study time and find the right help.",
    fields: [
      { key: "school", top: "school", label: "School", placeholder: "UC Berkeley", half: true },
      { key: "program", top: "program", label: "Major / program", placeholder: "Computer Science", half: true },
      { key: "year", label: "Year", placeholder: "Sophomore", half: true },
      { key: "gpa", top: "gpa", label: "GPA", placeholder: "3.8", half: true },
      { key: "courses", label: "Current classes", placeholder: "CS 61B, EE 16A, Math 54" },
      { key: "hardest", label: "Hardest class right now", placeholder: "CS 61B projects", half: true },
      { key: "studyTime", label: "Best study time", placeholder: "2–5pm, library", half: true },
      { key: "clubs", label: "Clubs & activities", placeholder: "Cal Robotics, ACM" },
      { key: "academicGoals", label: "Academic goals", placeholder: "Keep GPA above 3.5, finish projects 5 days early", kind: "textarea" },
    ],
  },
  {
    id: "work", statuses: ["working", "internship"], title: "Work", blurb: "Your role, so Northstar can protect focus time and handle work email.",
    fields: [
      { key: "work", top: "work", label: "Role", placeholder: "Software engineering intern", half: true },
      { key: "company", label: "Company / team", placeholder: "SkyDeck, infra team", half: true },
      { key: "workHours", label: "Work hours", placeholder: "Mon–Thu 10–4", half: true },
      { key: "manager", label: "Manager / mentor", placeholder: "Priya (mentor)", half: true },
      { key: "skills", label: "Skills you use", placeholder: "TypeScript, React, Python, SQL" },
      { key: "currentProjects", label: "What you're working on", placeholder: "Shipping the onboarding flow by Dec 1", kind: "textarea" },
      { key: "careerGoals", label: "Career goals", placeholder: "Full-time SWE offer, grow into backend", kind: "textarea" },
    ],
  },
  {
    id: "jobs", statuses: ["job_hunting"], title: "Job hunt", blurb: "What you're looking for, so Discover finds the right postings and the filler applies well.",
    fields: [
      { key: "targetRoles", label: "Target roles", placeholder: "SWE intern, ML intern, product engineer" },
      { key: "targetLocations", label: "Where", placeholder: "SF Bay Area, NYC, remote", half: true },
      { key: "startDate", label: "Available from", placeholder: "Summer 2027", half: true },
      { key: "companySize", label: "Company type", placeholder: "Any", kind: "select", options: ["Any", "Startup", "Mid-size", "Big tech", "Non-profit / research"], half: true },
      { key: "gradYear", top: "gradYear", label: "Graduation year", placeholder: "2028", half: true },
      { key: "dealBreakers", label: "Must-haves / deal-breakers", placeholder: "Paid, hybrid ok, no unpaid trials", kind: "textarea" },
    ],
  },
  {
    id: "leisure", statuses: ["leisure"], title: "Free time", blurb: "What you enjoy, so Northstar suggests fun things that actually fit you.",
    fields: [
      { key: "hobbies", label: "Hobbies", placeholder: "Bouldering, film photography, cooking" },
      { key: "wantToDo", label: "Things you want to do", placeholder: "See a Warriors game, learn to surf, try a pottery class", kind: "textarea" },
      { key: "favoritePlaces", label: "Favorite places / vibes", placeholder: "Cafés, beaches, night markets" },
      { key: "budget", label: "Budget", placeholder: "Free or cheap", kind: "select", options: ["Free", "Free or cheap", "Mid", "Treat myself"], half: true },
      { key: "company_pref", label: "Usually with", placeholder: "Solo", kind: "select", options: ["Solo", "A friend or two", "Groups", "Meeting new people"], half: true },
      { key: "freeTime", label: "When you're free", placeholder: "Weekends, Thu evenings" },
    ],
  },
];

/** Modes unlocked by the chosen statuses ("Other" alone unlocks none). */
export const activeModes = (p: Profile) => MODES.filter(m => m.statuses.some(s => p.statuses.includes(s)));
export const getField = (p: Profile, f: ModeField): string => (f.top ? String(p[f.top] ?? "") : p.extra?.[f.key] ?? "");
export const setField = (p: Profile, f: ModeField, v: string): Profile =>
  f.top ? { ...p, [f.top]: v } : { ...p, extra: { ...(p.extra ?? {}), [f.key]: v } };

export const WORK_AUTH_OPTIONS = ["US citizen / permanent resident", "Authorized (visa)", "Needs sponsorship"] as const;

const KEY = "ns.profile";
const load = (): Profile => { try { const s = JSON.parse(localStorage.getItem(KEY) || "{}"); return { ...EMPTY_PROFILE, ...s, extra: { ...(s.extra ?? {}) } }; } catch { return EMPTY_PROFILE; } };

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
    // The most search-relevant answer from each active mode.
    ...activeModes(p).map(m => {
      const key = m.id === "school" ? "courses" : m.id === "work" ? "skills" : m.id === "jobs" ? "targetRoles" : "hobbies";
      const v = p.extra?.[key]?.trim();
      return v ? `${key === "courses" ? "classes" : key === "targetRoles" ? "looking for" : key}: ${v}` : "";
    }),
    activeModes(p).some(m => m.id === "leisure") && p.extra?.budget ? `budget: ${p.extra.budget}` : "",
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
  if (p.email) L.push(`- Email: ${p.email}`);
  if (p.phone) L.push(`- Phone: ${p.phone}`);
  if (p.gpa) L.push(`- GPA: ${p.gpa}`);
  if (p.gradYear) L.push(`- Graduation year: ${p.gradYear}`);
  if (p.linkedin) L.push(`- LinkedIn: ${p.linkedin}`);
  if (p.github) L.push(`- GitHub: ${p.github}`);
  if (p.website) L.push(`- Website: ${p.website}`);
  if (p.workAuthorization) L.push(`- Work authorization: ${p.workAuthorization}`);
  if (p.context.trim()) for (const line of p.context.trim().split(/\n+/)) L.push(`- ${line.trim().replace(/^[-*]\s*/, "")}`);
  // Only the sections for the statuses the user picked, so the AI focuses on what matters now.
  for (const m of activeModes(p)) {
    const rows = m.fields.filter(f => !f.top && (p.extra?.[f.key] ?? "").trim());
    if (!rows.length) continue;
    L.push("", `## ${m.title}`);
    for (const f of rows) L.push(`- ${f.label}: ${p.extra[f.key].trim().replace(/\n+/g, " ")}`);
  }
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
    // Also hand the application fields to the actions service's form filler (best effort).
    const parts = profile.name.trim().split(/\s+/).filter(Boolean);
    void fetch(`${SERVICES.actions}/profile`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        name: profile.name.trim(), firstName: parts[0] ?? "", lastName: parts.slice(1).join(" "),
        email: profile.email, phone: profile.phone, school: profile.school, major: profile.program, gpa: profile.gpa,
        gradYear: profile.gradYear, linkedin: profile.linkedin, github: profile.github, website: profile.website,
        workAuthorization: profile.workAuthorization, resumePath: profile.resumePath, location: profile.location, currentRole: profile.work,
      }),
    }).catch(() => { /* ignore */ });
  },
}));
