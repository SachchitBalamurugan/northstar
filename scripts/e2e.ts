// End-to-end test for Northstar: memory :7701, inbox :7702, actions :7703 and the web UI :5199.
// Run from the repo root:   npx --prefix actions tsx scripts/e2e.ts [--only memory,inbox,actions,ui,cross]
// Starts every service that exists (MOCK=1 HEADLESS=1, fresh temp data dirs), runs contract checks derived from
// the SHARED CONTRACT and from what app/src/renderer/src/api.ts consumes, then tears everything down.
//   --real   one real-mode pass instead (MOCK=0, model calls with the key from .env; inbox stays on fixture mail)
// Only Node built-ins plus the tsx/playwright already installed in actions/node_modules. Exit code 1 on any FAIL.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(path.resolve(process.argv[1])), "..");
const SCRATCH =
  process.env.E2E_SCRATCH ?? path.join(os.tmpdir(), "northstar-e2e");
const MEM = "http://127.0.0.1:7701";
const INBOX = "http://127.0.0.1:7702";
const ACT = "http://127.0.0.1:7703";
const UI = "http://localhost:5199";
const ORIGIN = "http://localhost:5199";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const REFERENCE = "Dr. Alex Lee, alex.lee@example.edu";
const SMOKE_PORT = 7743; // actions' own smoke suite; not 7733 so it cannot collide with a builder running it

type Section = "memory" | "inbox" | "actions" | "ui" | "cross";
const ALL: Section[] = ["memory", "inbox", "actions", "cross", "ui"];
const onlyArg = process.argv.find((a) => a.startsWith("--only"));
const onlyVal = onlyArg ? (onlyArg.includes("=") ? onlyArg.split("=")[1] : process.argv[process.argv.indexOf(onlyArg) + 1]) : "";
const ONLY = new Set<Section>(onlyVal ? (onlyVal.split(",").map((s) => s.trim()) as Section[]) : ALL);
const want = (s: Section) => ONLY.has(s);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: unknown, n = 170) => {
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return t === undefined ? "undefined" : t.length > n ? t.slice(0, n) + "…" : t;
};

// ───────────────────────── results ─────────────────────────
class Skip extends Error {}
const skip = (why: string): never => {
  throw new Skip(why);
};
const results: { name: string; status: "PASS" | "FAIL" | "SKIP"; reason: string }[] = [];
function record(name: string, status: "PASS" | "FAIL" | "SKIP", reason: string) {
  results.push({ name, status, reason });
  console.log(`${status}  ${name} — ${reason}`);
}
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    record(name, "PASS", (await fn()) || "ok");
  } catch (err: any) {
    const reason = String(err?.message ?? err).split("\n").slice(0, 2).join(" ");
    record(name, err instanceof Skip ? "SKIP" : "FAIL", reason);
  }
}

// ───────────────────────── http ─────────────────────────
interface Res {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  ms: number;
}
async function http(
  method: string,
  url: string,
  opts: { body?: unknown; raw?: string; headers?: Record<string, string>; timeout?: number } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  const t0 = performance.now();
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(opts.timeout ?? 15_000) });
  const text = await res.text();
  const ms = performance.now() - t0;
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json, ms };
}
const ok2xx = (r: Res, what: string) => assert.ok(r.status >= 200 && r.status < 300, `${what} → ${r.status}: ${short(r.text, 120)}`);

// ───────────────────────── service lifecycle ─────────────────────────
type SvcName = "memory" | "inbox" | "actions" | "ui";
interface Svc {
  name: SvcName;
  port: number;
  cwd: string;
  entry: string[]; // every path must exist for the service to count as built
  cmd: string;
  args: string[];
  env: Record<string, string>;
  health: string;
  bootMs: number;
  state: "not-built" | "up" | "boot-failed" | "not-started";
  why?: string;
  child?: ChildProcess;
  log?: string;
}
const RUN_DIR = (() => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH, "e2e-"));
})();
const dataDir = (n: string) => {
  const d = path.join(RUN_DIR, n);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const REAL = process.argv.includes("--real"); // real-mode pass: MOCK=0, model calls with the key from .env
const BASE_ENV = { MOCK: REAL ? "0" : "1", INBOX_DEMO: "1", HEADLESS: "1", MEMORY_URL: MEM, DESKTOP_CONTROL: "0" }; // never drive the real desktop
// memory mirrors facts into umem, whose global store lives under $HOME: give it a throw-away HOME so a test
// run never writes to the real home directory. uv keeps using its real cache and interpreters.
const uvDir = (...a: string[]) => {
  try {
    return execFileSync("uv", a, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const SANDBOX_HOME = { HOME: dataDir("home"), UV_CACHE_DIR: uvDir("cache", "dir"), UV_PYTHON_INSTALL_DIR: uvDir("python", "dir") };
const svcs: Record<SvcName, Svc> = {
  memory: {
    name: "memory", port: 7701, cwd: path.join(ROOT, "memory"), entry: ["main.py"],
    cmd: "uv", args: ["run", "uvicorn", "main:app", "--port", "7701"],
    env: { ...SANDBOX_HOME, MEMORY_DATA_DIR: dataDir("memory-data") }, health: `${MEM}/health`, bootMs: 150_000, state: "not-started",
  },
  inbox: {
    name: "inbox", port: 7702, cwd: path.join(ROOT, "inbox"), entry: ["src/server.ts", "node_modules"],
    cmd: "npx", args: ["tsx", "src/server.ts"],
    env: { PORT: "7702", INBOX_DATA_DIR: dataDir("inbox-data") }, health: `${INBOX}/health`, bootMs: 60_000, state: "not-started",
  },
  actions: {
    name: "actions", port: 7703, cwd: path.join(ROOT, "actions"), entry: ["src/server.ts", "node_modules"],
    cmd: "npx", args: ["tsx", "src/server.ts"],
    env: { PORT: "7703", ACTIONS_DATA_DIR: dataDir("actions-data") }, health: `${ACT}/health`, bootMs: 60_000, state: "not-started",
  },
  ui: {
    name: "ui", port: 5199, cwd: path.join(ROOT, "app"), entry: ["vite.web.config.ts", "node_modules"],
    cmd: "npm", args: ["run", "web"], env: {}, health: `${UI}/`, bootMs: 60_000, state: "not-started",
  },
};
const up = (n: SvcName) => svcs[n].state === "up";
const need = (...ns: SvcName[]) => {
  for (const n of ns) if (!up(n)) skip(`${n} ${svcs[n].state === "not-built" ? "NOT BUILT YET" : svcs[n].state}${svcs[n].why ? ` (${svcs[n].why})` : ""}`);
};

function portTaken(port: number): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ host, port });
      const done = (v: boolean) => {
        s.destroy();
        resolve(v);
      };
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
      s.setTimeout(1000, () => done(false));
    });
  return Promise.all([tryHost("127.0.0.1"), tryHost("::1")]).then((r) => r.some(Boolean));
}

function logTail(s: Svc, lines = 12): string {
  try {
    return fs.readFileSync(s.log!, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

async function startSvc(s: Svc): Promise<void> {
  const missing = s.entry.filter((e) => !fs.existsSync(path.join(s.cwd, e)));
  if (missing.length) {
    s.state = "not-built";
    s.why = `missing ${s.name === "ui" ? "app" : s.name}/${missing[0]}`;
    return;
  }
  s.log = path.join(RUN_DIR, `${s.name}.log`);
  const out = fs.openSync(s.log, "a");
  s.child = spawn(s.cmd, s.args, {
    cwd: s.cwd,
    env: { ...process.env, ...BASE_ENV, ...s.env },
    stdio: ["ignore", out, out],
    detached: true, // own process group
  });
  let exited: string | null = null;
  s.child.on("exit", (code, sig) => (exited = `code=${code} signal=${sig}`));
  s.child.on("error", (e) => (exited = `spawn error: ${e.message}`));
  const deadline = Date.now() + s.bootMs;
  while (Date.now() < deadline) {
    if (exited) {
      s.state = "boot-failed";
      s.why = `exited during boot (${exited}); last log line: ${short(logTail(s, 1), 200)}`;
      return;
    }
    const res = await fetch(s.health, { signal: AbortSignal.timeout(1500) }).catch(() => null);
    if (res?.ok) {
      s.state = "up";
      return;
    }
    await sleep(300);
  }
  s.state = "boot-failed";
  s.why = `no answer on ${s.health} within ${s.bootMs / 1000}s; last log line: ${short(logTail(s, 1), 200)}`;
}

const extraChildren: ChildProcess[] = [];
function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
function killGroup(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig);
  } catch {
    /* gone */
  }
}
/** Chromium launched by our servers runs in its own group; it is recognisable by our temp dir on its command line. */
function killStrays() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    for (const l of out.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(l);
      if (m && m[2].includes(RUN_DIR) && Number(m[1]) !== process.pid)
        try {
          process.kill(Number(m[1]), "SIGKILL");
        } catch {
          /* gone */
        }
    }
  } catch {
    /* ps failed */
  }
}
let tornDown = false;
async function teardown() {
  if (tornDown) return;
  tornDown = true;
  const pids = [...Object.values(svcs).map((s) => s.child?.pid), ...extraChildren.map((c) => c.pid)].filter((p): p is number => !!p);
  for (const pid of pids) killGroup(pid, "SIGTERM");
  for (let i = 0; i < 25 && pids.some(groupAlive); i++) await sleep(200);
  for (const pid of pids) if (groupAlive(pid)) killGroup(pid, "SIGKILL");
  killStrays();
}
function teardownSync() {
  for (const c of extraChildren) if (c.pid && c.exitCode === null) killGroup(c.pid, "SIGKILL");
  if (tornDown) return;
  tornDown = true;
  for (const s of Object.values(svcs)) if (s.child?.pid) killGroup(s.child.pid, "SIGKILL");
  killStrays();
}
process.on("exit", teardownSync);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(sig, () => {
    teardownSync();
    process.exit(130);
  });

