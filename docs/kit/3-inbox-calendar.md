# Machine 3: Northstar Inbox + Calendar Autopilot (owner of `inbox/`)
You read the student's Gmail and Google Calendar, pull out what matters, plan time for it, and draft replies in their voice. Read the SHARED CONTRACT at the bottom first.

## Stack
- Node 22 + TypeScript + Fastify (`npm run dev` = `tsx watch src/server.ts`), `googleapis`, `openai` (official SDK), `zod`. Port 7702, with CORS open to localhost.
- OAuth
  - Google Cloud "Desktop app" client with loopback redirect `http://127.0.0.1:7702/auth/callback`.
  - Scopes: `gmail.readonly`, `gmail.compose`, `calendar.events`, `calendar.readonly`.
  - Tokens go in `inbox/data/tokens.json`, which is gitignored.
  - Add the team's Google accounts as test users on the OAuth consent screen at T+0, because it takes a few minutes.
- Use the official `openai` Node SDK. If you are unsure of an API detail, check platform.openai.com/docs instead of guessing.

## Pipeline
1. **Sync** (`POST /sync`, also every 5 min)
   - Mail: the last 7 days, incremental via `historyId`.
   - Calendar: the next 14 days of events.
   - Cache everything in `inbox/data/cache.json`.
2. **Triage**
   - Uses the fast model (`OPENAI_MODEL_FAST`), batching 20 emails per call, with structured JSON output validated by zod.
   - Sorts each email into `needsYou`, `fyi` or `ignore`.
   - Extracts:
     - `deadlines[] {title, dueAt, course?, effortMinutes}`
     - `asks[]`
     - sender role: prof, TA, recruiter, club, admin or promo
   - Before triage, calls `POST :7701/context` with sender and subject, so memory (for example "Prof. Lee = advisor") shapes priority.
   - Writes every deadline and important ask to `POST :7701/events` (kind `deadline` or `task`, source `gmail`, `refs.emailId`).
   - Hard cap: `needsYou` returns at most 5, sorted by urgency.
3. **Auto-schedule** (`POST /schedule/plan`)
   - For each deadline with no block yet, find free slots. Read best focus hours from memory (`/context {query:"routines best focus hours"}`).
   - Split the work into focus blocks of 50 minutes or less, with 10-minute buffers.
   - Never schedule after 11pm. Keep each day under 6h of planned work, and leave the last block at least 24h before the due date.
   - Emit `create_event` Proposals whose titles start with "◎ ". When one is approved, create the calendar event with a 10-minute popup reminder and log it to memory.
   - `GET /calendar/today` returns today's events for the UI.
4. **Drafts** (`POST /draft {emailId}`)
   - Read `writingstyle.md` and sender context via `/context`, then draft with the fast model (`OPENAI_MODEL_FAST`) and return a `send_reply` Proposal.
   - On approval, create a Gmail **draft**. Send it only if the payload has `autoSend: true`.
   - When the user edits a draft before approving, post a short summary of the diff to memory as kind `preference` ("prefers shorter sign-offs"), so the drafts learn their voice.
5. **Unsubscribe**: for promo senders the user never opens, emit an `unsubscribe` Proposal with the List-Unsubscribe URL in the payload. Machine 4's Sidekick can carry it out.

## Sub-agents (3, spawned at T+0)
- **Gmail**: OAuth, sync, parsing (strip quoted replies and signatures, decode base64 parts), drafts, List-Unsubscribe headers.
- **Calendar scheduler**: free/busy, the slot finder, event creation, the proposal approve handlers, `/calendar/today`.
- **Triage/Draft LLM**
  - Prompts, zod schemas, batching, and memory reads and writes.
  - Fixtures in `inbox/fixtures/` drive `MOCK=1`: 30 realistic student emails and 10 calendar events. The emails include a syllabus change, an internship online-assessment invite, a robotics club meeting, a financial aid form due Friday, a TA office-hours reply, and promos.

## Done =
- With `MOCK=1`:
  - `/triage` shows at most 5 needsYou with sensible deadlines.
  - `/schedule/plan` yields sensible blocks in the 2–5pm window from memory.
  - `/draft` sounds like the student.
- With a real account:
  - an approved block appears in Google Calendar
  - an approved reply appears in Gmail Drafts

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
