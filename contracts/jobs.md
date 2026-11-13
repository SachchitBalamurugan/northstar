# LinkedIn import + job matching + auto-apply contract

Privacy: everything stays local (memory Knowledge folder + actions data dir). LinkedIn is read in the user's own
logged-in Northstar Chrome window; no credentials ever pass through Northstar. Applications are never submitted
without the user approving the `fill_form` Proposal.

## actions :7703
```ts
interface LinkedInProfile {
  url: string; name: string; headline: string; location: string; about: string;
  experience: { title: string; company: string; dates: string; summary: string }[];
  education: { school: string; degree: string; dates: string }[];
  skills: string[];
  importedAt: string;
}
```
| Endpoint | Returns |
|---|---|
| `POST /linkedin/import {url}` | `{ ok: true, profile: LinkedInProfile }` or `{ ok: false, needsLogin: true, message }` (LinkedIn auth wall: the tab is left open in the Northstar Chrome window so the user can sign in, then call again) or `{ ok:false, error }` |
| `GET /linkedin` | `LinkedInProfile \| null` (last import) |
| `POST /apply/batch {jobs: {url, title, company}[]}` (max 5) | `{ results: { url, title, company, ok, proposalId?, filled?, needsYou?, error? }[] }`: runs the existing `/fill` flow for each URL, one after another |

On import: save `data/linkedin.json`, PUT memory `/knowledge/linkedin.md` (markdown bullets), and merge into the
actions profile (name/firstName/lastName if empty, linkedin url, location, currentRole = headline or latest title,
school/major from education[0] if empty).

## memory :7701
```ts
interface Job {
  id: string; title: string; company: string; location: string; url: string;   // url must come from a real search citation
  summary: string; why: string;            // why it fits the user's skills/profile
  skills: string[]; matchScore: number;    // 0..1
  postedAt?: string; deadline?: string; remote?: boolean;
}
interface JobsResponse { generatedAt: string | null; basedOn: string[]; jobs: Job[] }
```
| Endpoint | Returns |
|---|---|
| `GET /jobs` | `JobsResponse` (last search; empty until first run) |
| `POST /jobs/search {focus?: string, limit?: number}` | `JobsResponse` (OpenAI web search over profile.md + linkedin.md + goals.md; MOCK=1 → fixtures) |

`linkedin.md` is also added to Discover's profile files so all research uses it.
