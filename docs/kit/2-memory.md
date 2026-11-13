# Machine 2: Northstar Memory + Insight Engine (owner of `memory/`)
You are the shared brain. Every agent writes what it observes to you and reads context from you before acting. You wrap Universal Memory (umem) so the memory travels across agents and tools, and you keep a Sentient-style Markdown Knowledge folder the user can read and edit. Read the SHARED CONTRACT at the bottom first.

## Stack
Python 3.12 managed by `uv`, FastAPI + uvicorn, SQLite with FTS5, `universal-memory` (`uv add universal-memory`), `openai`, `apscheduler`. Runs on port 7701 with entrypoint `memory/main.py` (`app = FastAPI()`) and CORS open to localhost.

## Storage design
- `memory/data/events.db`
  - Holds every MemoryEvent from the contract.
  - FTS5 index on `text` and `tags`.
  - Also has a `proposals` table.
- `memory/data/knowledge/*.md` holds the human-readable beliefs, the same idea as Sentient's Knowledge folder:

  | File | What goes in it |
  |---|---|
  | `README.md` | who the student is |
  | `goals.md` | goals |
  | `classes.md` | classes |
  | `deadlines.md` | deadlines |
  | `writingstyle.md` | how the student writes |
  | `routines.md` | sleep and best focus hours |
  | `people.md` | profs, TAs, recruiters |

  Keep each file under 60 lines.
- **umem bridge** (`memory/umem_bridge.py`)
  - On startup, run `umem init` inside `memory/data/` (project scope).
  - Events with kind `preference` or `fact`, and every `/remember` call, are also mirrored through a subprocess: `umem remember --scope global "<text>" --tag <tag>`.
  - `/context` adds the output of `umem context --scope project` and caches `umem bootstrap --format json` once per process.
  - Document in `memory/README.md` how to register `umem-mcp` (`{"command":"uvx","args":["--from","universal-memory","umem-mcp"]}`), so any Claude Code or MCP agent shares the same memory.
  - umem's internal schema isn't documented. Treat it as a write-through mirror: SQLite is the source of truth, and umem failures are logged, never fatal.
  - Never store secrets. umem's secret scanner blocks them too; also regex-strip obvious keys before writing.

## Endpoints (see the contract)
- `/events`
- `/context`: FTS top-k events + the most relevant knowledge files + umem context, trimmed to about 2k tokens.
- `/knowledge` CRUD
- `/remember`
- `/insights`
- `/digest/run`
- `/proposals` + approve/reject for insight-generated `task` proposals. Approving a task can write a preference such as "user accepted moving study to 2pm".
- `/health`

## Insight engine (Sentient's "Proactive intelligence")
- `POST /digest/run` (scheduled every 30 min while running, plus a full "overnight" pass at 3 AM like Sentient):
  1. Pull events since the last digest.
  2. The smart model (`OPENAI_MODEL_SMART`) updates `knowledge/*.md`. Return a JSON patch per file and keep the files short.
  3. Produce a **NextThing** plus up to 5 insight cards.
- `GET /insights` returns the cached result instantly and recomputes it in the background if it's stale. The UI must never wait on an LLM call.
- NextThing ranking: deadline proximity × effort × energy fit (best hours in routines.md) × whether a calendar block exists. Always include a one-sentence `why` that cites memory.
- ADHD insights to detect:
  - deadlines with no time block
  - professor emails waiting more than 48h
  - overcommitted days (more than 6h scheduled)
  - patterns, e.g. "you skip 8am blocks, so move study to 2pm?"
  - wins worth celebrating, e.g. "3 deadlines done this week", gently

## Sub-agents (2, spawned at T+0)
- **umem/Storage**: SQLite + FTS, the knowledge files, the umem subprocess bridge, all endpoints, and pytest smoke tests.
- **Insight & Digest**
  - Prompts, ranking, the scheduler, and fixtures in `memory/fixtures/` so `MOCK=1` seeds a rich demo.
  - The fixtures describe a fake student, "Maya, CS sophomore, ADHD": 4 classes, 3 upcoming deadlines, a robotics club, an internship hunt, best focus 2–5pm, and a casual-but-polite writing style.

## Done =
- `curl :7701/insights` returns a sensible NextThing from the fixtures in under 200ms.
- Editing `knowledge/goals.md` changes the next insight after `POST /digest/run`.
- `umem context --scope project` shows the mirrored facts.
- `POST /context {"query":"Prof. Lee"}` returns Lee's role from `people.md`.

---

## SHARED CONTRACT (identical on all 4 machines; do not change without telling everyone)

### Architecture
```
northstar/                      (one GitHub repo; each machine owns ONE folder → no merge conflicts)
├─ app/        ← Machine 1  Electron + React + Vite + TS + Tailwind (UI shell, tray, hotkeys, spawns services)
├─ memory/     ← Machine 2  Python FastAPI  :7701  wraps umem + SQLite + Markdown Knowledge folder + Insight engine
├─ inbox/      ← Machine 3  Node/TS Fastify :7702  Gmail + Google Calendar: triage, deadlines, auto-scheduling, drafts
├─ actions/    ← Machine 4  Node/TS Fastify :7703  Playwright application/form filler + screen "Sidekick"
└─ contracts/  ← Machine 1 commits at T+10; everyone else reads only
```

