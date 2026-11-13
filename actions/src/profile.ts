// GET/PUT /profile backed by data/profile.json. Seeded with the demo student on first run.
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { DATA_DIR, FIXTURES_DIR, MEMORY_URL, MOCK } from "./config.js";
import type { Profile } from "./types.js";

const FILE = path.join(DATA_DIR, "profile.json");

const SEED: Profile = {
  name: "Maya Chen",
  firstName: "Maya",
  lastName: "Chen",
  email: "maya.chen@example.edu",
  phone: "555-014-2377",
  school: "Northfield State University",
  major: "Computer Science",
  gpa: "3.6",
  gradYear: "2029",
  linkedin: "https://www.linkedin.com/in/maya-chen-example",
  github: "https://github.com/maya-chen-example",
  resumePath: path.join(FIXTURES_DIR, "resume.pdf"),
  workAuthorization: "Authorized to work in the US",
};

const EMPTY: Profile = {
  name: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  school: "",
  major: "",
  gpa: "",
  gradYear: "",
  linkedin: "",
  github: "",
  resumePath: "",
  workAuthorization: "",
};

function readFile(): Partial<Profile> {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** Parse the memory service's profile.md ("- Name: X", "- School: X, program", ...). */
export function parseProfileMd(md: string): Partial<Profile> {
  const out: Partial<Profile> = {};
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*([^:]+):\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    if (!val) continue;
    if (key === "name") {
      out.name = val;
      const parts = val.split(/\s+/);
      out.firstName = parts[0];
      out.lastName = parts.length > 1 ? parts.slice(1).join(" ") : "";
    } else if (key === "school") {
      const i = val.indexOf(",");
      if (i >= 0) {
        out.school = val.slice(0, i).trim();
        const program = val.slice(i + 1).trim();
        if (program) out.major = program;
      } else out.school = val;
    } else if (key === "work / role" || key === "work/role" || key === "role" || key === "work") {
      out.currentRole = val;
    } else if (key === "location") {
      out.location = val;
    }
  }
  return out;
}

async function readMemoryProfile(): Promise<Partial<Profile>> {
  try {
    const r = await fetch(`${MEMORY_URL}/knowledge/profile.md`, { signal: AbortSignal.timeout(2_000) });
    if (!r.ok) return {};
    const ct = r.headers.get("content-type") ?? "";
    let text = await r.text();
    if (ct.includes("json")) {
      try {
        const j = JSON.parse(text);
        text = typeof j === "string" ? j : String(j.content ?? j.text ?? j.body ?? "");
      } catch {}
    }
    return parseProfileMd(text);
  } catch {
    return {};
  }
}

/** Mock mode: demo seed + profile.json. Real mode: empty + profile.json + the user's Northstar profile from memory. */
export async function readProfile(): Promise<Profile> {
  if (MOCK) return { ...SEED, ...readFile() } as Profile;
  return { ...EMPTY, ...readFile(), ...(await readMemoryProfile()) } as Profile;
}

export async function writeProfile(patch: Partial<Profile>): Promise<Profile> {
  const base = MOCK ? { ...SEED, ...readFile() } : { ...readFile() };
  fs.writeFileSync(FILE, JSON.stringify({ ...base, ...patch }, null, 2));
  return readProfile();
}

export async function profileRoutes(app: FastifyInstance) {
  app.get("/profile", async () => await readProfile());
  app.put<{ Body: Partial<Profile> }>("/profile", async (req, reply) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
      return reply.code(400).send({ error: "body must be a JSON object" });
    return await writeProfile(req.body);
  });
}
