"""LLM provider abstraction.

Providers are thin adapters: they own the provider-specific HTTP/SDK details
and translate failures into a :class:`ProviderError` with an
:class:`ErrorCategory`. Routing, retry policy, and fallback between models live
in :mod:`autoclip.intelligence.manager`, never here.

Two design choices carry most of the weight:

**Word indices, not seconds.** The model returns ``start_word_index`` /
``end_word_index``. Timing is then looked up from measured word timestamps, so a
model that is bad at arithmetic — which they all are — cannot produce a clip
that starts at the wrong moment.

**Validate, then retry with the error.** Small local models produce malformed
JSON often enough that a single retry carrying the actual validation message
turns most failures into successes. That loop lives in the AI manager, so every
provider and every capability inherits it.
"""

from __future__ import annotations

import base64
import json
import logging
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

PROMPT_DIR = Path(__file__).resolve().parent.parent / "prompts"


class ErrorCategory(StrEnum):
    """Why a provider call failed.

    The AI manager decides between retry, cooldown, and fallback from this
    alone, so adapters classify at the point where they still know the
    provider-specific details (status codes, SDK exception types).
    """

    TIMEOUT = "timeout"
    CONNECTION = "connection"
    RATE_LIMIT = "rate_limit"
    AUTH = "authentication_failed"
    UNAVAILABLE = "provider_unavailable"
    MODEL_UNAVAILABLE = "model_unavailable"
    MALFORMED = "malformed_response"
    SCHEMA = "schema_failure"
    INCOMPLETE = "incomplete_response"
    INVALID_REFERENCES = "invalid_references"
    INVALID_SCORES = "invalid_scores"
    BUDGET = "token_budget_exceeded"
    UNSUPPORTED_MODALITY = "unsupported_modality"
    NOT_CONFIGURED = "not_configured"
    BAD_REQUEST = "bad_request"
    REFUSAL = "refusal"
    INTERNAL = "internal_provider_failure"


class ProviderError(RuntimeError):
    """A provider could not produce a usable response."""

    def __init__(
        self,
        message: str,
        *,
        provider: str = "",
        hint: str = "",
        category: ErrorCategory = ErrorCategory.INTERNAL,
        retry_after_s: float | None = None,
    ) -> None:
        super().__init__(message)
        self.provider = provider
        self.hint = hint
        self.category = category
        self.retry_after_s = retry_after_s

    def __str__(self) -> str:
        base = super().__str__()
        return f"{base}\n\n{self.hint}" if self.hint else base


# --------------------------------------------------------------------------
# Contracts
# --------------------------------------------------------------------------


@dataclass
class TranscriptWindow:
    """A slice of transcript presented to the model.

    ``first_word`` lets a provider work on a window while still reporting
    indices in the full transcript's coordinate space.
    """

    text: str
    first_word: int
    last_word: int
    duration_s: float = 0.0
    speakers: list[str] = field(default_factory=list)

    @property
    def word_count(self) -> int:
        return self.last_word - self.first_word + 1


@dataclass
class DetectionConfig:
    min_duration_s: float = 20.0
    max_duration_s: float = 90.0
    max_clips: int = 10
    language: str = ""
    temperature: float = 0.3


@dataclass
class ProviderStatus:
    name: str
    available: bool
    detail: str = ""
    models: list[str] = field(default_factory=list)


@dataclass
class ImageInput:
    """One still frame for a vision-capable model."""

    data: bytes
    media_type: str = "image/jpeg"

    def b64(self) -> str:
        return base64.standard_b64encode(self.data).decode("ascii")


@dataclass
class GenerationRequest:
    """A provider-neutral text (or text + images) generation request."""

    system: str
    user: str
    #: None means "send no sampling parameter" — several current models reject
    #: temperature outright.
    temperature: float | None = 0.2
    max_tokens: int = 8000
    images: list[ImageInput] = field(default_factory=list)
    #: Provider-specific extras from the model registry (e.g. Claude effort).
    options: dict[str, Any] = field(default_factory=dict)


@dataclass
class Completion:
    text: str
    model: str = ""
    #: Token counts exactly as the provider reported them. None when the
    #: provider does not expose usage — never estimated.
    input_tokens: int | None = None
    output_tokens: int | None = None
    stop_reason: str | None = None


