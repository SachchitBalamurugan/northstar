"""Write-through mirror onto the `umem` CLI (universal-memory).

SQLite is the source of truth. Every umem failure here is logged and swallowed;
nothing in this module raises. All calls shell out to
`python -m universal_memory ...` with the Windows fcntl shim on PYTHONPATH and
UMEM_OFFLINE=1 (skips its npx installer), cwd = config.DATA_DIR.
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from typing import Any

import config

log = logging.getLogger("memory.umem")

TIMEOUT_S = 15
CONTEXT_TTL_S = 30

_available: bool = False
_context_cache: tuple[float, str] = (0.0, "")
_bootstrap_cache: dict | None = None
_bootstrap_tried = False
_lock = threading.Lock()

# --- secret scrubbing -------------------------------------------------------
_SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_\-]{8,}"),                 # OpenAI-style keys
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                    # AWS access key id
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),          # GitHub tokens
    re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"),         # Slack tokens
    re.compile(r"\bBearer\s+[A-Za-z0-9\-._~+/]+=*", re.I),  # Authorization headers
]
# key=value / key: value where the key looks like a credential
_KV_SECRET = re.compile(
    r"(?i)\b([\w\-]*(?:token|secret|password|passwd|pwd|api[_\-]?key|apikey)[\w\-]*)(\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|\S+)"
)


def redact(text: str) -> str:
    """Replace obvious secrets with [REDACTED]. Best effort, regex only."""
    out = text
    for pat in _SECRET_PATTERNS:
        out = pat.sub("[REDACTED]", out)
    out = _KV_SECRET.sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", out)
    return out


# --- subprocess plumbing ----------------------------------------------------
def _env() -> dict[str, str]:
    env = dict(os.environ)
    shims = str(config.SHIMS_DIR)
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = f"{shims}{os.pathsep}{existing}" if existing else shims
    env["UMEM_OFFLINE"] = "1"
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return env


def _run(*args: str, timeout: int = TIMEOUT_S) -> subprocess.CompletedProcess | None:
    """Run `python -m universal_memory <args>` in DATA_DIR. Returns None on any failure."""
    cmd = [sys.executable, "-m", "universal_memory", *args]
    kwargs: dict[str, Any] = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run(
            cmd,
            cwd=str(config.DATA_DIR),
            env=_env(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            **kwargs,
        )
    except subprocess.TimeoutExpired:
        log.warning("umem %s timed out after %ss", args[0] if args else "?", timeout)
        return None
    except Exception as exc:  # FileNotFoundError, OSError, anything
        log.warning("umem %s failed to start: %s", args[0] if args else "?", exc)
        return None
    if proc.returncode != 0:
        log.warning("umem %s exited %s: %s", args[0] if args else "?", proc.returncode,
                    (proc.stderr or proc.stdout or "").strip()[:400])
        return None
    return proc


# --- public API -------------------------------------------------------------
def available() -> bool:
    return bool(config.UMEM_ENABLED and _available)


def init() -> None:
    """Make sure DATA_DIR is a umem project. Never raises."""
    global _available
    _available = False
    if not config.UMEM_ENABLED:
        log.info("umem disabled (UMEM_ENABLED=0)")
        return
    try:
        if (config.DATA_DIR / ".umem").is_dir():
            _available = True
            log.info("umem project already initialised in %s", config.DATA_DIR)
            return
        proc = _run("init", "--yes", "--format", "json")
        if proc is not None:
            _available = True
            log.info("umem init ok in %s", config.DATA_DIR)
        else:
            log.warning("umem init failed; mirroring disabled for this process")
    except Exception as exc:  # belt and braces: this must never raise
        log.warning("umem init raised %s", exc)
        _available = False


def remember(text: str, tags: list[str] | None = None, scope: str = "global") -> bool:
    """Mirror one fact into umem. Returns True on success, False otherwise. Never raises."""
    if not available():
        return False
    try:
        clean = redact(text).strip()
        if not clean:
            return False
        args = ["remember", clean, "--scope", scope]
        for tag in tags or []:
            tag = re.sub(r"[^\w\-]", "_", str(tag)).strip("_")
            if tag:
                args += ["--tag", tag]
        args += ["--format", "json"]
        with _lock:  # umem takes file locks; serialise writers in this process
            proc = _run(*args)
        if proc is None:
            return False
        _invalidate_context()
        return True
    except Exception as exc:
        log.warning("umem remember raised %s", exc)
        return False


def _invalidate_context() -> None:
    global _context_cache
    _context_cache = (0.0, "")


def context() -> str:
    """`umem context --scope project` as plain text, cached for 30 s. "" on failure."""
    global _context_cache
    if not available():
        return ""
    ts, cached = _context_cache
    if cached and time.monotonic() - ts < CONTEXT_TTL_S:
        return cached
    try:
        proc = _run("context", "--scope", "project")
        text = (proc.stdout or "").strip() if proc is not None else ""
    except Exception as exc:
        log.warning("umem context raised %s", exc)
        text = ""
    if text:
        _context_cache = (time.monotonic(), text)
    return text


def bootstrap_json() -> dict | None:
    """`umem bootstrap --format json`, fetched once per process. None on failure."""
    global _bootstrap_cache, _bootstrap_tried
    if not available():
        return None
    if _bootstrap_tried:
        return _bootstrap_cache
    _bootstrap_tried = True
    try:
        proc = _run("bootstrap", "--format", "json")
        if proc is not None and proc.stdout.strip():
            _bootstrap_cache = json.loads(proc.stdout)
    except Exception as exc:
        log.warning("umem bootstrap unusable: %s", exc)
        _bootstrap_cache = None
    return _bootstrap_cache


def reset_cache() -> None:
    """Forget cached context/bootstrap (tests, or after a data-dir switch)."""
    global _bootstrap_cache, _bootstrap_tried
    _invalidate_context()
    _bootstrap_cache = None
    _bootstrap_tried = False
