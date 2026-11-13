"""Insight engine: NextThing ranking, ADHD insight cards, digest scheduler, cache.

Everything that ranks or detects is deterministic Python so MOCK=1 works without an
LLM. The only LLM step is the knowledge-file patch inside run_digest(), which is
skipped (and logged) in MOCK mode or on any error.

Event tag conventions this module reads (fixtures/events.json follows them):
    due:<ISO datetime>   when a deadline/task is due             (deadline + task events)
    effort:<minutes>     estimated work                          (deadline + task events)
    course:<CODE>        e.g. course:CS61B
    key:<slug>           stable identity shared by a deadline, its calendar block
                         and its completion event (e.g. key:cs61b-proj3)
    done                 the referenced key/deadline is finished (counted for wins)
    role:<prof|ta|recruiter|club|admin|peer>   sender role on gmail events
    from:<name>          display name of the sender on gmail events
    replied              a later event with the same refs.emailId tagged replied
                         closes a waiting email
    day:YYYY-MM-DD       calendar observation: which day the block is on
    minutes:<N>          calendar observation: block length
    start:HH:MM          calendar observation: block start time
    skipped              calendar observation: the block was skipped
A calendar block "exists" for a deadline when a source=calendar observation shares its
key:<slug> tag OR its text mentions the deadline title (case-insensitive).
"""
from __future__ import annotations

import hashlib
import logging
import re
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import BaseModel

import config
import models

log = logging.getLogger("memory.insights")

STALE_AFTER = timedelta(minutes=30)
MAX_CARDS = 5
MAX_BLOCK_MINUTES = 50
EFFORT_CAP_MINUTES = 240
DEFAULT_EFFORT_MINUTES = 60
DEFAULT_FOCUS = (14, 17)          # 2-5pm if routines.md says nothing
OVERCOMMITTED_MINUTES = 6 * 60
PROF_WAIT_HOURS = 48
CARDS_PER_DETECTOR_FIRST_PASS = 1  # round-robin so one detector can't crowd out the rest

_cache: models.InsightsResponse | None = None
_cache_at: datetime | None = None
_lock = threading.Lock()
_recompute_running = False
_scheduler: Any = None


# ----------------------------------------------------------------------------- helpers
def _now() -> datetime:
    return datetime.now().astimezone()


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.astimezone()  # treat naive stamps as local time
    return dt


def _tag_value(ev: models.MemoryEvent, prefix: str) -> str | None:
    for t in ev.tags or []:
        if t.startswith(prefix + ":"):
            return t[len(prefix) + 1:]
    return None


def _has_tag(ev: models.MemoryEvent, tag: str) -> bool:
    return tag in (ev.tags or [])


def _event_ts(ev: models.MemoryEvent) -> datetime:
    return _parse_ts(ev.ts) or datetime.fromtimestamp(0, tz=timezone.utc)


def _title_of(ev: models.MemoryEvent) -> str:
    """First sentence/clause of the event text, trimmed for a card title."""
    text = ev.text.strip()
    text = re.split(r"[.;\n]| due | - ", text, maxsplit=1)[0].strip()
    text = re.sub(r"^(deadline|task|reminder|calendar):\s*", "", text, flags=re.I)
    return text.strip("'\" ")[:60]


def _fmt_due(dt: datetime) -> str:
    """'Fri Nov 20, 5pm' style, in the event's own timezone."""
    hour = dt.strftime("%I").lstrip("0") or "12"
    minute = "" if dt.minute == 0 else f":{dt.minute:02d}"
    ampm = dt.strftime("%p").lower()
    return f"{dt.strftime('%a %b')} {dt.day}, {hour}{minute}{ampm}"


def _hour_label(h: int) -> str:
    h = h % 24
    if h == 0:
        return "12am"
    if h == 12:
        return "12pm"
    return f"{h}am" if h < 12 else f"{h - 12}pm"


def _short_id(kind: str, key: str) -> str:
    digest = hashlib.sha1(f"{kind}:{key}".encode()).hexdigest()[:8]
    return f"mem-{kind}-{digest}"


