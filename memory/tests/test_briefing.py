"""Tests for /briefing, /resume and /refine (MOCK=1, temp data dir, no umem, no LLM)."""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path

import pytest

os.environ.setdefault("MOCK", "1")
MEMORY_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MEMORY_DIR))

import briefing  # noqa: E402
import config  # noqa: E402
import insights  # noqa: E402
import models  # noqa: E402
import storage  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

NOW = datetime.fromisoformat("2026-11-13T09:30:00-08:00")  # the fixture anchor day, before both lectures


def _fixture():
    raw = json.loads((MEMORY_DIR / "fixtures" / "events.json").read_text(encoding="utf-8"))
    events = [models.MemoryEvent.model_validate(i) for i in raw["items"]]
    knowledge = {p.name: p.read_text(encoding="utf-8") for p in (MEMORY_DIR / "fixtures" / "knowledge").glob("*.md")}
    return events, knowledge


def _ev(text, tags, kind="task", source="user", ts="2026-11-12T10:00:00-08:00"):
    return models.MemoryEvent(ts=ts, agent="ui", source=source, kind=kind, text=text, tags=tags)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "MOCK", True)
    monkeypatch.setattr(config, "UMEM_ENABLED", False)
    storage.reset_for_tests(tmp_path / "data")
    insights._cache = insights._cache_at = None
    import main

    with TestClient(main.app) as c:
        yield c
    storage.close()
    insights._cache = insights._cache_at = None


# ----------------------------------------------------------------------------- briefing (pure)
def test_briefing_combines_events_deadlines_and_unfinished():
    events, knowledge = _fixture()
    b = briefing.build_briefing(events, knowledge, [], NOW)
    assert b.date == "2026-11-13" and b.greeting == "Good morning."
    assert 1 <= len(b.items) <= 5 and len({i.id for i in b.items}) == len(b.items)
    assert all(i.why.strip() and i.title.strip() for i in b.items)
    kinds = [i.kind for i in b.items]
    assert kinds[:2] == ["event", "event"] and "deadline" in kinds and "unfinished" in kinds
    assert [i.title for i in b.items[:2]] == ["CS61B lecture", "EE16A lecture"]
    assert b.items[0].start == "2026-11-13T10:00:00-08:00"
    deadlines = [i for i in b.items if i.kind == "deadline"]
    assert deadlines[0].title == "CS70 Homework 10" and deadlines[0].minutes == 90   # effort:90 is in memory
    assert deadlines == sorted(deadlines, key=lambda i: i.dueAt)
    assert b.summary.count(".") == 1                                                # one sentence
    assert briefing.build_briefing(events, knowledge, [], NOW) == b                  # deterministic


def test_briefing_minutes_only_when_memory_has_an_estimate():
    events = [
        _ev("History essay outline due Mon", ["due:2026-11-16T17:00:00-08:00", "key:hist"], kind="deadline"),
        _ev("Chem lab report due Tue", ["due:2026-11-17T17:00:00-08:00", "key:chem", "effort:45"], kind="deadline"),
    ]
    b = briefing.build_briefing(events, {}, [], NOW)
    by_title = {i.title: i for i in b.items if i.kind == "deadline"}
    assert by_title["History essay outline"].minutes is None   # no guess, even though insights defaults to 60
    assert by_title["Chem lab report"].minutes == 45
    off = briefing.build_briefing(events, {}, [], NOW, estimates=False)
    assert all(i.minutes is None for i in off.items)


def test_briefing_links_pending_proposal_and_handles_empty():
    events, knowledge = _fixture()
    cards = insights.compute(events, knowledge, NOW).cards
    b = briefing.build_briefing(events, knowledge, cards, NOW)
    assert len(b.items) <= 5
    linked = [i for i in b.items if i.proposalId]
    assert linked and all(i.proposalId in {c.id for c in cards} for i in linked)
    empty = briefing.build_briefing([], {}, [], NOW)
    assert empty.items == [] and "Nothing needs you" in empty.summary


def test_briefing_llm_polish_and_fallback(monkeypatch):
    import llm

    events, knowledge = _fixture()
    base = briefing.build_briefing(events, knowledge, [], NOW)
    monkeypatch.setattr(config, "MOCK", False)
    rev = [i.id for i in reversed(base.items)]
    monkeypatch.setattr(llm, "complete", lambda *a, **k: briefing._BriefingPolish(summary="A light day.", order=rev[:-1] + ["bogus"]))
    polished = briefing._polish(base)
    assert polished.summary == "A light day."
    assert sorted(i.id for i in polished.items) == sorted(i.id for i in base.items)   # nothing added or lost
    assert [i.id for i in polished.items][:-1] == rev[:-1]

    def boom(*a, **k):
        raise RuntimeError("model down")

    monkeypatch.setattr(llm, "complete", boom)
    assert briefing._polish(base) == base


# ----------------------------------------------------------------------------- resume (pure)
def test_resume_from_fixtures_uses_events_and_knowledge():
    events, knowledge = _fixture()
    items = briefing.build_resume(events, knowledge, NOW)
    assert 1 <= len(items) <= 3
    projects = [i.project for i in items]
    assert any("CS61B Project 3" in p for p in projects)
    proj3 = next(i for i in items if "CS61B Project 3" in i.project)
    assert "deadlines.md" in proj3.whereYouStopped and "pushed" in proj3.whereYouStopped
    assert proj3.nextStep and proj3.why.startswith("Due ")
    assert datetime.fromisoformat(proj3.lastTouched)
    assert not any("Lab 9" in p or "draft 2" in p for p in projects)   # completed work never comes back


