"""Storage endpoints: /events, /context, /knowledge, /remember, /proposals."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

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


def _trim_context(resp: models.ContextResponse, budget: int = CONTEXT_CHAR_BUDGET) -> models.ContextResponse:
    """Keep the payload near ~2k tokens: drop snippets first, then cut umem, then knowledge."""
    def size() -> int:
        return (sum(len(s.text) for s in resp.snippets)
                + sum(len(k.content) for k in resp.knowledge)
                + len(resp.umem or ""))

    while size() > budget and resp.snippets:
        resp.snippets.pop()
    if size() > budget and resp.umem:
        room = max(0, budget - (size() - len(resp.umem)))
        resp.umem = resp.umem[:room] or None
    for kf in reversed(resp.knowledge):
        if size() <= budget:
            break
        room = max(0, budget - (size() - len(kf.content)))
        kf.content = kf.content[:room]
    return resp


@router.post("/context", response_model=models.ContextResponse)
def post_context(req: models.ContextRequest) -> models.ContextResponse:
    resp = models.ContextResponse(
        snippets=storage.search_events(req.query, k=req.k),
        knowledge=knowledge.relevant(req.query),
        umem=umem_bridge.context() or None,
    )
    return _trim_context(resp)


# --- knowledge --------------------------------------------------------------
class KnowledgeWrite(BaseModel):
    content: str


@router.get("/knowledge", response_model=list[models.KnowledgeFile])
def get_knowledge() -> list[models.KnowledgeFile]:
    return knowledge.list_files()


@router.get("/knowledge/{file}", response_model=models.KnowledgeFile)
def get_knowledge_file(file: str) -> models.KnowledgeFile:
    try:
        return models.KnowledgeFile(file=file, content=knowledge.read(file))
    except ValueError:
        raise HTTPException(404, f"unknown knowledge file {file!r}")


@router.put("/knowledge/{file}", response_model=models.KnowledgeFile)
def put_knowledge_file(file: str, body: KnowledgeWrite) -> models.KnowledgeFile:
    try:
        return knowledge.write(file, body.content)
    except ValueError:
        raise HTTPException(404, f"unknown knowledge file {file!r}")


# --- remember ---------------------------------------------------------------
@router.post("/remember")
def post_remember(req: models.RememberRequest) -> dict:
    ev = models.MemoryEvent(
        ts=_now(), agent="ui", source="user", kind="fact", text=req.text, tags=req.tags or [],
    )
    storage.add_event(ev, mirror=False)
    mirrored = umem_bridge.remember(req.text, ["fact", *(req.tags or [])], scope=req.scope)
    return {"ok": True, "event": ev, "umem": mirrored}


# --- proposals --------------------------------------------------------------
@router.get("/proposals", response_model=list[models.Proposal])
def get_proposals(status: str | None = None) -> list[models.Proposal]:
    return storage.list_proposals(status=status)


def _decide(id: str, status: str, verb: str) -> models.Proposal:
    p = storage.set_proposal_status(id, status)
    if p is None:
        raise HTTPException(404, f"unknown proposal {id!r}")
    if p.type == "task":
        storage.add_event(models.MemoryEvent(
            ts=_now(), agent="memory", source="insight", kind="preference",
            text=f"user {verb}: {p.title}", tags=["insight", verb],
        ))
    return p


@router.post("/proposals/{id}/approve", response_model=models.Proposal)
def approve_proposal(id: str) -> models.Proposal:
    return _decide(id, "approved", "accepted")


@router.post("/proposals/{id}/reject", response_model=models.Proposal)
def reject_proposal(id: str) -> models.Proposal:
    return _decide(id, "rejected", "declined")