def _parse_focus_window(routines_md: str) -> tuple[int, int]:
    """Find 'best focus 2-5pm' / 'Best focus: 14:00-17:00' in routines.md -> (14, 17)."""
    m = re.search(
        r"best focus[^0-9]{0,12}(\d{1,2})(?::\d{2})?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?::\d{2})?\s*(am|pm)?",
        routines_md,
        flags=re.I,
    )
    if not m:
        return DEFAULT_FOCUS
    start, start_ap, end, end_ap = int(m.group(1)), m.group(2), int(m.group(3)), m.group(4)
    end_ap = end_ap or start_ap
    start_ap = start_ap or end_ap

    def to24(h: int, ap: str | None) -> int:
        if ap and ap.lower() == "pm" and h < 12:
            return h + 12
        if ap and ap.lower() == "am" and h == 12:
            return 0
        return h

    s, e = to24(start, start_ap), to24(end, end_ap)
    return (s, e) if 0 <= s < e <= 24 else DEFAULT_FOCUS


def _in_focus(now: datetime, focus: tuple[int, int]) -> bool:
    """True if now or the next hour overlaps the best-focus window."""
    s, e = focus
    return any(s <= (now + timedelta(hours=h)).hour < e for h in (0, 1))


def _focus_label(focus: tuple[int, int]) -> str:
    return f"{_hour_label(focus[0])}-{_hour_label(focus[1])}"


def _person_line(people_md: str, name: str) -> str | None:
    """The people.md bullet mentioning `name`, stripped of its bullet marker."""
    if not name:
        return None
    last = name.split()[-1].lower()
    for line in people_md.splitlines():
        if last in line.lower():
            line = line.strip().lstrip("-* ").strip()
            line = line.split(":", 1)[1].strip() if ":" in line else line   # drop "Prof. Lee:"
            return re.split(r"\.\s|\.$", line, maxsplit=1)[0].strip()      # first sentence only
    return None


# ----------------------------------------------------------------------------- candidates
class Candidate(BaseModel):
    event: models.MemoryEvent
    key: str
    title: str
    due: datetime
    effort: int
    course: str | None = None
    blocked: bool = False
    score: float = 0.0


def _calendar_blocks(events: list[models.MemoryEvent]) -> list[models.MemoryEvent]:
    return [
        e for e in events
        if e.source == "calendar" and e.kind == "observation" and not _has_tag(e, "skipped")
    ]


def _has_block(cand: Candidate, blocks: list[models.MemoryEvent]) -> bool:
    title = cand.title.lower()
    for b in blocks:
        if cand.key and _tag_value(b, "key") == cand.key:
            return True
        if title and title in b.text.lower():
            return True
    return False


def _done_keys(events: list[models.MemoryEvent]) -> set[str]:
    out: set[str] = set()
    for e in events:
        if _has_tag(e, "done"):
            k = _tag_value(e, "key")
            if k:
                out.add(k)
    return out


def _candidates(events: list[models.MemoryEvent], now: datetime) -> list[Candidate]:
    done = _done_keys(events)
    blocks = _calendar_blocks(events)
    out: list[Candidate] = []
    for e in events:
        if e.kind not in ("deadline", "task") or _has_tag(e, "done"):
            continue
        due = _parse_ts(_tag_value(e, "due"))
        if due is None or due <= now:
            continue
        key = _tag_value(e, "key") or _short_id("key", e.text)
        if key in done:
            continue
        effort = int(_tag_value(e, "effort") or DEFAULT_EFFORT_MINUTES)
        cand = Candidate(
            event=e, key=key, title=_title_of(e), due=due, effort=effort,
            course=_tag_value(e, "course"),
        )
        cand.blocked = _has_block(cand, blocks)
        out.append(cand)
    return out


# ----------------------------------------------------------------------------- NextThing
def _score(c: Candidate, now: datetime, focus: tuple[int, int]) -> float:
    days_left = max((c.due - now).total_seconds() / 86400, 0.0)
    proximity = 1.0 / (1.0 + days_left)                         # closer = higher
    effort = 0.5 + 0.5 * min(c.effort, EFFORT_CAP_MINUTES) / EFFORT_CAP_MINUTES
    energy = 1.0 if _in_focus(now, focus) else 0.75             # best hours per routines.md
    planned = 0.4 if c.blocked else 1.0                         # already on the calendar -> lower
    return proximity * effort * energy * planned


def _next_thing(cands: list[Candidate], now: datetime, focus: tuple[int, int]) -> models.NextThing:
    if not cands:
        return models.NextThing(
            title="Nothing urgent, take a breather",
            why="No upcoming deadlines or tasks in memory right now.",
            minutes=25,
        )
    for c in cands:
        c.score = _score(c, now, focus)
    best = max(cands, key=lambda c: (c.score, -c.due.timestamp()))
    block_part = "already has a calendar block" if best.blocked else "no time block yet"
    if _in_focus(now, focus):
        focus_part = f"and {_focus_label(focus)} is your best focus window per routines.md"
    else:
        focus_part = f"and your best focus window is {_focus_label(focus)} per routines.md"
    why = f"Due {_fmt_due(best.due)}, {block_part}, {focus_part}."
    return models.NextThing(
        title=best.title[:60],
        why=why,
        minutes=max(25, min(MAX_BLOCK_MINUTES, best.effort)),
        proposalId=None if best.blocked else _short_id("deadline_no_block", best.key),
        dueAt=best.due.isoformat(),
    )


