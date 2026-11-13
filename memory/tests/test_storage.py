"""Offline tests for storage / knowledge / umem_bridge / routes_storage (MOCK=1, no umem)."""
from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

os.environ.setdefault("MOCK", "1")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config  # noqa: E402
import knowledge  # noqa: E402
import models  # noqa: E402
import storage  # noqa: E402
import umem_bridge  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from routes_storage import router  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_store(tmp_path, monkeypatch):
    """Every test gets an empty data dir and umem switched off (no subprocesses)."""
    monkeypatch.setattr(config, "UMEM_ENABLED", False)
    monkeypatch.setattr(config, "FIXTURES_DIR", tmp_path / "no-fixtures")
    storage.reset_for_tests(tmp_path / "data")
    yield
    storage.close()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def ev(text, kind="observation", ts=None, tags=None, agent="inbox", source="gmail"):
    return models.MemoryEvent(
        ts=ts or datetime.now().astimezone().isoformat(timespec="seconds"),
        agent=agent, source=source, kind=kind, text=text, tags=tags,
    )


# --- events -----------------------------------------------------------------
def test_add_and_fts_search():
    a = storage.add_event(ev("Prof. Lee emailed about the CS61 extension", tags=["email", "prof"]))
    storage.add_event(ev("Robotics club meets Thursday"))
    assert a.id  # uuid assigned
    hits = storage.search_events("Prof. Lee")
    assert [h.id for h in hits] == [a.id]
    # tag matches count too
    assert storage.search_events("prof")[0].id == a.id
    # hostile punctuation must not break the FTS query
    assert storage.search_events('lee\'s "extension" (CS61) AND NOT OR *') != []
    assert storage.search_events("   ") == []
    assert storage.search_events("zzzznothing") == []


def test_search_newest_first_on_ties():
    old = storage.add_event(ev("deadline essay", ts="2026-01-01T10:00:00-08:00"))
    new = storage.add_event(ev("deadline essay", ts="2026-01-02T10:00:00-08:00"))
    assert [h.id for h in storage.search_events("deadline essay")] == [new.id, old.id]


def test_list_and_since_and_meta():
    storage.add_event(ev("one", kind="fact", ts="2026-01-01T00:00:00Z"))
    storage.add_event(ev("two", kind="deadline", ts="2026-01-02T00:00:00Z"))
    storage.add_event(ev("three", kind="fact", ts="2026-01-03T00:00:00Z"))
    assert [e.text for e in storage.list_events()] == ["three", "two", "one"]
    assert [e.text for e in storage.list_events(kind="fact")] == ["three", "one"]
    assert [e.text for e in storage.list_events(since="2026-01-01T12:00:00Z", limit=1)] == ["three"]
    assert [e.text for e in storage.events_since("2026-01-01T00:00:00Z")] == ["two", "three"]
    assert len(storage.events_since(None)) == 3
    assert storage.get_meta("last_digest") is None
    storage.set_meta("last_digest", "2026-01-03T00:00:00Z")
    assert storage.get_meta("last_digest") == "2026-01-03T00:00:00Z"


def test_refs_roundtrip():
    e = ev("mail")
    e.refs = models.EventRefs(emailId="abc")
    storage.add_event(e)
    got = storage.list_events()[0]
    assert got.refs and got.refs.emailId == "abc" and got.refs.url is None


# --- fixtures ---------------------------------------------------------------
def test_seed_fixtures_shifts_timestamps(tmp_path, monkeypatch):
    fx = tmp_path / "fixtures"
    (fx / "knowledge").mkdir(parents=True)
    (fx / "knowledge" / "people.md").write_text("# People\n- Prof. Lee: CS61 instructor\n", encoding="utf-8")
    (fx / "knowledge" / "ignored.txt").write_text("x", encoding="utf-8")
    anchor = "2026-11-13T08:00:00-08:00"
    (fx / "events.json").write_text(json.dumps({
        "anchor": anchor,
        "items": [
            {"ts": "2026-11-13T09:30:00-08:00", "agent": "inbox", "source": "gmail",
             "kind": "deadline", "text": "PS4 due", "tags": ["cs61"],
             "refs": {"emailId": "m1"}},
            {"ts": "2026-11-15T23:59:00-08:00", "agent": "inbox", "source": "calendar",
             "kind": "observation", "text": "lab"},
        ],
    }), encoding="utf-8")
    monkeypatch.setattr(config, "FIXTURES_DIR", fx)
    storage.reset_for_tests(tmp_path / "data2", seed_fixtures=True)

    events = storage.events_since(None)
    assert len(events) == 2
    delta = (date.today() - date(2026, 11, 13)).days
    first = datetime.fromisoformat(events[0].ts)
    assert first.date() == date(2026, 11, 13) + timedelta(days=delta)
    assert first.hour == 9 and first.minute == 30 and first.utcoffset() == timedelta(hours=-8)
    assert (config.KNOWLEDGE_DIR / "people.md").read_text(encoding="utf-8").startswith("# People")
    assert not (config.KNOWLEDGE_DIR / "ignored.txt").exists()
    # second init must not double-seed
    storage.reset_for_tests(tmp_path / "data2", seed_fixtures=True)
    assert len(storage.events_since(None)) == 2


