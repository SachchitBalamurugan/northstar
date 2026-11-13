"""Tests for the insight engine. Uses a tiny in-memory fake for storage/knowledge so
they never depend on the real SQLite layer (which may be unfinished)."""
from __future__ import annotations

import json
import sys
import time
import types
from datetime import datetime
from pathlib import Path

import pytest

MEMORY_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MEMORY_DIR))

import models  # noqa: E402
import insights  # noqa: E402

NOW = datetime.fromisoformat("2026-11-13T14:30:00-08:00")   # Friday, inside the 2-5pm window
ROUTINES = "# Routines\n- Sleep: 1am-9am.\n- Best focus: 2-5pm.\n"
PEOPLE = "# People\n- Prof. Lee: CS61B instructor and academic advisor. Emailed Nov 10.\n"


# ----------------------------------------------------------------------------- fakes
class FakeStorage(types.ModuleType):
    def __init__(self, events: list[models.MemoryEvent]):
        super().__init__("storage")
        self.events = events
        self.meta: dict[str, str] = {}
        self.proposals: dict[str, list[models.Proposal]] = {}

    def events_since(self, ts):
        return [e for e in self.events if ts is None or e.ts > ts]

    def list_events(self, kind=None, since=None, limit=200):
        return [e for e in self.events if kind is None or e.kind == kind][:limit]

    def search_events(self, query, k=8):
        return [e for e in self.events if query.lower() in e.text.lower()][:k]

    def get_meta(self, key):
        return self.meta.get(key)

    def set_meta(self, key, value):
        self.meta[key] = value

    def replace_pending_proposals(self, agent, proposals):
        self.proposals[agent] = list(proposals)

    def list_proposals(self, status=None):
        return [p for ps in self.proposals.values() for p in ps if status is None or p.status == status]


class FakeKnowledge(types.ModuleType):
    def __init__(self, files: dict[str, str]):
        super().__init__("knowledge")
        self.files = dict(files)

    def list_files(self):
        return [models.KnowledgeFile(file=k, content=v) for k, v in self.files.items()]

    def read(self, file):
        return self.files[file]

    def write(self, file, content):
        self.files[file] = content


def ev(kind, text, ts="2026-11-10T10:00:00-08:00", source="user", agent="ui", tags=None, refs=None, id=None):
    return models.MemoryEvent(id=id, ts=ts, agent=agent, source=source, kind=kind, text=text, tags=tags, refs=refs)


def deadline(text, due, effort=90, key=None, course=None, **kw):
    tags = [f"due:{due}", f"effort:{effort}"]
    if key:
        tags.append(f"key:{key}")
    if course:
        tags.append(f"course:{course}")
    return ev("deadline", text, source="gmail", agent="inbox", tags=tags, **kw)


def cal(text, day, minutes, start="14:00", key=None, extra=None):
    tags = [f"day:{day}", f"minutes:{minutes}", f"start:{start}"] + (extra or [])
    if key:
        tags.append(f"key:{key}")
    return ev("observation", text, ts=f"{day}T07:00:00-08:00", source="calendar", agent="inbox", tags=tags)


@pytest.fixture
def fake(monkeypatch):
    """Install fake storage/knowledge modules and reset the insights cache."""
    def _install(events, knowledge=None):
        st = FakeStorage(events)
        kn = FakeKnowledge(knowledge or {"routines.md": ROUTINES, "people.md": PEOPLE})
        monkeypatch.setitem(sys.modules, "storage", st)
        monkeypatch.setitem(sys.modules, "knowledge", kn)
        monkeypatch.setattr(insights, "_cache", None)
        monkeypatch.setattr(insights, "_cache_at", None)
        return st, kn
    return _install


KNOWLEDGE = {"routines.md": ROUTINES, "people.md": PEOPLE}


