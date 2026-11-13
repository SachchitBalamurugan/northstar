"""Northstar Memory service (Machine 2) — entrypoint. Port 7701.

Run:  uv run uvicorn main:app --port 7701 --reload
Owner map:
  storage.py, knowledge.py, umem_bridge.py, routes_storage.py  -> umem/Storage sub-agent
  llm.py, insights.py, routes_insights.py, fixtures/           -> Insight & Digest sub-agent
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import config
import insights
import storage
from routes_briefing import router as briefing_router
from routes_discover import router as discover_router
from routes_insights import router as insights_router
from routes_research import router as research_router
from routes_storage import router as storage_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.init(seed_fixtures=config.MOCK)   # db + knowledge dir + umem init (+ fixtures in MOCK)
    insights.start(app)                        # scheduler + warm the insights cache
    try:
        yield
    finally:
        insights.stop()


app = FastAPI(title="Northstar Memory", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    # Any localhost origin, plus file:// pages: the packaged Electron renderer loads from file:// and sends
    # "Origin: null" (same rule as inbox/src/app.ts).
    allow_origin_regex=r"^(null|file://.*|https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?)$",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "memory"}


app.include_router(storage_router)
app.include_router(insights_router)
app.include_router(discover_router)
app.include_router(briefing_router)
app.include_router(research_router)
