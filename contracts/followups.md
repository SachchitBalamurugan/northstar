# Follow-up notifications + auto-drafts (inbox :7702)

Runs automatically after every Gmail sync (POST /sync and the 5-minute timer). Drafts are `send_reply`
Proposals in Approve; nothing is sent until the user approves.

## Detection
- **followup_in**: an incoming email in the last 7 days that is a follow-up to the user: subject/body says
  "following up", "follow up", "checking in", "circling back", "any update", "gentle reminder", "bumping this",
  OR it is the 2nd+ message from the same sender in a thread the user hasn't replied to. Skip promos/newsletters.
- **followup_needed**: an email the USER sent 3-10 days ago (Gmail label SENT) with no reply from the recipient
  in that thread since. Skip if the user's message was itself a reply that closed the topic ("thanks!" only).

For each new detection (dedupe by emailId/threadId + kind, persisted so it never re-fires):
- create the draft: followup_in → reuse the existing reply drafter (draftReply(emailId)); followup_needed →
  a short polite follow-up in the same thread (threadId, to = original recipient, subject "Re: ...", `autoSend: true`),
  written in the user's voice with signRule(signerName()).
- create a Notification.

```ts
interface Notice {
  id: string;
  kind: "followup_in" | "followup_needed";
  title: string;        // "Prof. Lee followed up: CS 61B extension" | "No reply from Stripe Recruiting in 4 days"
  body: string;         // one sentence of what they asked / what you sent
  emailId?: string; threadId?: string;
  proposalId?: string;  // the drafted reply waiting in Approve
  createdAt: string;    // ISO
  read: boolean;
}
```

| Endpoint | Returns |
|---|---|
| `GET /notifications?unread=1` | `Notice[]` newest first |
| `POST /notifications/:id/read` | `{ ok: true }` |
| `POST /notifications/read-all` | `{ ok: true }` |
| `POST /followups/scan` | `{ found: number, notices: Notice[] }` (runs detection now) |