def test_seed_without_fixture_files_is_fine(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "FIXTURES_DIR", tmp_path / "missing")
    storage.reset_for_tests(tmp_path / "data3", seed_fixtures=True)
    assert storage.events_since(None) == []


# --- knowledge --------------------------------------------------------------
def test_knowledge_crud_and_allowed_list(caplog):
    files = knowledge.list_files()
    assert [f.file for f in files] == config.KNOWLEDGE_FILES
    assert all(f.content == "" for f in files)
    knowledge.write("people.md", "# People\n- Prof. Lee teaches CS61, replies slowly\n")
    assert "Prof. Lee" in knowledge.read("people.md")
    with pytest.raises(ValueError):
        knowledge.read("../secrets.md")
    with pytest.raises(ValueError):
        knowledge.write("notes.md", "x")
    with caplog.at_level("WARNING", logger="memory.knowledge"):
        big = "\n".join(f"line {i}" for i in range(config.KNOWLEDGE_MAX_LINES + 5))
        knowledge.write("goals.md", big)
    assert "lines" in caplog.text
    assert knowledge.read("goals.md") == big  # kept, not truncated


def test_knowledge_relevant():
    knowledge.write("README.md", "# Maya\nCS sophomore with ADHD\n")
    knowledge.write("people.md", "# People\n- Prof. Lee: CS61 instructor, office hours Tue\n")
    knowledge.write("classes.md", "# Classes\n- CS61\n- Math 54\n")
    top = knowledge.relevant("Prof. Lee")
    assert top[0].file == "people.md"
    assert "instructor" in top[0].content
    assert [k.file for k in knowledge.relevant("qwertyuiop")] == ["README.md"]
    assert len(knowledge.relevant("CS61 Lee", n=1)) == 1


# --- proposals --------------------------------------------------------------
def prop(id="p1", type="task", agent="memory", title="Move study block to 2pm"):
    return models.Proposal(id=id, agent=agent, createdAt="2026-11-13T10:00:00-08:00", type=type,
                           title=title, why="you skip 8am blocks", payload={"minutes": 50}, urgency=2)


def test_proposals_crud_and_replace():
    storage.add_proposal(prop("p1"))
    storage.add_proposal(prop("p2", type="send_reply", agent="inbox"))
    assert {p.id for p in storage.list_proposals("pending")} == {"p1", "p2"}
    assert storage.get_proposal("nope") is None
    assert storage.set_proposal_status("nope", "approved") is None
    assert storage.set_proposal_status("p2", "done").status == "done"
    assert [p.id for p in storage.list_proposals("pending")] == ["p1"]
    storage.replace_pending_proposals("memory", [prop("p3"), prop("p4")])
    assert {p.id for p in storage.list_proposals("pending")} == {"p3", "p4"}
    assert storage.get_proposal("p2").status == "done"  # other agents' / non-pending untouched


def test_approve_task_writes_preference(client):
    storage.add_proposal(prop("p1"))
    storage.add_proposal(prop("p9", type="send_reply", agent="inbox", title="Reply to Lee"))
    r = client.post("/proposals/p1/approve")
    assert r.status_code == 200 and r.json()["status"] == "approved"
    prefs = storage.list_events(kind="preference")
    assert len(prefs) == 1
    assert prefs[0].text == "user accepted: Move study block to 2pm"
    assert prefs[0].tags == ["insight", "accepted"]
    assert prefs[0].agent == "memory" and prefs[0].source == "insight"
    r = client.post("/proposals/p9/reject")
    assert r.json()["status"] == "rejected"
    assert len(storage.list_events(kind="preference")) == 1  # non-task: no preference
    storage.add_proposal(prop("p2", title="Study at 8am"))
    client.post("/proposals/p2/reject")
    texts = {e.text for e in storage.list_events(kind="preference")}
    assert "user declined: Study at 8am" in texts
    assert client.post("/proposals/zzz/approve").status_code == 404
    assert client.get("/proposals?status=approved").json()[0]["id"] == "p1"


