"""End-to-end smoke test of main:app (lifespan, MOCK=1 fixtures, temp data dir, no umem, no LLM)."""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

os.environ.setdefault("MOCK", "1")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config  # noqa: E402
import insights  # noqa: E402
import storage  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "MOCK", True)
    monkeypatch.setattr(config, "UMEM_ENABLED", False)
    storage.reset_for_tests(tmp_path / "data")
    insights._cache = insights._cache_at = None
    import main

    with TestClient(main.app) as c:  # runs the lifespan: seeds fixtures, starts the scheduler
        yield c
    storage.close()
    insights._cache = insights._cache_at = None


def test_full_flow(client):
    assert client.get("/health").json() == {"ok": True, "service": "memory"}
    assert [k["name"] for k in client.get("/knowledge").json()] == config.KNOWLEDGE_FILES

    first = client.post("/digest/run").json()
    assert first["nextThing"]["title"] and first["nextThing"]["why"].endswith(".") and first["nextThing"]["minutes"] > 0
    assert 1 <= len(first["cards"]) <= 5
    assert all(c["agent"] == "memory" and c["type"] == "task" and c["status"] == "pending" and len(c["title"]) <= 60
               for c in first["cards"])

    t0 = time.perf_counter()
    cached = client.get("/insights").json()
    assert time.perf_counter() - t0 < 0.2
    assert cached["nextThing"] == first["nextThing"]

    # editing goals.md changes the next insight after a digest (deterministic path)
    r = client.put("/knowledge/goals.md", json={"content": "# Goals\n\n- Ace CS70 this semester.\n"})
    assert r.json() == {"ok": True, "name": "goals.md"}
    second = client.post("/digest/run").json()
    assert second["nextThing"]["title"] != first["nextThing"]["title"]
    assert "CS70" in second["nextThing"]["title"] and "Ace CS70" in second["nextThing"]["why"]

    # Prof. Lee's role comes back from people.md
    ctx = client.post("/context", json={"query": "Prof. Lee"}).json()
    lee = next(k for k in ctx["knowledge"] if k.startswith("people.md: "))
    assert "advisor" in lee
    assert all(isinstance(s, str) for s in ctx["snippets"])

    # /events then /context finds it
    ev = client.post("/events", json={"ts": "2026-11-13T09:00:00-08:00", "agent": "inbox", "source": "gmail",
                                      "kind": "observation", "text": "Zorblat hackathon signup closes soon"}).json()
    assert ev["id"]
    assert "Zorblat hackathon signup closes soon" in client.post("/context", json={"query": "zorblat hackathon?"}).json()["snippets"]

    # proposals: pending list, approve writes a preference and leaves the queue, reject works
    pending = client.get("/proposals", params={"status": "pending"}).json()
    assert {p["id"] for p in pending} == {c["id"] for c in second["cards"]}
    done = client.post(f"/proposals/{pending[0]['id']}/approve", json={}).json()
    assert done["status"] == "approved"
    prefs = client.get("/events", params={"kind": "preference"}).json()
    assert any(pending[0]["title"] in p["text"] for p in prefs)
    assert client.post(f"/proposals/{pending[1]['id']}/reject", json={}).json()["status"] == "rejected"
    left = {p["id"] for p in client.get("/proposals", params={"status": "pending"}).json()}
    assert pending[0]["id"] not in left and pending[1]["id"] not in left
    assert pending[0]["id"] not in {c["id"] for c in client.get("/insights").json()["cards"]}
    assert client.post("/proposals/nope/approve", json={}).status_code == 404

    # CORS for the Electron renderer / Vite dev server
    r = client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"
    # the packaged Electron renderer loads from file:// and sends "Origin: null"
    for origin in ("null", "file://", "http://127.0.0.1:5199"):
        r = client.get("/health", headers={"Origin": origin})
        assert r.headers.get("access-control-allow-origin") == origin, origin
    r = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in r.headers

    # a rejected/approved card does not come back as pending after the next digest
    third = client.post("/digest/run").json()
    assert not ({pending[0]["id"], pending[1]["id"]} & {c["id"] for c in third["cards"]})
    assert client.get(f"/proposals").json()  # decided ones are still on record
    assert {p["status"] for p in client.get("/proposals").json()} >= {"approved", "rejected"}
