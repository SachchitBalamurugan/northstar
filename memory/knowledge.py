"""Markdown Knowledge folder (Sentient-style): 7 fixed files the user can read and edit."""
from __future__ import annotations

import logging
import re
from datetime import datetime
from pathlib import Path

import config
import models

log = logging.getLogger("memory.knowledge")

_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "my", "me",
    "i", "you", "it", "this", "that", "with", "at", "by", "from", "what", "who", "how",
    "when", "where", "do", "does", "about", "be", "as", "was", "were", "has", "have",
}


_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-]*\.md$")


def valid_name(file: str) -> bool:
    """Only plain `*.md` basenames: no slashes, no dots-dots, no hidden files."""
    return bool(_NAME_RE.match(file or ""))


def _path(file: str) -> Path:
    if not valid_name(file):
        raise ValueError(f"invalid knowledge file name {file!r}; only *.md basenames are allowed")
    return config.KNOWLEDGE_DIR / file


def exists(file: str) -> bool:
    return _path(file).is_file()


def updated_at(file: str) -> str | None:
    """ISO mtime of a file, None when it does not exist yet."""
    p = _path(file)
    if not p.is_file():
        return None
    return datetime.fromtimestamp(p.stat().st_mtime).astimezone().isoformat(timespec="seconds")


def names() -> list[str]:
    """The 7 standard files first, then any extra *.md the user added."""
    extra = sorted(p.name for p in config.KNOWLEDGE_DIR.glob("*.md")
                   if p.name not in config.KNOWLEDGE_FILES and valid_name(p.name))
    return [*config.KNOWLEDGE_FILES, *extra]


def read(file: str) -> str:
    """Content of one allowed file ('' when it does not exist yet). ValueError on bad names."""
    p = _path(file)
    return p.read_text(encoding="utf-8") if p.exists() else ""


def write(file: str, content: str) -> models.KnowledgeFile:
    p = _path(file)
    import umem_bridge

    content = umem_bridge.redact(content)  # never store secrets
    lines = content.count("\n") + (0 if content.endswith("\n") or not content else 1)
    if lines > config.KNOWLEDGE_MAX_LINES:
        log.warning("%s is %d lines (max %d); keeping it but it should be trimmed",
                    file, lines, config.KNOWLEDGE_MAX_LINES)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return models.KnowledgeFile(file=file, content=content)


def list_files() -> list[models.KnowledgeFile]:
    return [models.KnowledgeFile(file=f, content=read(f)) for f in names()]


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]{2,}", text.lower()) if t not in _STOPWORDS]


def relevant(query: str, n: int = 3) -> list[models.KnowledgeFile]:
    """Top-n files by keyword overlap with the query. README.md if nothing matches."""
    q = set(_tokens(query))
    scored: list[tuple[float, models.KnowledgeFile]] = []
    for kf in list_files():
        if not kf.content.strip() or not q:
            continue
        body = kf.content.lower()
        name = kf.file.lower()
        score = 0.0
        for tok in q:
            hits = body.count(tok)
            if hits:
                score += 1.0 + min(hits, 5) * 0.1  # presence matters most, repeats a little
            if tok in name:
                score += 0.5
        if score > 0:
            scored.append((score, kf))
    scored.sort(key=lambda s: (-s[0], s[1].file))
    out = [kf for _, kf in scored[:n]]
    if not out:
        out = [models.KnowledgeFile(file="README.md", content=read("README.md"))]
    return out


def excerpt(kf: models.KnowledgeFile, query: str, max_chars: int = 1500) -> str:
    """'<file>: <content excerpt>' for /context: lines that match the query first, then the rest."""
    q = set(_tokens(query))
    lines = [l.strip() for l in kf.content.splitlines() if l.strip()]
    hits = [l for l in lines if q & set(_tokens(l))]
    rest = [l for l in lines if l not in hits]
    return f"{kf.file}: " + "\n".join(hits + rest)[:max_chars]
