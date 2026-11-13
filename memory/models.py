"""Pydantic models mirroring contracts/types.ts. Do not drift from the contract."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

Source = Literal["gmail", "calendar", "screen", "form", "user", "insight"]
Agent = Literal["ui", "memory", "inbox", "actions"]
EventKind = Literal["observation", "preference", "deadline", "task", "fact"]
ProposalType = Literal["send_reply", "create_event", "fill_form", "submit_form", "unsubscribe", "task"]
ProposalStatus = Literal["pending", "approved", "rejected", "done", "failed"]


class EventRefs(BaseModel):
    emailId: str | None = None
    eventId: str | None = None
    url: str | None = None


class MemoryEvent(BaseModel):
    id: str | None = None
    ts: str
    agent: Agent
    source: Source
    kind: EventKind
    text: str
    tags: list[str] | None = None
    refs: EventRefs | None = None


class Proposal(BaseModel):
    id: str
    agent: Agent
    createdAt: str
    type: ProposalType
    title: str = Field(max_length=60)
    why: str
    payload: Any = None
    urgency: Literal[1, 2, 3]
    dueAt: str | None = None
    status: ProposalStatus = "pending"


class NextThing(BaseModel):
    title: str
    why: str
    minutes: int
    proposalId: str | None = None
    dueAt: str | None = None


class ContextRequest(BaseModel):
    query: str
    k: int = 8


class KnowledgeFile(BaseModel):
    file: str
    content: str


class ContextResponse(BaseModel):
    snippets: list[MemoryEvent]
    knowledge: list[KnowledgeFile]
    umem: str | None = None


class RememberRequest(BaseModel):
    text: str
    scope: Literal["global", "project"] = "global"
    tags: list[str] = []


class InsightsResponse(BaseModel):
    nextThing: NextThing
    cards: list[Proposal]
    computedAt: str | None = None
    stale: bool = False
