"""GET /insights and POST /digest/run (Insight & Digest sub-agent)."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

import insights
import models

router = APIRouter()


class DigestRequest(BaseModel):
    full: bool = False


@router.get("/insights", response_model=models.InsightsResponse)
def get_insights() -> models.InsightsResponse:
    return insights.get_insights()


@router.post("/digest/run", response_model=models.InsightsResponse)
def run_digest(body: DigestRequest | None = None) -> models.InsightsResponse:
    return insights.run_digest(full=bool(body and body.full))