# --- routes -----------------------------------------------------------------
def test_events_and_context_routes(client):
    knowledge.write("people.md", "# People\n- Prof. Lee: CS61 instructor\n")
    body = {"ts": "2026-11-13T09:00:00-08:00", "agent": "inbox", "source": "gmail",
            "kind": "observation", "text": "Prof. Lee asked for the PS4 draft", "tags": ["email"]}
    r = client.post("/events", json=body)
    assert r.status_code == 200 and r.json()["id"]
    r = client.post("/context", json={"query": "Prof. Lee"})
    assert r.status_code == 200
    data = r.json()
    assert data["snippets"][0]["text"] == body["text"]
    assert data["knowledge"][0]["file"] == "people.md"
    assert data["umem"] is None  # umem disabled in tests
    assert client.post("/events", json={"ts": "x", "agent": "bogus", "source": "gmail",
                                        "kind": "fact", "text": "t"}).status_code == 422


def test_context_trimming(client, monkeypatch):
    knowledge.write("people.md", "lee " * 3000)          # 12000 chars
    for i in range(20):
        storage.add_event(ev("lee " * 100 + str(i)))     # ~400 chars each
    monkeypatch.setattr(config, "UMEM_ENABLED", True)
    monkeypatch.setattr(umem_bridge, "_available", True)
    monkeypatch.setattr(umem_bridge, "context", lambda: "u" * 5000)
    data = client.post("/context", json={"query": "lee", "k": 20}).json()
    total = (sum(len(s["text"]) for s in data["snippets"])
             + sum(len(k["content"]) for k in data["knowledge"]) + len(data["umem"] or ""))
    assert total <= 8000
    assert data["snippets"] == []                         # snippets trimmed first
    assert len(data["knowledge"][0]["content"]) == 8000   # umem cut before knowledge
    assert data["umem"] is None


def test_knowledge_routes(client):
    assert [k["file"] for k in client.get("/knowledge").json()] == config.KNOWLEDGE_FILES
    r = client.put("/knowledge/goals.md", json={"content": "- ship Northstar\n"})
    assert r.status_code == 200 and r.json()["content"] == "- ship Northstar\n"
    assert client.get("/knowledge/goals.md").json()["content"] == "- ship Northstar\n"
    assert client.get("/knowledge/nope.md").status_code == 404
    assert client.put("/knowledge/nope.md", json={"content": "x"}).status_code == 404


def test_remember_route(client, monkeypatch):
    calls = []
    monkeypatch.setattr(umem_bridge, "remember", lambda text, tags, scope="global": calls.append((text, tags, scope)) or True)
    r = client.post("/remember", json={"text": "Tuesdays are lab days", "tags": ["routine"]})
    assert r.status_code == 200 and r.json()["umem"] is True
    facts = storage.list_events(kind="fact")
    assert facts[0].text == "Tuesdays are lab days" and facts[0].source == "user"
    assert calls == [("Tuesdays are lab days", ["fact", "routine"], "global")]


# --- umem bridge ------------------------------------------------------------
def test_umem_bridge_never_raises_when_cli_missing(monkeypatch, tmp_path, caplog):
    monkeypatch.setattr(config, "UMEM_ENABLED", True)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "umem-data")
    monkeypatch.setattr(sys, "executable", str(tmp_path / "no-such-python.exe"))
    umem_bridge.reset_cache()
    with caplog.at_level("WARNING", logger="memory.umem"):
        umem_bridge.init()
        assert umem_bridge.available() is False
        assert umem_bridge.remember("x", ["t"]) is False
        assert umem_bridge.context() == ""
        assert umem_bridge.bootstrap_json() is None
        # force a call through even though init failed
        monkeypatch.setattr(umem_bridge, "_available", True)
        assert umem_bridge.remember("x", ["t"]) is False
        assert umem_bridge.context() == ""
        assert umem_bridge.bootstrap_json() is None
    assert "failed" in caplog.text


def test_umem_disabled_short_circuits(monkeypatch):
    monkeypatch.setattr(config, "UMEM_ENABLED", False)
    monkeypatch.setattr(umem_bridge, "_run", lambda *a, **k: pytest.fail("must not spawn"))
    umem_bridge.init()
    assert umem_bridge.remember("x", []) is False
    assert umem_bridge.context() == ""
    assert umem_bridge.bootstrap_json() is None


def test_redact():
    r = umem_bridge.redact
    assert "sk-" not in r("my key is sk-proj-abcdefghijklmnop123")
    assert r("AKIAABCDEFGHIJKLMNOP") == "[REDACTED]"
    assert "ghp_" not in r("token ghp_abcdefghijklmnopqrstuvwxyz0123")
    assert r("Authorization: Bearer abc.def-ghi") == "Authorization: [REDACTED]"
    assert r("password=hunter2 and api_key: 'xyz'") == "password=[REDACTED] and api_key: [REDACTED]"
    assert r("Prof. Lee likes 2pm meetings") == "Prof. Lee likes 2pm meetings"
