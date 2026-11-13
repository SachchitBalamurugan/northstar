"""Storage endpoints: /events, /context, /knowledge, /remember, /proposals."""
from __future__ import annotations

import logging
import re
import threading
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import config
import insights
import knowledge
import models
import storage
import umem_bridge

log = logging.getLogger("memory.routes")
router = APIRouter()

CONTEXT_CHAR_BUDGET = 8000  # ~2k tokens


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# --- events / context -------------------------------------------------------
@router.post("/events", response_model=models.MemoryEvent)
def post_event(ev: models.MemoryEvent) -> models.MemoryEvent:
    return storage.add_event(ev)


@router.get("/events", response_model=list[models.MemoryEvent])
def get_events(kind: str | None = None, since: str | None = None, limit: int = 200) -> list[models.MemoryEvent]:
    return storage.list_events(kind=kind, since=since, limit=limit)


def _trim_context(snippets: list[str], know: list[str], budget: int = CONTEXT_CHAR_BUDGET) -> tuple[list[str], list[str]]:
    """Keep the payload near ~2k tokens: drop the weakest snippets first, then cut knowledge from the end."""
    def size() -> int:
        return sum(map(len, snippets)) + sum(map(len, know))

    while size() > budget and len(snippets) > 1:
        snippets.pop()
    for i in range(len(know) - 1, -1, -1):
        if size() <= budget:
            break
        room = max(0, budget - (size() - len(know[i])))
        know[i] = know[i][:room]
    if size() > budget and snippets:
        snippets[0] = snippets[0][: max(0, budget - sum(map(len, know)))]
    return [s for s in snippets if s], [k for k in know if k]


@router.post("/context")
def post_context(req: models.ContextRequest) -> dict:
    """Contract shape: {snippets: string[], knowledge: string[]} (knowledge items are "<file>: <excerpt>")."""
    snippets = [e.text for e in storage.search_events(req.query, k=max(1, min(req.k, 50)))]
    know = [knowledge.excerpt(kf, req.query) for kf in knowledge.relevant(req.query)]
    umem = umem_bridge.context()
    if umem:
        know.append(f"umem: {umem[:1500]}")
    snippets, know = _trim_context(snippets, know)
    return {"snippets": snippets, "knowledge": know}


# --- knowledge --------------------------------------------------------------
class KnowledgeWrite(BaseModel):
    content: str


def _check_name(file: str) -> None:
    if not knowledge.valid_name(file):
        raise HTTPException(400, "invalid knowledge file name; only *.md basenames are allowed")


@router.get("/knowledge")
def get_knowledge() -> list[dict]:
    """[{name, updatedAt}] (KnowledgeFile[] in contracts/types.ts)."""
    out = []
    for name in knowledge.names():
        item = {"name": name}
        ts = knowledge.updated_at(name)
        if ts:
            item["updatedAt"] = ts
        out.append(item)
    return out


# `{file:path}` so that encoded slashes / traversal attempts reach the 400 check instead of a routing 404.
@router.get("/knowledge/{file:path}")
def get_knowledge_file(file: str) -> dict:
    _check_name(file)
    if not knowledge.exists(file) and file not in config.KNOWLEDGE_FILES:
        raise HTTPException(404, f"unknown knowledge file {file!r}")
    out = {"name": file, "content": knowledge.read(file)}
    ts = knowledge.updated_at(file)
    if ts:
        out["updatedAt"] = ts
    return out


@router.put("/knowledge/{file:path}")
def put_knowledge_file(file: str, body: KnowledgeWrite) -> dict:
    _check_name(file)
    knowledge.write(file, body.content)
    return {"ok": True, "name": file}


# --- remember ---------------------------------------------------------------
_PREFERENCE_RE = re.compile(r"\b(prefer|prefers|like|likes|love|hate|always|never|don'?t|rather|best)\b", re.I)


@router.post("/remember")
def post_remember(req: models.RememberRequest) -> dict:
    tags = req.tags or []
    kind = "preference" if "preference" in tags or _PREFERENCE_RE.search(req.text) else "fact"
    ev = storage.add_event(models.MemoryEvent(
        ts=_now(), agent="ui", source="user", kind=kind, text=req.text, tags=tags,
    ), mirror=False)
    # umem is a subprocess (about a second): mirror in the background so the UI never waits on it.
    if umem_bridge.available():
        threading.Thread(target=umem_bridge.remember, args=(ev.text, [kind, *tags], req.scope),
                         daemon=True, name="umem-remember").start()
    return {"ok": True, "id": ev.id}


# --- proposals --------------------------------------------------------------
@router.get("/proposals", response_model=list[models.Proposal], response_model_exclude_none=True)
def get_proposals(status: str | None = None) -> list[models.Proposal]:
    return storage.list_proposals(status=status)


def _decide(id: str, status: str, verb: str) -> models.Proposal:
    cur = storage.get_proposal(id)
    if cur is None:
        raise HTTPException(404, f"unknown proposal {id!r}")
    if cur.status != "pending":  # already decided: idempotent, no second preference event
        return cur
    p = storage.set_proposal_status(id, status)
    assert p is not None
    if p.type == "task":
        storage.add_event(models.MemoryEvent(
            ts=_now(), agent="memory", source="insight", kind="preference",
            text=f"user {verb}: {p.title}", tags=["insight", verb],
        ))
    insights.drop_card(id)  # the decided card leaves the cached /insights right away
    return p


@router.post("/proposals/{id}/approve", response_model=models.Proposal, response_model_exclude_none=True)
def approve_proposal(id: str) -> models.Proposal:
    return _decide(id, "approved", "accepted")


@router.post("/proposals/{id}/reject", response_model=models.Proposal, response_model_exclude_none=True)
def reject_proposal(id: str) -> models.Proposal:
    return _decide(id, "rejected", "declined")