// ───────────────────────── shared assertions ─────────────────────────
const TYPES = ["send_reply", "create_event", "fill_form", "submit_form", "unsubscribe", "task"];
const STATUSES = ["pending", "approved", "rejected", "done", "failed"];
const isIso = (x: unknown) => typeof x === "string" && x.length >= 10 && !Number.isNaN(Date.parse(x));
function proposalProblems(p: any, agent?: string): string[] {
  const out: string[] = [];
  if (!p || typeof p !== "object") return ["not an object"];
  if (typeof p.id !== "string" || !p.id) out.push("id missing");
  if (agent ? p.agent !== agent : !["ui", "memory", "inbox", "actions"].includes(p.agent)) out.push(`agent=${short(p.agent)}${agent ? ` (expected ${agent})` : ""}`);
  if (!isIso(p.createdAt)) out.push(`createdAt=${short(p.createdAt)}`);
  if (!TYPES.includes(p.type)) out.push(`type=${short(p.type)}`);
  if (typeof p.title !== "string" || !p.title.trim()) out.push("title empty");
  else if ([...p.title].length > 60) out.push(`title is ${[...p.title].length} chars (> 60): "${short(p.title, 70)}"`);
  if (typeof p.why !== "string" || !p.why.trim()) out.push("why empty");
  if (![1, 2, 3].includes(p.urgency)) out.push(`urgency=${short(p.urgency)}`);
  if (!STATUSES.includes(p.status)) out.push(`status=${short(p.status)}`);
  if (!("payload" in p)) out.push("payload missing");
  return out.map((m) => `[${short(p.title ?? p.id, 40)}] ${m}`);
}
function assertProposals(list: any, agent: string | undefined, what: string) {
  assert.ok(Array.isArray(list), `${what} is not an array: ${short(list)}`);
  const probs = (list as any[]).flatMap((p) => proposalProblems(p, agent));
  assert.equal(probs.length, 0, `${what}: ${probs.slice(0, 3).join("; ")}${probs.length > 3 ? ` (+${probs.length - 3} more)` : ""}`);
}
async function corsCheck(base: string, method: "PUT" | "POST", p: string) {
  const g = await http("GET", `${base}/health`, { headers: { origin: ORIGIN } });
  const acao = g.headers.get("access-control-allow-origin");
  assert.ok(acao === "*" || acao === ORIGIN, `GET /health with Origin ${ORIGIN}: access-control-allow-origin = ${acao}`);
  const o = await http("OPTIONS", `${base}${p}`, {
    headers: { origin: ORIGIN, "access-control-request-method": method, "access-control-request-headers": "content-type" },
  });
  assert.ok(o.status < 300, `preflight OPTIONS ${p} → ${o.status}`);
  const pa = o.headers.get("access-control-allow-origin");
  assert.ok(pa === "*" || pa === ORIGIN, `preflight ${p}: access-control-allow-origin = ${pa}`);
  const am = o.headers.get("access-control-allow-methods") ?? "";
  assert.ok(am.includes("*") || am.toUpperCase().includes(method), `preflight ${p}: allow-methods "${am}" lacks ${method}`);
  const ah = (o.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  assert.ok(ah.includes("*") || ah.includes("content-type"), `preflight ${p}: allow-headers "${ah}" lacks content-type`);
  return `allow-origin ${acao}; preflight ${method} ${p} ok`;
}
async function healthCheck(base: string, service: string) {
  const r = await http("GET", `${base}/health`);
  assert.equal(r.status, 200, `status ${r.status}`);
  assert.equal(r.json?.ok, true, `ok=${short(r.json?.ok)}`);
  assert.equal(r.json?.service, service, `service=${short(r.json?.service)}`);
  return short(r.json);
}
async function proposalRoutes(base: string, agent: string) {
  const all = await http("GET", `${base}/proposals?status=pending`);
  assert.equal(all.status, 200, `GET /proposals?status=pending → ${all.status}`);
  assertProposals(all.json, agent, "pending proposals");
  assert.ok((all.json as any[]).every((p) => p.status === "pending"), "status=pending filter returned non-pending items");
  const a = await http("POST", `${base}/proposals/${UNKNOWN_ID}/approve`, { body: {} });
  assert.equal(a.status, 404, `approve unknown id → ${a.status}, expected 404`);
  const r = await http("POST", `${base}/proposals/${UNKNOWN_ID}/reject`, { body: {} });
  assert.equal(r.status, 404, `reject unknown id → ${r.status}, expected 404`);
  return all.json as any[];
}
async function pollFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 6000, every = 400): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
const ctxText = async (query: string, k?: number) => {
  const r = await http("POST", `${MEM}/context`, { body: k ? { query, k } : { query } });
  assert.equal(r.status, 200, `POST /context {"query":"${query}"} → ${r.status}: ${short(r.text, 100)}`);
  return r;
};

// state shared between sections
const S: {
  plan?: any[];
  deadlines?: any[];
  week?: any[];
  today?: any[];
  sidekickDetails: string[];
  ranInstructions: string[];
  runsAvailable?: boolean;
  askBuilt?: boolean;
  activityBuilt?: boolean;
} = { sidekickDetails: [], ranInstructions: [] };

// ───────────────────────── memory ─────────────────────────
async function memoryChecks() {
  const T = "memory";
  await check(`${T}: GET /health`, async () => (need("memory"), healthCheck(MEM, "memory")));

  const token = `zephyrquokka${Date.now() % 100000}`;
  await check(`${T}: POST /events then /context finds it`, async () => {
    need("memory");
    const ev = { ts: new Date().toISOString(), agent: "ui", source: "user", kind: "observation", text: `Maya reviewed ${token} flashcards for CS 201`, tags: ["e2e"] };
    ok2xx(await http("POST", `${MEM}/events`, { body: ev }), "POST /events");
    const hit = await pollFor(async () => {
      const r = await ctxText(token);
      assert.ok(Array.isArray(r.json?.snippets), `snippets is not an array: ${short(r.json)}`);
      assert.ok(Array.isArray(r.json?.knowledge), `knowledge is not an array: ${short(r.json)}`);
      return JSON.stringify(r.json.snippets).includes(token) ? r : null;
    }, 4000);
    assert.ok(hit, `event text not in /context snippets for query "${token}"`);
    const bad = await http("POST", `${MEM}/events`, { body: { text: 5 } });
    assert.ok(bad.status >= 400 && bad.status < 500, `invalid event body → ${bad.status}, expected 4xx`);
    return `${hit!.json.snippets.length} snippet(s), ${hit!.json.knowledge.length} knowledge item(s)`;
  });

  await check(`${T}: /context {"query":"Prof. Lee"} returns Lee's role`, async () => {
    need("memory");
    const r = await ctxText("Prof. Lee");
    const kn = JSON.stringify(r.json?.knowledge ?? "");
    assert.match(kn, /Lee/, `knowledge[] does not mention Lee: ${short(kn)}`);
    const people = await http("GET", `${MEM}/knowledge/people.md`);
    const line = String(people.json?.content ?? "").split("\n").find((l) => /Lee/.test(l)) ?? "";
    assert.ok(line, "people.md has no line about Lee");
    const squash = (s: string) => s.replace(/\\n/g, " ").replace(/[^a-z0-9]+/gi, " ").toLowerCase().trim();
    const role = squash(line.replace(/.*?Lee/, "")).split(" ").filter((w) => w.length > 3).slice(0, 2);
    const items = ((r.json.knowledge ?? []) as any[]).map((x) => squash(typeof x === "string" ? x : JSON.stringify(x)));
    assert.ok(role.length > 0 && items.some((t) => t.includes("lee") && role.every((w) => t.includes(w))), `no knowledge[] item has Lee's role (${role.join(" + ")}) from people.md ("${short(line, 70)}"): ${short(kn, 140)}`);
    return `people.md: "${short(line.trim(), 90)}"`;
  });

  const FILES = ["README.md", "goals.md", "classes.md", "deadlines.md", "writingstyle.md", "routines.md", "people.md"];
  await check(`${T}: GET /knowledge lists the md files`, async () => {
    need("memory");
    const r = await http("GET", `${MEM}/knowledge`);
    assert.equal(r.status, 200, `status ${r.status}`);
    assert.ok(Array.isArray(r.json), `not an array (api.ts expects KnowledgeFile[]): ${short(r.json)}`);
    const names = (r.json as any[]).map((k) => k?.name);
    assert.ok(names.every((n) => typeof n === "string"), `items lack a string "name": ${short(r.json)}`);
    const miss = FILES.filter((f) => !names.includes(f));
    assert.equal(miss.length, 0, `missing ${miss.join(", ")}; got ${names.join(", ")}`);
    return names.join(", ");
  });

  await check(`${T}: GET+PUT /knowledge/goals.md round-trips`, async () => {
    need("memory");
    const g = await http("GET", `${MEM}/knowledge/goals.md`);
    assert.equal(g.status, 200, `GET → ${g.status}`);
    assert.equal(g.json?.name, "goals.md", `name=${short(g.json?.name)}`);
    assert.ok(typeof g.json?.content === "string" && g.json.content.length > 0, `content: ${short(g.json?.content)}`);
    const next = `${g.json.content.trimEnd()}\n- e2e round trip ${token}\n`;
    ok2xx(await http("PUT", `${MEM}/knowledge/goals.md`, { body: { content: next } }), "PUT");
    const g2 = await http("GET", `${MEM}/knowledge/goals.md`);
    assert.ok(String(g2.json?.content).includes(`e2e round trip ${token}`), "content after PUT does not contain the edit");
    ok2xx(await http("PUT", `${MEM}/knowledge/goals.md`, { body: { content: g.json.content } }), "PUT (restore)");
    const miss = await http("GET", `${MEM}/knowledge/does-not-exist.md`);
    assert.equal(miss.status, 404, `GET unknown file → ${miss.status}, expected 404`);
    const bad = await http("PUT", `${MEM}/knowledge/goals.md`, { body: {} });
    assert.ok(bad.status >= 400 && bad.status < 500, `PUT without content → ${bad.status}, expected 4xx`);
    return `${g.json.content.split("\n").length} lines; edit visible after PUT; unknown file 404`;
  });

  await check(`${T}: path traversal rejected`, async () => {
    need("memory");
    const outside = path.join(svcs.memory.env.MEMORY_DATA_DIR, "evil.md");
    for (const p of ["..%2Fevil.md", "..%2F..%2Fmain.py", "%2e%2e%2fevents.db", "..%5Cevil.md", "%2Fetc%2Fpasswd", "sub%2F..%2F..%2Fevil.md"]) {
      const g = await http("GET", `${MEM}/knowledge/${p}`);
      assert.ok(g.status >= 400 && g.status < 500, `GET /knowledge/${p} → ${g.status}, expected 4xx`);
      const w = await http("PUT", `${MEM}/knowledge/${p}`, { body: { content: "pwned" } });
      assert.ok(w.status >= 400 && w.status < 500, `PUT /knowledge/${p} → ${w.status}, expected 4xx`);
    }
    assert.ok(!fs.existsSync(outside), "PUT wrote evil.md outside the knowledge folder");
    assert.ok(!fs.existsSync(path.join(ROOT, "memory", "evil.md")), "PUT wrote memory/evil.md");
    return "6 traversal paths → 4xx for GET and PUT, nothing written";
  });

  await check(`${T}: POST /remember`, async () => {
    need("memory");
    const fact = `Maya prefers ${token}-style spaced repetition`;
    ok2xx(await http("POST", `${MEM}/remember`, { body: { text: fact, scope: "global", tags: ["e2e"] } }), "POST /remember");
    const hit = await pollFor(async () => JSON.stringify((await ctxText(`${token}-style`)).json).includes(`${token}-style`), 4000);
    assert.ok(hit, "remembered text is not returned by /context");
    const bad = await http("POST", `${MEM}/remember`, { body: {} });
    assert.ok(bad.status >= 400 && bad.status < 500, `POST /remember {} → ${bad.status}, expected 4xx`);
    return "2xx, and /context finds the remembered text";
  });

  const insightKey = (j: any) => JSON.stringify([j?.nextThing?.title, j?.nextThing?.why, j?.nextThing?.minutes, (j?.cards ?? []).map((c: any) => [c?.title, c?.why])]);
  await check(`${T}: GET /insights shape, < 200 ms`, async () => {
    need("memory");
    await http("GET", `${MEM}/insights`);
    const runs: Res[] = [];
    for (let i = 0; i < 3; i++) runs.push(await http("GET", `${MEM}/insights`));
    const r = runs[0];
    assert.equal(r.status, 200, `status ${r.status}`);
    const n = r.json?.nextThing;
    assert.ok(n && typeof n.title === "string" && n.title.trim(), `nextThing.title: ${short(n)}`);
    assert.ok(typeof n.why === "string" && n.why.trim(), `nextThing.why: ${short(n)}`);
    assert.ok(typeof n.minutes === "number" && n.minutes > 0, `nextThing.minutes: ${short(n?.minutes)}`);
    assert.ok(Array.isArray(r.json.cards), `cards is not an array: ${short(r.json.cards)}`);
    assert.ok(r.json.cards.length <= 5, `${r.json.cards.length} cards (> 5)`);
    assertProposals(r.json.cards, undefined, "cards");
    const worst = Math.max(...runs.map((x) => x.ms));
    assert.ok(worst < 200, `slowest of 3 calls took ${worst.toFixed(0)} ms`);
    return `"${short(n.title, 50)}" (${n.minutes} min), ${r.json.cards.length} card(s), slowest ${worst.toFixed(0)} ms`;
  });

  await check(`${T}: editing goals.md then POST /digest/run changes the next insight`, async () => {
    need("memory");
    ok2xx(await http("POST", `${MEM}/digest/run`, { body: {}, timeout: 60_000 }), "POST /digest/run (baseline)");
    await sleep(500);
    const before = (await http("GET", `${MEM}/insights`)).json;
    const g = await http("GET", `${MEM}/knowledge/goals.md`);
    const goal = "Finish the marine biology poster on Zebrafish regeneration";
    ok2xx(await http("PUT", `${MEM}/knowledge/goals.md`, { body: { content: `# Goals\n\n- ${goal} (top priority, this week)\n` } }), "PUT goals.md");
    ok2xx(await http("POST", `${MEM}/digest/run`, { body: {}, timeout: 60_000 }), "POST /digest/run");
    const after = await pollFor(async () => {
      const j = (await http("GET", `${MEM}/insights`)).json;
      return insightKey(j) !== insightKey(before) ? j : null;
    }, 8000);
    await http("PUT", `${MEM}/knowledge/goals.md`, { body: { content: g.json?.content ?? "" } });
    await http("POST", `${MEM}/digest/run`, { body: {}, timeout: 60_000 });
    assert.ok(after, `insights identical before and after (nextThing "${short(before?.nextThing?.title, 50)}")`);
    return `nextThing "${short(before?.nextThing?.title, 40)}" → "${short(after.nextThing?.title, 40)}"`;
  });

  await check(`${T}: /proposals routes`, async () => {
    need("memory");
    const pending = await proposalRoutes(MEM, "memory");
    if (!pending.length) return "pending list valid but empty; unknown ids 404 (approve/reject of a real one not exercised)";
    const a = await http("POST", `${MEM}/proposals/${pending[0].id}/approve`, { body: {} });
    ok2xx(a, "approve");
    assert.ok(["approved", "done"].includes(a.json?.status), `approve response status=${short(a.json?.status)}`);
    let note = `approved 1 of ${pending.length}`;
    if (pending[1]) {
      ok2xx(await http("POST", `${MEM}/proposals/${pending[1].id}/reject`, { body: {} }), "reject");
      note += ", rejected 1";
    }
    const left = (await http("GET", `${MEM}/proposals?status=pending`)).json as any[];
    assert.ok(!left.some((p) => p.id === pending[0].id || p.id === pending[1]?.id), "approved/rejected proposal still pending");
    return `${note}; both left the pending list; unknown ids 404`;
  });

  await check(`${T}: CORS for ${ORIGIN}`, async () => (need("memory"), corsCheck(MEM, "PUT", "/knowledge/goals.md")));
}

