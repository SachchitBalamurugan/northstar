"""GET /briefing, GET /resume (+ done/snooze) and POST /refine. Logic lives in briefing.py."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

import briefing

router = APIRouter()


@router.get("/briefing", response_model=briefing.Briefing, response_model_exclude_none=True)
def get_briefing(estimates: bool = True) -> briefing.Briefing:
    """`?estimates=0` drops every `minutes` field (estimating durations is taxing for some students)."""
    return briefing.get_briefing(estimates=estimates)


@router.get("/resume", response_model=briefing.ResumeResponse)
def get_resume() -> briefing.ResumeResponse:
    return briefing.get_resume()


@router.post("/resume/{item_id}/done")
def resume_done(item_id: str) -> dict:
    if not briefing.mark_resume(item_id, "done"):
        raise HTTPException(status_code=404, detail=f"unknown resume item {item_id!r}")
    return {"ok": True}


@router.post("/resume/{item_id}/snooze")
def resume_snooze(item_id: str) -> dict:
    if not briefing.mark_resume(item_id, "snooze"):
        raise HTTPException(status_code=404, detail=f"unknown resume item {item_id!r}")
    return {"ok": True}


@router.post("/refine", response_model=briefing.RefineResponse, response_model_exclude_none=True)
def post_refine(body: briefing.RefineRequest) -> briefing.RefineResponse:
    return briefing.refine(body)