# ----------------------------------------------------------------------------- detectors
def _card(kind: str, key: str, title: str, why: str, urgency: int, now: datetime,
          payload: dict[str, Any], due_at: str | None = None) -> models.Proposal:
    return models.Proposal(
        id=_short_id(kind, key),
        agent="memory",
        createdAt=now.isoformat(),
        type="task",
        title=title[:60],
        why=why,
        payload={"kind": kind, **payload},
        urgency=urgency,  # type: ignore[arg-type]
        dueAt=due_at,
        status="pending",
    )


def _detect_deadline_no_block(cands: list[Candidate], now: datetime,
                              focus: tuple[int, int]) -> list[models.Proposal]:
    cards = []
    for c in sorted((c for c in cands if not c.blocked), key=lambda c: c.due):
        days = (c.due - now).total_seconds() / 86400
        urgency = 1 if days <= 3 else 2 if days <= 7 else 3
        hours = c.effort / 60
        why = (f"Due {_fmt_due(c.due)}, about {hours:g}h of work, and no calendar block "
               f"mentions it yet; {_focus_label(focus)} is your best focus window per routines.md.")
        cards.append(_card(
            "deadline_no_block", c.key, f"Block time for {c.title}", why, urgency, now,
            {"key": c.key, "course": c.course, "effortMinutes": c.effort,
             "suggestedMinutes": max(25, min(MAX_BLOCK_MINUTES, c.effort)),
             "suggestedStartHour": focus[0], "sourceEventId": c.event.id},
            due_at=c.due.isoformat(),
        ))
    return cards


