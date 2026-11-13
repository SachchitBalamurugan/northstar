"""Jobs: MOCK fixtures, endpoint shapes, persistence, and the real-mode citation-only URL rule."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("MOCK", "1")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config  # noqa: E402
import insights  # noqa: E402
import jobs  # noqa: E402
import llm  # noqa: E402
import storage  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

JOB_KEYS = {"id", "title", "company", "location", "url", "summary", "why", "skills", "matchScore"}


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


def test_get_is_empty_before_first_search(client):
    assert client.get("/jobs").json() == {"generatedAt": None, "basedOn": [], "jobs": []}


def test_search_shape_and_persistence(client):
    body = client.post("/jobs/search", json={"focus": "machine learning", "limit": 3}).json()
    assert set(body) == {"generatedAt", "basedOn", "jobs"}
    assert body["generatedAt"] and len(body["jobs"]) == 3
    for j in body["jobs"]:
        assert JOB_KEYS <= set(j)
        assert j["url"].startswith("https://") and 0 <= j["matchScore"] <= 1
    assert "Machine Learning" in body["jobs"][0]["title"]
    assert client.get("/jobs").json() == body
    assert len(client.post("/jobs/search").json()["jobs"]) == 5


def test_real_mode_only_uses_citation_urls_and_keeps_previous_on_failure(client, monkeypatch):
    monkeypatch.setattr(config, "MOCK", False)
    cites = [{"url": "https://jobs.example.org/a?utm_source=openai", "title": "A"}]
    monkeypatch.setattr(llm, "web_research", lambda *a, **k: ("notes", cites))
    item = dict(title="SWE Intern", company="Acme", location="Remote", summary="s", why="w", memoryRefs=[1],
                skills=["Python"], matchScore=1.4, postedAt=None, deadline="nope", remote=True)
    result = jobs._LLMResult(jobs=[jobs._LLMJob(sourceIndex=1, **item),
                                   jobs._LLMJob(sourceIndex=None, **{**item, "title": "No source"}),
                                   jobs._LLMJob(sourceIndex=9, **{**item, "title": "Bad source"})])
    monkeypatch.setattr(llm, "complete", lambda *a, **k: result)
    body = client.post("/jobs/search", json={}).json()
    assert [j["url"] for j in body["jobs"]] == ["https://jobs.example.org/a"]
    assert body["jobs"][0]["matchScore"] == 1.0 and "deadline" not in body["jobs"][0]

    def boom(*a, **k):
        raise RuntimeError("down")
    monkeypatch.setattr(llm, "web_research", boom)
    assert client.post("/jobs/search", json={}).json() == body
