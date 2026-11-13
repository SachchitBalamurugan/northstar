"""GET /discover, POST /discover/run, POST /discover/{id}/save, POST /discover/{id}/dismiss."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import discover
import research

router = APIRouter()


class DiscoverRunRequest(BaseModel):
    focus: str | None = None


def _body(res: discover.DiscoverResponse) -> dict:
    """generatedAt stays in the body even when null; optional item fields are omitted when unset."""
    return {"generatedAt": res.generatedAt, "basedOn": res.basedOn,
            "items": [i.model_dump(exclude_none=True) for i in res.items]}


@router.get("/discover")
def get_discover() -> dict:
    return _body(discover.get())


@router.post("/discover/run")
def run_discover(body: DiscoverRunRequest | None = None) -> dict:
    return _body(discover.run(focus=body.focus if body else None))


class ResearchRequest(BaseModel):
    query: str
    when: str = "any"
    where: str = "any"


@router.post("/discover/research")
def research_run(body: ResearchRequest) -> StreamingResponse:
    """Live research for the Discover search box: an SSE stream of DiscoverEvent (see research.py)."""
    if not body.query.strip():
        raise HTTPException(status_code=422, detail="query is required")
    if not research.available():
        raise HTTPException(status_code=503, detail="research needs real mode (MOCK=0) and an OpenAI key")
    return StreamingResponse(research.stream(body.query.strip()[:300], body.when, body.where),
                             media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.post("/discover/{item_id}/save")
def save_item(item_id: str) -> dict:
    if not discover.save(item_id):
        raise HTTPException(status_code=404, detail="unknown discover item")
    return {"ok": True}


@router.post("/discover/{item_id}/dismiss")
def dismiss_item(item_id: str) -> dict:
    if not discover.dismiss(item_id):
        raise HTTPException(status_code=404, detail="unknown discover item")
    return {"ok": True}
