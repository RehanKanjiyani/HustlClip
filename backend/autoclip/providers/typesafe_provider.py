"""TypeSafe (Jev) adapter — structured decisions, not text generation.

Implements the documented HTTP contract (https://docs.typesafe.ai/api)::

    POST {base}/v1/systemone
    Authorization: Bearer <TYPESAFE_API_KEY>
    {"state": ..., "model": "jev-latest", "questions": {id: Question}}

    -> {"model": "jev-1.13.0", "answers": {id: Answer},
        "usage": {"input_tokens": int, "output_tokens": int}}

Three question types are supported, exactly as documented:

* ``noul``   — yes/no; answer carries ``noul`` in [0, 1]
* ``choice`` — pick one of ``criteria`` keys; answer carries ``choice``,
  ``probabilities`` and ``confidence``
* ``score``  — ordered ``criteria`` levels (2..10); answer carries ``score``
  (a probability-weighted level index), ``probabilities``, ``confidence``

This module only speaks the wire format and validates answers against the
questions that were asked. What the answers *mean* for HustlClip is decided in
:mod:`autoclip.intelligence.capabilities`, so nothing outside that module
depends on Jev's response shape.

httpx is used directly (it is already a dependency) rather than the
``typesafe-sdk`` package: one endpoint does not justify another dependency, and
the AI manager owns retry/fallback policy anyway.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from .base import ErrorCategory, ProviderError, ProviderStatus

log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.typesafe.ai"
DEFAULT_MODEL = "jev-latest"
DEFAULT_TIMEOUT_S = 10.0

#: Documented limits (docs.typesafe.ai/api).
MAX_CHOICE_OPTIONS = 255
MIN_SCORE_LEVELS = 2
MAX_SCORE_LEVELS = 10


@dataclass
class DecisionAnswer:
    type: str
    #: noul: probability of yes. score: level-weighted value. choice: None.
    value: float | None = None
    choice: str | None = None
    probabilities: dict[str, float] = field(default_factory=dict)
    confidence: float | None = None


@dataclass
class DecisionResponse:
    model: str
    answers: dict[str, DecisionAnswer]
    input_tokens: int | None = None
    output_tokens: int | None = None


class TypeSafeProvider:
    """Client for TypeSafe's System One endpoint."""

    name = "typesafe"
    requires_key = True
    kind = "decision"

    def __init__(
        self,
        model: str = "",
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: Any = None,
    ) -> None:
        self.model = model or DEFAULT_MODEL
        self.api_key = api_key
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.timeout_s = timeout_s
        #: Injectable httpx transport, so tests never touch the network.
        self._transport = transport

    def _client(self):
        import httpx

        if not self.api_key:
            raise ProviderError(
                "No TypeSafe API key is set.",
                provider=self.name,
                category=ErrorCategory.NOT_CONFIGURED,
                hint="Set TYPESAFE_API_KEY, or run `hustlclip config set-secret typesafe`.",
            )
        return httpx.AsyncClient(
            base_url=self.base_url,
            timeout=self.timeout_s,
            transport=self._transport,
            headers={"Authorization": f"Bearer {self.api_key}"},
        )

    async def evaluate(self, state: Any, questions: dict[str, dict[str, Any]]) -> DecisionResponse:
        """Ask every question against ``state`` in one request."""
        _check_questions(questions)
        body = {"state": state, "model": self.model, "questions": questions}

        import httpx

        try:
            async with self._client() as client:
                response = await client.post("/v1/systemone", json=body)
        except httpx.TimeoutException as exc:
            raise ProviderError(
                "TypeSafe timed out.", provider=self.name, category=ErrorCategory.TIMEOUT
            ) from exc
        except httpx.TransportError as exc:
            raise ProviderError(
                "Could not reach TypeSafe.", provider=self.name, category=ErrorCategory.CONNECTION
            ) from exc

        if response.status_code != 200:
            raise _status_error(response)

        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderError(
                "TypeSafe returned a body that is not JSON.",
                provider=self.name,
                category=ErrorCategory.MALFORMED,
            ) from exc

        return parse_response(payload, questions, fallback_model=self.model)

    async def health_check(self) -> ProviderStatus:
        if not self.api_key:
            return ProviderStatus(name=self.name, available=False, detail="No API key set")
        try:
            async with self._client() as client:
                response = await client.get("/v1/models")
        except Exception as exc:
            return ProviderStatus(name=self.name, available=False, detail=str(exc)[:200])
        if response.status_code != 200:
            error = _status_error(response)
            return ProviderStatus(name=self.name, available=False, detail=str(error)[:200])
        try:
            names = [m.get("name", "") for m in response.json().get("models", [])]
        except (ValueError, AttributeError):
            names = []
        return ProviderStatus(
            name=self.name, available=True, detail=self.model, models=[n for n in names if n]
        )


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------