// ───────────────────────── inbox ─────────────────────────
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const hm = (d: Date) => d.getHours() + d.getMinutes() / 60;
function assertCalEvents(list: any, what: string) {
  assert.ok(Array.isArray(list), `${what} is not an array: ${short(list)}`);
  for (const e of list as any[]) {
    assert.ok(typeof e?.id === "string" && e.id, `${what}: event without id: ${short(e)}`);
    assert.ok(typeof e.title === "string" && e.title, `${what}: event without title: ${short(e)}`);
    assert.ok(isIso(e.start) && isIso(e.end), `${what}: start/end not ISO: ${short(e)}`);
    assert.ok(Date.parse(e.end) > Date.parse(e.start), `${what}: end <= start: ${short(e)}`);
    if (e.northstar !== undefined) assert.equal(typeof e.northstar, "boolean", `${what}: northstar not boolean: ${short(e)}`);
  }
}
function dueOf(p: any, deadlines: any[]): string | undefined {
  const direct = p.dueAt ?? p.payload?.dueAt ?? p.payload?.deadline?.dueAt ?? p.payload?.deadlineDueAt ?? p.payload?.due;
  if (isIso(direct)) return direct;
  const hay = `${p.title} ${JSON.stringify(p.payload ?? {})}`.toLowerCase();
  return deadlines.find((d) => typeof d?.title === "string" && hay.includes(d.title.toLowerCase()))?.dueAt;
}
async function getPlan(): Promise<any[]> {
  const r = await http("POST", `${INBOX}/schedule/plan`, { body: {}, timeout: 60_000 });
  assert.equal(r.status, 200, `POST /schedule/plan → ${r.status}: ${short(r.text, 120)}`);
  assert.ok(Array.isArray(r.json), `not an array (contract: Proposal[]): ${short(r.json)}`);
  return r.json;
}

async function inboxChecks() {
  const T = "inbox";
  await check(`${T}: GET /health`, async () => (need("inbox"), healthCheck(INBOX, "inbox")));

  let needsYou: any[] = [];
  await check(`${T}: GET /triage`, async () => {
    need("inbox");
    const r = await http("GET", `${INBOX}/triage`, { timeout: 60_000 });
    assert.equal(r.status, 200, `status ${r.status}: ${short(r.text, 100)}`);
    const t = r.json;
    assert.ok(Array.isArray(t?.needsYou), `needsYou is not an array: ${short(t)}`);
    assert.ok(Array.isArray(t.fyi), `fyi is not an array`);
    assert.equal(typeof t.ignored, "number", `ignored is ${typeof t.ignored}`);
    assert.ok(t.needsYou.length <= 5, `needsYou has ${t.needsYou.length} items (> 5)`);
    assert.ok(t.needsYou.length > 0, "needsYou is empty with MOCK=1 fixtures");
    for (const e of [...t.needsYou, ...t.fyi]) {
      for (const k of ["id", "from", "subject", "snippet", "receivedAt"])
        assert.ok(typeof e?.[k] === "string" && e[k], `email lacks "${k}": ${short(e)}`);
      assert.ok(isIso(e.receivedAt), `receivedAt not a date: ${short(e.receivedAt)}`);
      if (e.dueAt !== undefined && e.dueAt !== null) assert.ok(isIso(e.dueAt), `dueAt not a date: ${short(e.dueAt)}`);
    }
    needsYou = t.needsYou;
    return `${t.needsYou.length} needsYou, ${t.fyi.length} fyi, ${t.ignored} ignored`;
  });

  await check(`${T}: GET /deadlines`, async () => {
    need("inbox");
    const r = await http("GET", `${INBOX}/deadlines`, { timeout: 30_000 });
    assert.equal(r.status, 200, `status ${r.status}`);
    assert.ok(Array.isArray(r.json), `not an array: ${short(r.json)}`);
    assert.ok(r.json.length > 0, "no deadlines with MOCK=1 fixtures");
    for (const d of r.json) {
      assert.ok(typeof d?.title === "string" && d.title, `deadline without title: ${short(d)}`);
      assert.ok(isIso(d.dueAt), `deadline dueAt not a date: ${short(d)}`);
    }
    S.deadlines = r.json;
    return `${r.json.length} deadline(s), e.g. "${short(r.json[0].title, 50)}" due ${r.json[0].dueAt}`;
  });

  await check(`${T}: GET /calendar/today and /calendar/week are CalEvent[]`, async () => {
    need("inbox");
    const t = await http("GET", `${INBOX}/calendar/today`);
    assert.equal(t.status, 200, `/calendar/today → ${t.status}`);
    assertCalEvents(t.json, "/calendar/today");
    const now = new Date();
    for (const e of t.json) assert.ok(dayKey(new Date(e.start)) === dayKey(now) || dayKey(new Date(e.end)) === dayKey(now), `/calendar/today has an event not on today: ${short(e)}`);
    const w = await http("GET", `${INBOX}/calendar/week`);
    assert.equal(w.status, 200, `/calendar/week → ${w.status}`);
    assertCalEvents(w.json, "/calendar/week");
    assert.ok(w.json.length > 0, "/calendar/week is empty with MOCK=1 fixtures");
    S.today = t.json;
    S.week = w.json;
    return `today ${t.json.length}, week ${w.json.length}`;
  });

  await check(`${T}: POST /schedule/plan → "◎ …" create_event blocks within the rules`, async () => {
    need("inbox");
    const plan = await getPlan();
    S.plan = plan;
    assert.ok(plan.length > 0, "no proposals with MOCK=1 fixtures");
    assertProposals(plan, "inbox", "plan");
    const deadlines = S.deadlines ?? ((await http("GET", `${INBOX}/deadlines`)).json as any[]) ?? [];
    const perDay: Record<string, number> = {};
    let withDue = 0;
    for (const p of plan) {
      assert.equal(p.type, "create_event", `type ${p.type}: ${short(p.title)}`);
      assert.ok(p.title.startsWith("◎ "), `title does not start with "◎ ": "${p.title}"`);
      assert.ok(isIso(p.payload?.start) && isIso(p.payload?.end), `payload.start/end missing: ${short(p.payload)}`);
      const s = new Date(p.payload.start), e = new Date(p.payload.end);
      const mins = (e.getTime() - s.getTime()) / 60000;
      assert.ok(mins > 0 && mins <= 50, `block is ${mins} min (> 50): ${p.title}`);
      assert.ok(s.getTime() > Date.now() - 60_000, `block starts in the past (${p.payload.start}): ${p.title}`);
      assert.ok(dayKey(s) === dayKey(e) && hm(e) <= 23, `block ends after 23:00 (${e.toString().slice(0, 21)}): ${p.title}`);
      perDay[dayKey(s)] = (perDay[dayKey(s)] ?? 0) + mins;
      const due = dueOf(p, deadlines);
      if (due) {
        withDue++;
        const gapH = (Date.parse(due) - e.getTime()) / 3_600_000;
        assert.ok(gapH >= 24, `block ends ${gapH.toFixed(1)} h before its deadline ${due} (< 24 h): ${p.title}`);
      }
    }
    const worst = Object.entries(perDay).sort((a, b) => b[1] - a[1])[0];
    assert.ok(worst[1] <= 360, `${worst[1]} min planned on ${worst[0]} (> 6 h)`);
    assert.ok(withDue > 0, "no block could be tied to a deadline (no dueAt on the proposal/payload and no deadline title in it)");
    const sorted = plan.map((p) => [Date.parse(p.payload.start), Date.parse(p.payload.end)]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i][0] >= sorted[i - 1][1], "two planned blocks overlap");
    return `${plan.length} block(s) on ${Object.keys(perDay).length} day(s), busiest day ${worst[1]} min, ${withDue} tied to a deadline`;
  });

  await check(`${T}: approving a block makes it show up in /calendar/week`, async () => {
    need("inbox");
    const plan = (S.plan ?? []).filter((p) => p?.payload?.start).sort((a, b) => Date.parse(a.payload.start) - Date.parse(b.payload.start));
    if (!plan.length) skip("no planned block to approve (see the /schedule/plan check)");
    const p = plan[0];
    const a = await http("POST", `${INBOX}/proposals/${p.id}/approve`, { body: {}, timeout: 30_000 });
    ok2xx(a, "approve");
    assert.ok(["approved", "done"].includes(a.json?.status), `approve response status=${short(a.json?.status)}`);
    const found = await pollFor(async () => {
      const w = (await http("GET", `${INBOX}/calendar/week`)).json as any[];
      return Array.isArray(w) && w.find((e) => Date.parse(e.start) === Date.parse(p.payload.start) && String(e.title).includes(String(p.payload.title ?? p.title).replace(/^◎\s*/, "")));
    }, 5000);
    assert.ok(found, `block "${p.title}" at ${p.payload.start} (${((Date.parse(p.payload.start) - Date.now()) / 86_400_000).toFixed(1)} days from now) is not in /calendar/week`);
    assert.equal((found as any).northstar, true, `the event is in /calendar/week but northstar !== true: ${short(found)}`);
    const pend = (await http("GET", `${INBOX}/proposals?status=pending`)).json as any[];
    assert.ok(!pend.some((x) => x.id === p.id), "approved block is still in the pending list");
    S.week = (await http("GET", `${INBOX}/calendar/week`)).json;
    return `"${short(p.title, 50)}" at ${p.payload.start} is in /calendar/week with northstar:true`;
  });

  await check(`${T}: POST /draft {emailId} → send_reply; approving reaches done`, async () => {
    need("inbox");
    if (!needsYou.length) skip("no needsYou email to draft for (see the /triage check)");
    const r = await http("POST", `${INBOX}/draft`, { body: { emailId: needsYou[0].id }, timeout: 60_000 });
    assert.equal(r.status, 200, `status ${r.status}: ${short(r.text, 120)}`);
    const p = r.json;
    assert.deepEqual(proposalProblems(p, "inbox"), [], "invalid proposal");
    assert.equal(p.type, "send_reply", `type ${p.type}`);
    assert.equal(p.status, "pending", `status ${p.status}`);
    for (const k of ["to", "subject", "body"]) assert.ok(typeof p.payload?.[k] === "string" && p.payload[k].trim(), `payload.${k}: ${short(p.payload?.[k])}`);
    const pend = (await http("GET", `${INBOX}/proposals?status=pending`)).json as any[];
    assert.ok(pend.some((x) => x.id === p.id), "the draft is not in /proposals?status=pending");
    const a = await http("POST", `${INBOX}/proposals/${p.id}/approve`, { body: {}, timeout: 60_000 });
    ok2xx(a, "approve");
    const done = await pollFor(async () => {
      if (a.json?.status === "done") return true;
      const d = (await http("GET", `${INBOX}/proposals?status=done`)).json;
      return Array.isArray(d) && d.some((x: any) => x.id === p.id && x.status === "done");
    }, 8000);
    assert.ok(done, `after approve the proposal is "${a.json?.status}" and never reached "done"`);
    return `to ${p.payload.to}, "${short(p.payload.subject, 40)}", body ${p.payload.body.length} chars → done`;
  });

  await check(`${T}: unknown ids → 404`, async () => {
    need("inbox");
    await proposalRoutes(INBOX, "inbox");
    const d = await http("POST", `${INBOX}/draft`, { body: { emailId: "no-such-email-e2e" }, timeout: 30_000 });
    assert.equal(d.status, 404, `POST /draft with unknown emailId → ${d.status}, expected 404`);
    return "approve/reject/draft with unknown ids → 404; pending proposals valid";
  });

  await check(`${T}: bad input → 400`, async () => {
    need("inbox");
    const cases: [string, Parameters<typeof http>[2]][] = [
      ["POST /draft {}", { body: {} }],
      ["POST /draft {emailId: 5}", { body: { emailId: 5 } }],
      ["POST /draft malformed JSON", { raw: "{not json" }],
    ];
    for (const [name, o] of cases) {
      const r = await http("POST", `${INBOX}/draft`, { ...o, timeout: 30_000 });
      assert.equal(r.status, 400, `${name} → ${r.status}, expected 400`);
    }
    assert.equal((await http("GET", `${INBOX}/health`)).status, 200, "unhealthy after bad input");
    return "3 bad /draft bodies → 400";
  });

  await check(`${T}: GET /auth/url does not crash without Google config`, async () => {
    need("inbox");
    const r = await http("GET", `${INBOX}/auth/url`);
    assert.notEqual(r.status, 500, `status 500: ${short(r.text, 120)}`);
    assert.ok(r.json && typeof r.json === "object", `body is not JSON: ${short(r.text, 80)}`);
    if (r.status === 200) assert.equal(typeof r.json.url, "string", `200 but no string "url" (api.ts expects {url}): ${short(r.json)}`);
    assert.equal((await http("GET", `${INBOX}/health`)).status, 200, "unhealthy after /auth/url");
    return `status ${r.status}: ${short(r.json, 90)}`;
  });

  await check(`${T}: CORS for ${ORIGIN}`, async () => (need("inbox"), corsCheck(INBOX, "POST", "/draft")));
}