# ----------------------------------------------------------------------------- NextThing
def test_next_thing_picks_nearest_unblocked_deadline_and_cites_memory():
    events = [
        deadline("CS70 Homework 10 due Tue", "2026-11-17T23:59:00-08:00", effort=90, key="cs70-hw10"),
        deadline("CS61B Project 3 due Fri", "2026-11-20T17:00:00-08:00", effort=120, key="cs61b-proj3"),
        deadline("Financial aid form", "2026-11-16T12:00:00-08:00", effort=30, key="finaid"),
        cal("Calendar: 'Financial aid form' Mon 4-4:30pm", "2026-11-16", 30, key="finaid"),  # nearest, but blocked
    ]
    r = insights.compute(events, KNOWLEDGE, NOW)
    assert r.nextThing.title == "CS70 Homework 10"
    assert "no time block yet" in r.nextThing.why
    assert "routines.md" in r.nextThing.why and "2pm-5pm" in r.nextThing.why
    assert r.nextThing.why.count(".") >= 1 and r.nextThing.why.endswith(".")
    assert 25 <= r.nextThing.minutes <= 50
    assert r.nextThing.dueAt == "2026-11-17T23:59:00-08:00"
    assert r.nextThing.proposalId in {c.id for c in r.cards}


def test_next_thing_skips_done_and_past_deadlines():
    events = [
        deadline("Old lab", "2026-11-10T23:59:00-08:00", key="lab9"),                 # past
        deadline("Essay draft", "2026-11-19T17:00:00-08:00", key="draft2"),
        ev("task", "Turned in essay draft", ts="2026-11-12T10:00:00-08:00", tags=["done", "key:draft2"]),
        deadline("CS61B Project 3", "2026-11-20T17:00:00-08:00", key="proj3"),
    ]
    r = insights.compute(events, KNOWLEDGE, NOW)
    assert r.nextThing.title == "CS61B Project 3"


def test_next_thing_when_nothing_is_due():
    r = insights.compute([ev("fact", "Likes robotics")], KNOWLEDGE, NOW)
    assert r.nextThing.minutes > 0 and r.cards == []


def test_blocked_deadline_ranks_below_unblocked_but_can_still_win_when_alone():
    events = [
        deadline("Financial aid form", "2026-11-16T12:00:00-08:00", effort=30, key="finaid"),
        cal("Calendar: 'Financial aid form'", "2026-11-16", 30, key="finaid"),
    ]
    r = insights.compute(events, KNOWLEDGE, NOW)
    assert r.nextThing.title == "Financial aid form"
    assert "already has a calendar block" in r.nextThing.why
    assert r.nextThing.proposalId is None
    assert not any(c.payload["kind"] == "deadline_no_block" for c in r.cards)


def test_block_detected_by_title_mention_in_calendar_text():
    events = [
        deadline("CS70 Homework 10", "2026-11-17T23:59:00-08:00", key="hw10"),
        cal("Calendar: 'Work on cs70 homework 10' Mon 2-3pm", "2026-11-16", 60),  # no key tag, text match
    ]
    r = insights.compute(events, KNOWLEDGE, NOW)
    assert "already has a calendar block" in r.nextThing.why


# ----------------------------------------------------------------------------- detectors
def kinds(r):
    return [c.payload["kind"] for c in r.cards]


def test_detector_a_deadline_without_block():
    r = insights.compute([deadline("CS61B Project 3", "2026-11-20T17:00:00-08:00", effort=120, key="p3", course="CS61B")], KNOWLEDGE, NOW)
    [card] = r.cards
    assert card.payload["kind"] == "deadline_no_block"
    assert card.agent == "memory" and card.type == "task" and card.status == "pending"
    assert card.title.startswith("Block time for") and len(card.title) <= 60
    assert "routines.md" in card.why and "no calendar block" in card.why
    assert card.urgency == 3                       # 7.1 days out
    assert card.payload["suggestedMinutes"] == 50 and card.payload["course"] == "CS61B"
    assert card.dueAt == "2026-11-20T17:00:00-08:00"


