"""Daily briefing, resume-work prompts and response controls (user-research features).

    build_briefing(...)  -> Briefing      GET /briefing      (pure; LLM only polishes summary + order)
    build_resume(...)    -> [ResumeItem]  GET /resume        (pure, deterministic)
    refine(...)          -> RefineResponse POST /refine      (LLM with Structured Outputs; canned in MOCK)

Everything that selects or ranks is deterministic Python (same stance as insights.py), so
MOCK=1 works without a model and real mode always has a fallback.

Research findings baked in:
- Estimating task duration is mentally demanding, so `minutes` is optional. It is only set
  when memory already holds a number (an `effort:<min>` tag or a calendar block length) and
  `estimates=False` drops it everywhere. We never invent an estimate.
- Preferences for /refine live in the Knowledge folder (preferences.md, writingstyle.md), so the
  student can read and edit them through GET/PUT /knowledge/:file.

Extra tag conventions written by this module (on top of the ones in insights.py):
    resume:<id>      the resume item an event refers to
    resume-done      the student marked that item finished (also tagged `done` + key:<slug>)
    resume-snoozed   the student snoozed it; hidden for SNOOZE_HOURS after the event's ts
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel, field_validator

import config
import insights
import models

log = logging.getLogger("memory.briefing")

MAX_BRIEFING_ITEMS = 5
MAX_RESUME_ITEMS = 3
SNOOZE_HOURS = 24
PREFERENCE_FILES = ["preferences.md", "writingstyle.md"]

BriefingKind = Literal["event", "deadline", "unfinished", "approval"]
RefineMode = Literal["simplify", "challenge", "another"]


# ----------------------------------------------------------------------------- models
class BriefingItem(BaseModel):
    id: str
    title: str
    why: str
    kind: BriefingKind
    dueAt: str | None = None
    start: str | None = None
    minutes: int | None = None
    proposalId: str | None = None


class Briefing(BaseModel):
    date: str
    greeting: str
    summary: str
    items: list[BriefingItem]
    generatedAt: str


class ResumeItem(BaseModel):
    id: str
    project: str
    whereYouStopped: str
    nextStep: str
    lastTouched: str
    why: str


class ResumeResponse(BaseModel):
    items: list[ResumeItem]


class RefineRequest(BaseModel):
    text: str
    mode: RefineMode
    context: str | None = None

    @field_validator("text")
    @classmethod
    def _text_not_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("text must not be empty")
        return v


class RefineResponse(BaseModel):
    text: str
    mode: RefineMode
    note: str | None = None
    clarify: str | None = None


class _BriefingPolish(BaseModel):
    """Structured Output: the model may only rewrite the summary and reorder existing ids."""
    summary: str
    order: list[str]


class _RefineOut(BaseModel):
    """Structured Output for /refine. Empty string means 'not set'."""
    text: str
    note: str
    clarify: str


# ----------------------------------------------------------------------------- helpers
_TOKEN_STOP = {
    "the", "and", "for", "from", "with", "due", "your", "you", "this", "that", "have", "has",
    "mon", "tue", "wed", "thu", "fri", "sat", "sun", "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec", "yet", "min", "far", "are", "was", "not",
}


def _tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]{3,}", text.lower()) if t not in _TOKEN_STOP and not t.isdigit()}


def _one_sentence(text: str, limit: int = 160) -> str:
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[: limit - 3].rstrip() + "..."
    return text if text.endswith((".", "!", "?")) else text + "."


def _time_label(dt: datetime) -> str:
    hour = dt.strftime("%I").lstrip("0") or "12"
    minute = "" if dt.minute == 0 else f":{dt.minute:02d}"
    return f"{hour}{minute}{dt.strftime('%p').lower()}"


def _calendar_title(ev: models.MemoryEvent) -> str:
    m = re.search(r"'([^']+)'", ev.text)
    return (m.group(1) if m else insights._title_of(ev))[:60]


# ----------------------------------------------------------------------------- resume
_STARTED_RE = re.compile(
    r"\b(started|began|begun|half[- ]?(?:done|finished|way)|in progress|not (?:yet )?submitted|"
    r"left off|paused|stopped at|working on|saved (?:a |the )?draft)\b", re.I)
_KNOWLEDGE_MARK_RE = re.compile(
    r"\b(pending|in progress|started|begun|not (?:yet )?submitted|keeps getting pushed|"
    r"half[- ]?(?:done|finished|way)|unfinished|left off|paused)\b", re.I)


def _next_step(project: str) -> str:
    """One small, concrete first move. No duration estimate on purpose."""
    p = project.lower()
    if re.search(r"assessment|quiz|exam", p):
        return "Open the invite and read the instructions, without starting it yet."
    if re.search(r"form|application|apply|verification", p):
        return "Open the form and fill in only the first section."
    if re.search(r"essay|draft|paper|report|writing", p):
        return "Open the draft and reread the last paragraph you wrote."
    if re.search(r"homework|\bhw\b|problem set|pset", p):
        return "Open the homework and read problem 1."
    if re.search(r"project|lab|build", p):
        return "Open the project and write down the very next thing to do."
    if re.search(r"email|reply", p):
        return "Open the email and write just the first line of a reply."
    return "Open it and note in one line where you left off."


def _knowledge_marks(knowledge: dict[str, str]) -> list[tuple[str, str, str]]:
    """(file, project, note) for bullet lines that say something is unfinished."""
    out: list[tuple[str, str, str]] = []
    for file in ("deadlines.md", "goals.md"):
        in_done = False
        for raw in (knowledge.get(file) or "").splitlines():
            line = raw.strip()
            if line.startswith("#"):
                in_done = bool(re.search(r"\bdone\b|finished|completed", line, re.I))
                continue
            if in_done or not line.startswith(("-", "*")) or not _KNOWLEDGE_MARK_RE.search(line):
                continue
            line = line.lstrip("-* ").strip()
            if re.search(r"\bdone\b", line, re.I):
                continue
            project = re.split(r":\s", line, maxsplit=1)[0].strip()
            paren = re.search(r"\(([^)]*)\)", line)
            if paren and _KNOWLEDGE_MARK_RE.search(paren.group(1)):  # "(Nimbus ...: assessment pending)"
                project = paren.group(1).strip()
            parts = [s.strip() for s in re.split(r"(?<=[.;])\s+", line) if _KNOWLEDGE_MARK_RE.search(s)]
            note = " ".join(parts) if parts else line
            if paren and _KNOWLEDGE_MARK_RE.search(paren.group(1)):
                note = paren.group(1).strip()
            out.append((file, project[:60], note.strip(" .;")))
    return out


def _hidden_resume_ids(events: list[models.MemoryEvent], now: datetime) -> set[str]:
    hidden: set[str] = set()
    for e in events:
        rid = insights._tag_value(e, "resume")
        if not rid:
            continue
        if insights._has_tag(e, "resume-done"):
            hidden.add(rid)
        elif insights._has_tag(e, "resume-snoozed") and insights._event_ts(e) + timedelta(hours=SNOOZE_HOURS) > now:
            hidden.add(rid)
    return hidden


def _resume_all(events: list[models.MemoryEvent], knowledge: dict[str, str],
                now: datetime) -> list[tuple[ResumeItem, str]]:
    """Every unfinished project memory knows about, best first, as (item, key). Not capped, not hidden."""
    done = insights._done_keys(events)
    marks = _knowledge_marks(knowledge)
    used_marks: set[int] = set()
    rows: list[tuple[tuple, ResumeItem, str]] = []
    seen_keys: set[str] = set()

    def started_events(key: str) -> list[models.MemoryEvent]:
        return sorted(
            (e for e in events
             if e.kind in ("task", "observation") and insights._tag_value(e, "key") == key
             and not insights._has_tag(e, "done") and not insights._has_tag(e, "skipped")
             and not insights._tag_value(e, "resume") and _STARTED_RE.search(e.text)),
            key=insights._event_ts, reverse=True)

    # 1. deadlines/tasks with a due date and no completion event
    for c in insights._candidates(events, now):
        seen_keys.add(c.key)
        related = [e for e in events if insights._tag_value(e, "key") == c.key and not insights._tag_value(e, "resume")]
        last = max([c.event, *related], key=insights._event_ts)
        started = started_events(c.key)
        mark = next((i for i, (_, proj, note) in enumerate(marks)
                     if i not in used_marks and len(_tokens(c.title) & _tokens(proj + " " + note)) >= 2), None)
        if started:
            where, evidence = _one_sentence(started[0].text), 0
        elif mark is not None:
            used_marks.add(mark)
            where, evidence = _one_sentence(f"{marks[mark][0]} notes: {marks[mark][2]}"), 0
        elif c.blocked:
            where, evidence = "Time is blocked on your calendar, but no work is logged yet.", 1
        else:
            where, evidence = "No work is logged on this yet.", 1
        why = f"Due {insights._fmt_due(c.due)} and memory has no completion event for it."
        item = ResumeItem(
            id=insights._short_id("resume", c.key), project=c.title.strip(), whereYouStopped=where,
            nextStep=_next_step(c.title), lastTouched=insights._event_ts(last).isoformat(), why=why,
        )
        rows.append(((evidence, c.due.timestamp()), item, c.key))

    # 2. things the student started (no due date needed) and never finished
    for e in sorted(events, key=insights._event_ts, reverse=True):
        if e.kind not in ("task", "observation") or not _STARTED_RE.search(e.text):
            continue
        if insights._has_tag(e, "done") or insights._has_tag(e, "skipped") or insights._tag_value(e, "resume"):
            continue
        key = insights._tag_value(e, "key") or insights._short_id("key", e.text)
        if key in done or key in seen_keys:
            continue
        seen_keys.add(key)
        title = insights._title_of(e)
        item = ResumeItem(
            id=insights._short_id("resume", key), project=title, whereYouStopped=_one_sentence(e.text),
            nextStep=_next_step(e.text), lastTouched=insights._event_ts(e).isoformat(),
            why=f"You started this on {insights._fmt_due(insights._event_ts(e))} and memory has no completion event.",
        )
        rows.append(((0, -insights._event_ts(e).timestamp()), item, key))

    # 3. unfinished things only the Knowledge folder knows about
    for i, (file, project, note) in enumerate(marks):
        if i in used_marks:
            continue
        key = "kn-" + re.sub(r"[^a-z0-9]+", "-", project.lower()).strip("-")[:40]
        if key in seen_keys or key in done:
            continue
        seen_keys.add(key)
        item = ResumeItem(
            id=insights._short_id("resume", key), project=project, whereYouStopped=_one_sentence(note),
            nextStep=_next_step(project + " " + note), lastTouched=now.isoformat(),
            why=f"{file} lists this as unfinished.",
        )
        rows.append(((2, 0.0), item, key))

    rows.sort(key=lambda r: r[0])
    return [(item, key) for _, item, key in rows]


def build_resume(events: list[models.MemoryEvent], knowledge: dict[str, str],
                 now: datetime | None = None) -> list[ResumeItem]:
    """Pure: up to 3 unfinished projects, minus the ones marked done or snoozed."""
    now = now or insights._now()
    hidden = _hidden_resume_ids(events, now)
    return [item for item, _ in _resume_all(events, knowledge, now) if item.id not in hidden][:MAX_RESUME_ITEMS]


def get_resume() -> ResumeResponse:
    return ResumeResponse(items=build_resume(insights._load_all_events(), insights._load_knowledge()))


def mark_resume(item_id: str, action: Literal["done", "snooze"]) -> bool:
    """Record the decision as a memory event so the item is hidden. False when the id is unknown."""
    import storage

    events = insights._load_all_events()
    now = insights._now()
    known = {item.id: (item, key) for item, key in _resume_all(events, insights._load_knowledge(), now)}
    if item_id not in known:
        # already decided earlier (a done item is no longer derived): stay idempotent
        return any(insights._tag_value(e, "resume") == item_id for e in events)
    item, key = known[item_id]
    if action == "done":
        text, tags = f"Finished: {item.project}.", ["done", "resume-done", f"resume:{item_id}", f"key:{key}"]
    else:
        text, tags = f"Snoozed for now: {item.project}.", ["resume-snoozed", f"resume:{item_id}"]
    storage.add_event(models.MemoryEvent(
        ts=now.isoformat(timespec="seconds"), agent="memory", source="user", kind="task", text=text, tags=tags,
    ))
    return True


# ----------------------------------------------------------------------------- briefing
def _greeting(now: datetime) -> str:
    if now.hour < 12:
        return "Good morning."
    if now.hour < 18:
        return "Good afternoon."
    return "Good evening."


def _summary(items: list[BriefingItem]) -> str:
    if not items:
        return "Nothing needs you right now, so today can be an easy one."
    n = {k: sum(1 for i in items if i.kind == k) for k in ("event", "deadline", "unfinished", "approval")}
    parts = []
    if n["event"]:
        parts.append(f"{n['event']} thing{'s' if n['event'] > 1 else ''} on your calendar")
    if n["deadline"]:
        parts.append(f"{n['deadline']} deadline{'s' if n['deadline'] > 1 else ''} coming up")
    if n["unfinished"]:
        parts.append(f"{n['unfinished']} thing{'s' if n['unfinished'] > 1 else ''} to pick back up")
    if n["approval"]:
        parts.append(f"{n['approval']} suggestion{'s' if n['approval'] > 1 else ''} waiting for a yes or no")
    listed = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]
    return f"Today has {listed}; start with the first one and let the rest wait."


def build_briefing(events: list[models.MemoryEvent], knowledge: dict[str, str],
                   proposals: list[models.Proposal] | None = None, now: datetime | None = None,
                   estimates: bool = True) -> Briefing:
    """Pure and deterministic: today's events, nearest deadlines, unfinished work, one approval. Max 5."""
    now = now or insights._now()
    today = now.date().isoformat()
    pending = {p.id: p for p in (proposals or []) if p.status == "pending"}
    used_proposals: set[str] = set()

    # today's calendar blocks that have not ended yet
    event_items: list[BriefingItem] = []
    for e in insights._calendar_blocks(events):
        if insights._tag_value(e, "day") != today or insights._has_tag(e, "attended"):
            continue
        hhmm = insights._tag_value(e, "start") or ""
        try:
            start = datetime.fromisoformat(f"{today}T{hhmm}").replace(tzinfo=now.tzinfo)
        except ValueError:
            continue
        length = insights._tag_value(e, "minutes")
        minutes = int(length) if length and length.isdigit() else None
        if start + timedelta(minutes=minutes or 60) <= now:
            continue
        verb = "Started" if start <= now else "Starts"
        event_items.append(BriefingItem(
            id=insights._short_id("brief-event", e.id or e.text), title=_calendar_title(e), kind="event",
            why=f"{verb} at {_time_label(start)} on your calendar today.",
            start=start.isoformat(), minutes=minutes,  # block length is a fact from the calendar, not a guess
        ))
    event_items.sort(key=lambda i: i.start or "")

    # nearest deadlines without a completion event
    deadline_items: list[BriefingItem] = []
    cands = sorted(insights._candidates(events, now), key=lambda c: c.due)
    for c in cands:
        has_estimate = insights._tag_value(c.event, "effort") is not None  # never the engine's default guess
        pid = insights._short_id("deadline_no_block", c.key)
        block = "already has a calendar block" if c.blocked else "has no time block yet"
        deadline_items.append(BriefingItem(
            id=insights._short_id("brief-deadline", c.key), title=c.title.strip(), kind="deadline",
            why=f"Due {insights._fmt_due(c.due)} and it {block}.",
            dueAt=c.due.isoformat(), minutes=c.effort if has_estimate else None,
            proposalId=pid if pid in pending else None,
        ))
    used_proposals.update(i.proposalId for i in deadline_items[:2] if i.proposalId)

    # unfinished work that is not already shown as one of the two deadlines above
    shown = {insights._short_id("resume", c.key) for c in cands[:2]}
    unfinished_items = [
        BriefingItem(id=r.id, title=r.project[:60].strip(), kind="unfinished", dueAt=None,
                     why=_one_sentence(f"{r.whereYouStopped.rstrip('.')}; next step: {r.nextStep.rstrip('.')}", 220))
        for r in build_resume(events, knowledge, now) if r.id not in shown
    ]

    approval_items = [
        BriefingItem(id=insights._short_id("brief-approval", p.id), title=p.title, why=_one_sentence(p.why),
                     kind="approval", dueAt=p.dueAt, proposalId=p.id)
        for p in sorted(pending.values(), key=lambda p: -p.urgency) if p.id not in used_proposals
    ]

    first = [*event_items[:2], *deadline_items[:2], *unfinished_items[:1], *approval_items[:1]]
    rest = [*event_items[2:], *deadline_items[2:], *unfinished_items[1:], *approval_items[1:]]
    items = [*first, *rest][:MAX_BRIEFING_ITEMS]
    if not estimates:
        for i in items:
            i.minutes = None
    return Briefing(date=today, greeting=_greeting(now), summary=_summary(items), items=items,
                    generatedAt=now.isoformat(timespec="seconds"))


