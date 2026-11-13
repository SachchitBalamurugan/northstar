"""POST /research/brief {topic} -> {text, citations}: a short, current, cited brief via OpenAI web search.

Used by the inbox service's /compose (e.g. "email X about the latest news in tech"). MOCK=1 returns a canned
brief so demos and tests never hit the network.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import config
import llm

log = logging.getLogger(__name__)
router = APIRouter()

_SYSTEM = (
    "You are a research assistant. Search the web for the most recent, reliable information on the topic "
    "and write a short brief: 4-6 bullet points, each one concrete sentence with a date or number when possible, "
    "plain language, no hype. Only include things you found in sources."
)


class BriefRequest(BaseModel):
    topic: str


@router.post("/research/brief")
def research_brief(req: BriefRequest) -> dict:
    topic = req.topic.strip()
    if not topic:
        raise HTTPException(400, "topic required")
    if config.MOCK:
        return {"text": f"- (demo) Three notable developments related to {topic} this week.\n"
                        "- (demo) Set MOCK=0 with an OpenAI key for real, cited research.",
                "citations": [], "mock": True}
    try:
        text, citations = llm.web_research("smart", _SYSTEM, f"Topic: {topic}")
    except Exception as exc:  # network / key / quota
        log.warning("research brief failed: %s", exc)
        raise HTTPException(502, f"web research failed: {exc}") from exc
    return {"text": text, "citations": citations[:8], "mock": False}
