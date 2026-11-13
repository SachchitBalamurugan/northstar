"""GET /jobs, POST /jobs/search."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

import jobs

router = APIRouter()


class JobsSearchRequest(BaseModel):
    focus: str | None = None
    limit: int | None = None


def _body(res: jobs.JobsResponse) -> dict:
    return {"generatedAt": res.generatedAt, "basedOn": res.basedOn,
            "jobs": [j.model_dump(exclude_none=True) for j in res.jobs]}


@router.get("/jobs")
def get_jobs() -> dict:
    return _body(jobs.get())


@router.post("/jobs/search")
def search_jobs(body: JobsSearchRequest | None = None) -> dict:
    return _body(jobs.search(focus=body.focus if body else None, limit=body.limit if body else None))