### Rules
- Services talk over HTTP on `127.0.0.1` with JSON bodies. Every service has `GET /health → {ok:true, service}` and allows CORS from the Electron renderer.
- Nothing irreversible happens without approval. Sending email, submitting forms and creating calendar events all go through a **Proposal** the user approves in the UI. Calendar events can skip this only when `autoApproveCalendar` is on.
- Every service writes what it observes to memory (`POST :7701/events`) and reads context before deciding anything (`POST :7701/context`).
- LLM: OpenAI API through the official `openai` SDK and `OPENAI_API_KEY` in `.env`. Never commit `.env` or OAuth tokens.
  - Every model call goes through one helper per service (`src/llm.ts` or `memory/llm.py`) exposing `complete({tier: "fast"|"smart", system, input, schema?})`. Swapping providers later is then a one-file change.
  - Models come from env vars `OPENAI_MODEL_FAST` (triage, drafts, form mapping, Sidekick steps) and `OPENAI_MODEL_SMART` (digest and insights). At T+0, check platform.openai.com/docs/models and set both to current models.
  - Every JSON response uses Structured Outputs (`response_format` with a JSON schema; zod via `zodResponseFormat` in Node, pydantic in Python). Never parse free text.
  - Screenshots go in as `image_url` input parts (base64 data URLs).
- Every service ships a `MOCK=1` mode with fixture data, so each machine can demo alone and nobody blocks on anyone else.
- Commit and push to `main` in your own folder only, at least every 20 minutes.

### Types
```ts
// contracts/types.ts
type Source = "gmail" | "calendar" | "screen" | "form" | "user" | "insight";
type Agent  = "ui" | "memory" | "inbox" | "actions";

interface MemoryEvent { id?: string; ts: string; agent: Agent; source: Source;
  kind: "observation"|"preference"|"deadline"|"task"|"fact"; text: string;
  tags?: string[]; refs?: { emailId?: string; eventId?: string; url?: string } }

interface Proposal { id: string; agent: Agent; createdAt: string;
  type: "send_reply"|"create_event"|"fill_form"|"submit_form"|"unsubscribe"|"task";
  title: string;            // ≤ 60 chars, plain language ("Reply to Prof. Lee about extension")
  why: string;              // one sentence, cites memory ("You said Tuesdays are lab days")
  payload: any; urgency: 1|2|3; dueAt?: string;
  status: "pending"|"approved"|"rejected"|"done"|"failed" }

interface NextThing { title: string; why: string; minutes: number; proposalId?: string; dueAt?: string }
```

### Endpoints
| Service | Endpoints |
|---|---|
| memory :7701 | `POST /events` (MemoryEvent) · `POST /context {query, k?}` → `{snippets[], knowledge[]}` · `GET /knowledge` · `GET /knowledge/:file` · `PUT /knowledge/:file` · `POST /remember {text, scope, tags}` · `GET /insights` → `{nextThing: NextThing, cards: Proposal[]}` · `POST /digest/run` |
| inbox :7702 | `GET /auth/url` · `GET /auth/callback` · `POST /sync` · `GET /triage` → `{needsYou[], fyi[], ignored: number}` · `GET /deadlines` · `GET /calendar/today` · `POST /schedule/plan` → Proposal[] · `POST /draft {emailId}` → Proposal |
| actions :7703 | `POST /fill {url, profile?}` → Proposal (field preview + screenshot) · `POST /submit {proposalId}` · `POST /sidekick {instruction}` → SSE step stream · `GET /profile` · `PUT /profile` |
| every service | `GET /proposals?status=pending` · `POST /proposals/:id/approve` · `POST /proposals/:id/reject` |

The UI merges proposals from all three services into one "Approve" queue.

### Timeline (2:00 total)
- **0:00–0:10** Machine 1 creates the repo, the folder skeleton and `contracts/`, then pushes. The others scaffold their own folders locally and start on mocks.
- **0:10–1:00** Core build. Every service reaches its own MVP with `MOCK=1`.
- **1:00–1:30** Real integrations: Google OAuth, umem, Playwright on a real form. Curl `/health` on the other machines.
- **1:30–1:45** Integration. Machine 1 runs `npm run dev:all`, and each machine fixes its own contract mismatches.
- **1:45–2:00** Freeze, demo script, Windows build, README.

### Team
| Machine | Folder | Lead + sub-agents |
|---|---|---|
| 1 UI/Shell | app/, contracts/ | 1 + 2 (UI Critic on a loop, Component Builder) |
| 2 Memory | memory/ | 1 + 2 (umem/Storage, Insight & Digest) |
| 3 Inbox/Calendar | inbox/ | 1 + 3 (Gmail, Calendar scheduler, Triage/Draft LLM) |
| 4 Actions | actions/ | 1 + 2 (Form filler, Sidekick) |

**How to run sub-agents:** the lead spawns them in parallel with the Agent tool at T+0. Each gets its own subfolder and the contract above. The lead integrates, runs the "Done =" checks, and pushes.

### Product: Northstar
A Windows version of Sentient OS (sentient-os.ai), built for ADHD students. It reads Gmail and Calendar, plans deadlines into time blocks, drafts replies in the student's voice, fills applications, and uses Universal Memory (github.com/YanAmorelli/universal-memory) as the shared brain all agents read and write. ADHD principles: one decision at a time · never more than 5 items · always show "why" · make time visible · be gentle · every action is approved first or can be undone.