def _detect_prof_waiting(events: list[models.MemoryEvent], now: datetime,
                         people_md: str) -> list[models.Proposal]:
    replied: set[str] = set()
    for e in events:
        eid = e.refs.emailId if e.refs else None
        if eid and _has_tag(e, "replied"):
            replied.add(eid)
    cards = []
    for e in events:
        if not (e.source == "gmail" and e.kind == "task" and _has_tag(e, "role:prof")):
            continue
        eid = e.refs.emailId if e.refs else None
        if eid and eid in replied:
            continue
        hours = (now - _event_ts(e)).total_seconds() / 3600
        if hours <= PROF_WAIT_HOURS:
            continue
        name = _tag_value(e, "from") or "your professor"
        days = int(hours // 24)
        wait_str = f"{days} day{'s' if days != 1 else ''}" if days >= 1 else f"{int(hours)} hours"
        person = _person_line(people_md, name)
        cite = f"people.md lists them as {person}" if person else "they are on your people.md list"
        why = f"{name}'s email has been waiting {wait_str}, and {cite}."
        cards.append(_card(
            "prof_email_waiting", eid or e.text, f"Reply to {name}", why,
            1 if hours > 72 else 2, now,
            {"emailId": eid, "from": name, "waitingHours": int(hours),
             "subject": _title_of(e), "sourceEventId": e.id},
        ))
    return cards


def _detect_overcommitted(events: list[models.MemoryEvent], now: datetime,
                          routines_md: str) -> list[models.Proposal]:
    per_day: dict[str, list[models.MemoryEvent]] = {}
    for e in _calendar_blocks(events):
        day = _tag_value(e, "day")
        if day and _tag_value(e, "minutes"):
            per_day.setdefault(day, []).append(e)
    today = now.date().isoformat()
    cards = []
    for day in sorted(per_day):
        if day < today:
            continue
        minutes = sum(int(_tag_value(e, "minutes") or 0) for e in per_day[day])
        if minutes <= OVERCOMMITTED_MINUTES:
            continue
        d = datetime.fromisoformat(day)
        label = f"{d.strftime('%a %b')} {d.day}"
        sleep = re.search(
            r"sleep[^\n]*?(\d{1,2}\s*(?:am|pm)?\s*(?:-|–)\s*\d{1,2}\s*(?:am|pm))",
            routines_md, re.I,
        )
        sleep_part = f"; routines.md says you sleep {sleep.group(1)}" if sleep else ""
        why = (f"Your calendar has {minutes / 60:g}h booked on {label} across "
               f"{len(per_day[day])} blocks{sleep_part}, so there's little slack.")
        cards.append(_card(
            "overcommitted_day", day, f"Lighten up {label} ({minutes / 60:g}h booked)", why,
            1 if day == today else 2, now,
            {"day": day, "minutes": minutes, "blocks": [_title_of(e) for e in per_day[day]]},
        ))
    return cards


def _detect_skipped_pattern(events: list[models.MemoryEvent], now: datetime,
                            focus: tuple[int, int]) -> list[models.Proposal]:
    skipped = [e for e in events if _has_tag(e, "skipped") and now - _event_ts(e) <= timedelta(days=21)]
    if len(skipped) < 2:
        return []
    hours: dict[int, int] = {}
    for e in skipped:
        m = re.match(r"(\d{1,2})", _tag_value(e, "start") or "")
        if m:
            hours[int(m.group(1))] = hours.get(int(m.group(1)), 0) + 1
    if not hours:
        return []
    hour, count = max(hours.items(), key=lambda kv: kv[1])
    if count < 2:
        return []
    old, new = _hour_label(hour), _hour_label(focus[0])
    why = (f"You skipped {count} {old} blocks in the last three weeks, and routines.md says "
           f"{_focus_label(focus)} is your best focus window.")
    return [_card(
        "pattern_skipped_block", str(hour), f"Move study from {old} to {new}?", why, 3, now,
        {"skippedHour": hour, "count": count, "suggestedHour": focus[0]},
    )]


def _detect_wins(events: list[models.MemoryEvent], now: datetime) -> list[models.Proposal]:
    week = [e for e in events if _has_tag(e, "done") and now - _event_ts(e) <= timedelta(days=7)]
    if not week:
        return []
    n = len(week)
    titles = [_title_of(e) for e in week]
    noun = "deadline" if n == 1 else "deadlines"
    since = _fmt_due(now - timedelta(days=7)).split(",")[0]
    why = f"Memory shows {n} {noun} marked done since {since}: {', '.join(titles)[:120]}."
    return [_card(
        "win", now.date().isoformat(), f"Nice: {n} {noun} done this week", why, 3, now,
        {"count": n, "titles": titles},
    )]


def _pick_cards(groups: list[list[models.Proposal]]) -> list[models.Proposal]:
    """Round-robin one card per detector first, then fill, then sort by urgency/due."""
    chosen: list[models.Proposal] = []
    for g in groups:
        chosen.extend(g[:CARDS_PER_DETECTOR_FIRST_PASS])
    for g in groups:
        for card in g[CARDS_PER_DETECTOR_FIRST_PASS:]:
            if len(chosen) >= MAX_CARDS:
                break
            chosen.append(card)
    chosen.sort(key=lambda c: (c.urgency, c.dueAt or "9999", c.title))
    return chosen[:MAX_CARDS]


# ----------------------------------------------------------------------------- compute
def compute(events: list[models.MemoryEvent], knowledge: dict[str, str],
            now: datetime | None = None) -> models.InsightsResponse:
    """Pure function: events + knowledge text -> NextThing + cards. No I/O, no LLM."""
    now = now or _now()
    routines = knowledge.get("routines.md", "")
    people = knowledge.get("people.md", "")
    focus = _parse_focus_window(routines)
    cands = _candidates(events, now)
    next_thing = _next_thing(cands, now, focus)
    cards = _pick_cards([
        _detect_deadline_no_block(cands, now, focus),
        _detect_prof_waiting(events, now, people),
        _detect_overcommitted(events, now, routines),
        _detect_skipped_pattern(events, now, focus),
        _detect_wins(events, now),
    ])
    if next_thing.proposalId and next_thing.proposalId not in {c.id for c in cards}:
        next_thing.proposalId = None
    return models.InsightsResponse(
        nextThing=next_thing, cards=cards, computedAt=now.isoformat(), stale=False,
    )


def _load_all_events() -> list[models.MemoryEvent]:
    import storage

    return list(storage.list_events(limit=5000))


def _load_knowledge() -> dict[str, str]:
    import knowledge

    out: dict[str, str] = {}
    for name in config.KNOWLEDGE_FILES:
        try:
            out[name] = knowledge.read(name)
        except Exception as exc:  # a missing file is fine
            log.debug("knowledge.read(%s) failed: %s", name, exc)
    return out


# ----------------------------------------------------------------------------- LLM patch
class FilePatch(BaseModel):
    file: str
    content: str


class KnowledgePatch(BaseModel):
    files: list[FilePatch]


def _patch_knowledge(new_events: list[models.MemoryEvent], knowledge_text: dict[str, str],
                     full: bool) -> int:
    """Ask the smart model to rewrite knowledge files. Returns files written. Never raises."""
    import knowledge
    import llm
    import prompts

    if not new_events and not full:
        return 0
    try:
        current = "\n\n".join(f"### {name}\n{text}" for name, text in knowledge_text.items())
        evs = "\n".join(
            f"- [{e.ts}] {e.kind}/{e.source} {e.text} tags={e.tags or []}"
            for e in new_events[-200:]
        )
        mode = "full overnight pass" if full else "incremental"
        user = (f"CURRENT KNOWLEDGE FILES\n{current}\n\nNEW EVENTS ({mode})\n{evs or '(none)'}"
                "\n\nReturn full replacements only for files that should change.")
        patch = llm.complete("smart", prompts.KNOWLEDGE_PATCH_SYSTEM, user, schema=KnowledgePatch)
        written = 0
        for fp in patch.files:  # type: ignore[union-attr]
            if fp.file not in config.KNOWLEDGE_FILES:
                log.warning("knowledge patch skipped unknown file %s", fp.file)
                continue
            lines = fp.content.splitlines()[: config.KNOWLEDGE_MAX_LINES]
            knowledge.write(fp.file, "\n".join(lines).rstrip() + "\n")
            written += 1
        return written
    except llm.LLMUnavailable as exc:
        log.info("knowledge patch skipped: %s", exc)
    except Exception as exc:
        log.warning("knowledge patch failed, keeping files as they are: %s", exc)
    return 0


# ----------------------------------------------------------------------------- public API
def run_digest(full: bool = False, now: datetime | None = None) -> models.InsightsResponse:
    """Synchronous digest: patch knowledge (LLM, optional) -> rank -> persist cards -> cache."""
    import storage

    global _cache, _cache_at
    now = now or _now()
    last = storage.get_meta("last_digest_ts")
    new_events = list(storage.events_since(None if full else last))
    knowledge_text = _load_knowledge()
    if not config.MOCK and config.OPENAI_API_KEY:
        if _patch_knowledge(new_events, knowledge_text, full):
            knowledge_text = _load_knowledge()
    else:
        log.info("digest: MOCK or no API key, skipping knowledge patch")
    result = compute(_load_all_events(), knowledge_text, now)
    storage.replace_pending_proposals("memory", result.cards)
    storage.set_meta("last_digest_ts", now.isoformat())
    with _lock:
        _cache, _cache_at = result, now
    log.info("digest done: next=%r cards=%d full=%s", result.nextThing.title, len(result.cards), full)
    return result


def _recompute_in_background(full: bool = False) -> None:
    global _recompute_running
    with _lock:
        if _recompute_running:
            return
        _recompute_running = True

    def job() -> None:
        global _recompute_running
        try:
            run_digest(full=full)
        except Exception as exc:
            log.warning("background digest failed: %s", exc)
        finally:
            with _lock:
                _recompute_running = False

    threading.Thread(target=job, name="memory-digest", daemon=True).start()


def get_insights() -> models.InsightsResponse:
    """Cached insights, instantly. Never waits on an LLM."""
    global _cache, _cache_at
    now = _now()
    with _lock:
        cached, cached_at = _cache, _cache_at
    if cached is None:
        result = compute(_load_all_events(), _load_knowledge(), now)  # pure Python, fast
        with _lock:
            _cache, _cache_at = result, now
        return result
    if cached_at and now - cached_at > STALE_AFTER:
        _recompute_in_background()
        return cached.model_copy(update={"stale": True})
    return cached


def start(app) -> None:
    """Start the scheduler (30-min digest + 03:00 overnight pass) and warm the cache."""
    global _scheduler
    from apscheduler.schedulers.background import BackgroundScheduler

    _scheduler = BackgroundScheduler(daemon=True)
    _scheduler.add_job(run_digest, "interval", minutes=30, id="digest-30min", kwargs={"full": False})
    _scheduler.add_job(run_digest, "cron", hour=3, minute=0, id="digest-overnight", kwargs={"full": True})
    _scheduler.start()
    _recompute_in_background()  # warm the cache so the first GET /insights is instant
    log.info("insights scheduler started")


def stop() -> None:
    global _scheduler
    if _scheduler is not None:
        try:
            _scheduler.shutdown(wait=False)
        except Exception as exc:
            log.debug("scheduler shutdown: %s", exc)
        _scheduler = None
