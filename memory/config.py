"""Shared configuration for the memory service. Import this first; it loads .env."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

MEMORY_DIR = Path(__file__).resolve().parent
REPO_ROOT = MEMORY_DIR.parent
load_dotenv(REPO_ROOT / ".env")          # repo-root .env is the shared one
load_dotenv(MEMORY_DIR / ".env", override=True)  # optional per-service override

DATA_DIR = Path(os.environ.get("MEMORY_DATA_DIR", MEMORY_DIR / "data"))
KNOWLEDGE_DIR = DATA_DIR / "knowledge"
DB_PATH = DATA_DIR / "events.db"
FIXTURES_DIR = MEMORY_DIR / "fixtures"
SHIMS_DIR = MEMORY_DIR / "shims"          # Windows fcntl shim for the umem subprocess

MOCK = os.environ.get("MOCK", "1") == "1"
PORT = int(os.environ.get("MEMORY_PORT", "7701"))
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL_FAST = os.environ.get("OPENAI_MODEL_FAST", "gpt-6-luna")
OPENAI_MODEL_SMART = os.environ.get("OPENAI_MODEL_SMART", "gpt-6.1-sol")
UMEM_ENABLED = os.environ.get("UMEM_ENABLED", "1") == "1"

KNOWLEDGE_FILES = [
    "README.md", "goals.md", "classes.md", "deadlines.md",
    "writingstyle.md", "routines.md", "people.md",
]
KNOWLEDGE_MAX_LINES = 60
