"""One helper for every model call in the memory service (see SHARED CONTRACT).

    complete(tier, system, input, schema=None) -> BaseModel | str

- tier "fast" / "smart" picks config.OPENAI_MODEL_FAST / OPENAI_MODEL_SMART.
- schema (a pydantic model class) -> Structured Output via client.responses.parse.
- no schema -> plain text via client.responses.create.
- In MOCK mode or without OPENAI_API_KEY we raise LLMUnavailable so callers fall back
  to deterministic logic. Never parse free text for JSON.

Input may be a plain string or a list of Responses-API content parts, e.g.
    [{"type": "input_text", "text": "..."},
     {"type": "input_image", "image_url": "data:image/png;base64,..."}]
The list is passed through untouched as the user message content.
"""
from __future__ import annotations

import logging
from typing import Any, Literal

from pydantic import BaseModel

import config

log = logging.getLogger("memory.llm")

Tier = Literal["fast", "smart"]


class LLMUnavailable(RuntimeError):
    """Raised when no model can be called (MOCK=1 or missing OPENAI_API_KEY)."""


_client: Any = None


def _get_client():
    """Build the OpenAI client lazily so importing this module never needs a key."""
    global _client
    if config.MOCK:
        raise LLMUnavailable("MOCK=1: LLM calls are disabled")
    if not config.OPENAI_API_KEY:
        raise LLMUnavailable("OPENAI_API_KEY is not set")
    if _client is None:
        from openai import OpenAI  # imported here so MOCK mode never touches the SDK

        _client = OpenAI(api_key=config.OPENAI_API_KEY)
    return _client


def _model_for(tier: Tier) -> str:
    return config.OPENAI_MODEL_SMART if tier == "smart" else config.OPENAI_MODEL_FAST


def _messages(system: str, user: str | list) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def complete(
    tier: Tier,
    system: str,
    input: str | list,
    schema: type[BaseModel] | None = None,
) -> BaseModel | str:
    """Call the model. Returns a parsed `schema` instance, or the output text."""
    client = _get_client()
    model = _model_for(tier)
    if schema is not None:
        response = client.responses.parse(
            model=model,
            input=_messages(system, input),
            text_format=schema,
        )
        parsed = response.output_parsed
        if parsed is None:
            raise RuntimeError("model returned no parsed output (refusal or empty)")
        return parsed
    response = client.responses.create(model=model, input=_messages(system, input))
    return response.output_text
