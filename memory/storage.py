"""SQLite + FTS5 store for MemoryEvents, Proposals and meta. Source of truth.

Thread-safe (one connection, one RLock; FastAPI runs sync routes in a pool).
Events of kind preference/fact are mirrored to umem in a background thread.
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import sqlite3
import threading
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import config
import models
import umem_bridge

log = logging.getLogger("memory.storage")

_conn: sqlite3.Connection | None = None
_lock = threading.RLock()

MIRROR_KINDS = {"preference", "fact"}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id     TEXT PRIMARY KEY,
    ts     TEXT NOT NULL,
    agent  TEXT NOT NULL,
    source TEXT NOT NULL,
    kind   TEXT NOT NULL,
    text   TEXT NOT NULL,
    tags   TEXT NOT NULL DEFAULT '[]',
    refs   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    text, tags, content='events', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
    INSERT INTO events_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;

CREATE TABLE IF NOT EXISTS proposals (
    id        TEXT PRIMARY KEY,
    json      TEXT NOT NULL,
    status    TEXT NOT NULL,
    createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


# --- lifecycle --------------------------------------------------------------
def init(seed_fixtures: bool = False) -> None:
    """Create dirs + tables, init umem, optionally seed fixtures into an empty db."""
    global _conn
    with _lock:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        config.KNOWLEDGE_DIR.mkdir(parents=True, exist_ok=True)
        if _conn is not None:
            _conn.close()
        _conn = sqlite3.connect(str(config.DB_PATH), check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
        _conn.executescript(_SCHEMA)
        _conn.commit()
    umem_bridge.init()
    if seed_fixtures:
        _seed_fixtures()


def close() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            _conn.close()
            _conn = None


def reset_for_tests(data_dir: Path | None = None, seed_fixtures: bool = False) -> None:
    """Point config at a fresh data dir (tmp path) and re-init. Tests only."""
    close()
    if data_dir is not None:
        data_dir = Path(data_dir)
        config.DATA_DIR = data_dir
        config.KNOWLEDGE_DIR = data_dir / "knowledge"
        config.DB_PATH = data_dir / "events.db"
    umem_bridge.reset_cache()
    init(seed_fixtures=seed_fixtures)


def _db() -> sqlite3.Connection:
    if _conn is None:
        init()
    assert _conn is not None
    return _conn


# --- helpers ----------------------------------------------------------------
def _row_to_event(row: sqlite3.Row) -> models.MemoryEvent:
    refs = json.loads(row["refs"] or "{}")
    return models.MemoryEvent(
        id=row["id"], ts=row["ts"], agent=row["agent"], source=row["source"],
        kind=row["kind"], text=row["text"], tags=json.loads(row["tags"] or "[]"),
        refs=models.EventRefs(**refs) if refs else None,
    )


def _row_to_proposal(row: sqlite3.Row) -> models.Proposal:
    p = models.Proposal.model_validate_json(row["json"])
    p.status = row["status"]
    return p


def _fts_query(query: str) -> str:
    """Quote every token and OR them so user text can never break FTS5 syntax."""
    tokens = re.findall(r"\w+", query, flags=re.UNICODE)
    return " OR ".join(f'"{t}"' for t in tokens)


# --- events -----------------------------------------------------------------
def add_event(ev: models.MemoryEvent, *, mirror: bool = True) -> models.MemoryEvent:
    if not ev.id:
        ev.id = str(uuid.uuid4())
    tags = ev.tags or []
    refs = ev.refs.model_dump(exclude_none=True) if ev.refs else {}
    with _lock:
        _db().execute(
            "INSERT OR REPLACE INTO events(id, ts, agent, source, kind, text, tags, refs) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (ev.id, ev.ts, ev.agent, ev.source, ev.kind, ev.text,
             json.dumps(tags), json.dumps(refs)),
        )
        _db().commit()
    if mirror and ev.kind in MIRROR_KINDS and umem_bridge.available():
        threading.Thread(
            target=umem_bridge.remember,
            args=(ev.text, [ev.kind, *tags], "global"),
            daemon=True, name="umem-mirror",
        ).start()
    return ev


def search_events(query: str, k: int = 8) -> list[models.MemoryEvent]:
    """FTS5 top-k (bm25), newest first on ties. Falls back to LIKE on FTS errors."""
    tokens = re.findall(r"\w+", query or "")
    if not tokens:
        return []
    with _lock:
        try:
            rows = _db().execute(
                "SELECT e.* FROM events_fts f JOIN events e ON e.rowid = f.rowid "
                "WHERE events_fts MATCH ? ORDER BY f.rank, e.ts DESC LIMIT ?",
                (_fts_query(query), k),
            ).fetchall()
        except sqlite3.Error as exc:
            log.warning("FTS search failed (%s); falling back to LIKE", exc)
            where = " OR ".join("(text LIKE ? OR tags LIKE ?)" for _ in tokens)
            params: list[Any] = []
            for t in tokens:
                params += [f"%{t}%", f"%{t}%"]
            rows = _db().execute(
                f"SELECT * FROM events WHERE {where} ORDER BY ts DESC LIMIT ?",
                (*params, k),
            ).fetchall()
    return [_row_to_event(r) for r in rows]


def list_events(kind: str | None = None, since: str | None = None, limit: int = 200) -> list[models.MemoryEvent]:
    sql = "SELECT * FROM events"
    clauses, params = [], []
    if kind:
        clauses.append("kind = ?")
        params.append(kind)
    if since:
        clauses.append("ts > ?")
        params.append(since)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY ts DESC LIMIT ?"
    params.append(limit)
    with _lock:
        rows = _db().execute(sql, params).fetchall()
    return [_row_to_event(r) for r in rows]


def events_since(ts: str | None) -> list[models.MemoryEvent]:
    """All events with ts > given ISO string (all events when None), oldest first."""
    sql = "SELECT * FROM events"
    params: list[Any] = []
    if ts:
        sql += " WHERE ts > ?"
        params.append(ts)
    sql += " ORDER BY ts ASC"
    with _lock:
        rows = _db().execute(sql, params).fetchall()
    return [_row_to_event(r) for r in rows]


def count_events() -> int:
    with _lock:
        return int(_db().execute("SELECT COUNT(*) FROM events").fetchone()[0])


# --- meta -------------------------------------------------------------------
def get_meta(key: str) -> str | None:
    with _lock:
        row = _db().execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(key: str, value: str) -> None:
    with _lock:
        _db().execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, value))
        _db().commit()


# --- proposals --------------------------------------------------------------
def add_proposal(p: models.Proposal) -> models.Proposal:
    if not p.id:
        p.id = str(uuid.uuid4())
    with _lock:
        _db().execute(
            "INSERT OR REPLACE INTO proposals(id, json, status, createdAt) VALUES (?, ?, ?, ?)",
            (p.id, p.model_dump_json(), p.status, p.createdAt),
        )
        _db().commit()
    return p


def list_proposals(status: str | None = None) -> list[models.Proposal]:
    sql = "SELECT * FROM proposals"
    params: list[Any] = []
    if status:
        sql += " WHERE status = ?"
        params.append(status)
    sql += " ORDER BY createdAt DESC"
    with _lock:
        rows = _db().execute(sql, params).fetchall()
    return [_row_to_proposal(r) for r in rows]


def get_proposal(id: str) -> models.Proposal | None:
    with _lock:
        row = _db().execute("SELECT * FROM proposals WHERE id = ?", (id,)).fetchone()
    return _row_to_proposal(row) if row else None


def set_proposal_status(id: str, status: str) -> models.Proposal | None:
    p = get_proposal(id)
    if p is None:
        return None
    p.status = status  # type: ignore[assignment]
    with _lock:
        _db().execute(
            "UPDATE proposals SET status = ?, json = ? WHERE id = ?",
            (status, p.model_dump_json(), id),
        )
        _db().commit()
    return p


def replace_pending_proposals(agent: str, proposals: list[models.Proposal]) -> None:
    """Drop this agent's pending proposals and insert the new batch (insight engine refresh)."""
    with _lock:
        db = _db()
        rows = db.execute("SELECT id, json FROM proposals WHERE status = 'pending'").fetchall()
        stale = [r["id"] for r in rows if json.loads(r["json"]).get("agent") == agent]
        if stale:
            db.executemany("DELETE FROM proposals WHERE id = ?", [(i,) for i in stale])
        for p in proposals:
            if not p.id:
                p.id = str(uuid.uuid4())
            db.execute(
                "INSERT OR REPLACE INTO proposals(id, json, status, createdAt) VALUES (?, ?, ?, ?)",
                (p.id, p.model_dump_json(), p.status, p.createdAt),
            )
        db.commit()