def _check_questions(questions: dict[str, dict[str, Any]]) -> None:
    """Reject malformed questions before spending a request on them."""
    if not questions:
        raise ProviderError(
            "No questions to ask.", provider="typesafe", category=ErrorCategory.BAD_REQUEST
        )
    for key, question in questions.items():
        kind = question.get("type")
        if kind not in ("noul", "choice", "score") or not question.get("instructions"):
            raise ProviderError(
                f"Question '{key}' is malformed.",
                provider="typesafe",
                category=ErrorCategory.BAD_REQUEST,
            )
        criteria = question.get("criteria")
        if kind == "choice" and (
            not isinstance(criteria, dict) or not 1 <= len(criteria) <= MAX_CHOICE_OPTIONS
        ):
            raise ProviderError(
                f"Choice '{key}' needs 1-{MAX_CHOICE_OPTIONS} options.",
                provider="typesafe",
                category=ErrorCategory.BAD_REQUEST,
            )
        if kind == "score" and (
            not isinstance(criteria, list)
            or not MIN_SCORE_LEVELS <= len(criteria) <= MAX_SCORE_LEVELS
        ):
            raise ProviderError(
                f"Score '{key}' needs {MIN_SCORE_LEVELS}-{MAX_SCORE_LEVELS} levels.",
                provider="typesafe",
                category=ErrorCategory.BAD_REQUEST,
            )


def parse_response(
    payload: Any, questions: dict[str, dict[str, Any]], *, fallback_model: str = ""
) -> DecisionResponse:
    """Validate a response body against the questions that were asked.

    HTTP 200 is not success: every asked question must come back with an
    answer of the matching type whose values are in range.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("answers"), dict):
        raise ProviderError(
            "TypeSafe response has no answers map.",
            provider="typesafe",
            category=ErrorCategory.SCHEMA,
        )

    raw_answers: dict[str, Any] = payload["answers"]
    answers: dict[str, DecisionAnswer] = {}

    for key, question in questions.items():
        raw = raw_answers.get(key)
        if not isinstance(raw, dict):
            raise ProviderError(
                f"TypeSafe returned no answer for '{key}'.",
                provider="typesafe",
                category=ErrorCategory.INCOMPLETE,
            )
        kind = question["type"]
        if raw.get("type") != kind:
            raise ProviderError(
                f"Answer '{key}' has type {raw.get('type')!r}, expected {kind!r}.",
                provider="typesafe",
                category=ErrorCategory.SCHEMA,
            )
        answers[key] = _parse_answer(key, kind, raw, question)

    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    return DecisionResponse(
        model=str(payload.get("model") or fallback_model),
        answers=answers,
        input_tokens=_int_or_none(usage.get("input_tokens")),
        output_tokens=_int_or_none(usage.get("output_tokens")),
    )


def _parse_answer(
    key: str, kind: str, raw: dict[str, Any], question: dict[str, Any]
) -> DecisionAnswer:
    def bad(detail: str) -> ProviderError:
        return ProviderError(
            f"Answer '{key}' is invalid: {detail}",
            provider="typesafe",
            category=ErrorCategory.INVALID_SCORES,
        )

    if kind == "noul":
        value = _float_or_none(raw.get("noul"))
        if value is None or not 0.0 <= value <= 1.0:
            raise bad("noul must be a number in [0, 1]")
        return DecisionAnswer(type=kind, value=value)

    confidence = _float_or_none(raw.get("confidence"))
    if confidence is not None and not 0.0 <= confidence <= 1.0:
        raise bad("confidence out of range")
    probabilities = {
        str(k): float(v)
        for k, v in (raw.get("probabilities") or {}).items()
        if _float_or_none(v) is not None
    }

    if kind == "choice":
        choice = raw.get("choice")
        if choice not in question["criteria"]:
            raise bad(f"choice {choice!r} is not one of the offered options")
        return DecisionAnswer(
            type=kind, choice=choice, probabilities=probabilities, confidence=confidence
        )

    levels = len(question["criteria"])
    value = _float_or_none(raw.get("score"))
    if value is None or not 0.0 <= value <= levels - 1:
        raise bad(f"score must be within [0, {levels - 1}]")
    return DecisionAnswer(
        type=kind, value=value, probabilities=probabilities, confidence=confidence
    )


def _status_error(response: Any) -> ProviderError:
    status = response.status_code
    detail = ""
    try:
        detail = str(response.json())[:200]
    except ValueError:
        detail = (response.text or "")[:200]

    if status in (401, 403):
        return ProviderError(
            "TypeSafe rejected the API key.",
            provider="typesafe",
            category=ErrorCategory.AUTH,
            hint="Check TYPESAFE_API_KEY.",
        )
    if status == 429:
        return ProviderError(
            "TypeSafe rate limit reached.",
            provider="typesafe",
            category=ErrorCategory.RATE_LIMIT,
            retry_after_s=_float_or_none(response.headers.get("retry-after")),
        )
    if status == 404:
        return ProviderError(
            "TypeSafe does not recognise the model.",
            provider="typesafe",
            category=ErrorCategory.MODEL_UNAVAILABLE,
        )
    if status == 422 or status == 400:
        return ProviderError(
            f"TypeSafe rejected the request: {detail}",
            provider="typesafe",
            category=ErrorCategory.BAD_REQUEST,
        )
    if status == 529 or status >= 500:
        return ProviderError(
            "TypeSafe is temporarily overloaded or unavailable.",
            provider="typesafe",
            category=ErrorCategory.UNAVAILABLE,
            retry_after_s=_float_or_none(response.headers.get("retry-after")),
        )
    return ProviderError(
        f"TypeSafe returned HTTP {status}: {detail}",
        provider="typesafe",
        category=ErrorCategory.INTERNAL,
    )


def _float_or_none(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
