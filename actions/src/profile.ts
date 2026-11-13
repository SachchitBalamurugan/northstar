// GET/PUT /profile backed by data/profile.json. Seeded with the demo student on first run.
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { DATA_DIR, FIXTURES_DIR } from "./config.js";
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

export function readProfile(): Profile {
  try {
    return { ...SEED, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    return { ...SEED };
  }
}

export function writeProfile(patch: Partial<Profile>): Profile {
  const next = { ...readProfile(), ...patch } as Profile;
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

export async function profileRoutes(app: FastifyInstance) {
  app.get("/profile", async () => readProfile());
  app.put<{ Body: Partial<Profile> }>("/profile", async (req, reply) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
      return reply.code(400).send({ error: "body must be a JSON object" });
    return writeProfile(req.body);
  });
}
