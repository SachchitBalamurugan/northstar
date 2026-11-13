# Inbox briefing contract (inbox service :7702)

Automatic: after every sync (POST /sync and the 5-minute timer) the inbox service regenerates the briefing in the
background from the triaged real Gmail. Nothing is ever sent without the user approving a Proposal.

```ts
interface BriefItem {
  emailId: string;
  threadId?: string;
  from: string;              // display name
  fromEmail?: string;        // address to reply to
  subject: string;
  receivedAt: string;        // ISO
  importance: "high" | "medium" | "low";
  oneLine: string;           // one-sentence summary of what the email says / asks
  why: string;               // why it matters to the user (cites memory/profile when possible)
  suggestedReply: string | null; // short reply in the user's voice; null when no reply is needed
}
interface Brief {
  generatedAt: string | null;   // null until the first run finishes
  summary: string;              // 2-4 sentence overview of the inbox right now
  items: BriefItem[];           // newest + most important first, max 8
  source: "google" | "fixtures";
  stale?: boolean;              // true while a regeneration is running
}
```

| Endpoint | Returns |
|---|---|
| `GET /inbox/brief` | `Brief` (cached; kicks a background regeneration if older than 10 min or missing) |
| `POST /inbox/brief/refresh` | `Brief` (regenerates now; may take ~20-60s with the LLM) |
| `POST /inbox/brief/:emailId/reply {body}` | `Proposal` (`send_reply`, threaded reply to `fromEmail`, `autoSend: true`, urgency most-urgent) |
| `POST /inbox/brief/email-me` | `Proposal` (`send_reply`, `fresh: true`, to the connected account's own address, subject "Your inbox briefing - <date>", body = summary + items + suggested replies) |
