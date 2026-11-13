"""Discover: MOCK fixtures over the real store, save/dismiss events, and the real-mode URL/fallback rules."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("MOCK", "1")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config  # noqa: E402
import discover  # noqa: E402
import insights  # noqa: E402
import llm  # noqa: E402
import storage  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

CATEGORIES = {"opportunity", "resource", "event", "reading", "idea"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "MOCK", True)
    monkeypatch.setattr(config, "UMEM_ENABLED", False)
    storage.reset_for_tests(tmp_path / "data")
    insights._cache = insights._cache_at = None
    import main

    with TestClient(main.app) as c:  # lifespan seeds the fixture knowledge + events
        yield c
    storage.close()
    insights._cache = insights._cache_at = None


def test_mock_get_runs_lazily_and_has_the_contract_shape(client):
    assert storage.get_meta(discover.META_KEY) is None
    body = client.get("/discover").json()
    assert set(body) == {"generatedAt", "basedOn", "items"}
    assert body["generatedAt"]
    assert 1 <= len(body["items"]) <= 5 and 1 <= len(body["basedOn"]) <= 5
    assert any(b.startswith("goals.md: ") and "internship" in b for b in body["basedOn"])
    for it in body["items"]:
        assert it["id"] and len(it["title"]) <= 60 and it["summary"] and it["nextStep"]
        assert it["category"] in CATEGORIES and 0 <= it["confidence"] <= 1
        assert ".md says" in it["why"]                       # always shows why, citing memory
        assert "saved" not in it
    assert client.get("/discover").json() == body            # stored, not regenerated
    again = client.post("/discover/run", json={}).json()     # deterministic
    assert [i["id"] for i in again["items"]] == [i["id"] for i in body["items"]]


def test_mock_is_personalised_by_the_knowledge_folder(client):
    client.put("/knowledge/goals.md", json={"content": "# Goals\n\n- Ace CS70 this semester.\n"})
    body = client.post("/discover/run").json()
    ids = [i["id"] for i in body["items"]]
    assert "disc-swe-intern-roles" not in ids and "disc-cs61b-tutoring" in ids   # no internship goal -> not shown
    assert not any("internship" in b and b.startswith("goals.md") for b in body["basedOn"])


def test_focus_reorders(client):
    body = client.post("/discover/run", json={"focus": "tutoring"}).json()
    assert body["items"][0]["id"] == "disc-cs61b-tutoring"


def test_save_and_dismiss(client):
    items = client.get("/discover").json()["items"]
    keep, drop = items[0], items[1]

    assert client.post(f"/discover/{keep['id']}/save").json() == {"ok": True}
    assert client.post(f"/discover/{keep['id']}/save").json() == {"ok": True}   # idempotent
    saved = [e for e in storage.list_events(kind="task") if f"discover:{keep['id']}" in (e.tags or [])]
    assert len(saved) == 1 and saved[0].source == "insight" and keep["title"] in saved[0].text

    assert client.post(f"/discover/{drop['id']}/dismiss").json() == {"ok": True}
    prefs = [e for e in storage.list_events(kind="preference") if "dismissed" in (e.tags or [])]
    assert len(prefs) == 1 and drop["title"] in prefs[0].text and prefs[0].source == "insight"

    after = client.get("/discover").json()
    assert drop["id"] not in [i["id"] for i in after["items"]]
    assert next(i for i in after["items"] if i["id"] == keep["id"])["saved"] is True
    rerun = client.post("/discover/run").json()               # dismissed stays hidden, saved stays saved
    assert drop["id"] not in [i["id"] for i in rerun["items"]]
    assert next(i for i in rerun["items"] if i["id"] == keep["id"])["saved"] is True
    assert discover._dismissed_titles() == [drop["title"]]

    assert client.post("/discover/nope/save").status_code == 404
    assert client.post("/discover/nope/dismiss").status_code == 404
    assert client.post(f"/discover/{drop['id']}/save").status_code == 404


# ----------------------------------------------------------------------------- real mode (LLM faked)
def _llm_result(**over):
    base = dict(title="Nimbus-style SWE internship list", summary="A list of open roles.",
                why="goals.md says you want a summer 2027 internship.", category="opportunity", memoryRef=1,
                sourceIndex=1, deadline="2026-12-01", nextStep="Open the list.", confidence=1.4)
    return discover._LLMItem(**{**base, **over})


def test_real_mode_empty_get_does_not_call_the_model(client, monkeypatch):
    monkeypatch.setattr(config, "MOCK", False)
    monkeypatch.setattr(llm, "web_research", lambda *a, **k: pytest.fail("GET must not call the model"))
    assert client.get("/discover").json() == {"generatedAt": None, "basedOn": [], "items": []}


def test_real_mode_urls_only_from_citations(client, monkeypatch):
    monkeypatch.setattr(config, "MOCK", False)
    monkeypatch.setattr(llm, "web_research", lambda tier, system, input: (
        "notes", [{"url": "https://example.org/roles", "title": "Example roles"}]))
    monkeypatch.setattr(llm, "complete", lambda tier, system, input, schema=None: discover._LLMResult(items=[
        _llm_result(),
        _llm_result(title="Lead with a made-up source", sourceIndex=7),
        _llm_result(title="Ungrounded item", memoryRef=999),
    ]))
    body = client.post("/discover/run", json={"focus": "internships"}).json()
    first, second = body["items"]                              # the ungrounded one is dropped
    assert first["url"] == "https://example.org/roles" and first["sourceLabel"] == "Example roles"
    assert first["deadline"] == "2026-12-01" and first["confidence"] == 1.0
    assert "url" not in second and "deadline" not in second and "sourceLabel" not in second
    assert len(body["basedOn"]) == 1 and body["basedOn"][0].startswith("goals.md: ")


def test_real_mode_falls_back_to_leads_without_urls(client, monkeypatch):
    monkeypatch.setattr(config, "MOCK", False)

    def boom(*a, **k):
        raise RuntimeError("web search tool not available")

    seen = {}

    def fake_complete(tier, system, input, schema=None):
        seen["system"] = system
        return discover._LLMResult(items=[_llm_result()])

    monkeypatch.setattr(llm, "web_research", boom)
    monkeypatch.setattr(llm, "complete", fake_complete)
    body = client.post("/discover/run").json()
    assert "no web access" in seen["system"]
    assert len(body["items"]) == 1 and "url" not in body["items"][0] and "deadline" not in body["items"][0]


def test_real_mode_failure_keeps_previous_result(client, monkeypatch):
    before = client.get("/discover").json()                    # MOCK result is stored
    monkeypatch.setattr(config, "MOCK", False)
    monkeypatch.setattr(config, "OPENAI_API_KEY", "")          # llm raises LLMUnavailable
    assert client.post("/discover/run").json() == before