// ───────────────────────── actions ─────────────────────────
async function sse(instruction: string, timeout = 120_000) {
  const res = await fetch(`${ACT}/sidekick`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ instruction }),
    signal: AbortSignal.timeout(timeout),
  });
  const bodyText = await res.text();
  const frames: any[] = [];
  for (const block of bodyText.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (!data.trim()) continue;
    try {
      frames.push(JSON.parse(data));
    } catch {
      /* ignored */
    }
  }
  return { status: res.status, frames, bodyText };
}

const runSmoke = () =>
  // Its server must not write into the memory instance under test.
  runSuite("npx", ["tsx", "scripts/smoke.ts"], path.join(ROOT, "actions"), { SMOKE_PORT: String(SMOKE_PORT), SMOKE_SCRATCH: RUN_DIR, MEMORY_URL: "http://127.0.0.1:9" });

function runSuite(cmd: string, args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    extraChildren.push(child);
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      out += "\n[e2e] suite timed out after 8 min; killed";
      if (child.pid) killGroup(child.pid, "SIGKILL");
    }, 480_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: out + String(e) });
    });
  });
}

async function actionsChecks(smoke: Promise<{ code: number | null; out: string }> | null) {
  const T = "actions";
  await check(`${T}: GET /health`, async () => (need("actions"), healthCheck(ACT, "actions")));

  let runsBody: Res | null = null;
  await check(`${T}: GET /runs is an array`, async () => {
    need("actions");
    runsBody = await http("GET", `${ACT}/runs`);
    S.runsAvailable = runsBody.status !== 404;
    if (runsBody.status === 404) skip("GET /runs → 404: not built yet");
    assert.equal(runsBody.status, 200, `status ${runsBody.status}: ${short(runsBody.text, 100)}`);
    assert.ok(Array.isArray(runsBody.json), `not an array: ${short(runsBody.json)}`);
    return `${runsBody.json.length} run(s)`;
  });

  let frames: any[] = [];
  const instruction = "find the CS 101 syllabus";
  await check(`${T}: POST /sidekick streams SidekickStep frames`, async () => {
    need("actions");
    const s = await sse(instruction);
    assert.equal(s.status, 200, `status ${s.status}: ${short(s.bodyText, 100)}`);
    frames = s.frames;
    assert.ok(frames.length > 1, `${frames.length} frame(s)`);
    for (const f of frames) assert.ok(typeof f.step === "number" && typeof f.action === "string" && typeof f.detail === "string", `bad frame: ${short(f, 100)}`);
    assert.equal(frames[frames.length - 1].action, "done", `last frame action "${frames[frames.length - 1].action}"`);
    S.sidekickDetails = frames.map((f) => f.detail);
    S.ranInstructions.push(instruction);
    return `${frames.length} frames, last: "${short(frames[frames.length - 1].detail, 70)}"`;
  });

  await check(`${T}: SSE frames carry runId`, async () => {
    need("actions");
    if (!frames.length) skip("no frames (see the /sidekick check)");
    const ids = new Set(frames.map((f) => f.runId));
    if (ids.size === 1 && ids.has(undefined)) {
      if (S.runsAvailable === false) skip("no runId on frames and GET /runs → 404: not built yet");
      assert.fail("frames have no runId although /runs exists");
    }
    assert.ok(frames.every((f) => typeof f.runId === "string" && f.runId), `some frames lack runId: ${short(frames.find((f) => !f.runId), 100)}`);
    assert.equal(ids.size, 1, `frames of one run carry ${ids.size} different runIds`);
    return `runId ${[...ids][0]} on all ${frames.length} frames`;
  });

  await check(`${T}: a Sidekick run appears in /runs with steps and a final status`, async () => {
    need("actions");
    if (S.runsAvailable === false) skip("GET /runs → 404: not built yet");
    if (!frames.length) skip("no sidekick run (see the /sidekick check)");
    const rid = frames[0].runId;
    const run = await pollFor(async () => {
      const list = (await http("GET", `${ACT}/runs`)).json;
      assert.ok(Array.isArray(list), "/runs is not an array");
      const r = rid ? list.find((x: any) => x.id === rid || x.runId === rid) : list.find((x: any) => JSON.stringify(x).includes(instruction));
      return r && !["running", "pending", "queued"].includes(r.status) ? r : null;
    }, 6000);
    assert.ok(run, `no finished run ${rid ?? `for "${instruction}"`} in /runs`);
    assert.ok(Array.isArray(run.steps) && run.steps.length > 0, `run.steps: ${short(run.steps, 80)}`);
    assert.ok(typeof run.status === "string" && run.status, `run.status: ${short(run.status)}`);
    const id = run.id ?? run.runId;
    const one = await http("GET", `${ACT}/runs/${id}`);
    assert.equal(one.status, 200, `GET /runs/${id} → ${one.status}`);
    assert.equal(one.json?.id ?? one.json?.runId, id, "GET /runs/:id returned a different run");
    assert.equal((await http("GET", `${ACT}/runs/${UNKNOWN_ID}`)).status, 404, "GET /runs/<unknown> is not 404");
    const c = await http("POST", `${ACT}/runs/${UNKNOWN_ID}/cancel`, { body: {} });
    assert.equal(c.status, 404, `POST /runs/<unknown>/cancel → ${c.status}, expected 404`);
    const c2 = await http("POST", `${ACT}/runs/${id}/cancel`, { body: {} });
    assert.ok(c2.status < 500, `cancelling a finished run → ${c2.status}`);
    const again = await http("GET", `${ACT}/runs/${id}`);
    assert.equal(again.json?.status, run.status, `cancel changed a finished run's status ${run.status} → ${again.json?.status}`);
    return `run ${id}: status ${run.status}, ${run.steps.length} step(s); /runs/:id ok; unknown → 404; cancel of a finished run → ${c2.status}, status unchanged`;
  });

  await check(`${T}: CORS for ${ORIGIN}`, async () => (need("actions"), corsCheck(ACT, "POST", "/sidekick")));

  await check(`${T}: own smoke suite (actions/scripts/smoke.ts on :${SMOKE_PORT})`, async () => {
    if (!smoke) skip("actions NOT BUILT YET");
    const { code, out } = await smoke!;
    fs.writeFileSync(path.join(RUN_DIR, "actions-smoke.out"), out);
    const m = /summary: (\d+) passed, (\d+) failed, (\d+) total/.exec(out);
    const fails = out.split("\n").filter((l) => l.startsWith("FAIL")).map((l) => short(l.replace(/^FAIL\s+/, ""), 140));
    assert.ok(m, `no summary line (exit ${code}); tail: ${short(out.trim().split("\n").slice(-2).join(" | "), 240)}`);
    assert.ok(code === 0 && m![2] === "0", `${m![1]} passed, ${m![2]} failed of ${m![3]} (exit ${code}); failed: ${fails.join(" || ")}`);
    return `${m![1]} passed, 0 failed, ${m![3]} total`;
  });
}

