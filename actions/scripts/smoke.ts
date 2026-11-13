// Contract smoke test for the Northstar `actions` service.
// Run: npx tsx scripts/smoke.ts            (spawns its own server on :7733, MOCK=1 HEADLESS=1)
// Env: SMOKE_PORT (default 7733), SMOKE_VERBOSE=1 (always print the server log tail).
// Only Node built-ins are used. Exits non-zero if any check fails.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT ?? 7733);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH =
  process.env.SMOKE_SCRATCH ??
  "/private/tmp/claude-501/-Users-brianhuang/189f7f62-8b0d-4d70-b12f-62f3e245a361/scratchpad";
const FIXTURE_URL = `${BASE}/fixtures/internship.html`;
const ORIGIN = "http://localhost:5173";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const REFERENCE = "Dr. Alex Lee, alex.lee@example.edu";

// ───────────────────────── server lifecycle ─────────────────────────
let child: ChildProcess | null = null;
let dataDir = "";
let logFile = "";

async function startServer(): Promise<void> {
  const already = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
  if (already) throw new Error(`port ${PORT} is already in use; refusing to test someone else's server`);

  fs.mkdirSync(SCRATCH, { recursive: true });
  dataDir = fs.mkdtempSync(path.join(SCRATCH, "actions-smoke-"));
  logFile = path.join(dataDir, "server.log");
  const out = fs.openSync(logFile, "a");
  child = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), MOCK: "1", HEADLESS: "1", ACTIONS_DATA_DIR: dataDir },
    stdio: ["ignore", out, out],
    detached: true, // own process group, so npx + tsx + node + chromium all die together
  });
  let exited: string | null = null;
  child.on("exit", (code, sig) => (exited = `code=${code} signal=${sig}`));

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited during boot (${exited})`);
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
    if (res?.ok) return;
    await sleep(300);
  }
  throw new Error("server did not answer /health within 45 s");
}

interface Proc {
  pid: number;
  ppid: number;
  cmd: string;
}
function procs(): Proc[] {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return out
      .split("\n")
      .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
  } catch {
    return [];
  }
}
/** Chromium launched by our server: its command line carries --user-data-dir=<dataDir>/browser-profile. */
const browserMain = (ps: Proc[]) => ps.find((p) => p.cmd.includes(dataDir) && !p.cmd.includes("--type="));
/** Open tabs, observed as renderer processes of our Chromium. null when the browser is not running. */
async function tabCount(): Promise<number | null> {
  await sleep(400);
  const ps = procs();
  const main = dataDir ? browserMain(ps) : undefined;
  if (!main) return null;
  return ps.filter((p) => p.ppid === main.pid && p.cmd.includes("--type=renderer")).length;
}
async function waitTabs(expected: number, ms = 5000): Promise<number | null> {
  const end = Date.now() + ms;
  let n = await tabCount();
  while (n !== expected && Date.now() < end) n = await tabCount();
  return n;
}

let stopped = false;
async function stopServer(): Promise<void> {
  if (stopped || !child?.pid) return;
  stopped = true;
  const pid = child.pid;
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 25 && alive(); i++) await sleep(200);
  if (alive()) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  // Playwright starts Chromium in its own process group; make sure none outlives the server.
  for (const p of procs().filter((p) => p.cmd.includes(dataDir)))
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      /* gone */
    }
}

function killSync() {
  if (stopped || !child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* gone */
  }
}
process.on("exit", killSync);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(sig, () => {
    killSync();
    process.exit(130);
  });

function logTail(lines = 40): string {
  try {
    return fs.readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no server log)";
  }
}

// ───────────────────────── helpers ─────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Res {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

async function http(
  method: string,
  p: string,
  opts: { body?: unknown; raw?: string; headers?: Record<string, string>; timeout?: number } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeout ?? 15_000),
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

const is4xx = (s: number) => s >= 400 && s < 500;
/** 4xx for bad input; a 404 would only mean the route is not registered. */
const badInput = (s: number) => is4xx(s) && s !== 404;
const short = (s: unknown, n = 160) => {
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return t === undefined ? "undefined" : t.length > n ? t.slice(0, n) + "…" : t;
};

const results: { name: string; ok: boolean; reason: string }[] = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    results.push({ name, ok: true, reason: note || "ok" });
    console.log(`PASS  ${name} — ${note || "ok"}`);
  } catch (err: any) {
    const reason = String(err?.message ?? err).split("\n")[0];
    results.push({ name, ok: false, reason });
    console.log(`FAIL  ${name} — ${reason}`);
  }
}

// ───────────────────────── fill helpers ─────────────────────────
type Cat =
  | "reference"
  | "linkedin"
  | "github"
  | "email"
  | "phone"
  | "gpa"
  | "gradYear"
  | "major"
  | "school"
  | "workAuth"
  | "firstName"
  | "lastName"
  | "name";

/** Classify a field description (label / name / id / selector text) into a profile category. */
function classify(descRaw: string): Cat | null {
  const d = descRaw
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase → words
    .toLowerCase()
    .replace(/\[\s*name\s*[~|^$*]?=/g, "[") // drop the attribute keyword in [name="x"] selectors
    .replace(/\b(input|select|textarea|form|label|nth-of-type|type|text|value|id|for)\b/g, " ");
  if (/referen/.test(d)) return "reference";
  if (/linked[\s_-]*in/.test(d)) return "linkedin";
  if (/git[\s_-]*hub/.test(d)) return "github";
  if (/e[\s_-]*mail/.test(d)) return "email";
  if (/phone|mobile|(^|[^a-z])tel([^a-z]|$)/.test(d)) return "phone";
  if (/(^|[^a-z])gpa([^a-z]|$)|grade[\s_-]*point/.test(d)) return "gpa";
  if (/grad/.test(d) && !/under[\s_-]*grad|post[\s_-]*grad|grade/.test(d)) return "gradYear";
  if (/grad[a-z]*[\s_-]*(year|date)|year[\s_-]*of[\s_-]*grad|class[\s_-]*of/.test(d)) return "gradYear";
  if (/(^|[^a-z])major([^a-z]|$)|field[\s_-]*of[\s_-]*study|degree[\s_-]*program/.test(d)) return "major";
  if (/school|university|college|institution/.test(d)) return "school";
  if (/authoriz|authoris|sponsor|eligib|right[\s_-]*to[\s_-]*work|work[\s_-]*auth|visa/.test(d)) return "workAuth";
  if (/company|employer|emergency|user[\s_-]*name|file|resume|cover|project|club|org/.test(d)) return null;
  if (/first[\s_-]*name|given[\s_-]*name|(^|[^a-z])fname([^a-z]|$)/.test(d)) return "firstName";
  if (/last[\s_-]*name|family[\s_-]*name|surname|(^|[^a-z])lname([^a-z]|$)/.test(d)) return "lastName";
  if (/(^|[^a-z])name([^a-z]|$)/.test(d)) return "name";
  return null;
}

const DESC_KEYS = ["label", "name", "id", "key", "field", "question", "title", "selector"];
function fieldCat(f: any): Cat | null {
  // Prefer human/semantic descriptors; fall back to the selector.
  for (const k of DESC_KEYS) {
    if (typeof f?.[k] === "string" && f[k].trim()) {
      const c = classify(f[k]);
      if (c) return c;
    }
  }
  return null;
}

function valueText(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(valueText).join(", ");
  return String(v).trim();
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const digits = (s: string) => s.replace(/\D/g, "");
const looseEq = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
};

/** Is `value` a correct answer for category `cat` given the profile? */
function correct(cat: Cat, value: string, profile: any): boolean {
  if (!value) return false;
  const first = profile.firstName ?? String(profile.name).split(/\s+/)[0];
  const last = profile.lastName ?? String(profile.name).split(/\s+/).slice(-1)[0];
  switch (cat) {
    case "name":
      return norm(value) === norm(profile.name);
    case "firstName":
      return norm(value) === norm(first);
    case "lastName":
      return norm(value) === norm(last);
    case "email":
      return norm(value) === norm(profile.email);
    case "phone":
      return digits(value).length >= 7 && digits(value).endsWith(digits(profile.phone));
    case "school":
      return looseEq(value, profile.school);
    case "major":
      return looseEq(value, profile.major);
    case "gpa":
      return Number.parseFloat(value) === Number.parseFloat(profile.gpa);
    case "gradYear":
      return value.includes(String(profile.gradYear));
    case "linkedin":
      return looseEq(value.replace(/^https?:\/\/(www\.)?/, ""), String(profile.linkedin).replace(/^https?:\/\/(www\.)?/, ""));
    case "github":
      return looseEq(value.replace(/^https?:\/\/(www\.)?/, ""), String(profile.github).replace(/^https?:\/\/(www\.)?/, ""));
    case "workAuth":
      // Form options vary ("Yes", "Authorized", "US Citizen/Authorized"…): accept any non-negative,
      // non-empty answer when the profile says the student is authorized.
      return /authoriz|authoris|citizen|yes|true|eligible|no sponsor|permanent/i.test(value)
        ? !/^\s*(no|false|not authorized)\s*$/i.test(value)
        : looseEq(value, profile.workAuthorization);
    default:
      return false;
  }
}

/** Categories the fixture form actually asks for, derived from its HTML (labels + control attributes). */
function fixtureCats(html: string): Set<Cat> {
  const cats = new Set<Cat>();
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const descs: string[] = [];
  for (const m of body.matchAll(/<(label|legend)\b[^>]*>([\s\S]*?)<\/\1>/gi))
    descs.push(m[2].replace(/<[^>]+>/g, " "));
  for (const m of body.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    for (const a of m[2].matchAll(/\b(name|id|placeholder|aria-label|autocomplete)\s*=\s*("([^"]*)"|'([^']*)')/gi))
      descs.push(a[3] ?? a[4] ?? "");
  }
  for (const d of descs) {
    const c = classify(d);
    if (c) cats.add(c);
  }
  return cats;
}

const PROFILE_CATS: Cat[] = [
  "name",
  "firstName",
  "lastName",
  "email",
  "phone",
  "school",
  "major",
  "gpa",
  "gradYear",
  "linkedin",
  "github",
  "workAuth",
];

function findScreenshot(payload: any): string | null {
  // Any string in the payload (depth ≤ 3) that looks like a base64 image.
  const seen: string[] = [];
  const walk = (v: any, depth: number) => {
    if (typeof v === "string") {
      if (v.length > 1000) seen.push(v);
    } else if (v && typeof v === "object" && depth < 3) {
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(payload, 0);
  for (const s of seen) {
    const b64 = s.replace(/^data:image\/\w+;base64,/, "");
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64.slice(0, 4000))) continue;
    const head = Buffer.from(b64.slice(0, 16), "base64");
    const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    const jpg = head[0] === 0xff && head[1] === 0xd8;
    if (png || jpg) return b64;
  }
  return null;
}

/** Payload minus the bulky / field-level parts, for searching confirmation text. */
function payloadMeta(payload: any): string {
  if (!payload || typeof payload !== "object") return String(payload ?? "");
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "fields") continue;
    if (typeof v === "string" && v.length > 1000) continue;
    o[k] = v;
  }
  return JSON.stringify(o);
}

function assertProposalShape(p: any, type: string) {
  assert.ok(p && typeof p === "object", `response is not a JSON object: ${short(p)}`);
  assert.equal(typeof p.id, "string", "proposal.id must be a string");
  assert.equal(p.type, type, `type should be "${type}", got ${short(p.type)}`);
  assert.equal(p.agent, "actions", `agent should be "actions", got ${short(p.agent)}`);
  assert.ok(typeof p.title === "string" && p.title.length > 0, "title must be a non-empty string");
  assert.ok(p.title.length <= 60, `title is ${p.title.length} chars (> 60)`);
  assert.ok(typeof p.why === "string" && p.why.trim().length > 0, "why must be a non-empty string");
  assert.ok([1, 2, 3].includes(p.urgency), `urgency must be 1|2|3, got ${short(p.urgency)}`);
  assert.ok(!Number.isNaN(Date.parse(p.createdAt)), "createdAt must be an ISO date");
}

// ───────────────────────── SSE helpers ─────────────────────────
interface Sse {
  status: number;
  contentType: string;
  frames: any[];
  badFrames: string[];
  bodyText: string;
}

async function sse(instruction: unknown, timeout = 120_000): Promise<Sse> {
  const res = await fetch(`${BASE}/sidekick`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(instruction === undefined ? {} : { instruction }),
    signal: AbortSignal.timeout(timeout),
  });
  const bodyText = await res.text(); // resolves when the server ends the stream
  const frames: any[] = [];
  const badFrames: string[] = [];
  for (const block of bodyText.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data.trim()) continue;
    try {
      frames.push(JSON.parse(data));
    } catch {
      badFrames.push(data.slice(0, 80));
    }
  }
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", frames, badFrames, bodyText };
}

function assertStream(s: Sse) {
  assert.equal(s.status, 200, `status ${s.status}: ${short(s.bodyText)}`);
  assert.match(s.contentType, /text\/event-stream/, `content-type is "${s.contentType}"`);
  assert.equal(s.badFrames.length, 0, `unparseable data frame: ${s.badFrames[0]}`);
  assert.ok(s.frames.length > 0, "no data: frames in stream");
  s.frames.forEach((f, i) => {
    assert.equal(typeof f.step, "number", `frame ${i}: step is ${typeof f.step}, expected number`);
    assert.equal(typeof f.action, "string", `frame ${i}: action is ${typeof f.action}, expected string`);
    assert.equal(typeof f.detail, "string", `frame ${i}: detail is ${typeof f.detail}, expected string`);
    if (f.screenshot !== undefined)
      assert.equal(typeof f.screenshot, "string", `frame ${i}: screenshot must be a string when present`);
  });
  const last = s.frames[s.frames.length - 1];
  assert.equal(last.action, "done", `last frame action is "${last.action}" (${short(last.detail, 80)}), expected "done"`);
}

async function sidekickTask(instruction: string): Promise<string> {
  const tabsBefore = await tabCount();
  const s = await sse(instruction);
  assertStream(s);
  assert.ok(s.frames.length <= 27, `${s.frames.length} frames (max 25 steps)`);
  const shots = s.frames.filter((f) => typeof f.screenshot === "string" && f.screenshot.length > 100);
  assert.ok(shots.length > 0, "no frame carries a screenshot");
  const b64 = shots[0].screenshot.replace(/^data:image\/\w+;base64,/, "");
  const head = Buffer.from(b64.slice(0, 16), "base64");
  assert.ok(
    (head[0] === 0x89 && head[1] === 0x50) || (head[0] === 0xff && head[1] === 0xd8),
    "screenshot is not base64 PNG/JPEG",
  );
  const last = s.frames[s.frames.length - 1];
  s.frames.forEach((f, i) => assert.equal(f.step, i + 1, `frame ${i} has step ${f.step}, expected ${i + 1}`));
  if (tabsBefore !== null) assert.equal(await waitTabs(tabsBefore), tabsBefore, "sidekick left its tab open");
  return `${s.frames.length} frames [${s.frames.map((f) => f.action).join(",")}], ${shots.length} screenshots; done: ${short(last.detail, 70)}`;
}

// ───────────────────────── checks ─────────────────────────
async function run() {
  let profile: any = null;
  let fill1: any = null;
  const fill = (profileOverride?: Record<string, string>) =>
    http("POST", "/fill", {
      body: profileOverride ? { url: FIXTURE_URL, profile: profileOverride } : { url: FIXTURE_URL },
      timeout: 120_000,
    });

  await check("1 health", async () => {
    const r = await http("GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.json?.ok, true, `ok=${short(r.json?.ok)}`);
    assert.equal(r.json?.service, "actions", `service=${short(r.json?.service)}`);
  });

  await check("2 CORS", async () => {
    const r = await http("GET", "/health", { headers: { origin: ORIGIN } });
    const acao = r.headers.get("access-control-allow-origin");
    assert.ok(acao === ORIGIN || acao === "*", `GET access-control-allow-origin=${short(acao)}`);
    const o = await http("OPTIONS", "/profile", {
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type",
      },
    });
    assert.ok(o.status >= 200 && o.status < 300, `preflight status ${o.status}`);
    const pacao = o.headers.get("access-control-allow-origin");
    assert.ok(pacao === ORIGIN || pacao === "*", `preflight allow-origin=${short(pacao)}`);
    const methods = o.headers.get("access-control-allow-methods") ?? "";
    assert.match(methods, /PUT/i, `preflight allow-methods="${methods}" lacks PUT`);
    return `allow-origin=${acao}; preflight ${o.status}, methods=${methods}`;
  });

  await check("3 profile get/put", async () => {
    const g = await http("GET", "/profile");
    assert.equal(g.status, 200);
    for (const k of [
      "name",
      "email",
      "phone",
      "school",
      "major",
      "gpa",
      "gradYear",
      "linkedin",
      "github",
      "resumePath",
      "workAuthorization",
    ])
      assert.ok(typeof g.json?.[k] === "string" && g.json[k].length > 0, `profile.${k} missing/empty`);
    const phone = "555-010-9944";
    const p = await http("PUT", "/profile", { body: { phone } });
    assert.equal(p.status, 200, `PUT status ${p.status}: ${short(p.text)}`);
    const g2 = await http("GET", "/profile");
    assert.equal(g2.json?.phone, phone, "patched phone not reflected by GET");
    assert.equal(g2.json?.email, g.json.email, "PUT patch clobbered other fields");
    assert.ok(fs.existsSync(path.join(dataDir, "profile.json")), "profile.json not written to ACTIONS_DATA_DIR");
    const badArr = await http("PUT", "/profile", { body: [1, 2] });
    assert.ok(is4xx(badArr.status), `PUT [1,2] → ${badArr.status}, expected 4xx`);
    const badJson = await http("PUT", "/profile", { raw: "{not json" });
    assert.ok(is4xx(badJson.status), `PUT malformed JSON → ${badJson.status}, expected 4xx`);
    const g3 = await http("GET", "/profile");
    assert.equal(g3.json?.name, g.json.name, "invalid PUT corrupted the profile");
    profile = g3.json;
    return `11 keys present; patch persisted; invalid bodies → ${badArr.status}/${badJson.status}`;
  });
  if (!profile) profile = (await http("GET", "/profile").catch(() => null))?.json ?? null;

  await check("4 proposals list + unknown id", async () => {
    const r = await http("GET", "/proposals?status=pending");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json), `expected array, got ${short(r.text)}`);
    assert.ok(r.json.every((p: any) => p.status === "pending"), "non-pending proposal in ?status=pending");
    const a = await http("POST", `/proposals/${UNKNOWN_ID}/approve`);
    assert.equal(a.status, 404, `approve unknown → ${a.status}`);
    const j = await http("POST", `/proposals/${UNKNOWN_ID}/reject`);
    assert.equal(j.status, 404, `reject unknown → ${j.status}`);
    return `${r.json.length} pending; unknown approve/reject → 404`;
  });

  let fixtureHtml = "";
  await check("5 fixture served", async () => {
    const r = await http("GET", "/fixtures/internship.html");
    assert.equal(r.status, 200, `status ${r.status}`);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/, "content-type is not text/html");
    assert.match(r.text, /<form[\s>]/i, "no <form> in fixture");
    fixtureHtml = r.text;
    const controls = [...r.text.matchAll(/<(input|select|textarea)\b/gi)].length;
    return `${r.text.length} bytes, ${controls} form controls, asks for: ${[...fixtureCats(r.text)].join(",")}`;
  });

  let taskId: string | null = null;
  await check("6 POST /fill on fixture", async () => {
    assert.ok(profile, "no profile available (check 3 failed)");
    const r = await fill();
    assert.equal(r.status, 200, `status ${r.status}: ${short(r.text)}`);
    const p = r.json;
    assertProposalShape(p, "fill_form");
    fill1 = p; // shape is good enough for the dependent checks
    assert.equal(p.status, "pending", `status "${p.status}", expected "pending"`);
    const fields: any[] = p.payload?.fields;
    assert.ok(Array.isArray(fields) && fields.length > 0, "payload.fields must be a non-empty array");
    fields.forEach((f, i) => {
      assert.ok(typeof f.selector === "string" && f.selector.length > 0, `fields[${i}].selector missing`);
      assert.ok("value" in f, `fields[${i}] (${f.selector}) has no value key`);
      assert.ok(
        typeof f.confidence === "number" && f.confidence >= 0 && f.confidence <= 1,
        `fields[${i}] (${f.selector}) confidence=${short(f.confidence)} not a number in 0..1`,
      );
      // Brief: "flag anything under 0.7".
      assert.equal(f.flagged, f.confidence < 0.7, `fields[${i}] (${f.selector}) confidence ${f.confidence} but flagged=${f.flagged}`);
    });
    assert.ok(findScreenshot(p.payload), "no base64 PNG/JPEG screenshot found in payload");

    // Which profile-answerable questions does the form ask? From the fixture HTML when available,
    // otherwise from the payload itself.
    const byCat = new Map<Cat, any[]>();
    for (const f of fields) {
      const c = fieldCat(f);
      if (c) byCat.set(c, [...(byCat.get(c) ?? []), f]);
    }
    const asked = new Set<Cat>(fixtureHtml ? fixtureCats(fixtureHtml) : byCat.keys());
    for (const c of byCat.keys()) asked.add(c);
    const expected = PROFILE_CATS.filter((c) => asked.has(c));
    assert.ok(expected.length >= 6, `only ${expected.length} profile-answerable fields detected (${expected.join(",")})`);

    const wrong: string[] = [];
    const good: string[] = [];
    for (const c of expected) {
      const fs_ = byCat.get(c) ?? [];
      const hit = fs_.find((f) => correct(c, valueText(f.value), profile));
      if (hit) good.push(c);
      else wrong.push(`${c}=${fs_.length ? short(fs_.map((f) => valueText(f.value)).join("|"), 40) : "<no field in payload>"}`);
    }
    const rate = good.length / expected.length;
    const pct = `${good.length}/${expected.length} (${Math.round(rate * 100)}%)`;

    // The must-be-exact ones.
    const hasName = good.includes("name") || (good.includes("firstName") && good.includes("lastName"));
    assert.ok(hasName, `name not filled correctly from profile; wrong: ${wrong.join("; ")}`);
    for (const c of ["email", "school", "major"] as Cat[])
      assert.ok(good.includes(c), `${c} not filled correctly from profile; wrong: ${wrong.join("; ")}`);
    assert.ok(rate >= 0.9, `profile fill rate ${pct} < 90%; wrong: ${wrong.join("; ")}`);

    // Resume upload and the essay (from memory context) are part of the brief.
    const resume = fields.find((f) => f.type === "file" || /resume|cv/i.test(f.label ?? ""));
    assert.ok(resume && /resume\.pdf$/.test(valueText(resume.value)), `resume not uploaded: ${short(resume)}`);
    const essay = fields.find((f) => f.type === "textarea" || /why/i.test(f.label ?? ""));
    assert.ok(essay && valueText(essay.value).length >= 80, `essay missing or too short: ${short(essay)}`);
    assert.equal(essay.flagged, true, "the drafted essay should be flagged for review");

    // Never invent a reference: it must not be in fields with a value; it must be listed as unknown
    // and a pending task proposal must ask the student for it.
    const refs = byCat.get("reference") ?? [];
    for (const f of refs)
      assert.ok(!valueText(f.value), `reference field ${f.selector} was filled with "${short(valueText(f.value), 40)}"`);
    const unknown: any[] = p.payload.unknown;
    const skipped: any[] = p.payload.skipped;
    assert.ok(Array.isArray(unknown) && Array.isArray(skipped), "payload.unknown / payload.skipped must be arrays");
    assert.ok(unknown.some((f) => /referen/i.test(f.label)), `reference not listed in payload.unknown: ${short(unknown)}`);
    assert.equal(unknown.length, 1, `expected only the reference to be unknown, got: ${unknown.map((f) => f.label).join(" | ")}`);
    assert.ok(skipped.some((f) => /hear/i.test(f.label)), `"How did you hear about us?" not in payload.skipped: ${short(skipped)}`);
    assert.equal(skipped.length, 1, `expected only hear-about to be skipped, got: ${skipped.map((f) => f.label).join(" | ")}`);
    assert.ok(!fields.some((f) => /hear/i.test(f.label ?? "")), "hear-about was answered (invented)");

    assert.equal(p.payload.totalCount, 15, `totalCount=${p.payload.totalCount}, the fixture has 15 fields`);
    assert.equal(p.payload.filledCount, fields.length, "filledCount does not match fields.length");
    assert.equal(fields.length + unknown.length + skipped.length, 15, "fields + unknown + skipped != 15");
    assert.equal(p.payload.pages, 2, `pages=${p.payload.pages}, the fixture has 2 pages`);

    taskId = p.payload.taskProposalId ?? null;
    assert.equal(typeof taskId, "string", "no payload.taskProposalId for the unknown required field");
    const pend = (await http("GET", "/proposals?status=pending")).json as any[];
    const task = pend.find((x) => x.id === taskId);
    assert.ok(task, "taskProposalId does not point at a pending proposal");
    assertProposalShape(task, "task");
    assert.match(`${task.title} ${task.why} ${JSON.stringify(task.payload)}`, /referen/i, "task proposal does not mention the reference");

    const lowConf = fields.filter((f) => f.confidence < 0.7).length;
    return `profile-answerable ${pct}; overall ${fields.length}/15 filled (${Math.round((fields.length / 15) * 100)}%); reference → unknown + task proposal; hear-about → skipped; ${lowConf} flagged <0.7; mapper=${p.payload.mapper}`;
  });

  await check("7 fill proposal is pending, not submitted", async () => {
    assert.ok(fill1?.id, "no fill proposal (check 6 failed before returning one)");
    const r = await http("GET", "/proposals?status=pending");
    assert.ok(Array.isArray(r.json), "pending list is not an array");
    const p = r.json.find((x: any) => x.id === fill1.id);
    assert.ok(p, "fill proposal not in GET /proposals?status=pending");
    assert.equal(p.status, "pending");
    assert.ok(
      !("confirmation" in (p.payload ?? {})) && p.payload?.submitted !== true,
      `payload already carries a submission marker: ${short(payloadMeta(p.payload))}`,
    );
    const all = await http("GET", "/proposals");
    assert.ok(Array.isArray(all.json) && all.json.some((x: any) => x.id === fill1.id), "not in unfiltered list");
    return `proposal ${fill1.id.slice(0, 8)} pending, no confirmation yet`;
  });

  await check("8a /submit with a required field unanswered → failed, clear error", async () => {
    assert.ok(fill1?.id, "no fill proposal (check 6 failed before returning one)");
    const r = await http("POST", "/submit", { body: { proposalId: fill1.id }, timeout: 120_000 });
    assert.equal(r.status, 200, `status ${r.status}: ${short(r.text)}`);
    assert.equal(r.json?.id, fill1.id, "response is not the same proposal");
    assert.equal(r.json?.status, "failed", `status "${r.json?.status}", expected "failed" (reference is required and empty)`);
    const err = r.json.payload?.error;
    assert.ok(typeof err === "string" && /referen/i.test(err), `payload.error does not name the missing field: ${short(err)}`);
    assert.notEqual(r.json.payload.submitted, true, "failed proposal is marked submitted");
    assert.ok(!r.json.payload.confirmation, "failed proposal carries a confirmation");
    const pend = (await http("GET", "/proposals?status=pending")).json as any[];
    assert.ok(!pend.some((x) => x.id === fill1.id), "failed proposal still listed as pending");
    // Retrying a failed proposal must not flip it to done.
    const again = await http("POST", "/submit", { body: { proposalId: fill1.id }, timeout: 120_000 });
    assert.equal(again.json?.status, "failed", `second submit of a failed proposal → "${again.json?.status}"`);
    assert.equal((await http("GET", "/health")).status, 200, "server unhealthy after failed submit");
    return `failed: ${short(err, 110)}`;
  });

  await check("8b fill with reference supplied → /submit → done", async () => {
    const r = await fill({ reference: REFERENCE });
    assert.equal(r.status, 200, `fill status ${r.status}: ${short(r.text)}`);
    const p = r.json;
    assertProposalShape(p, "fill_form");
    const ref = (p.payload.fields as any[]).find((f) => /referen/i.test(f.label ?? ""));
    assert.equal(ref?.value, REFERENCE, `reference field value: ${short(ref?.value)}`);
    assert.equal(p.payload.unknown.length, 0, `unknown should be empty: ${short(p.payload.unknown)}`);
    assert.ok(!p.payload.taskProposalId, "a task proposal was created although nothing required is unknown");
    assert.equal(p.payload.filledCount, 14, `filledCount=${p.payload.filledCount}, expected 14 of 15`);
    const prof = (await http("GET", "/profile")).json;
    assert.ok(!("reference" in prof), "the per-request profile override was persisted to /profile");
    const shotBefore = p.payload.screenshot;

    const s = await http("POST", "/submit", { body: { proposalId: p.id }, timeout: 120_000 });
    assert.equal(s.status, 200, `submit status ${s.status}: ${short(s.text)}`);
    assert.equal(s.json?.id, p.id, "response is not the same proposal");
    assert.equal(s.json?.status, "done", `status "${s.json?.status}"${s.json?.payload?.error ? ` error: ${short(s.json.payload.error, 120)}` : ""}`);
    assert.equal(s.json.payload.submitted, true, "payload.submitted !== true");
    const conf = s.json.payload.confirmation;
    assert.ok(typeof conf === "string" && /submitted|received|thank/i.test(conf), `payload.confirmation: ${short(conf)}`);
    // The fixture's confirmation echoes the name that was really typed into the DOM.
    assert.ok(conf.includes(`${profile.firstName} ${profile.lastName}`), `confirmation does not echo the applicant name: ${short(conf)}`);
    assert.ok(findScreenshot(s.json.payload), "no screenshot after submit");
    assert.notEqual(s.json.payload.screenshot, shotBefore, "screenshot was not replaced after submit");
    assert.ok(Array.isArray(s.json.payload.fields) && s.json.payload.fields.length === 14, "fields lost after submit");
    const pend = (await http("GET", "/proposals?status=pending")).json as any[];
    assert.ok(!pend.some((x) => x.id === p.id), "submitted proposal still listed as pending");
    const again = await http("POST", "/submit", { body: { proposalId: p.id }, timeout: 60_000 });
    assert.equal(again.json?.status, "done", "re-submitting a done proposal changed its status");
    return `done; confirmation: ${short(conf, 100)}`;
  });

  await check("8c approving the proposal submits (POST /proposals/:id/approve)", async () => {
    const r = await fill({ reference: REFERENCE });
    assert.equal(r.status, 200, `fill status ${r.status}: ${short(r.text)}`);
    const a = await http("POST", `/proposals/${r.json.id}/approve`, { timeout: 120_000 });
    assert.equal(a.status, 200, `approve status ${a.status}: ${short(a.text)}`);
    assert.equal(a.json?.status, "done", `status "${a.json?.status}"${a.json?.payload?.error ? ` error: ${short(a.json.payload.error, 120)}` : ""}`);
    assert.equal(a.json.payload.submitted, true, "payload.submitted !== true");
    assert.match(String(a.json.payload.confirmation), /submitted/i, "no confirmation");
    return `done via approve; confirmation: ${short(a.json.payload.confirmation, 80)}`;
  });

  await check("8d /submit validation", async () => {
    const unk = await http("POST", "/submit", { body: { proposalId: UNKNOWN_ID }, timeout: 60_000 });
    assert.equal(unk.status, 404, `unknown proposalId → ${unk.status}, expected 404`);
    const none = await http("POST", "/submit", { body: {}, timeout: 60_000 });
    assert.equal(none.status, 400, `missing proposalId → ${none.status}, expected 400`);
    const num = await http("POST", "/submit", { body: { proposalId: 7 }, timeout: 60_000 });
    assert.equal(num.status, 400, `numeric proposalId → ${num.status}, expected 400`);
    const nobody = await http("POST", "/submit", { timeout: 60_000 });
    assert.ok(badInput(nobody.status), `no body → ${nobody.status}, expected 4xx`);
    assert.ok(taskId, "no task proposal from check 6 to test the non-fill_form case");
    const task = await http("POST", "/submit", { body: { proposalId: taskId }, timeout: 60_000 });
    assert.equal(task.status, 400, `task proposal → ${task.status}, expected 400`);
    const all = (await http("GET", "/proposals")).json as any[];
    assert.equal(all.find((x) => x.id === taskId)?.status, "pending", "the task proposal was changed by /submit");
    return `unknown → 404, missing → ${none.status}, numeric → ${num.status}, no body → ${nobody.status}, task proposal → 400 and left pending`;
  });

  let rejectedTabs: { afterFill: number | null; afterReject: number | null; id: string } | null = null;
  await check("9 reject flow", async () => {
    const r = await fill({ reference: REFERENCE }); // would submit successfully if anything submitted it
    assert.equal(r.status, 200, `fill status ${r.status}: ${short(r.text)}`);
    const id = r.json?.id;
    assert.ok(typeof id === "string", "/fill returned no proposal id");
    assert.notEqual(id, fill1?.id, "/fill reused an earlier proposal id");
    assert.equal(r.json.status, "pending");
    const afterFill = await tabCount();
    const rej = await http("POST", `/proposals/${id}/reject`, { timeout: 60_000 });
    assert.equal(rej.status, 200, `reject status ${rej.status}`);
    assert.equal(rej.json?.status, "rejected", `after reject status="${rej.json?.status}"`);
    const app = await http("POST", `/proposals/${id}/approve`, { timeout: 120_000 });
    assert.ok(app.status === 200 || is4xx(app.status), `approve-after-reject → ${app.status}`);
    const sub = await http("POST", "/submit", { body: { proposalId: id }, timeout: 120_000 });
    assert.ok(sub.status === 200 || is4xx(sub.status), `submit-after-reject → ${sub.status}`);
    const all = await http("GET", "/proposals");
    const now = all.json.find((x: any) => x.id === id);
    assert.equal(now?.status, "rejected", `after approve+submit of a rejected proposal status="${now?.status}"`);
    assert.ok(!now.payload.confirmation && now.payload.submitted !== true, "rejected proposal was submitted");
    rejectedTabs = { afterFill, afterReject: await tabCount(), id };
    return `rejected stays rejected, never submitted (approve → ${app.status}, submit → ${sub.status})`;
  });

  await check("9b stale tab of a rejected fill is closed by the next /fill [OS process table, not HTTP]", async () => {
    // No HTTP endpoint exposes open tabs. Observed instead through Chromium's renderer processes
    // (one per open tab, measured: blank tab + one per kept-open form).
    assert.ok(rejectedTabs, "check 9 did not get far enough");
    const { afterFill, afterReject } = rejectedTabs!;
    assert.ok(afterFill !== null && afterReject !== null, "could not find the Chromium process for this server (not observable)");
    const r = await fill();
    assert.equal(r.status, 200, `fill status ${r.status}`);
    // The rejected tab closes and one new tab opens → same count as right after the rejected fill.
    const settled = await waitTabs(afterFill!);
    assert.equal(settled, afterFill, `renderers: ${afterFill} after fill, ${afterReject} after reject, ${settled} after the next fill (expected ${afterFill}; a leak would be ${afterFill! + 1})`);
    // And it keeps holding: reject + fill again does not grow the count either.
    await http("POST", `/proposals/${r.json.id}/reject`);
    const r2 = await fill();
    const settled2 = await waitTabs(afterFill!);
    assert.equal(settled2, afterFill, `renderers grew to ${settled2} after a second reject+fill cycle`);
    await http("POST", `/proposals/${r2.json.id}/reject`);
    return `renderer processes: ${afterFill} after fill → ${afterReject} after reject (tab stays until the next /fill) → ${settled} after next /fill → ${settled2} after another cycle`;
  });

  await check("10 /fill input validation", async () => {
    const before = (await http("GET", "/proposals")).json?.length ?? 0;
    const none = await http("POST", "/fill", { body: {}, timeout: 60_000 });
    assert.ok(badInput(none.status), `missing url → ${none.status}, expected 4xx`);
    const file = await http("POST", "/fill", { body: { url: "file:///etc/passwd" }, timeout: 60_000 });
    assert.ok(badInput(file.status), `file:///etc/passwd → ${file.status}, expected 4xx: ${short(file.text, 80)}`);
    assert.ok(!/root:|nobody:/.test(file.text), "response leaks file contents");
    const junk = await http("POST", "/fill", { body: { url: "not a url" }, timeout: 60_000 });
    assert.ok(badInput(junk.status), `"not a url" → ${junk.status}, expected 4xx`);
    const num = await http("POST", "/fill", { body: { url: 42 }, timeout: 60_000 });
    assert.ok(badInput(num.status), `url: 42 → ${num.status}, expected 4xx`);
    const js = await http("POST", "/fill", { body: { url: "javascript:alert(1)" }, timeout: 60_000 });
    assert.ok(badInput(js.status), `javascript: url → ${js.status}, expected 4xx`);
    const prof = await http("POST", "/fill", { body: { url: FIXTURE_URL, profile: "x" }, timeout: 60_000 });
    assert.ok(badInput(prof.status), `profile: "x" → ${prof.status}, expected 4xx`);
    const nobody = await http("POST", "/fill", { timeout: 60_000 });
    assert.ok(badInput(nobody.status), `no body → ${nobody.status}, expected 4xx`);
    // Unreachable page: an error response, not a hang or a crash, and no orphan proposal.
    // (The first call also flushes stale tabs of earlier rejected fills, so compare call 1 vs call 2.)
    const deadFill = () => http("POST", "/fill", { body: { url: "http://127.0.0.1:9/nope" }, timeout: 60_000 });
    const dead = await deadFill();
    assert.ok(dead.status >= 400 && typeof dead.json?.error === "string", `unreachable url → ${dead.status} ${short(dead.text, 80)}`);
    await sleep(1000);
    const tabsBefore = await tabCount();
    const dead2 = await deadFill();
    assert.equal(dead2.status, dead.status, `second unreachable /fill → ${dead2.status}`);
    if (tabsBefore !== null) {
      const tabsAfter = await waitTabs(tabsBefore);
      assert.equal(tabsAfter, tabsBefore, `a failed /fill left its tab open (renderers ${tabsBefore} → ${tabsAfter})`);
    }
    const after = (await http("GET", "/proposals")).json?.length ?? 0;
    assert.equal(after, before, "a rejected /fill request still created a proposal");
    const h = await http("GET", "/health");
    assert.equal(h.status, 200, "server unhealthy after bad /fill input");
    return `missing → ${none.status}, file:// → ${file.status}, junk → ${junk.status}, number → ${num.status}, javascript: → ${js.status}, bad profile → ${prof.status}, no body → ${nobody.status}, unreachable → ${dead.status}`;
  });

  await check("11a sidekick: unsubscribe", () => sidekickTask("unsubscribe from the Campus Deals newsletter"));
  await check("11b sidekick: find syllabus", () => sidekickTask("find the CS 101 syllabus"));

  await check("12 sidekick: desktop task falls back", async () => {
    const before: any[] = (await http("GET", "/proposals?status=pending")).json ?? [];
    const s = await sse("open Excel and make a budget spreadsheet");
    assert.equal(s.status, 200, `status ${s.status}: ${short(s.bodyText)}`);
    assert.match(s.contentType, /text\/event-stream/, `content-type is "${s.contentType}"`);
    assert.equal(s.badFrames.length, 0, `unparseable data frame: ${s.badFrames[0]}`);
    assert.ok(s.frames.length > 0, "no frames");
    s.frames.forEach((f, i) =>
      assert.ok(
        typeof f.step === "number" && typeof f.action === "string" && typeof f.detail === "string",
        `frame ${i} malformed: ${short(f, 80)}`,
      ),
    );
    const after: any[] = (await http("GET", "/proposals?status=pending")).json ?? [];
    const ids = new Set(before.map((p) => p.id));
    const newTask = after.find((p) => !ids.has(p.id) && p.type === "task");
    const msg = s.frames.find((f) => /browser/i.test(f.detail));
    assert.ok(msg || newTask, `neither a browser-instead message nor a new task proposal; frames: ${short(s.frames.map((f) => `${f.action}:${f.detail}`), 200)}`);
    if (newTask) assertProposalShape(newTask, "task");
    const last = s.frames[s.frames.length - 1];
    assert.equal(last.action, "done", `stream did not end with a "done" frame (last: ${last.action})`);
    return `${s.frames.length} frame(s); message: ${msg ? short(msg.detail, 70) : "none"}; task proposal: ${newTask ? short(newTask.title, 50) : "none"}`;
  });

  await check("13 sidekick: empty instruction", async () => {
    const empty = await http("POST", "/sidekick", { body: { instruction: "" }, timeout: 30_000 });
    assert.ok(is4xx(empty.status), `instruction "" → ${empty.status}, expected 4xx`);
    const blank = await http("POST", "/sidekick", { body: { instruction: "   " }, timeout: 30_000 });
    assert.ok(is4xx(blank.status), `whitespace instruction → ${blank.status}, expected 4xx`);
    const none = await http("POST", "/sidekick", { body: {}, timeout: 30_000 });
    assert.ok(is4xx(none.status), `missing instruction → ${none.status}, expected 4xx`);
    return `"" → ${empty.status}, blank → ${blank.status}, missing → ${none.status}`;
  });

  await check("15 sidekick safety classifier [unit test of src/sidekick/safety.ts; runtime stop path NOT reachable in MOCK]", async () => {
    // In MOCK mode /sidekick only drives the two fixed fixtures (neither has a payment/password/submit
    // control) or a canned stream, so hardStop() cannot be triggered over HTTP without an LLM.
    // This exercises the pure classifier that guards every click/type instead.
    const { classifyAction, needsDesktop } = await import("../src/sidekick/safety.ts");
    const cases: [string, any, boolean, string?][] = [
      ["click Submit application", { action: "click", tag: "button", text: "Submit application" }, true, "submit"],
      ["click <input type=submit> without text", { action: "click", tag: "input", type: "submit", text: "" }, true, "submit"],
      ["click Send", { action: "click", tag: "button", text: "Send" }, true, "submit"],
      ["click Pay now", { action: "click", tag: "button", text: "Pay now" }, true, "payment"],
      ["click Place order", { action: "click", tag: "button", text: "Place order" }, true, "payment"],
      ["click link to /checkout", { action: "click", tag: "a", text: "Continue", href: "/cart/checkout" }, true, "payment"],
      ["type into password input", { action: "type", tag: "input", type: "password", typedText: "hunter2" }, true, "password"],
      ["type into text input labelled Password", { action: "type", tag: "input", type: "text", label: "Password" }, true, "password"],
      ["type into cc-number field", { action: "type", tag: "input", autocomplete: "cc-number", typedText: "1" }, true, "payment"],
      ["type a card number anywhere", { action: "type", tag: "input", label: "Notes", typedText: "4111 1111 1111 1111" }, true, "payment"],
      ["click Unsubscribe", { action: "click", tag: "button", text: "Unsubscribe" }, false],
      ["click Submit unsubscribe request", { action: "click", tag: "button", text: "Submit unsubscribe request" }, false],
      ["click Next", { action: "click", tag: "button", text: "Next" }, false],
      ["click syllabus link", { action: "click", tag: "a", text: "CS 101 syllabus", href: "/fixtures/syllabus.html" }, false],
      ["type a search query", { action: "type", tag: "input", type: "search", name: "q", typedText: "cs 101 syllabus" }, false],
      ["click Forgot password? link", { action: "click", tag: "a", text: "Forgot password?" }, false],
    ];
    const bad: string[] = [];
    for (const [name, target, stop, cat] of cases) {
      const v = classifyAction(target);
      if (v.stop !== stop || (stop && cat && v.category !== cat)) bad.push(`${name} → stop=${v.stop} category=${v.category}`);
    }
    assert.equal(bad.length, 0, `misclassified: ${bad.join("; ")}`);
    assert.equal(needsDesktop("open Excel and make a budget spreadsheet"), true);
    assert.equal(needsDesktop("find the CS 101 syllabus"), false);
    assert.equal(needsDesktop("unsubscribe from the Campus Deals newsletter"), false);
    return `${cases.length} classifier cases correct; hardStop()/"stopped" frame itself is unverified at runtime`;
  });

  await check("16 GET /proposals response size [informational]", async () => {
    const all = await http("GET", "/proposals", { timeout: 60_000 });
    const pend = await http("GET", "/proposals?status=pending", { timeout: 60_000 });
    assert.ok(Array.isArray(all.json), "not an array");
    const fills = all.json.filter((p: any) => p.type === "fill_form");
    const shots = fills.map((p: any) => (typeof p.payload?.screenshot === "string" ? p.payload.screenshot.length : 0));
    const shotBytes = shots.reduce((a: number, b: number) => a + b, 0);
    const kb = (n: number) => `${Math.round(n / 1024)} KB`;
    const disk = fs.statSync(path.join(dataDir, "proposals.json")).size;
    return `${all.json.length} proposals (${fills.length} fill_form): GET /proposals = ${kb(all.text.length)}, ?status=pending = ${kb(pend.text.length)}, proposals.json = ${kb(disk)}; screenshots are ${kb(shotBytes)} of it (avg ${kb(shotBytes / Math.max(1, fills.length))} per fill, max ${kb(Math.max(0, ...shots))})`;
  });

  await check("14 still healthy", async () => {
    const r = await http("GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.json?.ok, true);
    assert.equal(child?.exitCode, null, "server process exited");
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    const fatal = log.split("\n").filter((l) => /"level":60|UnhandledPromiseRejection|uncaughtException|ERR_UNHANDLED/.test(l));
    assert.equal(fatal.length, 0, `fatal lines in server log: ${short(fatal[0])}`);
    const fives = log.split("\n").filter((l) => /"statusCode":5\d\d/.test(l)).length;
    return `ok; server log: no fatal lines, ${fives} 5xx response(s) (2 expected: the unreachable-URL /fill calls)`;
  });
}

// ───────────────────────── main ─────────────────────────
let bootError: string | null = null;
try {
  await startServer();
  console.log(`server up on ${BASE} (data dir ${dataDir})\n`);
  await run();
} catch (err: any) {
  bootError = String(err?.stack ?? err);
} finally {
  await stopServer();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n──── summary: ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total ────`);
for (const f of failed) console.log(`  FAIL ${f.name}: ${f.reason}`);
if (bootError) console.log(`\nABORTED: ${bootError}`);
if (bootError || failed.length || process.env.SMOKE_VERBOSE === "1") {
  console.log(`\nserver log: ${logFile}`);
  if (bootError || process.env.SMOKE_VERBOSE === "1") console.log(logTail());
}
process.exit(bootError || failed.length ? 1 : 0);
