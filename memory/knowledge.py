"""Markdown Knowledge folder (Sentient-style): 7 fixed files the user can read and edit."""
from __future__ import annotations

import logging
import re
from pathlib import Path

import config
import models

log = logging.getLogger("memory.knowledge")

_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "my", "me",
    "i", "you", "it", "this", "that", "with", "at", "by", "from", "what", "who", "how",
    "when", "where", "do", "does", "about", "be", "as", "was", "were", "has", "have",
}


def _path(file: str) -> Path:
    if file not in config.KNOWLEDGE_FILES:
        raise ValueError(f"unknown knowledge file {file!r}; allowed: {config.KNOWLEDGE_FILES}")
    return config.KNOWLEDGE_DIR / file


def read(file: str) -> str:
    """Content of one allowed file ('' when it does not exist yet). ValueError on bad names."""
    p = _path(file)
    return p.read_text(encoding="utf-8") if p.exists() else ""


def write(file: str, content: str) -> models.KnowledgeFile:
    p = _path(file)
    lines = content.count("\n") + (0 if content.endswith("\n") or not content else 1)
    if lines > config.KNOWLEDGE_MAX_LINES:
        log.warning("%s is %d lines (max %d); keeping it but it should be trimmed",
                    file, lines, config.KNOWLEDGE_MAX_LINES)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return models.KnowledgeFile(file=file, content=content)


def list_files() -> list[models.KnowledgeFile]:
    return [models.KnowledgeFile(file=f, content=read(f)) for f in config.KNOWLEDGE_FILES]


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