BRIEFING_POLISH_SYSTEM = """You polish a morning briefing for an ADHD college student.
You get up to 5 items (id, kind, title, why). Return:
- summary: ONE calm sentence (max 30 words). Gentle, no guilt, no exclamation marks, no
  time or duration estimates. Mention only what is in the items.
- order: the same ids, best first. Things happening now or soonest come first. Never add,
  drop or rename an id."""


def _polish(b: Briefing) -> Briefing:
    """Real mode only: the model writes the summary and may reorder. Any error keeps the deterministic one."""
    if config.MOCK or not b.items:
        return b
    try:
        import llm

        listing = "\n".join(f"- id={i.id} kind={i.kind} title={i.title!r} why={i.why!r}" for i in b.items)
        out = llm.complete("fast", BRIEFING_POLISH_SYSTEM, f"Date: {b.date}\nItems:\n{listing}", schema=_BriefingPolish)
        by_id = {i.id: i for i in b.items}
        ordered = [by_id.pop(i) for i in out.order if i in by_id]
        summary = " ".join((out.summary or "").split())
        return b.model_copy(update={"items": [*ordered, *by_id.values()], "summary": summary or b.summary})
    except Exception as exc:
        log.info("briefing polish skipped (%s); using the deterministic briefing", exc)
        return b


