"""Jobs: find current, real job/internship postings that match what Northstar knows about the user.

- Profile = bullets from profile.md, linkedin.md, goals.md, README.md (discover helpers).
- MOCK=1: deterministic fixtures/jobs.json, ranked by profile/focus keyword overlap.
- MOCK=0: llm.web_research then a Structured Output pass; `url` may ONLY come from a real search citation
  (the model points at [S#]); items without a citation are dropped. Any failure keeps the previous result.
Stored as JSON in the meta table (same SQLite db under MEMORY_DATA_DIR), like discover.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from datetime import datetime, timedelta

from pydantic import BaseModel, Field

import config
import llm
from discover import _bullets, _clip, _now

log = logging.getLogger("memory.jobs")

META_KEY = "jobs:latest"
FIXTURE = "jobs.json"
PROFILE_FILES = ["profile.md", "linkedin.md", "goals.md", "README.md"]
DEFAULT_LIMIT = 8
MAX_LIMIT = 20
_lock = threading.RLock()


class Job(BaseModel):
    id: str
    title: str
    company: str
    location: str
    url: str
    summary: str
    why: str
    skills: list[str] = []
    matchScore: float = Field(ge=0, le=1)
    postedAt: str | None = None
    deadline: str | None = None
    remote: bool | None = None


class JobsResponse(BaseModel):
    generatedAt: str | None = None
    basedOn: list[str] = []
    jobs: list[Job] = []


# --- Structured Output schema (all fields required; nullable instead of optional) ---
class _LLMJob(BaseModel):
    title: str
    company: str
    location: str
    sourceIndex: int | None          # [S#] citation that is the posting; null -> dropped
    summary: str
    why: str
    memoryRefs: list[int]            # [M#] profile lines it matches
    skills: list[str]
    matchScore: float
    postedAt: str | None
    deadline: str | None
    remote: bool | None


class _LLMResult(BaseModel):
    jobs: list[_LLMJob]


def _job_id(company: str, title: str) -> str:
    return "job-" + hashlib.sha1(f"{company}|{title}".strip().lower().encode("utf-8")).hexdigest()[:10]


def build_profile() -> list[str]:
    import knowledge

    lines: list[str] = []
    for name in PROFILE_FILES:
        try:
            for b in _bullets(knowledge.read(name))[:12]:
                lines.append(f"{name}: {b}")
        except Exception as exc:
            log.debug("jobs: knowledge.read(%s) failed: %s", name, exc)
    return [_clip(line, 200) for line in lines][:40]


def _load() -> JobsResponse | None:
    import storage

    raw = storage.get_meta(META_KEY)
    if not raw:
        return None
    try:
        return JobsResponse.model_validate_json(raw)
    except Exception as exc:
        log.warning("jobs: stored result unreadable, ignoring: %s", exc)
        return None


def _save(res: JobsResponse) -> None:
    import storage

    storage.set_meta(META_KEY, res.model_dump_json(exclude_none=True))


# ----------------------------------------------------------------------------- MOCK
def _tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"\w+", text.lower()) if len(t) > 1}


def _run_mock(profile: list[str], focus: str | None, limit: int, now: datetime) -> list[tuple[Job, list[str]]]:
    data = json.loads((config.FIXTURES_DIR / FIXTURE).read_text(encoding="utf-8"))
    focus_t = _tokens(focus or "")
    out: list[tuple[Job, list[str], float]] = []
    for raw in data["jobs"]:
        kws = [k.lower() for k in raw.get("keywords", [])] + [s.lower() for s in raw.get("skills", [])]
        hits = [p for p in profile if any(k in p.lower() for k in kws)][:2]
        if hits:
            src = hits[0]
            file, _, text = src.partition(": ")
            why = f'Matches your profile: {file} says "{_clip(text, 100)}".'
        else:
            why = "Matches common early-career software engineering skills."
        deadline = None
        if raw.get("deadlineInDays") is not None:
            deadline = (now + timedelta(days=int(raw["deadlineInDays"]))).date().isoformat()
        score = float(raw["matchScore"])
        rank = score + (0.5 if focus_t and focus_t & _tokens(" ".join(kws) + " " + raw["title"]) else 0)
        job = Job(id=_job_id(raw["company"], raw["title"]), title=raw["title"], company=raw["company"],
                  location=raw["location"], url=raw["url"], summary=raw["summary"], why=why,
                  skills=raw.get("skills", []), matchScore=score, deadline=deadline, remote=raw.get("remote"))
        out.append((job, [_clip(h, 90) for h in hits], rank))
    out.sort(key=lambda t: -t[2])
    return [(j, b) for j, b, _ in out[:limit]]


# ----------------------------------------------------------------------------- real mode
_RESEARCH_SYSTEM = (
    "You find CURRENT, real, open job and internship postings for one person. You get numbered profile lines "
    "[M#] (skills, experience, education, goals, location). Search the web for postings that match their "
    "skills and experience level (e.g. internships or new-grad roles for students), preferring their location "
    "or remote roles. Only include postings that are open now; skip closed or expired ones. For each posting "
    "report title, company, location, whether remote, posted date and deadline if stated, key required "
    "skills, which [M#] lines it matches, and cite the posting page itself (include the posting URL). Never "
    "invent postings or facts about the person."
)
_STRUCTURE_SYSTEM = (
    "Turn the research notes into job items. Rules: only include postings backed by one of the [S#] citations; "
    "sourceIndex is the number of the [S#] citation that is the posting (or best source for it), null if none. "
    "Never write URLs yourself. summary is 1-2 sentences about the role. why is ONE sentence citing the "
    "profile line(s) it matches (name the file, e.g. 'linkedin.md lists Python and React'); memoryRefs are "
    "those [M#] numbers. skills are the role's key skills. matchScore is 0..1 fit to the profile. postedAt and "
    "deadline are ISO dates only when stated, else null. remote is true/false/null. Never invent facts."
)


def _prompt(profile: list[str], focus: str | None, limit: int, now: datetime) -> str:
    parts = [f"Today is {now.date().isoformat()}. Find up to {limit} postings.", "Profile lines:"]
    parts += [f"[M{i}] {line}" for i, line in enumerate(profile, 1)]
    if focus:
        parts.append(f"Focus on: {focus}")
    return "\n".join(parts)


def _clean_date(value: str | None) -> str | None:
    if not value:
        return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value
    except ValueError:
        return None


def _run_real(profile: list[str], focus: str | None, limit: int, now: datetime) -> list[tuple[Job, list[str]]]:
    """Raises on any failure (no key, web search error); the caller keeps the previous result."""
    prompt = _prompt(profile, focus, limit, now)
    notes, citations = llm.web_research("smart", _RESEARCH_SYSTEM, prompt)
    if not notes.strip() or not citations:
        raise RuntimeError("web research returned no text or no citations")
    sources = "\n".join(f"[S{i}] {c['title']} ({c['url']})" for i, c in enumerate(citations, 1))
    result = llm.complete("fast", _STRUCTURE_SYSTEM,
                          f"{prompt}\n\nResearch notes:\n{notes}\n\nCitations:\n{sources}", _LLMResult)
    out: list[tuple[Job, list[str]]] = []
    seen: set[str] = set()
    for raw in result.jobs:  # type: ignore[union-attr]
        if not raw.sourceIndex or not (1 <= raw.sourceIndex <= len(citations)):
            continue                                   # url must come from a real citation
        url = re.sub(r"[?&]utm_source=openai$", "", citations[raw.sourceIndex - 1]["url"])
        jid = _job_id(raw.company, raw.title)
        if jid in seen or url in seen:
            continue
        seen.update({jid, url})
        refs = [profile[r - 1] for r in raw.memoryRefs if 1 <= r <= len(profile)]
        job = Job(id=jid, title=_clip(raw.title, 100), company=raw.company.strip(),
                  location=raw.location.strip(), url=url, summary=raw.summary.strip(), why=raw.why.strip(),
                  skills=raw.skills[:8], matchScore=min(1.0, max(0.0, raw.matchScore)),
                  postedAt=_clean_date(raw.postedAt), deadline=_clean_date(raw.deadline), remote=raw.remote)
        out.append((job, [_clip(r, 90) for r in refs]))
    out.sort(key=lambda p: -p[0].matchScore)
    return out[:limit]


# ----------------------------------------------------------------------------- public API
def search(focus: str | None = None, limit: int | None = DEFAULT_LIMIT, now: datetime | None = None) -> JobsResponse:
    now = now or _now()
    focus = (focus or "").strip() or None
    limit = max(1, min(MAX_LIMIT, int(limit or DEFAULT_LIMIT)))
    profile = build_profile()
    with _lock:
        prev = _load()
        try:
            pairs = (_run_mock if config.MOCK else _run_real)(profile, focus, limit, now)
        except Exception as exc:
            log.warning("jobs: search failed, keeping previous result: %s", exc)
            return prev or JobsResponse()
        based = [b for _, bs in pairs for b in bs]
        res = JobsResponse(generatedAt=now.isoformat(timespec="seconds"),
                           basedOn=list(dict.fromkeys(based))[:8], jobs=[p[0] for p in pairs])
        _save(res)
        return res


def get() -> JobsResponse:
    """Last stored search; empty until the first run."""
    return _load() or JobsResponse()