def test_detector_b_prof_email_waiting_over_48h():
    waiting = ev("task", "Email from Prof. Lee: confirm advising slot", ts="2026-11-10T09:15:00-08:00",
                 source="gmail", agent="inbox", tags=["role:prof", "from:Prof. Lee"],
                 refs=models.EventRefs(emailId="em-1"))
    fresh = ev("task", "Email from Prof. Rao: new HW posted", ts="2026-11-12T18:00:00-08:00",
               source="gmail", agent="inbox", tags=["role:prof", "from:Prof. Rao"],
               refs=models.EventRefs(emailId="em-2"))
    r = insights.compute([waiting, fresh], KNOWLEDGE, NOW)
    [card] = r.cards
    assert card.payload["kind"] == "prof_email_waiting"
    assert card.title == "Reply to Prof. Lee" and card.urgency == 1
    assert "3 days" in card.why and "people.md" in card.why and "academic advisor" in card.why
    assert card.payload["emailId"] == "em-1"


def test_detector_b_cleared_by_reply_event():
    waiting = ev("task", "Email from Prof. Lee", ts="2026-11-10T09:15:00-08:00", source="gmail", agent="inbox",
                 tags=["role:prof", "from:Prof. Lee"], refs=models.EventRefs(emailId="em-1"))
    reply = ev("observation", "Replied to Prof. Lee", ts="2026-11-11T09:00:00-08:00", source="gmail", agent="inbox",
               tags=["replied"], refs=models.EventRefs(emailId="em-1"))
    assert insights.compute([waiting, reply], KNOWLEDGE, NOW).cards == []


def test_detector_c_overcommitted_day():
    events = [
        cal("Calendar: 'CS70 lecture'", "2026-11-17", 90, "11:00"),
        cal("Calendar: 'EE16A lab'", "2026-11-17", 180, "12:30"),
        cal("Calendar: 'English R1B'", "2026-11-17", 90, "15:30"),
        cal("Calendar: 'Robotics'", "2026-11-17", 120, "19:00"),
        cal("Calendar: 'CS61B lecture'", "2026-11-16", 60, "10:00"),   # light day, no card
        cal("Calendar: 'Old heavy day'", "2026-11-03", 600, "08:00"),  # in the past, no card
    ]
    r = insights.compute(events, KNOWLEDGE, NOW)
    [card] = r.cards
    assert card.payload["kind"] == "overcommitted_day"
    assert card.payload["day"] == "2026-11-17" and card.payload["minutes"] == 480
    assert "8h" in card.title and card.urgency == 2
    assert "routines.md" in card.why and "1am-9am" in card.why


def test_detector_d_skipped_8am_pattern():
    events = [
        cal("Skipped 'Study CS70' at 8am", "2026-11-04", 60, "08:00", extra=["skipped"]),
        cal("Skipped 'Study CS61B' at 8am", "2026-11-06", 60, "08:00", extra=["skipped"]),
        cal("Skipped 'Study CS70' at 8am", "2026-11-11", 60, "08:00", extra=["skipped"]),
    ]
    r = insights.compute(events, KNOWLEDGE, NOW)
    [card] = r.cards
    assert card.payload["kind"] == "pattern_skipped_block"
    assert card.title == "Move study from 8am to 2pm?"
    assert "skipped 3 8am blocks" in card.why and "routines.md" in card.why
    assert card.urgency == 3 and card.payload == {"kind": "pattern_skipped_block", "skippedHour": 8, "count": 3, "suggestedHour": 14}


def test_detector_e_gentle_win():
    events = [
        ev("task", "Submitted CS61B Lab 9", ts="2026-11-10T21:00:00-08:00", tags=["done", "key:lab9"]),
        ev("task", "Turned in R1B draft 2", ts="2026-11-12T16:00:00-08:00", tags=["done", "key:draft2"]),
        ev("task", "Ancient win", ts="2026-10-01T16:00:00-08:00", tags=["done"]),  # too old
    ]
    r = insights.compute(events, KNOWLEDGE, NOW)
    [card] = r.cards
    assert card.payload["kind"] == "win" and card.payload["count"] == 2
    assert card.title == "Nice: 2 deadlines done this week" and card.urgency == 3