def get_briefing(estimates: bool = True) -> Briefing:
    import storage

    try:
        proposals = storage.list_proposals("pending")
    except Exception as exc:
        log.debug("could not load proposals for the briefing: %s", exc)
        proposals = []
    b = build_briefing(insights._load_all_events(), insights._load_knowledge(), proposals, estimates=estimates)
    return _polish(b)


# ----------------------------------------------------------------------------- refine
REFINE_SYSTEM = """You help an ADHD college student rework a piece of text. Mode decides the job:
- simplify: rewrite it shorter and plainer. Short sentences, everyday words, same meaning.
- challenge: do NOT agree. Push back on the reasoning: name the single weakest assumption,
  then give one concrete counter-argument. Be kind but direct; no flattery.
- another: answer the same need with a clearly different approach, not a rewording.

Follow the student's preferences below when they apply (they wrote and can edit them).
Never invent facts about the student.

If the intent of the text is too unclear to act on, do not guess: return text "" and put ONE
short question in `clarify`. Otherwise `clarify` is "".
`note` is one short sentence saying what you changed or assumed, or "" if nothing to add."""

_SIMPLE_WORDS = [
    (r"\bin order to\b", "to"), (r"\butili[sz]e\b", "use"), (r"\bapproximately\b", "about"),
    (r"\badditionally\b", "also"), (r"\bfurthermore\b", "also"), (r"\bhowever\b", "but"),
    (r"\btherefore\b", "so"), (r"\bdue to the fact that\b", "because"), (r"\bat this point in time\b", "now"),
    (r"\bfacilitate\b", "help"), (r"\bcommence\b", "start"), (r"\bsubsequently\b", "then"),
    (r"\bprior to\b", "before"), (r"\bin the event that\b", "if"), (r"\ba number of\b", "some"),
    (r"\b(basically|actually|really|very|just|essentially|literally)\s+", ""),
]
_ABSOLUTE_RE = re.compile(
    r"\b(always|never|everyone|no one|nobody|obviously|definitely|certainly|impossible|"
    r"can't|cannot|no way|guaranteed|too late)\b", re.I)
