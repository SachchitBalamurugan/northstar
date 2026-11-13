# Northstar inbox service (port 7702)

Reads Gmail and Google Calendar, triages mail, plans focus blocks and drafts replies.
Until Google is connected (or with `MOCK=1`) it serves demo data from `fixtures/`.

```bash
npm install
npm run dev        # http://127.0.0.1:7702
npm test           # offline, Google is stubbed
```

## Connect Google

### 1. Google Cloud Console (once, about 5 minutes)

1. Go to <https://console.cloud.google.com>, create a project (any name).
2. **APIs & Services → Library**: enable **Gmail API** and **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform"):
   - User type **External**, publishing status **Testing**.
   - **Test users**: add the Google account whose mail and calendar you want to use. Only test users can sign in.
   - **Scopes / Data access**: add these four (you can also skip this; the app requests them itself):
     - `https://www.googleapis.com/auth/gmail.readonly` (read mail)
     - `https://www.googleapis.com/auth/gmail.compose` (create reply drafts, send a draft you approved)
     - `https://www.googleapis.com/auth/calendar.events` (read events, add events you approved)
     - `https://www.googleapis.com/auth/userinfo.email` (show which account is connected)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorized redirect URIs**: `http://127.0.0.1:7702/auth/callback` (exactly this: `127.0.0.1`, not `localhost`, no trailing slash).
   - A **Desktop app** client also works and needs no redirect URI setup.
5. Copy the **Client ID** and **Client secret**.

### 2. `.env` in the repo root

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
MOCK=0
```

Restart the service after editing `.env` (it is read at startup). `MOCK=1` always forces demo data.

### 3. Sign in

Open the URL from `GET http://127.0.0.1:7702/auth/url` (the app's Connect Google button does this), pick the test
user, and tick every permission box. Google shows "Google hasn't verified this app" for apps in Testing: choose
**Advanced → Go to (your app)**. You land on a page that says "Connected. You can close this tab." and the first
sync starts.

Check: `curl http://127.0.0.1:7702/auth/status`

```json
{ "authed": true, "configured": true, "mock": false, "source": "google", "email": "you@gmail.com" }
```

When `source` is `"fixtures"`, `reason` says why in plain language. `GET /health` carries the same fields.

Disconnect: `curl -X POST http://127.0.0.1:7702/auth/disconnect` revokes access at Google, deletes the saved
tokens and the cached mail, and goes back to demo data.

### Good to know

- Tokens are stored in `inbox/data/tokens.json` (git-ignored, owner-only). Never commit `data/` or `.env`.
- While the consent screen is in **Testing**, Google expires the sign-in after 7 days. `/auth/status` then says so;
  connect again. Publishing the app removes the limit (Gmail scopes then need Google's verification).
- `redirect_uri_mismatch`: the redirect URI in the console is not exactly `http://127.0.0.1:7702/auth/callback`.
- `access_denied` / "app is being tested": the account is not in the Test users list.

## What it can and cannot do to your account

- **Sync only reads.** `POST /sync` (and the 5 minute timer) lists mail from the last 7 days and events for the
  next 14 days. It never sends, deletes, labels or edits anything.
- **Replies:** approving a `send_reply` card creates a Gmail **draft**. It is sent only if the approved payload has
  `autoSend: true` (drafts are created with `autoSend: false`).
- **Calendar:** an event is inserted only when a `create_event` card is approved, or when you click Add in the
  "Add to calendar" box (`POST /calendar/add`). `AUTO_APPROVE_CALENDAR=1` lets planned focus blocks skip the card.
- **Unsubscribe:** approving only records the decision; nothing is sent or deleted.
- Connecting or disconnecting clears pending cards, so a card built from demo data can never act on a real account.

## Endpoints added for Google and the calendar box

| Endpoint | Returns |
|---|---|
| `GET /auth/url` | `{ url, configured: true }`, or `400 { url: "", configured: false, error }` when the two env vars are missing |
| `GET /auth/callback?code&state` | small HTML page; saves tokens and starts the first sync |
| `GET /auth/status` | `{ authed, configured, mock, source: "google"\|"fixtures", email?, reason? }` |
| `POST /auth/disconnect` | `{ ok: true, revoked, ...status }` |
| `POST /calendar/suggest {query}` | `EventCandidate[]` (max 4) from what you typed, mail, memory, calendar and pending cards, with `conflict` |
| `POST /calendar/add {candidate}` | `{ ok: true, eventId, htmlLink, mock?, duplicate? }`; `400`/`502 { ok: false, error }` |
