"""Discover: auto-research based on what Northstar already knows about the student.

Flow: profile (numbered memory lines from the Knowledge folder + recent events) -> research -> <=5 items.

- MOCK=1: deterministic items from fixtures/discover.json. Each fixture item names the memory it needs
  (`cite: {file, keywords}`); it is only shown when that line really exists, and its `why` quotes it.
- MOCK=0: llm.web_research (OpenAI web search tool) then a Structured Output pass that may only attach
  a URL by pointing at a real search citation. If web search fails we fall back to a plain structured
  completion that proposes leads WITHOUT urls. No key / any error -> the previous result is kept.

Stored as JSON in the meta table (same SQLite db, so MEMORY_DATA_DIR is respected).
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel, Field

import config
import llm
import models

log = logging.getLogger("memory.discover")

MAX_ITEMS = 5
META_KEY = "discover:latest"
FIXTURE = "discover.json"
PROFILE_FILES = ["profile.md", "linkedin.md", "goals.md", "README.md", "classes.md", "people.md", "routines.md", "deadlines.md"]
_lock = threading.RLock()

Category = Literal["opportunity", "resource", "event", "reading", "idea"]


class DiscoverItem(BaseModel):
    id: str
    title: str = Field(max_length=60)
    summary: str
    why: str
    category: Category
    url: str | None = None
    sourceLabel: str | None = None
    deadline: str | None = None
    nextStep: str
    confidence: float = Field(ge=0, le=1)
    saved: bool | None = None


class DiscoverResponse(BaseModel):
    generatedAt: str | None = None
    basedOn: list[str] = []
    items: list[DiscoverItem] = []


class _Stored(DiscoverResponse):
    dismissed: list[str] = []          # ids hidden by the student (kept so reruns stay hidden)


# --- Structured Output schemas (every field required; nullable instead of optional) ---
class _LLMItem(BaseModel):
    title: str
    summary: str
    why: str
    category: Category
    memoryRef: int                     # number of the [M#] profile line this came from
    sourceIndex: int | None            # number of the [S#] search citation, or null
    deadline: str | None               # ISO date, only when the source states one
    nextStep: str
    confidence: float


class _LLMResult(BaseModel):
    items: list[_LLMItem]


# ----------------------------------------------------------------------------- helpers
def _now() -> datetime:
    return datetime.now().astimezone()


def _clip(text: str, n: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _item_id(title: str) -> str:
    return "disc-" + hashlib.sha1(title.strip().lower().encode("utf-8")).hexdigest()[:10]


def _bullets(md: str) -> list[str]:
    out = []
    for line in md.splitlines():
        m = re.match(r"^\s*[-*]\s+(.*\S)", line)
        if m:
            out.append(m.group(1))
    return out


def _has_tag(ev: models.MemoryEvent, tag: str) -> bool:
    return tag in (ev.tags or [])


# ----------------------------------------------------------------------------- profile
def build_profile() -> list[str]:
    """Memory lines the research may use, each prefixed with where it came from."""
    import knowledge
    import storage

    lines: list[str] = []
    for name in PROFILE_FILES:
        try:
            for b in _bullets(knowledge.read(name))[:8]:
                lines.append(f"{name}: {b}")
        except Exception as exc:  # a missing file is fine
            log.debug("discover: knowledge.read(%s) failed: %s", name, exc)
    try:
        events = storage.list_events(limit=400)        # newest first
    except Exception as exc:
        log.debug("discover: list_events failed: %s", exc)
        events = []
    forms = [e for e in events if e.source == "form"][:4]
    prefs = [e for e in events if e.kind == "preference" and not _has_tag(e, "discover")][:4]
    deadlines = [e for e in events if e.kind == "deadline" and not _has_tag(e, "done")][:4]
    for label, group in (("form event", forms), ("preference", prefs), ("deadline", deadlines)):
        lines.extend(f"{label}: {e.text}" for e in group)
    return [_clip(line, 200) for line in lines][:48]


def _dismissed_titles() -> list[str]:
    """Titles the student dismissed before (from preference events), newest first."""
    import storage

    try:
        events = storage.list_events(kind="preference", limit=400)
    except Exception:
        return []
    out = []
    for e in events:
        if _has_tag(e, "discover") and _has_tag(e, "dismissed"):
            m = re.search(r'"(.+)"', e.text)
            out.append(m.group(1) if m else e.text)
    return out[:15]


# ----------------------------------------------------------------------------- store
def _load() -> _Stored | None:
    import storage

    raw = storage.get_meta(META_KEY)
    if not raw:
        return None
    try:
        return _Stored.model_validate_json(raw)
    except Exception as exc:
        log.warning("discover: stored result unreadable, ignoring: %s", exc)
        return None


def _save(st: _Stored) -> None:
    import storage

    storage.set_meta(META_KEY, st.model_dump_json(exclude_none=True))


def _public(st: _Stored | None) -> DiscoverResponse:
    if st is None:
        return DiscoverResponse()
    items = [i for i in st.items if i.id not in st.dismissed][:MAX_ITEMS]
    return DiscoverResponse(generatedAt=st.generatedAt, basedOn=st.basedOn[:MAX_ITEMS], items=items)


# ----------------------------------------------------------------------------- MOCK
def _focus_rank(focus: str | None, text: str) -> int:
    tokens = [t for t in re.findall(r"\w+", (focus or "").lower()) if len(t) > 2]
    return 0 if tokens and any(t in text.lower() for t in tokens) else 1


def _run_mock(profile: list[str], focus: str | None, now: datetime) -> list[tuple[DiscoverItem, str]]:
    """(item, memory line it is based on) pairs."""
    data = json.loads((config.FIXTURES_DIR / FIXTURE).read_text(encoding="utf-8"))
    picked: list[tuple[DiscoverItem, str]] = []
    for raw in data["items"]:
        cite = raw.get("cite") or {}
        prefix = f"{cite.get('file', '')}: "
        line = next((p for p in profile if p.startswith(prefix)
                     and any(k.lower() in p.lower() for k in cite.get("keywords", []))), None)
        if line is None:               # never claim memory we do not have
            continue
        quoted = _clip(line[len(prefix):].rstrip("."), 110)
        deadline = None
        if raw.get("deadlineInDays") is not None:
            deadline = (now + timedelta(days=int(raw["deadlineInDays"]))).replace(
                hour=17, minute=0, second=0, microsecond=0).isoformat(timespec="seconds")
        item = DiscoverItem(
            id=raw["id"], title=_clip(raw["title"], 60), summary=raw["summary"],
            why=f'{raw["whyLead"]}: {cite["file"]} says "{quoted}".',
            category=raw["category"], url=raw.get("url"), sourceLabel=raw.get("sourceLabel"),
            deadline=deadline, nextStep=raw["nextStep"], confidence=float(raw.get("confidence", 0.6)),
        )
        picked.append((item, _clip(line, 90)))
    picked.sort(key=lambda p: _focus_rank(focus, f"{p[0].title} {p[0].summary} {p[0].category}"))
    return picked


# ----------------------------------------------------------------------------- real mode
_RESEARCH_SYSTEM = (
    "You research real, current opportunities for one university student, for a calm assistant for students "
    "with ADHD. You get numbered memory lines [M#] about the student. Pick up to 5 research topics that follow "
    "directly from those lines (e.g. internships matching goals and major, scholarships, campus resources for a "
    "class they find hard, events or clubs matching interests), search the web, and report the best concrete "
    "finding per topic with its source, any stated deadline, and which [M#] line it serves. Only state facts "
    "about the student that appear in the memory lines. Skip anything similar to the 'not interested' list."
)
_STRUCTURE_SYSTEM = (
    "Turn the research notes into at most 5 items for the student. Rules: title <= 60 characters, plain "
    "language. summary is 1-2 sentences. why is ONE sentence that cites the memory line it came from (name the "
    "file or event, e.g. 'goals.md says you want a summer 2027 SWE internship'). memoryRef is the number of "
    "that [M#] line. sourceIndex is the number of the [S#] citation that supports the item, or null when there "
    "is none; never write URLs yourself. deadline is an ISO date only when the notes state one, else null. "
    "nextStep is one small concrete action under 15 minutes. confidence is 0..1. Never invent facts about the "
    "student. Gentle tone, no guilt. Skip anything similar to the 'not interested' list."
)
_LEADS_SYSTEM = (
    "You have no web access. From the numbered memory lines [M#], propose at most 5 search-worthy leads for "
    "this student: things worth looking up, not claims that a specific programme exists or is open. Do not "
    "state dates, amounts or URLs. " + _STRUCTURE_SYSTEM
)


def _prompt(profile: list[str], focus: str | None, avoid: list[str], now: datetime) -> str:
    parts = [f"Today is {now.date().isoformat()}.", "Memory lines:"]
    parts += [f"[M{i}] {line}" for i, line in enumerate(profile, 1)]
    if focus:
        parts.append(f"The student asked to focus on: {focus}")
    if avoid:
        parts.append("Not interested (dismissed before): " + "; ".join(avoid))
    return "\n".join(parts)


def _run_real(profile: list[str], focus: str | None, now: datetime) -> list[tuple[DiscoverItem, str]]:
    """Raises llm.LLMUnavailable (no key) or any model error; the caller keeps the old result."""
    avoid = _dismissed_titles()
    prompt = _prompt(profile, focus, avoid, now)
    citations: list[dict[str, str]] = []
    try:
        notes, citations = llm.web_research("smart", _RESEARCH_SYSTEM, prompt)
        if not notes.strip():
            raise RuntimeError("web research returned no text")
        sources = "\n".join(f"[S{i}] {c['title']} ({c['url']})" for i, c in enumerate(citations, 1))
        result = llm.complete("fast", _STRUCTURE_SYSTEM,
                              f"{prompt}\n\nResearch notes:\n{notes}\n\nCitations:\n{sources or '(none)'}", _LLMResult)
    except llm.LLMUnavailable:
        raise
    except Exception as exc:
        log.warning("discover: web research failed (%s); falling back to leads without urls", exc)
        citations = []
        result = llm.complete("smart", _LEADS_SYSTEM, prompt, _LLMResult)

    avoid_l = {a.strip().lower() for a in avoid}
    out: list[tuple[DiscoverItem, str]] = []
    for raw in result.items:  # type: ignore[union-attr]
        if not (1 <= raw.memoryRef <= len(profile)):       # must be grounded in a real memory line
            continue
        title = _clip(raw.title, 60)
        if title.lower() in avoid_l or any(i.id == _item_id(title) for i, _ in out):
            continue
        cite = citations[raw.sourceIndex - 1] if raw.sourceIndex and 1 <= raw.sourceIndex <= len(citations) else None
        deadline = None
        if cite and raw.deadline:                           # dates only count when a real source backs them
            try:
                datetime.fromisoformat(raw.deadline.replace("Z", "+00:00"))
                deadline = raw.deadline
            except ValueError:
                pass
        label = None
        if cite:
            label = cite["title"] or re.sub(r"^https?://(www\.)?([^/]+).*$", r"\2", cite["url"])
        item = DiscoverItem(
            id=_item_id(title), title=title, summary=raw.summary.strip(), why=raw.why.strip(),
            category=raw.category, url=re.sub(r"[?&]utm_source=openai$", "", cite["url"]) if cite else None,
            sourceLabel=_clip(label, 60) if label else None, deadline=deadline,
            nextStep=raw.nextStep.strip(), confidence=min(1.0, max(0.0, raw.confidence)),
        )
        out.append((item, _clip(profile[raw.memoryRef - 1], 90)))
    return out


# ----------------------------------------------------------------------------- public API
def run(focus: str | None = None, now: datetime | None = None) -> DiscoverResponse:
    """Research now and store the result. On failure in real mode the previous result is returned."""
    now = now or _now()
    focus = (focus or "").strip() or None
    profile = build_profile()
    with _lock:
        prev = _load()
        dismissed = list(prev.dismissed) if prev else []
        try:
            pairs = (_run_mock if config.MOCK else _run_real)(profile, focus, now)
        except Exception as exc:
            log.warning("discover: run failed, keeping previous result: %s", exc)
            return _public(prev)
        pairs = [p for p in pairs if p[0].id not in dismissed][:MAX_ITEMS]
        items = [p[0] for p in pairs]
        based = [p[1] for p in pairs]     # only memory behind items that are actually shown
        was_saved = {i.id for i in prev.items if i.saved} if prev else set()
        for i in items:
            if i.id in was_saved:
                i.saved = True
        st = _Stored(generatedAt=now.isoformat(timespec="seconds"),
                     basedOn=list(dict.fromkeys(based))[:MAX_ITEMS], items=items, dismissed=dismissed)
        _save(st)
        return _public(st)


def get() -> DiscoverResponse:
    """Latest stored result. MOCK runs once lazily; real mode never blocks on a model call here."""
    st = _load()
    if st is None and config.MOCK:
        return run()
    return _public(st)


def _find(st: _Stored | None, item_id: str) -> DiscoverItem | None:
    if st is None or item_id in st.dismissed:
        return None
    return next((i for i in st.items if i.id == item_id), None)


def save(item_id: str) -> bool:
    """Mark saved and tell the other agents the student is interested. False = unknown id."""
    import storage

    with _lock:
        st = _load()
        item = _find(st, item_id)
        if item is None or st is None:
            return False
        if not item.saved:
            text = f'Interested in "{item.title}" (from Discover). Next step: {item.nextStep}'
            if item.deadline:
                text += f" Deadline: {item.deadline}."
            storage.add_event(models.MemoryEvent(
                ts=_now().isoformat(timespec="seconds"), agent="memory", source="insight", kind="task",
                text=text, tags=["discover", "saved", f"category:{item.category}", f"discover:{item.id}"],
                refs=models.EventRefs(url=item.url) if item.url else None,
            ))
            item.saved = True
            _save(st)
        return True


def dismiss(item_id: str) -> bool:
    """Hide the item and record a preference so future runs avoid similar things. False = unknown id."""
    import storage

    with _lock:
        st = _load()
        item = _find(st, item_id)
        if item is None or st is None:
            return False
        storage.add_event(models.MemoryEvent(
            ts=_now().isoformat(timespec="seconds"), agent="memory", source="insight", kind="preference",
            text=f'Not interested in Discover suggestions like "{item.title}" ({item.category}).',
            tags=["discover", "dismissed", f"category:{item.category}", f"discover:{item.id}"],
        ), mirror=False)
        st.dismissed.append(item.id)
        _save(st)
        return True