_CLAIM_RE = re.compile(r"\b(must|only|have to|will|should|because|so|all|none)\b", re.I)


def load_preferences() -> dict[str, str]:
    """preferences.md and writingstyle.md from the Knowledge folder (missing files are skipped)."""
    import knowledge

    out: dict[str, str] = {}
    for name in PREFERENCE_FILES:
        try:
            content = knowledge.read(name)
        except Exception as exc:
            log.debug("knowledge.read(%s) failed: %s", name, exc)
            continue
        if content and content.strip():
            out[name] = content
    return out


def _sentences(text: str) -> list[str]:
    flat = " ".join(text.split())
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", flat) if s.strip()]


def _unclear(text: str) -> bool:
    words = re.findall(r"[A-Za-z']{2,}", text)
    return len(words) < 3


def _prefs_note(prefs: dict[str, str]) -> str:
    return f" Followed {' and '.join(prefs)}." if prefs else ""


def _canned_refine(req: RefineRequest, prefs: dict[str, str]) -> RefineResponse:
    """Deterministic transformations for MOCK=1 and as the fallback when the model fails."""
    text = req.text.strip()
    if _unclear(text):
        return RefineResponse(text="", mode=req.mode,
                              clarify="What would you like me to work on? Paste the text or say a bit more.")
    sents = _sentences(text)
    if req.mode == "simplify":
        plain = re.sub(r"\s*\([^)]*\)", "", text)
        for pat, rep in _SIMPLE_WORDS:
            plain = re.sub(pat, rep, plain, flags=re.I)
        kept = _sentences(plain)[:2]
        kept = [s[0].upper() + s[1:] for s in kept if s]
        want_bullets = any(re.search(r"\bbullet", p, re.I) for p in prefs.values())
        out = "\n".join(f"- {s}" for s in kept) if want_bullets else " ".join(kept)
        note = f"Kept the first {len(kept)} of {len(sents)} sentence{'s' if len(sents) != 1 else ''} and used plainer words."
        return RefineResponse(text=out, mode=req.mode, note=note + _prefs_note(prefs))
    if req.mode == "challenge":
        weakest = (next((s for s in sents if _ABSOLUTE_RE.search(s)), None)
                   or next((s for s in sents if _CLAIM_RE.search(s)), sents[-1]))
        weakest = weakest.rstrip(".!?")
        out = (
            f'I am not going to just agree with this. The weakest assumption is: "{weakest}". '
            "It is stated as a given, but nothing here backs it up. "
            "Counter-argument: if that turns out to be only partly true, the conclusion no longer follows, "
            "and a smaller or different step may work better. "
            "What would you expect to see if it were wrong?"
        )
        return RefineResponse(text=out, mode=req.mode,
                              note="Named the weakest assumption and argued against it instead of agreeing.")
    first = sents[0].rstrip(".!?")
    out = (
        f'A different way in: instead of starting from "{first}", work backwards. '
        "1) Write the outcome you want in one line. "
        "2) List what has to be true right before that. "
        "3) Do only the first item on that list today."
    )
    return RefineResponse(text=out, mode=req.mode,
                          note="Took a work-backwards approach instead of rewording the original." + _prefs_note(prefs))


def refine(req: RefineRequest) -> RefineResponse:
    prefs = load_preferences()
    if config.MOCK:
        return _canned_refine(req, prefs)
    try:
        import llm

        pref_text = "\n\n".join(f"## {name}\n{content.strip()}" for name, content in prefs.items()) or "(none saved)"
        user = f"Mode: {req.mode}\n\nStudent preferences:\n{pref_text}\n\n"
        if req.context and req.context.strip():
            user += f"Context:\n{req.context.strip()}\n\n"
        user += f"Text:\n{req.text.strip()}"
        out = llm.complete("fast", REFINE_SYSTEM, user, schema=_RefineOut)
        clarify = (out.clarify or "").strip()
        body = (out.text or "").strip()
        if clarify or not body:
            return RefineResponse(text="", mode=req.mode,
                                  clarify=clarify or "Can you say a bit more about what you want changed?")
        return RefineResponse(text=body, mode=req.mode, note=(out.note or "").strip() or None)
    except Exception as exc:
        log.info("refine: model unavailable (%s); using the deterministic fallback", exc)
        return _canned_refine(req, prefs)