# ----------------------------------------------------------------------------- cards
def test_max_five_cards_sorted_by_urgency_with_one_per_detector():
    events = [deadline(f"Deadline {i}", f"2026-11-{14 + i}T17:00:00-08:00", key=f"d{i}") for i in range(6)]
    events += [
        ev("task", "Email from Prof. Lee", ts="2026-11-09T09:00:00-08:00", source="gmail", agent="inbox",
           tags=["role:prof", "from:Prof. Lee"], refs=models.EventRefs(emailId="em-1")),
        cal("A", "2026-11-17", 200, "09:00"), cal("B", "2026-11-17", 200, "13:00"),
        cal("S1", "2026-11-04", 60, "08:00", extra=["skipped"]), cal("S2", "2026-11-06", 60, "08:00", extra=["skipped"]),
        ev("task", "Done thing", ts="2026-11-12T16:00:00-08:00", tags=["done"]),
    ]
    r = insights.compute(events, KNOWLEDGE, NOW)
    assert len(r.cards) == 5
    assert [c.urgency for c in r.cards] == sorted(c.urgency for c in r.cards)
    assert set(kinds(r)) == {"deadline_no_block", "prof_email_waiting", "overcommitted_day", "pattern_skipped_block", "win"}
    assert all(len(c.title) <= 60 for c in r.cards)
    assert len({c.id for c in r.cards}) == 5


def test_card_ids_are_stable_across_runs():
    events = [deadline("CS61B Project 3", "2026-11-20T17:00:00-08:00", key="p3")]
    a = insights.compute(events, KNOWLEDGE, NOW).cards[0].id
    b = insights.compute(events, KNOWLEDGE, datetime.fromisoformat("2026-11-14T09:00:00-08:00")).cards[0].id
    assert a == b


# ----------------------------------------------------------------------------- digest + cache
def test_run_digest_persists_proposals_and_meta(fake):
    st, kn = fake([deadline("CS70 Homework 10", "2026-11-17T23:59:00-08:00", key="hw10")])
    r = insights.run_digest(now=NOW)
    assert r.nextThing.title == "CS70 Homework 10"
    assert [p.id for p in st.proposals["memory"]] == [c.id for c in r.cards]
    assert st.meta["last_digest_ts"] == NOW.isoformat()
    assert insights.get_insights() is r or insights.get_insights().computedAt == r.computedAt


def test_run_digest_skips_llm_in_mock_and_keeps_knowledge(fake, monkeypatch):
    import config
    monkeypatch.setattr(config, "MOCK", True)
    st, kn = fake([deadline("X", "2026-11-18T10:00:00-08:00")])
    before = dict(kn.files)
    insights.run_digest(now=NOW)
    assert kn.files == before


def test_run_digest_survives_llm_failure(fake, monkeypatch):
    import config
    import llm
    monkeypatch.setattr(config, "MOCK", False)
    monkeypatch.setattr(config, "OPENAI_API_KEY", "sk-test-not-real")

    def boom(*a, **k):
        raise RuntimeError("network down")
    monkeypatch.setattr(llm, "complete", boom)
    st, kn = fake([deadline("X", "2026-11-18T10:00:00-08:00")])
    r = insights.run_digest(now=NOW)
    assert r.nextThing.title == "X"


