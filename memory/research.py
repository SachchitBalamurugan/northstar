"""Discover research runs: POST /discover/research {query, when, where} -> text/event-stream of DiscoverEvent.

The stream the Discover screen renders (app/src/renderer/src/discover.ts): plan -> step / source / result ... ->
agent_done -> done. Real web search through llm.web_research, ranked against what memory knows about the student
(Knowledge files, mail and calendar events, opt-in computer activity). A result only ever carries a URL that the
search actually cited; nothing is invented. In MOCK mode or without a model the route answers 503 and the UI
falls back to its built-in demo run.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime
from typing import Iterator, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field

import config
import discover
import llm

log = logging.getLogger("memory.research")

AGENTS = [
    {"id": "a1", "name": "Web search", "task": "Live results from across the web", "icon": "globe"},
    {"id": "a4", "name": "Memory check", "task": "Rank against what Northstar knows about you", "icon": "brain"},
]

_SEARCH_SYSTEM = (
    "You research on behalf of a university student. Search the web for real, current, specific things that answer "
    "the request: events with dates, opportunities with deadlines, places, or useful articles. Prefer primary pages "
    "(the organiser, the employer, the venue). Use the notes about the student only to choose what is relevant; "
    "never state anything about the student that is not in the notes. Report 4 to 8 findings, each with its date or "
    "deadline, location and cost when the page gives them, and cite the page for every finding."
)
_RANK_SYSTEM = (
    "Turn the research notes into results for the student. Use ONLY facts in the notes. Each result must point at "
    "one numbered source via sourceIndex; drop findings that have no source. `why` is one sentence saying why it "
    "fits THIS student and should cite the memory note it relies on when one applies; if no note applies, say what "
    "in the request it answers. `score` is 0..1 relevance. Leave start, end, deadline, location and price empty "
    "unless the notes state them. Dates are ISO 8601 with the student's UTC offset."
)


class _Result(BaseModel):
    kind: Literal["event", "opportunity", "place", "article"]
    title: str
    summary: str
    sourceIndex: int
    start: str | None = None
    end: str | None = None
    location: str | None = None
    price: str | None = None
    deadline: str | None = None
    why: str
    score: float = Field(ge=0, le=1)
    tags: list[str] = Field(default_factory=list)


class _Results(BaseModel):
    results: list[_Result]


def available() -> bool:
    return not config.MOCK and bool(config.OPENAI_API_KEY)


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def _host(url: str) -> str:
    return (urlparse(url).hostname or "").removeprefix("www.")


def _iso(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return None


def stream(query: str, when: str = "any", where: str = "any") -> Iterator[str]:
    t0 = time.monotonic()
    filters = [{"week": "This week", "month": "This month"}.get(when, "Any time"),
               {"campus": "Near campus", "online": "Online"}.get(where, "Anywhere")]
    yield _sse({"type": "plan", "intent": f"Research: {query}", "agents": AGENTS, "filters": filters})

    profile = discover.build_profile()
    yield _sse({"type": "step", "agentId": "a4",
                "text": f"Reading {len(profile)} notes about you" if profile else "Nothing in memory about you yet, so this is a general search"})

    found = 0
    try:
        now = datetime.now().astimezone()
        prompt = "\n".join([
            f"Request: {query}",
            f"Today: {now.strftime('%A %B %d, %Y')} (UTC offset {now.strftime('%z')})",
            f"Time window: {filters[0]}. Place: {filters[1]}.",
            "Notes about the student (from their own files, mail, calendar and computer activity):",
            *(f"- {line}" for line in profile[:30]),
        ])
        yield _sse({"type": "step", "agentId": "a1", "text": "Searching the web"})
        notes, citations = llm.web_research("smart", _SEARCH_SYSTEM, prompt)
        seen_hosts: list[str] = []
        for c in citations:
            h = _host(c["url"])
            if h and h not in seen_hosts:
                seen_hosts.append(h)
                yield _sse({"type": "source", "agentId": "a1", "domain": h})
        yield _sse({"type": "step", "agentId": "a1", "text": f"Read {len(citations)} pages"})
        if citations:
            yield _sse({"type": "step", "agentId": "a4", "text": "Checking each result against what matters to you"})
            sources = "\n".join(f"[{i}] {c['title']} ({c['url']})" for i, c in enumerate(citations, 1))
            ranked = llm.complete(
                "fast", _RANK_SYSTEM,
                f"Request: {query}\n\nNotes about the student:\n" + "\n".join(f"- {p}" for p in profile[:30])
                + f"\n\nResearch notes:\n{notes}\n\nNumbered sources:\n{sources}", schema=_Results)
            used: set[str] = set()
            for n, r in enumerate(sorted(ranked.results, key=lambda r: -r.score)[:8]):  # type: ignore[union-attr]
                if not 1 <= r.sourceIndex <= len(citations):
                    continue
                url = citations[r.sourceIndex - 1]["url"]          # only URLs the search really cited
                if (url, r.title) in used:
                    continue
                used.add((url, r.title))
                result = {
                    "id": f"r{int(time.time() * 1000):x}{n}", "kind": r.kind, "title": r.title.strip()[:120],
                    "summary": r.summary.strip(), "source": _host(url), "url": url, "why": r.why.strip(),
                    "score": round(float(r.score), 2), "agentId": "a1", "tags": [t for t in r.tags if t][:4],
                }
                for key, value in (("start", _iso(r.start)), ("end", _iso(r.end)), ("deadline", _iso(r.deadline)),
                                   ("location", r.location), ("price", r.price)):
                    if value:
                        result[key] = value
                found += 1
                yield _sse({"type": "result", "result": result})
        else:
            yield _sse({"type": "step", "agentId": "a1", "text": "The search came back without usable sources. Try wording it differently."})
    except Exception as exc:  # never break the stream: say what happened and finish
        log.warning("research run failed: %s", exc)
        yield _sse({"type": "step", "agentId": "a1", "text": "The search could not finish. Please try again in a moment."})

    yield _sse({"type": "agent_done", "agentId": "a1", "found": found})
    yield _sse({"type": "agent_done", "agentId": "a4", "found": 0})
    yield _sse({"type": "done", "total": found, "ms": int((time.monotonic() - t0) * 1000)})