# --- fixtures ---------------------------------------------------------------
_ISO_DT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$")
_ISO_D = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _shift_iso(value: str, delta: timedelta) -> str:
    if _ISO_DT.match(value):
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        out = (dt + delta).isoformat()
        return out.replace("+00:00", "Z") if value.endswith("Z") else out
    if _ISO_D.match(value):
        return (date.fromisoformat(value) + delta).isoformat()
    return value


def shift_timestamps(obj: Any, delta: timedelta) -> Any:
    """Recursively shift every ISO-8601 date/datetime string in a JSON structure."""
    if isinstance(obj, str):
        return _shift_iso(obj, delta)
    if isinstance(obj, list):
        return [shift_timestamps(x, delta) for x in obj]
    if isinstance(obj, dict):
        return {k: shift_timestamps(v, delta) for k, v in obj.items()}
    return obj


def _seed_fixtures() -> None:
    """Load fixtures/events.json (time-shifted to today) + copy fixtures/knowledge/*.md."""
    events_path = config.FIXTURES_DIR / "events.json"
    if count_events() > 0:
        log.info("events table not empty; skipping fixture events")
    elif not events_path.exists():
        log.info("no fixture events at %s; skipping", events_path)
    else:
        try:
            raw = json.loads(events_path.read_text(encoding="utf-8"))
            anchor = raw.get("anchor")
            items = raw.get("items", raw if isinstance(raw, list) else [])
            delta = timedelta(0)
            if anchor:
                anchor_day = datetime.fromisoformat(str(anchor).replace("Z", "+00:00")).date()
                delta = timedelta(days=(date.today() - anchor_day).days)
            n = 0
            for item in shift_timestamps(items, delta):
                try:
                    add_event(models.MemoryEvent.model_validate(item), mirror=False)
                    n += 1
                except Exception as exc:
                    log.warning("skipping bad fixture event: %s", exc)
            log.info("seeded %d fixture events (shifted by %s days)", n, delta.days)
        except Exception as exc:
            log.warning("could not load fixture events: %s", exc)

    kdir = config.FIXTURES_DIR / "knowledge"
    if not kdir.is_dir():
        log.info("no fixture knowledge dir at %s; skipping", kdir)
        return
    config.KNOWLEDGE_DIR.mkdir(parents=True, exist_ok=True)
    copied = 0
    for src in sorted(kdir.glob("*.md")):
        dst = config.KNOWLEDGE_DIR / src.name
        if not dst.exists():
            shutil.copyfile(src, dst)
            copied += 1
    log.info("copied %d fixture knowledge files", copied)