// ───────────────────────── each service's own test suite (run after our services are down) ─────────────────────────
async function ownSuites() {
  if (want("memory"))
    await check("memory: own test suite (uv run pytest in memory/)", async () => {
      if (!fs.existsSync(path.join(ROOT, "memory/tests"))) skip("memory/tests does not exist yet");
      const { code, out } = await runSuite("uv", ["run", "pytest", "-q"], path.join(ROOT, "memory"), { ...SANDBOX_HOME, MOCK: "1", MEMORY_DATA_DIR: dataDir("memory-pytest-data") });
      fs.writeFileSync(path.join(RUN_DIR, "memory-pytest.out"), out);
      const last = out.trim().split("\n").filter((l) => /passed|failed|error/i.test(l)).slice(-1)[0] ?? out.trim().split("\n").slice(-1)[0];
      const fails = out.split("\n").filter((l) => /^(FAILED|ERROR) /.test(l)).map((l) => short(l, 150));
      assert.equal(code, 0, `exit ${code}: ${short(last, 120)}${fails.length ? ` — ${fails.slice(0, 4).join(" || ")}` : ""}`);
      return short(last.replace(/=+/g, "").trim(), 120);
    });
  if (want("inbox"))
    await check("inbox: own test suite (npm test in inbox/)", async () => {
      let script: string | undefined;
      try {
        script = JSON.parse(fs.readFileSync(path.join(ROOT, "inbox/package.json"), "utf8")).scripts?.test;
      } catch {
        skip("inbox/package.json does not exist yet");
      }
      if (!script || /no test specified/.test(script)) skip("inbox/package.json has no test script yet");
      const { code, out } = await runSuite("npm", ["test"], path.join(ROOT, "inbox"), { MOCK: "1", INBOX_DATA_DIR: dataDir("inbox-test-data"), MEMORY_URL: "http://127.0.0.1:9" });
      fs.writeFileSync(path.join(RUN_DIR, "inbox-test.out"), out);
      const lines = out.trim().split("\n");
      const tally = lines.filter((l) => /^\s*(ℹ|#)?\s*(tests|pass|fail)\b|Tests?\s+\d|passed|failed/i.test(l)).slice(-4).map((l) => l.replace(/^\s*(ℹ|#)\s*/, "").trim()).join(", ");
      const fails = lines.filter((l) => /^\s*(✖|not ok|FAIL|×)/.test(l)).map((l) => short(l.trim(), 120));
      assert.equal(code, 0, `exit ${code}: ${short(tally || lines.slice(-2).join(" | "), 160)}${fails.length ? ` — ${[...new Set(fails)].slice(0, 4).join(" || ")}` : ""}`);
      return `"${short(script, 50)}": ${short(tally || lines.slice(-1)[0], 120)}`;
    });
}

// ───────────────────────── cross-service ─────────────────────────
async function crossChecks() {
  const T = "cross";
  await check(`${T}: after inbox triage, memory /context finds a deadline event written by inbox`, async () => {
    need("memory", "inbox");
    ok2xx(await http("GET", `${INBOX}/triage`, { timeout: 60_000 }), "GET /triage");
    const deadlines = (await http("GET", `${INBOX}/deadlines`)).json as any[];
    assert.ok(Array.isArray(deadlines) && deadlines.length, "inbox has no deadlines");
    // Memory returns snippets as plain text. An event that pairs a deadline's title with the exact ISO dueAt
    // inbox computed can only have been written by inbox's triage (memory's own seed facts use prose dates).
    const tried: string[] = [];
    const hit = await pollFor(async () => {
      for (const d of deadlines.slice(0, 5)) {
        const r = await ctxText(`${d.title} due`, 10);
        const m = ((r.json?.snippets ?? []) as any[]).map((x) => (typeof x === "string" ? x : String(x?.text ?? JSON.stringify(x)))).find((t) => t.includes(d.title) && t.includes(d.dueAt));
        if (m) return { d, m };
        if (!tried.includes(d.title)) tried.push(d.title);
      }
      return null;
    }, 8000, 1000);
    const posts = (fs.readFileSync(svcs.memory.log!, "utf8").match(/POST \/events/g) ?? []).length;
    assert.ok(hit, `memory /context has no "<title> … <dueAt>" event for inbox deadlines ${tried.map((t) => `"${short(t, 30)}"`).join(", ")}; memory log shows ${posts} POST /events in total`);
    return `"${short(hit!.d.title, 40)}" → ${short(hit!.m, 110)}`;
  });

  const inWindow = (plan: any[], from: number, to: number) =>
    plan.filter((p) => !(hm(new Date(p.payload.start)) >= from && hm(new Date(p.payload.end)) <= to && dayKey(new Date(p.payload.start)) === dayKey(new Date(p.payload.end))));
  const fmt = (p: any) => `${new Date(p.payload.start).toTimeString().slice(0, 5)}–${new Date(p.payload.end).toTimeString().slice(0, 5)}`;

  await check(`${T}: inbox /schedule/plan blocks fall in 14:00–17:00 (focus hours from memory)`, async () => {
    need("memory", "inbox");
    const routines = (await http("GET", `${MEM}/knowledge/routines.md`)).json?.content ?? "";
    assert.match(String(routines), /2\s*(pm)?\s*(-|–|to)\s*5\s*pm|14:00\s*(-|–|to)\s*17:00/i, `memory routines.md does not state 2–5pm focus hours: ${short(routines, 120)}`);
    const plan = S.plan?.length ? S.plan : await getPlan();
    S.plan = plan;
    assert.ok(plan.length > 0, "no blocks planned");
    const out = inWindow(plan, 14, 17);
    assert.equal(out.length, 0, `${out.length} of ${plan.length} blocks outside 14:00–17:00 local, e.g. "${short(out[0]?.title, 40)}" ${out[0] ? fmt(out[0]) : ""}`);
    return `all ${plan.length} blocks inside 14:00–17:00 local (${plan.slice(0, 3).map(fmt).join(", ")}…)`;
  });

  await check(`${T}: changing routines.md to 9–11am moves most newly planned blocks into that window`, async () => {
    need("memory", "inbox");
    const orig = (await http("GET", `${MEM}/knowledge/routines.md`)).json?.content;
    assert.equal(typeof orig, "string", "cannot read routines.md");
    try {
      ok2xx(await http("PUT", `${MEM}/knowledge/routines.md`, { body: { content: "# Routines\n\n- Best focus hours: 9am-11am (mornings)\n- Sleep: 11:30pm-7:30am\n" } }), "PUT routines.md");
      const pend = ((await http("GET", `${INBOX}/proposals?status=pending`)).json as any[]).filter((p) => p.type === "create_event");
      for (const p of pend) await http("POST", `${INBOX}/proposals/${p.id}/reject`, { body: {} });
      const plan = await getPlan();
      if (!plan.length) skip(`inconclusive: after rejecting ${pend.length} pending block(s), /schedule/plan returned no new blocks`);
      // A 2-hour window cannot hold every block, so the planner may spill over; most blocks must follow memory.
      const out = inWindow(plan, 9, 11);
      const still = plan.length - inWindow(plan, 14, 17).length;
      assert.ok(out.length <= plan.length / 2, `${out.length} of ${plan.length} new blocks are outside 09:00–11:00 (${still} still in 14:00–17:00, e.g. ${fmt(out[0] ?? plan[0])}) although memory now says best focus is 9–11am`);
      return `${plan.length - out.length} of ${plan.length} new blocks inside 09:00–11:00 (${plan.slice(0, 3).map(fmt).join(", ")}…); ${out.length} spilled over, ${still} left in 14:00–17:00`;
    } finally {
      await http("PUT", `${MEM}/knowledge/routines.md`, { body: { content: orig } }).catch(() => {});
    }
  });

  await check(`${T}: a submitted actions fill writes a "form" event that memory /context finds`, async () => {
    need("memory", "actions");
    const f = await http("POST", `${ACT}/fill`, { body: { url: `${ACT}/fixtures/internship.html`, profile: { reference: REFERENCE } }, timeout: 120_000 });
    assert.equal(f.status, 200, `POST /fill → ${f.status}: ${short(f.text, 120)}`);
    const s = await http("POST", `${ACT}/submit`, { body: { proposalId: f.json.id }, timeout: 120_000 });
    assert.equal(s.status, 200, `POST /submit → ${s.status}: ${short(s.text, 120)}`);
    assert.equal(s.json?.status, "done", `submit status "${s.json?.status}" ${short(s.json?.payload?.error ?? "", 100)}`);
    const hit = await pollFor(async () => {
      for (const q of ["Applied internship application submitted", "Applied to", "internship application", "submitted fields filled automatically"]) {
        const sn = ((await ctxText(q, 10)).json?.snippets ?? []) as any[];
        const m = sn.find((x) => {
          const t = typeof x === "string" ? x : JSON.stringify(x);
          return /Applied to/.test(t) && /submitted/.test(t) && (typeof x === "string" || x.source === undefined || x.source === "form");
        });
        if (m) return m;
      }
      return null;
    }, 8000, 1000);
    assert.ok(hit, `no "Applied to … (submitted …)" form event in memory /context after a successful submit`);
    return short(hit, 150);
  });

  await check(`${T}: every service's pending proposals are valid Proposal objects`, async () => {
    need("memory", "inbox", "actions");
    const counts: string[] = [];
    const probs: string[] = [];
    for (const [agent, base] of [["memory", MEM], ["inbox", INBOX], ["actions", ACT]] as const) {
      const r = await http("GET", `${base}/proposals?status=pending`);
      assert.equal(r.status, 200, `${agent} /proposals?status=pending → ${r.status}`);
      assert.ok(Array.isArray(r.json), `${agent}: not an array`);
      counts.push(`${agent} ${r.json.length}`);
      for (const p of r.json) {
        probs.push(...proposalProblems(p, agent).map((m) => `${agent} ${m}`));
        if (p.status !== "pending") probs.push(`${agent} [${short(p.title, 30)}] status=${p.status} in pending list`);
      }
    }
    assert.equal(probs.length, 0, `${probs.length} problem(s): ${probs.slice(0, 4).join("; ")}`);
    return counts.join(", ");
  });
}

// ───────────────────────── real mode (--real): MOCK=0, one model call of each kind ─────────────────────────
async function realChecks() {
  const T = "real";
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  await check(`${T}: services report real mode`, async () => {
    need("memory", "inbox", "actions");
    const i = (await http("GET", `${INBOX}/health`)).json;
    const a = (await http("GET", `${ACT}/health`)).json;
    assert.equal(a?.mock, false, `actions /health mock=${a?.mock}`);
    assert.equal(i?.llm, true, `inbox /health llm=${i?.llm} (no usable OPENAI key/model?)`);
    return `inbox ${short(i)}; actions ${short(a)}`;
  });

  await check(`${T}: memory knowledge holds the demo student's files (routines.md with focus hours)`, async () => {
    need("memory");
    const before = ((await http("GET", `${MEM}/knowledge`)).json as any[]).map((k) => k.name);
    const dir = path.join(ROOT, "memory/fixtures/knowledge");
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md")))
      ok2xx(await http("PUT", `${MEM}/knowledge/${f}`, { body: { content: fs.readFileSync(path.join(dir, f), "utf8") } }), `PUT ${f}`);
    const r = await ctxText("routines best focus hours");
    assert.match(JSON.stringify(r.json.knowledge), /routines\.md/, "after seeding, /context does not return routines.md for the focus-hours query");
    return `memory started with ${before.length} knowledge file(s); wrote 7 from memory/fixtures/knowledge`;
  });

  let needsYou: any[] = [];
  await check(`${T}: inbox /triage with the model (fixture mail)`, async () => {
    need("inbox");
    ok2xx(await http("POST", `${INBOX}/sync`, { body: {}, timeout: 300_000 }), "POST /sync");
    const r = await http("GET", `${INBOX}/triage`, { timeout: 300_000 });
    assert.equal(r.status, 200, `status ${r.status}: ${short(r.text, 160)}`);
    const t = r.json;
    assert.ok(Array.isArray(t?.needsYou) && Array.isArray(t.fyi) && typeof t.ignored === "number", `shape: ${short(t)}`);
    assert.ok(t.needsYou.length > 0 && t.needsYou.length <= 5, `needsYou has ${t.needsYou.length} items`);
    for (const e of t.needsYou) for (const k of ["id", "from", "subject", "snippet", "receivedAt"]) assert.ok(typeof e?.[k] === "string" && e[k], `email lacks "${k}": ${short(e)}`);
    needsYou = t.needsYou;
    const log = fs.readFileSync(svcs.inbox.log!, "utf8");
    const fellBack = /heuristic|fallback|LLMUnavailable/i.test(log) ? ` — inbox log mentions a fallback: ${short(log.split("\n").find((l) => /heuristic|fallback|LLMUnavailable/i.test(l)), 160)}` : "";
    return `${secs(r.ms)}: ${t.needsYou.length} needsYou (${t.needsYou.map((e: any) => short(e.subject, 28)).join(" | ")}), ${t.fyi.length} fyi, ${t.ignored} ignored${fellBack}`;
  });

  await check(`${T}: inbox deadline events land in memory`, async () => {
    need("inbox", "memory");
    const deadlines = (await http("GET", `${INBOX}/deadlines`, { timeout: 120_000 })).json as any[];
    assert.ok(Array.isArray(deadlines) && deadlines.length, `inbox has no deadlines: ${short(deadlines)}`);
    S.deadlines = deadlines;
    const hit = await pollFor(async () => {
      for (const d of deadlines.slice(0, 6)) {
        const sn = ((await ctxText(`${d.title} due`, 10)).json?.snippets ?? []) as any[];
        const m = sn.map((x) => (typeof x === "string" ? x : String(x?.text))).find((t) => t.includes(d.title) && t.includes(d.dueAt));
        if (m) return m;
      }
      return null;
    }, 8000, 1000);
    assert.ok(hit, `memory /context has no "<title> … <dueAt>" event for any of ${deadlines.length} inbox deadlines (e.g. "${deadlines[0].title}")`);
    return `${deadlines.length} deadline(s); memory has: ${short(hit, 110)}`;
  });

  await check(`${T}: inbox /schedule/plan reads focus hours from the live memory service`, async () => {
    need("inbox", "memory");
    const plan = await getPlan();
    assert.ok(plan.length > 0, "no blocks planned");
    assertProposals(plan, "inbox", "plan");
    const bad: string[] = [];
    const spilled: string[] = [];
    const perDay: Record<string, number> = {};
    for (const p of plan) {
      const s = new Date(p.payload.start), e = new Date(p.payload.end);
      const mins = (e.getTime() - s.getTime()) / 60000;
      perDay[dayKey(s)] = (perDay[dayKey(s)] ?? 0) + mins;
      if (!p.title.startsWith("◎ ")) bad.push(`title "${p.title}"`);
      if (mins > 50) bad.push(`${mins} min block`);
      if (hm(e) > 23 || dayKey(s) !== dayKey(e)) bad.push(`ends after 23:00: ${p.title}`);
      const due = dueOf(p, S.deadlines ?? []);
      if (due && (Date.parse(due) - e.getTime()) / 3_600_000 < 24) bad.push(`< 24 h before deadline: ${p.title}`);
      if (!(hm(s) >= 14 && hm(e) <= 17)) spilled.push(`${short(p.title, 30)} ${s.toTimeString().slice(0, 5)}`);
    }
    // By design (inbox/src/calendar/planner.ts:6,107) the planner fills every day's focus window first and only
    // then uses other daytime slots, so a few spill-over blocks are legitimate; the bulk must sit in the window.
    assert.ok(spilled.length <= plan.length / 4, `${spilled.length} of ${plan.length} blocks outside the 14:00–17:00 focus window: ${spilled.slice(0, 4).join("; ")}`);
    for (const [d, m] of Object.entries(perDay)) if (m > 360) bad.push(`${m} min on ${d}`);
    assert.equal(bad.length, 0, `${bad.length} rule violation(s) in ${plan.length} blocks: ${bad.slice(0, 4).join("; ")}`);
    assert.match(String(plan[0].why), /routines\.md/, `why does not cite routines.md: "${plan[0].why}"`);
    return `${plan.length} block(s) within the rules, ${plan.length - spilled.length} in 14:00–17:00, ${spilled.length} spilled over (${spilled.slice(0, 3).join("; ")}); why: "${short(plan[0].why, 100)}"`;
  });

  await check(`${T}: inbox /draft with the model → send_reply → approve → done`, async () => {
    need("inbox");
    if (!needsYou.length) skip("no needsYou email (see the triage check)");
    const r = await http("POST", `${INBOX}/draft`, { body: { emailId: needsYou[0].id }, timeout: 180_000 });
    assert.equal(r.status, 200, `status ${r.status}: ${short(r.text, 160)}`);
    const p = r.json;
    assert.deepEqual(proposalProblems(p, "inbox"), [], "invalid proposal");
    assert.equal(p.type, "send_reply");
    for (const k of ["to", "subject", "body"]) assert.ok(typeof p.payload?.[k] === "string" && p.payload[k].trim(), `payload.${k}: ${short(p.payload?.[k])}`);
    fs.writeFileSync(path.join(RUN_DIR, "real-draft.txt"), `To: ${p.payload.to}\nSubject: ${p.payload.subject}\n\n${p.payload.body}\n\nwhy: ${p.why}\n`);
    const a = await http("POST", `${INBOX}/proposals/${p.id}/approve`, { body: {}, timeout: 60_000 });
    ok2xx(a, "approve");
    assert.equal(a.json?.status, "done", `after approve: status "${a.json?.status}" ${short(a.json?.payload?.error ?? "", 100)}`);
    return `${secs(r.ms)}; to ${p.payload.to}; body ${p.payload.body.length} chars: "${short(p.payload.body.replace(/\s+/g, " "), 150)}" → done`;
  });

  await check(`${T}: memory /digest/run with the model, then /insights`, async () => {
    need("memory");
    const d = await http("POST", `${MEM}/digest/run`, { body: {}, timeout: 400_000 });
    assert.equal(d.status, 200, `POST /digest/run → ${d.status}: ${short(d.text, 200)}`);
    const i = await http("GET", `${MEM}/insights`);
    const n = i.json?.nextThing;
    assert.ok(n && typeof n.title === "string" && n.title.trim() && typeof n.why === "string" && n.why.trim() && typeof n.minutes === "number", `nextThing: ${short(n)}`);
    assert.ok(Array.isArray(i.json.cards) && i.json.cards.length <= 5, `cards: ${short(i.json.cards, 80)}`);
    assertProposals(i.json.cards, "memory", "cards");
    assert.ok(i.ms < 200, `/insights took ${i.ms.toFixed(0)} ms after the digest`);
    const long: string[] = [];
    for (const k of (await http("GET", `${MEM}/knowledge`)).json as any[]) {
      const c = String((await http("GET", `${MEM}/knowledge/${k.name}`)).json?.content ?? "");
      if (c.split("\n").length > 60) long.push(`${k.name} ${c.split("\n").length} lines`);
    }
    assert.equal(long.length, 0, `knowledge files over 60 lines after the digest: ${long.join(", ")}`);
    const log = fs.readFileSync(svcs.memory.log!, "utf8");
    const warn = log.split("\n").filter((l) => /error|traceback|fallback|failed/i.test(l) && !/umem/i.test(l)).slice(-1)[0];
    return `${secs(d.ms)}; nextThing "${short(n.title, 50)}" (${n.minutes} min) — why: "${short(n.why, 110)}"; ${i.json.cards.length} card(s)${warn ? ` — memory log: ${short(warn, 160)}` : ""}`;
  });

  await check(`${T}: actions fill via a Sidekick instruction → approve → "form" event in memory`, async () => {
    need("actions", "memory");
    const s = await sse(`Fill out the application form at ${ACT}/fixtures/internship.html`, 300_000);
    assert.equal(s.status, 200, `status ${s.status}`);
    const last = s.frames[s.frames.length - 1];
    assert.equal(last?.action, "stopped", `last frame is "${last?.action}": ${short(last?.detail, 160)}`);
    assert.ok(s.frames.every((f) => typeof f.runId === "string"), "frames lack runId");
    const run = (await http("GET", `${ACT}/runs/${last.runId}`)).json;
    assert.equal(run?.status, "stopped", `run status ${run?.status}`);
    const p = ((await http("GET", `${ACT}/proposals?status=pending`)).json as any[]).find((x) => x.id === last.proposalId);
    assert.ok(p, `no pending proposal ${last.proposalId}`);
    assert.deepEqual(proposalProblems(p, "actions"), [], "invalid proposal");
    const fields = (p.payload?.fields ?? []) as any[];
    const filled = fields.filter((f) => String(f.value ?? "").trim()).length;
    assert.ok(filled >= 8, `only ${filled} of ${fields.length} fields have a value`);
    const answers: Record<string, string> = {};
    for (const u of (p.payload?.unknown ?? []) as any[]) if (u.selector) answers[u.selector] = /referen/i.test(u.label ?? "") ? REFERENCE : "N/A";
    const a = await http("POST", `${ACT}/proposals/${p.id}/approve`, { body: Object.keys(answers).length ? { answers } : {}, timeout: 180_000 });
    ok2xx(a, "approve");
    assert.equal(a.json?.status, "done", `after approve: status "${a.json?.status}" ${short(a.json?.payload?.error ?? "", 160)}`);
    const hit = await pollFor(async () => {
      const sn = ((await ctxText("Applied to", 10)).json?.snippets ?? []) as any[];
      return sn.map((x) => (typeof x === "string" ? x : String(x?.text))).find((t) => /Applied to/.test(t) && /submitted/.test(t));
    }, 8000, 1000);
    assert.ok(hit, "no form event in memory /context after the submit");
    return `${s.frames.length} frames; ${filled}/${fields.length} fields filled, ${Object.keys(answers).length} answered by "the user"; submit done ("${short(a.json?.payload?.confirmation, 60)}"); memory: ${short(hit, 90)}`;
  });

  await check(`${T}: every service's pending proposals are valid`, async () => {
    need("memory", "inbox", "actions");
    const counts: string[] = [];
    const probs: string[] = [];
    for (const [agent, base] of [["memory", MEM], ["inbox", INBOX], ["actions", ACT]] as const) {
      const r = await http("GET", `${base}/proposals?status=pending`);
      counts.push(`${agent} ${r.json.length}`);
      for (const p of r.json) probs.push(...proposalProblems(p, agent).map((m) => `${agent} ${m}`));
    }
    assert.equal(probs.length, 0, `${probs.length} problem(s): ${probs.slice(0, 4).join("; ")}`);
    return counts.join(", ");
  });
}

// ───────────────────────── ui (Playwright) ─────────────────────────
async function uiChecks() {
  const T = "ui";
  if (!up("ui")) {
    await check(`${T}: web UI on :5199`, async () => need("ui"));
    return;
  }
  const pw = await import(pathToFileURL(path.join(ROOT, "actions/node_modules/playwright/index.mjs")).href);
  const browser = await pw.chromium.launch({ headless: true });
  const liveSvcs = (["memory", "inbox", "actions"] as const).filter(up);
  const REACT_ERR = /Minified React error|Maximum update depth|Cannot read propert|is not a function|Something went wrong|Unexpected Application Error|error boundary/i;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("ns.onboarded", "1");
      } catch {}
    });
    const errors: string[] = [];
    const watch = (p: any) => {
      p.on("pageerror", (e: Error) => errors.push(`pageerror: ${e.message.split("\n")[0]}`));
      p.on("console", (m: any) => {
        if (m.type() === "error" && /React|Uncaught|Warning: |The above error/i.test(m.text())) errors.push(`console: ${m.text().split("\n")[0]}`);
      });
    };
    ctx.on("page", watch);
    const page = await ctx.newPage();
    const bodyText = async (p: any = page) => ((await p.locator("body").innerText().catch(() => "")) as string);
    const errsSince = (n: number) => errors.slice(n);
    const navBtn = (label: string) => page.locator("header >> nth=0 >> button", { hasText: new RegExp(`^\\s*${label}(\\s*\\d+)?\\s*$`) }).last();

    await check(`${T}: app loads with no page errors`, async () => {
      await page.goto(UI, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.locator("header").first().waitFor({ state: "visible", timeout: 15_000 });
      await page.waitForTimeout(1500);
      assert.equal(errors.length, 0, errors.slice(0, 2).join(" | "));
      const t = await bodyText();
      assert.ok(t.includes("Northstar"), `header text missing: ${short(t, 80)}`);
      assert.ok(!REACT_ERR.test(t), `error text on page: ${short(t.match(REACT_ERR)?.[0])}`);
      return `header rendered, ${t.length} chars of text, 0 errors`;
    });

    await check(`${T}: header shows each running service as live`, async () => {
      if (!liveSvcs.length) skip("no service is running");
      const bad: string[] = [];
      for (const s of ["memory", "inbox", "actions"] as const) {
        const expectLive = up(s);
        const sel = `header [title="${s}: ${expectLive ? "live" : "demo data"}"]`;
        const ok = await page.locator(sel).first().waitFor({ state: "attached", timeout: 8000 }).then(() => true, () => false);
        if (!ok) bad.push(`${s} not shown as ${expectLive ? "live" : "demo data"}`);
      }
      assert.equal(bad.length, 0, bad.join("; "));
      return `live: ${liveSvcs.join(", ")}${liveSvcs.length < 3 ? "; the rest shown as demo data" : ""}`;
    });

    let screens: string[] = [];
    await check(`${T}: each nav screen renders without a React error`, async () => {
      const labels = ((await page.locator("header >> nth=0 >> button").allInnerTexts()) as string[]).map((t) => t.replace(/\s*\d+\s*$/, "").trim());
      // every nav button the header offers (Dashboard, Activity, … included), not just the ones known today
      screens = [...new Set(labels)].filter((l) => l && l !== "Northstar" && !/Hand off|Ctrl/i.test(l) && l.length <= 20);
      S.activityBuilt = screens.includes("Activity");
      const core = ["Approve", "Workflow", "Knowledge"].filter((l) => !screens.includes(l));
      assert.equal(core.length, 0, `nav lacks ${core.join(", ")}; buttons found: ${labels.join(" | ")}`);
      const notes: string[] = [];
      for (const label of screens) {
        const before = errors.length;
        await navBtn(label).click();
        await page.waitForTimeout(1300);
        const t = ((await page.locator("main").innerText()) as string).trim();
        assert.ok(t.length > 20, `${label}: main is (nearly) empty: "${short(t, 60)}"`);
        assert.ok(!REACT_ERR.test(t), `${label}: error text on screen: ${short(t.match(REACT_ERR)?.[0])}`);
        assert.equal(errsSince(before).length, 0, `${label}: ${errsSince(before).slice(0, 2).join(" | ")}`);
        notes.push(`${label} ${t.length}ch`);
      }
      return notes.join(", ") + (S.activityBuilt ? "" : " (no Activity nav button yet)") + (screens.includes("Dashboard") ? "" : " (no Dashboard nav button yet)");
    });

    await check(`${T}: Approve lists real proposals from the running services`, async () => {
      if (!liveSvcs.length) skip("no service is running");
      const real: any[] = [];
      for (const s of liveSvcs) {
        const r = await http("GET", `${{ memory: MEM, inbox: INBOX, actions: ACT }[s]}/proposals?status=pending`).catch(() => null);
        if (Array.isArray(r?.json)) real.push(...r!.json);
      }
      if (!real.length) skip("the running services have no pending proposals");
      real.sort((a, b) => b.urgency - a.urgency);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("header").first().waitFor({ state: "visible" });
      await navBtn("Approve").click();
      const top = real.filter((p) => p.urgency === real[0].urgency).map((p) => String(p.title));
      const seen = await pollFor(async () => {
        const t = await bodyText();
        return top.find((x) => t.includes(x)) ?? null;
      }, 8000);
      const t = await bodyText();
      assert.ok(seen, `none of the ${top.length} top-urgency real titles is on the Approve screen (e.g. "${short(top[0], 50)}"); screen says: ${short(t.replace(/\s+/g, " ").slice(120), 160)}`);
      const badge = ((await navBtn("Approve").innerText()) as string).match(/\d+/)?.[0];
      if (liveSvcs.length === 3) assert.equal(Number(badge), real.length, `nav badge shows ${badge}, services have ${real.length} pending`);
      return `shows "${short(seen, 50)}"; badge ${badge ?? "none"} vs ${real.length} real pending`;
    });

    const MOCK_STEP = "Filling 14 of 15 fields";
    await check(`${T}: command bar runs a Sidekick instruction and shows streamed steps`, async () => {
      const instruction = "find the CS 101 syllabus";
      await page.locator("button", { hasText: "Hand off a task" }).first().click(); // floating button, no longer in the header
      const input = page.locator('input[placeholder*="take over" i]');
      await input.waitFor({ state: "visible", timeout: 5000 });
      await input.fill(instruction);
      await input.press("Enter");
      const steps = page.locator("div.fixed", { has: input }).locator("ul li", { has: page.locator("svg") });
      await steps.first().waitFor({ state: "visible", timeout: 20_000 });
      // finished = no spinner left
      await pollFor(async () => (await steps.locator("svg.animate-spin").count()) === 0 && (await steps.count()) > 1, 60_000, 500);
      const texts = ((await steps.allInnerTexts()) as string[]).map((x) => x.trim());
      assert.ok(texts.length >= 2, `only ${texts.length} step(s) shown: ${short(texts)}`);
      if (up("actions")) {
        S.ranInstructions.push(instruction);
        assert.ok(!texts.includes(MOCK_STEP), `the UI showed its offline mock steps although actions is up: ${short(texts)}`);
        if (S.sidekickDetails.length) assert.ok(texts.some((x) => S.sidekickDetails.includes(x)), `shown steps do not match the service's stream: ${short(texts, 200)}`);
      }
      await page.keyboard.press("Escape");
      return `${texts.length} step(s) shown, last: "${short(texts[texts.length - 1], 70)}"${up("actions") ? "" : " (actions down: UI mock stream)"}`;
    });

    // ── screens fed by live services (the UI builder could only test these against mocks) ──
    const BASES = { memory: MEM, inbox: INBOX, actions: ACT } as const;
    const pendingOf = async (s: "memory" | "inbox" | "actions"): Promise<any[]> => {
      const r = up(s) ? await http("GET", `${BASES[s]}/proposals?status=pending`).catch(() => null) : null;
      return Array.isArray(r?.json) ? r!.json : [];
    };
    const openMain = async (label: string) => {
      await page.goto("about:blank");
      await page.goto(UI, { waitUntil: "domcontentloaded" });
      await page.locator("header").first().waitFor({ state: "visible" });
      await navBtn(label).click();
      await page.waitForTimeout(800);
    };
    /** Is tab `p` showing the main app on screen `label`? True when clicking that nav button changes nothing. */
    const onScreen = async (p: any, label: string): Promise<{ same: boolean; was: string } | null> => {
      const b = p.locator("header >> nth=0 >> button", { hasText: new RegExp(`^\\s*${label}(\\s*\\d+)?\\s*$`) }).last();
      if (!(await b.count().catch(() => 0))) return null;
      await p.waitForTimeout(900);
      const head = async () => ((await p.locator("main").innerText()) as string).replace(/\s+/g, " ").slice(0, 50);
      const was = await head();
      await b.click();
      await p.waitForTimeout(900);
      return { same: !!was && was === (await head()), was };
    };
    /** Smallest element whose text has every needle (case-insensitive): a "row". */
    const rowWith = (needles: string[]) =>
      page.evaluate((ns: string[]) => {
        let best: string | null = null;
        for (const el of Array.from(document.querySelectorAll("main li, main tr, main article, main div, main button"))) {
          const t = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ");
          if (t.length < 400 && ns.every((n) => t.toLowerCase().includes(n.toLowerCase())) && (!best || t.length < best.length)) best = t;
        }
        return best;
      }, needles);

    await check(`${T}: Dashboard renders with live data`, async () => {
      need("memory", "inbox");
      const before = errors.length;
      const ins = (await http("GET", `${MEM}/insights`)).json;
      const tri = (await http("GET", `${INBOX}/triage`, { timeout: 60_000 })).json;
      const today = (await http("GET", `${INBOX}/calendar/today`)).json as any[];
      const fromMemory = [ins?.nextThing?.title, ...(await pendingOf("memory")).map((p) => p.title)].filter(Boolean) as string[];
      const fromInbox = [...(tri?.needsYou ?? []).flatMap((e: any) => [e.subject, e.from]), ...(await pendingOf("inbox")).map((p) => p.title), ...today.map((e) => e.title)].filter(Boolean) as string[];
      await openMain("Dashboard");
      const seen = await pollFor(async () => {
        const t = await bodyText();
        const m = fromMemory.find((x) => t.includes(x));
        const i = fromInbox.find((x) => t.includes(x));
        return m && i ? { m, i } : null;
      }, 10_000);
      const t = (await bodyText()).replace(/\s+/g, " ");
      assert.ok(seen, `Dashboard lacks live data from ${fromMemory.some((x) => t.includes(x)) ? "" : "memory "}${fromInbox.some((x) => t.includes(x)) ? "" : "inbox"}; it says: ${short(t.slice(60), 220)}`);
      assert.ok(!REACT_ERR.test(t), "error text on Dashboard");
      assert.equal(errsSince(before).length, 0, errsSince(before).slice(0, 2).join(" | "));
      return `memory: "${short(seen!.m, 45)}"; inbox: "${short(seen!.i, 45)}"`;
    });

    await check(`${T}: Inbox screen shows real triage`, async () => {
      need("inbox");
      const tri = (await http("GET", `${INBOX}/triage`, { timeout: 60_000 })).json;
      const senders = [...new Set((tri?.needsYou ?? []).map((e: any) => String(e.from)))] as string[];
      assert.ok(senders.length > 0, "inbox /triage has no needsYou");
      await openMain("Workflow"); // Inbox is a sub-tab of Workflow
      await page.locator("main button", { hasText: /^\s*Inbox\s*$/ }).first().click();
      await page.waitForTimeout(600);
      const all = await pollFor(async () => {
        const t = await bodyText();
        return senders.every((s) => t.includes(s));
      }, 8000);
      const t = await bodyText();
      const missing = senders.filter((s) => !t.includes(s));
      assert.ok(all, `${missing.length} of ${senders.length} real needsYou senders not on the Inbox screen (e.g. "${missing[0]}"); it says: ${short(t.replace(/\s+/g, " ").slice(60), 200)}`);
      const subj = (tri.needsYou as any[]).filter((e) => t.includes(e.subject)).length;
      return `all ${senders.length} needsYou senders shown, ${subj} of ${tri.needsYou.length} subjects`;
    });

    await check(`${T}: Knowledge screen loads and saves a real file`, async () => {
      need("memory");
      const before = errors.length;
      const orig = (await http("GET", `${MEM}/knowledge/goals.md`)).json?.content as string;
      assert.equal(typeof orig, "string", "cannot read goals.md from memory");
      const marker = `e2e ui save ${Date.now() % 1_000_000}`;
      try {
        await openMain("Knowledge");
        await page.locator("main button", { hasText: /^\s*goals\.md\s*$/ }).first().click();
        const plain = orig.split("\n").map((l) => l.replace(/^[\s#>*-]+/, "").replace(/[*_`]/g, "").trim()).filter((l) => l.length > 18);
        const probe = plain[Math.min(1, plain.length - 1)]?.slice(0, 18) ?? "";
        const loaded = await pollFor(async () => probe && (await bodyText()).includes(probe), 8000);
        assert.ok(loaded, `goals.md content from memory ("${probe}…") is not shown`);
        await page.getByText("Edit", { exact: true }).first().click();
        const ta = page.locator("main textarea").first();
        await ta.waitFor({ state: "visible", timeout: 5000 });
        assert.equal(((await ta.inputValue()) as string).trim(), orig.trim(), "the editor does not hold the real file content");
        await ta.fill(`${orig.trimEnd()}\n- ${marker}\n`);
        await page.locator("main button", { hasText: /^\s*Save\s*$/ }).first().click();
        const saved = await pollFor(async () => String((await http("GET", `${MEM}/knowledge/goals.md`)).json?.content).includes(marker), 8000);
        assert.ok(saved, "after Save, memory's goals.md does not contain the edit");
        assert.ok(await pollFor(async () => (await bodyText()).includes(marker), 4000), "the saved text is not shown after Save");
        assert.equal(errsSince(before).length, 0, errsSince(before).slice(0, 2).join(" | "));
        return `goals.md shown ("${probe}…"), edited and saved; memory now has the edit`;
      } finally {
        await http("PUT", `${MEM}/knowledge/goals.md`, { body: { content: orig } }).catch(() => {});
      }
    });

    // ── Ask window ──
    const FILL = "Fill my Stripe application";
    const ask = await ctx.newPage();
    let askReady = false;
    await check(`${T}: /#ask renders an input`, async () => {
      await ask.goto(`${UI}/#ask`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await ask.waitForTimeout(1500);
      const input = ask.locator("input:visible, textarea:visible").first();
      const has = await input.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false);
      const mainNav = (await ask.locator("header >> nth=0 >> button", { hasText: "Knowledge" }).count()) > 0;
      S.askBuilt = has && !mainNav;
      if (!S.askBuilt) skip(`Ask window not built yet: /#ask ${mainNav ? "renders the main app" : "has no visible input"}`);
      askReady = true;
      return `input visible (placeholder "${(await input.getAttribute("placeholder")) ?? ""}")`;
    });

    let fillProposal: any = null;
    await check(`${T}: /#ask runs "${FILL}", shows steps and "Review & approve"`, async () => {
      if (!askReady) skip("Ask window not built yet");
      need("actions");
      const before = errors.length;
      const input = ask.locator("input:visible, textarea:visible").first();
      await input.fill(FILL);
      await input.press("Enter");
      const btn = ask.locator("button", { hasText: "Review & approve" });
      const shown = await btn.first().waitFor({ state: "visible", timeout: 120_000 }).then(() => true, () => false);
      const t = (await bodyText(ask)).replace(/\s+/g, " ");
      assert.ok(shown, `"Review & approve" never appeared; the panel says: ${short(t, 220)}`);
      const steps = ((await ask.locator("ul li").allInnerTexts()) as string[]).map((x) => x.trim()).filter(Boolean);
      assert.ok(steps.length >= 1, "no step lines shown");
      // it must be the real service's run, not the UI's offline mock stream
      const runs = (await http("GET", `${ACT}/runs`)).json as any[];
      const run = runs.find((r) => JSON.stringify(r).includes(FILL));
      assert.ok(run, `actions /runs has no run for "${FILL}": the panel showed its offline mock stream`);
      assert.equal(run.status, "stopped", `run status "${run.status}", expected "stopped" (paused for approval)`);
      const lastFrame = run.steps?.[run.steps.length - 1];
      assert.ok(steps.some((s) => (run.steps as any[]).some((f) => f.detail === s || String(f.detail).startsWith(s.replace(/…$/, "")))), `shown steps are not the run's steps: ${short(steps, 160)}`);
      fillProposal = (await pendingOf("actions")).find((p) => p.type === "fill_form" && (!lastFrame?.proposalId || p.id === lastFrame.proposalId));
      assert.ok(fillProposal, "no pending fill_form proposal in actions after the run");
      S.ranInstructions.push(FILL);
      assert.equal(errsSince(before).length, 0, errsSince(before).slice(0, 2).join(" | "));
      return `${steps.length} step line(s), last "${short(steps[steps.length - 1], 60)}"; run ${run.status}; pending "${short(fillProposal.title, 40)}"`;
    });

    await check(`${T}: Ask "Review & approve" lands on the Approve screen`, async () => {
      if (!fillProposal) skip("no finished fill run in the Ask window (see the check above)");
      await ask.locator("button", { hasText: "Review & approve" }).first().click();
      const st = await pollFor(async () => onScreen(ask, "Approve"), 6000);
      assert.ok(st, `no main app in the Ask tab after the click; url ${ask.url()}`);
      assert.ok(st!.same, `the main app opened on "${st!.was}", not on Approve`);
      return `main app on Approve ("${short(st!.was, 40)}")`;
    });

    await check(`${T}: /#ask maximize control lands on the Activity screen`, async () => {
      if (!askReady) skip("Ask window not built yet");
      const ask2 = await ctx.newPage();
      try {
        await ask2.goto(`${UI}/#ask`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await ask2.locator("input:visible").first().waitFor({ state: "visible", timeout: 8000 });
        const ctl = ask2.locator(
          '[aria-label*="aximi" i], [title*="aximi" i], [aria-label*="xpand" i], [title*="xpand" i], [aria-label*="ctivity" i], [title*="ctivity" i], [aria-label*="full" i], [title*="full" i], [aria-label*="open northstar" i]',
        ).first();
        if (!(await ctl.count())) {
          const labels = await ask2.locator("button").evaluateAll((bs: Element[]) => bs.map((b) => b.getAttribute("aria-label") || b.getAttribute("title") || (b.textContent ?? "").trim().slice(0, 20)));
          assert.fail(`no maximize control found on /#ask (buttons: ${short(labels, 160)})`);
        }
        const known = new Set(ctx.pages());
        await ctl.click();
        await ask2.waitForTimeout(800);
        const targets = [ask2, ...ctx.pages().filter((p: any) => !known.has(p))];
        let st: { same: boolean; was: string } | null = null;
        for (const p of targets) st = st ?? (await onScreen(p, "Activity"));
        assert.ok(st, `after the click no window shows the main app; ask url is ${ask2.url()}`);
        assert.ok(st!.same, `the main app opened on "${st!.was}", not on Activity`);
        return `main app on Activity ("${short(st!.was, 40)}")`;
      } finally {
        await ask2.close().catch(() => {});
      }
    });

    await check(`${T}: /#activity and /#approve select those screens on load`, async () => {
      const notes: string[] = [];
      for (const [hash, label] of [["activity", "Activity"], ["approve", "Approve"]] as const) {
        const p = await ctx.newPage();
        try {
          await p.goto(`${UI}/#${hash}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await p.locator("header").first().waitFor({ state: "visible", timeout: 10_000 });
          const st = await onScreen(p, label);
          assert.ok(st?.same, `/#${hash} opened on "${st?.was}", not on ${label}`);
          notes.push(`/#${hash} → ${label}`);
        } finally {
          await p.close().catch(() => {});
        }
      }
      return notes.join(", ");
    });

    await check(`${T}: Approve lists proposals from all three services`, async () => {
      need("memory", "inbox", "actions");
      const per = { memory: await pendingOf("memory"), inbox: await pendingOf("inbox"), actions: await pendingOf("actions") };
      const empty = (Object.keys(per) as (keyof typeof per)[]).filter((s) => !per[s].length);
      assert.equal(empty.length, 0, `no pending proposals in ${empty.join(", ")}, so the merged queue cannot be checked for it`);
      const total = per.memory.length + per.inbox.length + per.actions.length;
      await openMain("Approve");
      const seen = { memory: "", inbox: "", actions: "" };
      await page.locator("main").click({ position: { x: 5, y: 5 } }).catch(() => {});
      for (let i = 0; i <= total + 2; i++) {
        const t = await bodyText();
        for (const s of Object.keys(per) as (keyof typeof per)[]) seen[s] ||= per[s].map((p) => String(p.title)).find((x) => t.includes(x)) ?? "";
        if (seen.memory && seen.inbox && seen.actions) break;
        await page.keyboard.press("j");
        await page.waitForTimeout(350);
      }
      const miss = (Object.keys(seen) as (keyof typeof seen)[]).filter((s) => !seen[s]);
      assert.equal(miss.length, 0, `stepping through the queue (${total} pending) never showed a proposal from ${miss.join(", ")} (it has ${miss.map((s) => per[s].length).join("/")} pending)`);
      const badge = Number(((await navBtn("Approve").innerText()) as string).match(/\d+/)?.[0]);
      assert.equal(badge, total, `nav badge shows ${badge}, the services have ${total} pending`);
      return `queue of ${total}: memory "${short(seen.memory, 28)}", inbox "${short(seen.inbox, 28)}", actions "${short(seen.actions, 28)}"; badge ${badge}`;
    });

    await check(`${T}: Activity shows real runs from :7703/runs with their status, live`, async () => {
      if (!S.activityBuilt) skip("Activity screen not built yet: no Activity button in the nav");
      need("actions");
      const before = errors.length;
      await openMain("Activity");
      const notes: string[] = [];
      const runs = (await http("GET", `${ACT}/runs`)).json as any[];
      const main = async () => ((await page.locator("main").innerText()) as string).replace(/\s+/g, " ");
      const doneRun = runs.find((r) => r.status === "done");
      if (doneRun) {
        const row = await pollFor(() => rowWith([doneRun.instruction, "Done"]), 8000);
        assert.ok(row, `run "${doneRun.instruction}" (done) has no row marked Done; screen: ${short(await main(), 220)}`);
        notes.push(`"${short(doneRun.instruction, 30)}" → Done`);
      }
      const stopped = runs.find((r) => r.status === "stopped");
      if (stopped) {
        const row = await pollFor(() => rowWith([stopped.instruction, "Needs your OK"]), 8000);
        assert.ok(row, `run "${stopped.instruction}" (stopped) has no row marked "Needs your OK"; screen: ${short(await main(), 220)}`);
        notes.push(`"${short(stopped.instruction, 30)}" → Needs your OK`);
      }
      assert.ok(doneRun || stopped, "actions /runs has no finished run to look for");
      // a run started while the screen is open must show up without a reload and end as Done
      const live = `find the CS 101 syllabus again ${Date.now() % 10_000}`;
      const stream = sse(live).catch(() => null);
      const appeared = await pollFor(() => rowWith([live]), 12_000, 300);
      assert.ok(appeared, `a run started while Activity is open never appeared (no reload); screen: ${short(await main(), 200)}`);
      await stream;
      const finished = await pollFor(() => rowWith([live, "Done"]), 10_000, 300);
      assert.ok(finished, `the new run's row never changed to Done; row: ${short(await rowWith([live]), 160)}`);
      S.ranInstructions.push(live);
      notes.push(`new run appeared live (${/done/i.test(appeared!) ? "already Done" : "as running"}) and ended Done`);
      assert.equal(errsSince(before).length, 0, errsSince(before).slice(0, 2).join(" | "));
      return notes.join("; ");
    });

    await check(`${T}: Activity lists real inbox events, including an approved ◎ block`, async () => {
      if (!S.activityBuilt) skip("Activity screen not built yet: no Activity button in the nav");
      need("inbox");
      let week = (await http("GET", `${INBOX}/calendar/week`)).json as any[];
      if (!week.some((e) => e.northstar)) {
        const next = (await pendingOf("inbox")).filter((p) => p.type === "create_event" && Date.parse(p.payload?.start) > Date.now()).sort((a, b) => Date.parse(a.payload.start) - Date.parse(b.payload.start))[0];
        assert.ok(next, "no approved ◎ block and no pending block to approve");
        ok2xx(await http("POST", `${INBOX}/proposals/${next.id}/approve`, { body: {} }), "approve a block");
        week = (await http("GET", `${INBOX}/calendar/week`)).json as any[];
      }
      const today = (await http("GET", `${INBOX}/calendar/today`)).json as any[];
      const strip = (s: string) => String(s).replace(/^◎\s*/, "");
      const plain = [...new Set([...today, ...week].filter((e) => !e.northstar).map((e) => strip(e.title)))];
      const blocks = [...new Set([...today, ...week].filter((e) => e.northstar && Date.parse(e.end) > Date.now()).map((e) => strip(e.title)))];
      assert.ok(blocks.length > 0, "inbox has no upcoming approved ◎ block in /calendar/today or /calendar/week");
      await openMain("Activity");
      const got = await pollFor(async () => {
        const t = await bodyText();
        const a = plain.filter((x) => t.includes(x));
        const b = blocks.find((x) => t.includes(x) && t.includes("◎"));
        return a.length && b ? { a, b } : null;
      }, 8000);
      const t = (await page.locator("main").innerText() as string).replace(/\s+/g, " ");
      assert.ok(got, `Activity lacks ${plain.some((x) => t.includes(x)) ? "" : "inbox's calendar events "}${blocks.some((x) => t.includes(x)) ? "" : `the approved block "◎ ${blocks[0]}"`}; screen: ${short(t, 260)}`);
      return `${got!.a.length} of ${plain.length} inbox event titles shown (e.g. "${short(got!.a[0], 30)}"); approved block "◎ ${short(got!.b, 30)}" shown`;
    });

    await check(`${T}: no page errors during the whole UI session`, async () => {
      assert.equal(errors.length, 0, `${errors.length} error(s): ${[...new Set(errors)].slice(0, 3).join(" | ")}`);
      return "0 page errors / React console errors";
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

// ───────────────────────── main ─────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`── northstar e2e${REAL ? " REAL MODE (MOCK=0)" : ""} · ${new Date().toISOString()} · sections: ${[...ONLY].join(",")} · run dir ${RUN_DIR}`);
  const toStart: SvcName[] = ["memory", "inbox", "actions", ...(want("ui") && !REAL ? (["ui"] as const) : [])];
  const taken: number[] = [];
  for (const n of toStart) if (await portTaken(svcs[n].port)) taken.push(svcs[n].port);
  if (taken.length) {
    console.log(`ABORT  port(s) ${taken.join(", ")} already in use; refusing to test someone else's server`);
    process.exit(2);
  }
  // memory first: inbox and actions read from it at boot
  await startSvc(svcs.memory);
  await Promise.all(toStart.filter((n) => n !== "memory").map((n) => startSvc(svcs[n])));
  for (const n of toStart) {
    const s = svcs[n];
    if (s.state === "up") console.log(`UP     ${n} on :${s.port}`);
    else if (s.state === "not-built") console.log(`NOT BUILT YET  ${n} (${s.why})`);
    else record(`${n}: service boots`, "FAIL", `${s.why}`);
  }
  const smoke = !REAL && want("actions") && svcs.actions.state !== "not-built" ? runSmoke() : null;

  try {
    if (REAL) await realChecks();
    else {
    if (want("memory")) await memoryChecks();
    if (want("inbox")) await inboxChecks();
    if (want("actions")) await actionsChecks(smoke);
    if (want("cross")) await crossChecks();
    if (want("ui")) await uiChecks();
    }
    // a service that died mid-run is a failure in its own right
    for (const n of toStart) {
      const s = svcs[n];
      if (s.state === "up" && s.child && s.child.exitCode !== null) record(`${n}: process stayed up`, "FAIL", `exited with code ${s.child.exitCode}; log tail: ${short(logTail(s, 3), 300)}`);
    }
  } finally {
    await teardown();
  }
  if (!REAL) await ownSuites();
  const n = (st: string) => results.filter((r) => r.status === st).length;
  const h = (x: SvcName) => (up(x) ? 1 : 0);
  console.log(`STATE  health=memory:${h("memory")},inbox:${h("inbox")},actions:${h("actions")},ui:${h("ui")} ask=${S.askBuilt ? 1 : 0} activity=${S.activityBuilt ? 1 : 0} runs=${S.runsAvailable ? 1 : 0}`);
  console.log(`──── summary: ${n("PASS")} passed, ${n("FAIL")} failed, ${n("SKIP")} skipped, ${results.length} total · ${((Date.now() - t0) / 1000).toFixed(0)} s ────`);
  process.exit(n("FAIL") ? 1 : 0);
}
main().catch(async (err) => {
  console.log(`ABORT  ${err?.stack ?? err}`);
  await teardown();
  process.exit(1);
});
