# Northstar

A calm AI assistant for ADHD students on Windows. It reads your mail and calendar, plans your week, fills applications, and asks before it acts. Inspired by Sentient OS, with Universal Memory as the shared brain.

| Folder | Owner | What | Port |
|---|---|---|---|
| `app/` | Machine 1 | Electron + React UI, tray, hotkeys | — |
| `memory/` | Machine 2 | umem + SQLite + Knowledge files + insights | 7701 |
| `inbox/` | Machine 3 | Gmail + Calendar autopilot | 7702 |
| `actions/` | Machine 4 | Application filler + Sidekick | 7703 |
| `contracts/` | Machine 1 | Shared types (`types.ts`) | |

## Run the UI
```bash
cd app && npm install
npm run dev     # Electron app
npm run web     # same UI in a browser at http://localhost:5199 (fast for UI review)
npm run dist    # portable Windows .exe in app/dist
```
If a service is offline, the UI falls back to demo data and that service's dot in the left rail turns grey.

## Run everything
`npm install && npm run dev:all` from the repo root (needs `uv` for memory).

Hotkeys: **Ctrl+Space** hands off a task to Sidekick · **Ctrl+Shift+D** drafts a reply.