def test_run_digest_applies_llm_patch_when_available(fake, monkeypatch):
    import config
    import llm
    monkeypatch.setattr(config, "MOCK", False)
    monkeypatch.setattr(config, "OPENAI_API_KEY", "sk-test-not-real")
    st, kn = fake([deadline("X", "2026-11-18T10:00:00-08:00")])

    def fake_complete(tier, system, input, schema=None):
        assert tier == "smart" and schema is insights.KnowledgePatch
        return schema(files=[
            insights.FilePatch(file="routines.md", content="# Routines\n- Best focus: 9-11am\n" + "\n" * 100),
            insights.FilePatch(file="evil.md", content="nope"),
        ])
    monkeypatch.setattr(llm, "complete", fake_complete)
    r = insights.run_digest(now=NOW)
    assert "evil.md" not in kn.files
    assert len(kn.files["routines.md"].splitlines()) <= 60
    assert "9am-11am" in r.nextThing.why   # the patched focus window is used in the same digest


def test_get_insights_is_fast_without_cache(fake):
    fake([deadline("CS70 Homework 10", "2026-11-17T23:59:00-08:00", key="hw10")])
    t0 = time.perf_counter()
    r = insights.get_insights()
    assert (time.perf_counter() - t0) < 0.2
    assert r.stale is False and r.nextThing.title == "CS70 Homework 10"


def test_get_insights_marks_stale_and_recomputes_in_background(fake, monkeypatch):
    st, kn = fake([deadline("CS70 Homework 10", "2026-11-17T23:59:00-08:00", key="hw10")])
    old = insights.run_digest(now=NOW)
    monkeypatch.setattr(insights, "_cache_at", insights._now() - insights.STALE_AFTER * 2)
    kicked = []
    monkeypatch.setattr(insights, "_recompute_in_background", lambda full=False: kicked.append(full))
    r = insights.get_insights()
    assert r.stale is True and r.nextThing == old.nextThing and kicked == [False]


# ----------------------------------------------------------------------------- fixtures + llm
def test_fixtures_validate_and_produce_demo_insights():
    data = json.loads((MEMORY_DIR / "fixtures" / "events.json").read_text(encoding="utf-8"))
    anchor = datetime.fromisoformat(data["anchor"])
    events = [models.MemoryEvent.model_validate(x) for x in data["items"]]
    assert len(events) >= 40
    knowledge = {p.name: p.read_text(encoding="utf-8") for p in (MEMORY_DIR / "fixtures" / "knowledge").glob("*.md")}
    assert set(knowledge) == {"README.md", "goals.md", "classes.md", "deadlines.md", "writingstyle.md", "routines.md", "people.md"}
    assert all(len(t.splitlines()) <= 60 for t in knowledge.values())
    r = insights.compute(events, knowledge, anchor.replace(hour=14, minute=30))
    assert r.nextThing.title == "CS70 Homework 10"
    assert set(kinds(r)) == {"deadline_no_block", "prof_email_waiting", "overcommitted_day", "pattern_skipped_block", "win"}
    assert r.cards[0].title == "Reply to Prof. Lee"


def test_llm_raises_unavailable_in_mock(monkeypatch):
    import config
    import llm
    monkeypatch.setattr(config, "MOCK", True)
    with pytest.raises(llm.LLMUnavailable):
        llm.complete("fast", "sys", "hi")
    monkeypatch.setattr(config, "MOCK", False)
    monkeypatch.setattr(config, "OPENAI_API_KEY", "")
    with pytest.raises(llm.LLMUnavailable):
        llm.complete("smart", "sys", [{"type": "input_text", "text": "hi"}])


def test_routes_wire_to_insights(fake, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import routes_insights

    fake([deadline("CS70 Homework 10", "2026-11-17T23:59:00-08:00", key="hw10")])
    app = FastAPI()
    app.include_router(routes_insights.router)
    client = TestClient(app)
    body = client.get("/insights").json()
    assert body["nextThing"]["title"] == "CS70 Homework 10" and "cards" in body
    body = client.post("/digest/run", json={"full": True}).json()
    assert body["nextThing"]["title"] == "CS70 Homework 10"
    assert client.post("/digest/run").status_code == 200
