# Northstar Memory service (Machine 2) — port 7701

The shared brain. Every agent writes what it observes here (`POST /events`) and reads
context before acting (`POST /context`). Storage is SQLite + FTS5 (source of truth), a
Markdown Knowledge folder the user can read and edit, and a write-through mirror into
Universal Memory (`umem`) so other agents/tools see the same facts.

## Run

```powershell
cd memory
uv run uvicorn main:app --port 7701            # add --reload while developing
curl http://127.0.0.1:7701/health              # {"ok":true,"service":"memory"}
uv run pytest -q                               # offline tests
```

Config comes from the repo-root `.env` (optional `memory/.env` overrides):

| Var | Default | Meaning |
|---|---|---|
| `MOCK` | `1` | Seed `fixtures/events.json` (time-shifted to today) and `fixtures/knowledge/*.md` on first boot; insights use fixture data instead of the LLM. |
| `MEMORY_DATA_DIR` | `memory/data` | Where `events.db`, `knowledge/` and `.umem/` live. |
| `UMEM_ENABLED` | `1` | Set `0` to skip the umem mirror entirely. |
| `OPENAI_API_KEY`, `OPENAI_MODEL_FAST`, `OPENAI_MODEL_SMART` | | Used by the insight engine when `MOCK=0`. |

Data layout: `data/events.db` (tables `events` + FTS5 `events_fts`, `proposals`, `meta`),
`data/knowledge/{README,goals,classes,deadlines,writingstyle,routines,people}.md`
(each kept under 60 lines), `data/.umem/` (umem project, gitignored).

## Endpoints

| Method + path | Body / query | Returns |
|---|---|---|
| `POST /events` | `MemoryEvent` | stored event (id assigned). `preference`/`fact` kinds are also mirrored to umem in the background. |
| `GET /events` | `?kind=&since=&limit=` | newest first |
| `POST /context` | `{query, k?}` | `{snippets[], knowledge[], umem}`: FTS top-k events, most relevant knowledge files, `umem context` text. Trimmed to ~8000 chars (snippets dropped first). |
| `GET /knowledge` | | all 7 files (missing ones have empty content) |
| `GET /knowledge/{file}` · `PUT /knowledge/{file}` | `{content}` | one file; 404 for names outside the fixed list |
| `POST /remember` | `{text, scope?, tags?}` | stores a `fact` event (source `user`) and mirrors it to umem synchronously; `{ok, event, umem: bool}` |
| `GET /proposals` | `?status=pending` | proposals (insight cards are `type: task`) |
| `POST /proposals/{id}/approve` · `/reject` | | approving/rejecting a `task` also records a `preference` event: `user accepted: <title>` / `user declined: <title>` |
| `GET /insights` · `POST /digest/run` | | insight engine (see `insights.py`) |
| `GET /health` | | `{ok:true, service:"memory"}` |

Example:

```powershell
curl -X POST http://127.0.0.1:7701/events -H "content-type: application/json" `
  -d '{"ts":"2026-11-13T09:00:00-08:00","agent":"inbox","source":"gmail","kind":"observation","text":"Prof. Lee asked for the PS4 draft","tags":["email"]}'
curl -X POST http://127.0.0.1:7701/context -H "content-type: application/json" -d '{"query":"Prof. Lee"}'
curl -X POST http://127.0.0.1:7701/remember -H "content-type: application/json" -d '{"text":"Tuesdays are lab days","tags":["routine"]}'
```

## umem (Universal Memory) bridge

`umem_bridge.py` shells out to `python -m universal_memory` (the venv's `universal-memory`
package) with `cwd=memory/data`. SQLite stays the source of truth; every umem failure is
logged and never raised, so the service works even if umem is broken or disabled.

Two Windows-specific details:

- **fcntl shim.** `universal-memory` imports the Unix-only `fcntl` module. `memory/shims/fcntl.py`
  maps it onto `msvcrt.locking`. The bridge sets `PYTHONPATH=memory/shims` for every subprocess;
  do the same for any umem command you run by hand.
- **`UMEM_OFFLINE=1`.** Skips umem's `npx` installer step so startup is fast and never touches the network.

Inspect the mirror by hand (from `memory/data`):

```powershell
cd memory\data
$env:PYTHONPATH = "..\shims"; $env:UMEM_OFFLINE = "1"
uv run --project .. python -m universal_memory context --scope project
uv run --project .. python -m universal_memory facts list --scope global
```

`umem init` drops `CLAUDE.md` / `AGENTS.md` into `memory/data`; both are gitignored.

### Sharing the memory with other agents (umem-mcp)

Any MCP-capable agent (Claude Code, Cursor, Codex, ...) can read/write the same memory by
registering umem's MCP server. For Claude Code add to `.mcp.json` (or `claude mcp add`):

```json
{
  "mcpServers": {
    "umem": {
      "command": "uvx",
      "args": ["--from", "universal-memory", "umem-mcp"],
      "env": { "PYTHONPATH": "C:/path/to/northstar/memory/shims", "UMEM_OFFLINE": "1" }
    }
  }
}
```

The `PYTHONPATH` entry is the fcntl shim again (required on Windows, harmless elsewhere).
Facts stored with `--scope global` (what this service uses) are visible from any project
directory; project-scope facts are visible only when the agent runs inside `memory/data`.

## Files (owner map)

- `storage.py` SQLite/FTS5 events, proposals, meta, fixture seeding
- `knowledge.py` the 7 Markdown files + keyword relevance
- `umem_bridge.py` umem subprocess mirror + secret redaction
- `routes_storage.py` the endpoints above
- `llm.py`, `insights.py`, `routes_insights.py`, `prompts.py`, `fixtures/` insight engine (Insight & Digest sub-agent)
- `tests/test_storage.py` offline tests (`uv run pytest -q`)