def test_resume_started_but_not_submitted_and_done_hides_it():
    started = _ev("Started the Acme scholarship application; saved a draft, not submitted.",
                  ["key:acme-app"], kind="observation", source="form")
    items = briefing.build_resume([started], {}, NOW)
    assert len(items) == 1 and "Acme scholarship application" in items[0].project
    assert "not submitted" in items[0].whereYouStopped and "form" in items[0].nextStep.lower()
    done = _ev("Submitted the Acme scholarship application.", ["done", "key:acme-app"])
    assert briefing.build_resume([started, done], {}, NOW) == []
    snooze = _ev("Snoozed", ["resume-snoozed", f"resume:{items[0].id}"], ts="2026-11-13T09:00:00-08:00")
    assert briefing.build_resume([started, snooze], {}, NOW) == []
    later = datetime.fromisoformat("2026-11-15T09:30:00-08:00")
    assert len(briefing.build_resume([started, snooze], {}, later)) == 1    # snooze wears off


# ----------------------------------------------------------------------------- HTTP
def test_briefing_and_resume_endpoints(client):
    b = client.get("/briefing").json()
    assert set(b) == {"date", "greeting", "summary", "items", "generatedAt"}
    assert len(b["items"]) <= 5 and b["items"]
    assert all({"id", "title", "why", "kind"} <= set(i) for i in b["items"])
    assert any("minutes" in i for i in b["items"])
    off = client.get("/briefing?estimates=0").json()
    assert all("minutes" not in i for i in off["items"])

    items = client.get("/resume").json()["items"]
    assert 1 <= len(items) <= 3
    assert all(set(i) == {"id", "project", "whereYouStopped", "nextStep", "lastTouched", "why"} for i in items)
    first, n_events = items[0], storage.count_events()
    assert client.post(f"/resume/{first['id']}/done").json() == {"ok": True}
    assert storage.count_events() == n_events + 1
    after = client.get("/resume").json()["items"]
    assert first["id"] not in [i["id"] for i in after]
    assert client.post(f"/resume/{first['id']}/done").status_code == 200       # idempotent
    if after:
        assert client.post(f"/resume/{after[0]['id']}/snooze").json() == {"ok": True}
        assert after[0]["id"] not in [i["id"] for i in client.get("/resume").json()["items"]]
    assert client.post("/resume/nope/done").status_code == 404
    assert client.post("/resume/nope/snooze").status_code == 404
    assert first["project"] not in [i["title"] for i in client.get("/briefing").json()["items"]]


LONG = ("In order to finish the project (which is basically huge), I will utilize every evening this week. "
        "However, I always work best under pressure. Additionally, I might ask a friend for help.")


def test_refine_modes_and_validation(client):
    s = client.post("/refine", json={"text": LONG, "mode": "simplify"}).json()
    assert s["mode"] == "simplify" and 0 < len(s["text"]) < len(LONG) and "clarify" not in s
    assert "utilize" not in s["text"] and "(" not in s["text"] and "writingstyle.md" in s["note"]

    c = client.post("/refine", json={"text": LONG, "mode": "challenge"}).json()
    assert "weakest assumption" in c["text"] and "I always work best under pressure" in c["text"]
    assert "Counter-argument" in c["text"] and "agree" in c["text"]

    a = client.post("/refine", json={"text": LONG, "mode": "another", "context": "planning"}).json()
    assert a["mode"] == "another" and a["text"] not in (s["text"], c["text"]) and "different" in a["text"].lower()
    assert client.post("/refine", json={"text": LONG, "mode": "another"}).json() == a   # deterministic

    q = client.post("/refine", json={"text": "fix it??", "mode": "simplify"}).json()
    assert q["text"] == "" and q["clarify"].strip() and "note" not in q

    assert client.post("/refine", json={"text": LONG, "mode": "shout"}).status_code == 422
    assert client.post("/refine", json={"text": "   ", "mode": "simplify"}).status_code == 422
    assert client.post("/refine", json={"mode": "simplify"}).status_code == 422


def test_refine_reads_editable_preferences(client):
    assert client.put("/knowledge/preferences.md",
                      json={"content": "# Preferences\n- Answer in bullet points.\n"}).status_code == 200
    s = client.post("/refine", json={"text": LONG, "mode": "simplify"}).json()
    assert s["text"].startswith("- ") and "preferences.md" in s["note"]


def test_refine_real_mode_uses_llm_and_falls_back(client, monkeypatch):
    import llm

    seen = {}

    def fake(tier, system, input, schema=None):
        if schema is not briefing._RefineOut:   # the background digest shares the helper; keep it out
            raise llm.LLMUnavailable("not under test")
        seen.update(system=system, input=input, schema=schema)
        return briefing._RefineOut(text="Shorter.", note="Cut it down.", clarify="")

    monkeypatch.setattr(config, "MOCK", False)
    monkeypatch.setattr(llm, "complete", fake)
    r = client.post("/refine", json={"text": LONG, "mode": "simplify", "context": "for my advisor"}).json()
    assert r == {"text": "Shorter.", "mode": "simplify", "note": "Cut it down."}
    assert seen["schema"] is briefing._RefineOut and "writingstyle.md" in seen["input"] and "for my advisor" in seen["input"]

    def unsure(tier, system, input, schema=None):
        if schema is not briefing._RefineOut:
            raise llm.LLMUnavailable("not under test")
        return briefing._RefineOut(text="guess", note="", clarify="Which part?")

    monkeypatch.setattr(llm, "complete", unsure)
    assert client.post("/refine", json={"text": LONG, "mode": "another"}).json() == {
        "text": "", "mode": "another", "clarify": "Which part?"}

    def boom(*a, **k):
        raise RuntimeError("model down")

    monkeypatch.setattr(llm, "complete", boom)
    fb = client.post("/refine", json={"text": LONG, "mode": "challenge"}).json()
    assert "weakest assumption" in fb["text"]