# --------------------------------------------------------------------------
# Base provider
# --------------------------------------------------------------------------


class LLMProvider(ABC):
    """Base class for text-generating providers."""

    #: Stable identifier, matching the key used in settings.
    name: str = ""
    #: Whether the provider needs an API key.
    requires_key: bool = True
    #: Whether :meth:`generate` accepts images. Adapters that implement vision
    #: set this; the model registry still decides per model.
    supports_images: bool = False

    def __init__(self, model: str, *, api_key: str | None = None, base_url: str | None = None):
        self.model = model
        self.api_key = api_key
        self.base_url = base_url

    # -- to implement ------------------------------------------------------

    @abstractmethod
    async def _complete(self, system: str, user: str, config: DetectionConfig) -> str:
        """Send one prompt and return the raw response text."""

    @abstractmethod
    async def health_check(self) -> ProviderStatus:
        """Report whether this provider is usable right now."""

    # -- generic generation -------------------------------------------------

    async def generate(self, request: GenerationRequest) -> Completion:
        """Run one generation request.

        The default wraps :meth:`_complete`, which reports no usage. Adapters
        whose API exposes token counts override this so the AI manager can
        record real numbers instead of guesses.
        """
        if request.images and not self.supports_images:
            raise ProviderError(
                f"{self.name} does not accept image input.",
                provider=self.name,
                category=ErrorCategory.UNSUPPORTED_MODALITY,
            )
        text = await self._complete(
            request.system,
            request.user,
            DetectionConfig(
                temperature=request.temperature if request.temperature is not None else 0.3
            ),
        )
        return Completion(text=text, model=self.model)


# --------------------------------------------------------------------------
# Prompt handling
# --------------------------------------------------------------------------


def load_prompt(version: str) -> str:
    """Read a versioned prompt file from ``autoclip/prompts/``."""
    path = PROMPT_DIR / f"{version}.txt"
    if not path.exists():
        raise ProviderError(
            f"Prompt '{version}' not found at {path}.",
            category=ErrorCategory.NOT_CONFIGURED,
            hint="Prompt files live in backend/autoclip/prompts/ as versioned .txt files.",
        )
    return path.read_text(encoding="utf-8")


_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)

#: Reasoning models served over OpenAI-compatible APIs often inline their chain
#: of thought. Braces inside it would otherwise be mistaken for the answer.
_THINK_BLOCK = re.compile(r"<(think|thinking|reasoning)>.*?</\1>", re.DOTALL | re.IGNORECASE)
_THINK_CLOSE = re.compile(r"</(think|thinking|reasoning)>", re.IGNORECASE)


def strip_reasoning(raw: str) -> str:
    """Remove inline reasoning blocks, keeping only the final answer text."""
    text = _THINK_BLOCK.sub("", raw)
    # An opening tag whose close was emitted but whose opener was cut (or a
    # server that strips only the opener) leaves the answer after the last close.
    closes = list(_THINK_CLOSE.finditer(text))
    if closes:
        text = text[closes[-1].end() :]
    return text.strip()


def extract_json_object(raw: str) -> dict[str, Any]:
    """Pull a JSON object out of a model response.

    Handles the things models do despite being told not to: think out loud
    before answering, wrap the JSON in markdown fences, prepend an explanatory
    sentence, and append a trailing note. Falls back to brace matching so a
    stray character outside the object doesn't cost a retry round-trip.
    """
    text = strip_reasoning(raw or "")
    if not text:
        raise ValueError("The provider returned an empty response.")

    if match := _JSON_FENCE.search(text):
        text = match.group(1).strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = _json_by_brace_matching(text)

    if isinstance(parsed, list):
        # Some models skip the wrapper object and return the array directly.
        return {"clips": parsed}
    if not isinstance(parsed, dict):
        raise ValueError(f"Expected a JSON object, got {type(parsed).__name__}.")
    return parsed


def _json_by_brace_matching(text: str) -> Any:
    """Extract the first balanced ``{...}`` or ``[...]`` region and parse it."""
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        if start == -1:
            continue
        depth = 0
        in_string = False
        escaped = False
        for i in range(start, len(text)):
            char = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == opener:
                depth += 1
            elif char == closer:
                depth -= 1
                if depth == 0:
                    return json.loads(text[start : i + 1])

    raise ValueError("No JSON object found in the response.")
