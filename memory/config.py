"""Shared configuration for the memory service. Import this first; it loads .env."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

MEMORY_DIR = Path(__file__).resolve().parent
REPO_ROOT = MEMORY_DIR.parent
# memory/.env wins; the repo-root .env fills in the rest. Neither overrides real environment variables.
load_dotenv(MEMORY_DIR / ".env", override=False)
load_dotenv(REPO_ROOT / ".env", override=False)

DATA_DIR = Path(os.environ.get("MEMORY_DATA_DIR") or MEMORY_DIR / "data").expanduser().resolve()
KNOWLEDGE_DIR = DATA_DIR / "knowledge"
DB_PATH = DATA_DIR / "events.db"
FIXTURES_DIR = MEMORY_DIR / "fixtures"
SHIMS_DIR = MEMORY_DIR / "shims"          # Windows fcntl shim for the umem subprocess

MOCK = os.environ.get("MOCK", "1") == "1"
PORT = int(os.environ.get("MEMORY_PORT", "7701"))
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL_FAST = os.environ.get("OPENAI_MODEL_FAST", "gpt-6-luna")
OPENAI_MODEL_SMART = os.environ.get("OPENAI_MODEL_SMART", "gpt-6-astra")
UMEM_ENABLED = os.environ.get("UMEM_ENABLED", "1") == "1"

KNOWLEDGE_FILES = [
    "README.md", "goals.md", "classes.md", "deadlines.md",
    "writingstyle.md", "routines.md", "people.md",
]
KNOWLEDGE_MAX_LINES = 60
