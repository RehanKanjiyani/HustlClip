"""The AI manager — deterministic routing between capability and model.

There is exactly one of these. Pipeline code calls::

    result = await manager.run(capabilities.CANDIDATE_DISCOVERY, payload)

and gets a normalised result back, never a provider-specific response. For
every request the manager:

1. looks up the capability's contract and required input modality,
2. asks the registry for eligible models (capability, modality, enabled,
   provider configured) in priority order,
3. skips models that are unhealthy for this job (cooling down after a rate
   limit, disabled after an auth failure, downgraded after repeated unusable
   answers) or that would exceed the token budget,
4. executes through the provider adapter under a wall-clock timeout,
5. validates the response through the capability contract (schema, required
   fields, references, score ranges),
6. records a :class:`DecisionRecord` for every attempt,
7. retries only where that is safe, then falls back to the next model.

Nothing here is a language model; every decision is code.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import Any

from ..config import Settings
from ..providers import build_decision_provider, build_provider
from ..providers.base import ErrorCategory, GenerationRequest, ProviderError
from . import capabilities as caps
from .registry import IMAGE, TEXT, ModelEntry, build_registry, candidates_for

log = logging.getLogger(__name__)

#: How long a model rests after a rate limit when the provider gives no hint.
DEFAULT_RATE_LIMIT_COOLDOWN_S = 60.0
#: Cooldown after a transient outage (timeout/connection/5xx) that survived a retry.
TRANSIENT_COOLDOWN_S = 30.0
#: Unusable answers (schema/quality) from one model for one capability before
#: that pairing is switched off for the rest of the job.
QUALITY_STRIKES = 2
#: Concurrency for fan-out decision requests (one Jev call per candidate).
DECISION_CONCURRENCY = 4

#: Categories where trying the *same* model again can plausibly succeed.
_RETRYABLE = {
    ErrorCategory.TIMEOUT,
    ErrorCategory.CONNECTION,
    ErrorCategory.MALFORMED,
    ErrorCategory.SCHEMA,
    ErrorCategory.INCOMPLETE,
    ErrorCategory.INVALID_REFERENCES,
    ErrorCategory.INVALID_SCORES,
}


class CapabilityUnavailable(RuntimeError):
    """Every eligible model failed (or none was eligible) for a capability."""

    def __init__(
        self, capability: str, message: str, *, category: ErrorCategory | None = None
    ) -> None:
        super().__init__(message)
        self.capability = capability
        self.category = category


@dataclass
class DecisionRecord:
    job_id: str
    capability: str
    provider: str
    model: str
    attempt: int
    fallback_used: bool
    fallback_reason: str | None
    latency_ms: int | None
    input_tokens: int | None
    output_tokens: int | None
    schema_valid: bool | None
    quality_valid: bool | None
    status: str
    error_category: str | None
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CapabilityResult:
    output: Any
    provider: str
    model: str
    fallback_used: bool
    records: list[DecisionRecord] = field(default_factory=list)


# --------------------------------------------------------------------------
# Health
# --------------------------------------------------------------------------


HEALTHY = "healthy"
DEGRADED = "degraded"
RATE_LIMITED = "rate_limited"
UNAVAILABLE = "unavailable"
AUTH_FAILED = "authentication_failed"
DISABLED = "disabled"
COOLING_DOWN = "cooling_down"


@dataclass
class ModelHealth:
    state: str = HEALTHY
    until: float = 0.0
    failures: int = 0
    successes: int = 0
    last_error: str | None = None


class HealthTracker:
    """Job-scoped model health.

    Temporary problems (rate limits, outages) set a cooldown that expires on
    its own; permanent-for-this-job problems (bad key, unknown model) disable.
    Nothing here outlives the job, so a model is never permanently disabled.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._models: dict[str, ModelHealth] = {}
        self._disabled_providers: dict[str, str] = {}
        #: (model id, capability) -> reason
        self._disabled_pairs: dict[tuple[str, str], str] = {}
        self._quality_strikes: dict[tuple[str, str], int] = {}

    def get(self, model_id: str) -> ModelHealth:
        return self._models.setdefault(model_id, ModelHealth())

    def usable(self, entry: ModelEntry, capability: str) -> tuple[bool, str | None]:
        if entry.provider in self._disabled_providers:
            return False, self._disabled_providers[entry.provider]
        if (entry.id, capability) in self._disabled_pairs:
            return False, self._disabled_pairs[(entry.id, capability)]
        health = self.get(entry.id)
        if health.state in (DISABLED, AUTH_FAILED, UNAVAILABLE) and health.until == 0.0:
            return False, health.state
        if health.until and self._clock() < health.until:
            return False, health.state
        if health.until and self._clock() >= health.until:
            # Cooldown over: allow a recheck, remember it was shaky.
            health.state, health.until = DEGRADED, 0.0
        return True, None

    def success(self, entry: ModelEntry) -> None:
        health = self.get(entry.id)
        health.successes += 1
        health.state = HEALTHY
        health.last_error = None

    def cooldown(self, entry: ModelEntry, seconds: float, state: str) -> None:
        health = self.get(entry.id)
        health.state = state
        health.until = self._clock() + max(1.0, seconds)
        health.failures += 1

    def disable_provider(self, provider: str, reason: str) -> None:
        self._disabled_providers[provider] = reason

    def disable_model(self, entry: ModelEntry, state: str) -> None:
        health = self.get(entry.id)
        health.state = state
        health.until = 0.0
        health.failures += 1

    def disable_pair(self, entry: ModelEntry, capability: str, reason: str) -> None:
        self._disabled_pairs[(entry.id, capability)] = reason

    def quality_strike(self, entry: ModelEntry, capability: str) -> None:
        key = (entry.id, capability)
        self._quality_strikes[key] = self._quality_strikes.get(key, 0) + 1
        self.get(entry.id).failures += 1
        if self._quality_strikes[key] >= QUALITY_STRIKES:
            self.disable_pair(entry, capability, "repeated unusable answers")

    def snapshot(self) -> dict[str, dict[str, Any]]:
        now = self._clock()
        out: dict[str, dict[str, Any]] = {}
        for model_id, health in self._models.items():
            state = health.state
            if health.until and now >= health.until:
                state = DEGRADED
            out[model_id] = {
                "state": state,
                "failures": health.failures,
                "successes": health.successes,
            }
        for provider, reason in self._disabled_providers.items():
            out[f"{provider}/*"] = {"state": reason, "failures": 0, "successes": 0}
        return out


# --------------------------------------------------------------------------
# Manager
# --------------------------------------------------------------------------


ProviderFactory = Callable[[ModelEntry, Settings], Any]


def default_provider_factory(entry: ModelEntry, settings: Settings) -> Any:
    if entry.provider == "typesafe":
        return build_decision_provider(entry.provider, settings, model=entry.api_model)
    return build_provider(entry.provider, settings, model=entry.api_model)


def estimate_tokens(*texts: str) -> int:
    """Gate-keeping estimate (≈4 chars/token). Never recorded as usage."""
    return sum(len(t) for t in texts) // 4 + 1


class AIManager:
    """Routes capability requests for one job."""

    def __init__(
        self,
        settings: Settings,
        *,
        job_id: str = "",
        registry: list[ModelEntry] | None = None,
        provider_factory: ProviderFactory = default_provider_factory,
        on_record: Callable[[DecisionRecord], None] | None = None,
        health: HealthTracker | None = None,
    ) -> None:
        self.settings = settings
        self.job_id = job_id
        self.registry = registry if registry is not None else build_registry(settings)
        self._factory = provider_factory
        self._on_record = on_record
        self.health = health or HealthTracker()
        self.records: list[DecisionRecord] = []
        self.tokens_used = 0
        self._providers: dict[str, Any] = {}

    # -- introspection -----------------------------------------------------

    def eligible(self, capability: str) -> list[ModelEntry]:
        spec = caps.SPECS[capability]
        modality = IMAGE if spec.modality == "image" else TEXT
        return candidates_for(self.registry, capability, modality=modality, settings=self.settings)

    def available(self, capability: str) -> bool:
        return any(self.health.usable(e, capability)[0] for e in self.eligible(capability))

    # -- execution ---------------------------------------------------------

    async def run(self, capability: str, payload: Any) -> CapabilityResult:
        spec = caps.SPECS.get(capability)
        if spec is None:
            raise CapabilityUnavailable(capability, f"Unknown capability '{capability}'.")

        entries = self.eligible(capability)
        if not entries:
            raise CapabilityUnavailable(
                capability,
                _no_model_message(capability),
                category=ErrorCategory.NOT_CONFIGURED,
            )

        attempt = 0
        first_choice = entries[0]
        fallback_reason: str | None = None
        last_category: ErrorCategory | None = None
        records: list[DecisionRecord] = []

        for entry in entries:
            usable, why = self.health.usable(entry, capability)
            if not usable:
                fallback_reason = fallback_reason or f"{entry.id} {why}"
                continue
            if entry is not first_choice and not entry.fallback_eligible:
                continue

            budget = self.settings.ai.job_token_budget
            if budget and self.tokens_used >= budget:
                last_category = ErrorCategory.BUDGET
                records.append(
                    self._record(capability, entry, attempt + 1, entry is not first_choice,
                                 fallback_reason, None, None, None, None, None, "skipped",
                                 ErrorCategory.BUDGET, "job token budget exhausted")
                )
                break

            repair: str | None = None
            tries = 0
            while tries <= entry.max_retries:
                tries += 1
                attempt += 1
                is_fallback = entry is not first_choice
                started = time.perf_counter()
                try:
                    output, model_name, tokens_in, tokens_out = await self._execute(
                        entry, spec, payload, repair
                    )
                except caps.CapabilityError as exc:
                    latency = int((time.perf_counter() - started) * 1000)
                    last_category = exc.category
                    schema_ok = exc.category not in (ErrorCategory.MALFORMED, ErrorCategory.SCHEMA)
                    records.append(
                        self._record(capability, entry, attempt, is_fallback, fallback_reason,
                                     latency, getattr(exc, "tokens_in", None),
                                     getattr(exc, "tokens_out", None), schema_ok, False,
                                     "invalid", exc.category, str(exc)[:300])
                    )
                    self.health.quality_strike(entry, capability)
                    if exc.retryable and tries <= entry.max_retries and self.health.usable(
                        entry, capability
                    )[0]:
                        repair = str(exc)
                        continue
                    fallback_reason = f"{entry.id}: {exc.category.value}"
                    break
                except ProviderError as exc:
                    latency = int((time.perf_counter() - started) * 1000)
                    last_category = exc.category
                    records.append(
                        self._record(capability, entry, attempt, is_fallback, fallback_reason,
                                     latency, None, None, None, None, "error", exc.category,
                                     _safe_detail(exc))
                    )
                    retry_same = self._handle_provider_error(entry, capability, exc, tries)
                    if retry_same:
                        continue
                    fallback_reason = f"{entry.id}: {exc.category.value}"
                    break
                else:
                    latency = int((time.perf_counter() - started) * 1000)
                    self.tokens_used += (tokens_in or 0) + (tokens_out or 0)
                    self.health.success(entry)
                    records.append(
                        self._record(capability, entry, attempt, is_fallback, fallback_reason,
                                     latency, tokens_in, tokens_out, True, True, "success",
                                     None, spec.describe(payload))
                    )
                    return CapabilityResult(
                        output=output,
                        provider=entry.provider,
                        model=model_name,
                        fallback_used=is_fallback,
                        records=records,
                    )

        raise CapabilityUnavailable(
            capability,
            _failure_message(capability, last_category),
            category=last_category,
        )

    def _handle_provider_error(
        self, entry: ModelEntry, capability: str, exc: ProviderError, tries: int
    ) -> bool:
        """Update health for a failure; return True to retry the same model."""
        category = exc.category
        if category == ErrorCategory.RATE_LIMIT:
            self.health.cooldown(
                entry, exc.retry_after_s or DEFAULT_RATE_LIMIT_COOLDOWN_S, RATE_LIMITED
            )
            return False
        if category in (ErrorCategory.AUTH, ErrorCategory.NOT_CONFIGURED):
            # A bad key is bad for every model behind that provider.
            self.health.disable_provider(entry.provider, AUTH_FAILED)
            return False
        if category == ErrorCategory.MODEL_UNAVAILABLE:
            self.health.disable_model(entry, UNAVAILABLE)
            return False
        if category == ErrorCategory.UNSUPPORTED_MODALITY:
            self.health.disable_pair(entry, capability, "unsupported modality")
            return False
        if category in (ErrorCategory.TIMEOUT, ErrorCategory.CONNECTION, ErrorCategory.UNAVAILABLE):
            if tries <= entry.max_retries and category != ErrorCategory.UNAVAILABLE:
                return True
            self.health.cooldown(entry, exc.retry_after_s or TRANSIENT_COOLDOWN_S, COOLING_DOWN)
            return False
        if category in _RETRYABLE and tries <= entry.max_retries:
            return True
        # BAD_REQUEST, REFUSAL, BUDGET, INTERNAL: never loop on these.
        return False

    async def _execute(
        self, entry: ModelEntry, spec: caps.CapabilitySpec, payload: Any, repair: str | None
    ) -> tuple[Any, str, int | None, int | None]:
        provider = self._provider(entry)

        if getattr(provider, "kind", "") == "decision":
            requests = spec.build_decisions(payload)
            if requests is None:
                raise ProviderError(
                    f"{entry.id} cannot serve {spec.name}.",
                    provider=entry.provider,
                    category=ErrorCategory.UNSUPPORTED_MODALITY,
                )
            largest = max((estimate_tokens(str(state)) for state, _ in requests), default=0)
            if largest > entry.max_input_tokens:
                raise ProviderError(
                    "Decision state exceeds the model's input limit.",
                    provider=entry.provider,
                    category=ErrorCategory.BUDGET,
                )
            semaphore = asyncio.Semaphore(DECISION_CONCURRENCY)

            async def ask(state: Any, questions: dict[str, dict]):
                async with semaphore:
                    return await asyncio.wait_for(
                        provider.evaluate(state, questions), timeout=entry.timeout_s
                    )

            try:
                responses = await asyncio.gather(*(ask(s, q) for s, q in requests))
            except TimeoutError as exc:
                raise ProviderError(
                    f"{entry.id} timed out.", provider=entry.provider, category=ErrorCategory.TIMEOUT
                ) from exc
            tokens_in = _sum_or_none(r.input_tokens for r in responses)
            tokens_out = _sum_or_none(r.output_tokens for r in responses)
            model_name = responses[0].model if responses else entry.api_model
            try:
                output = spec.parse_decisions(list(responses), payload)
            except (KeyError, TypeError, ValueError) as exc:
                raise caps.CapabilityError(
                    f"Decision answers could not be normalised: {exc}", ErrorCategory.SCHEMA
                ) from exc
            return output, model_name, tokens_in, tokens_out

        system, user = spec.build_prompt(payload, repair)
        if estimate_tokens(system, user) > entry.max_input_tokens:
            raise ProviderError(
                "Prompt exceeds the model's input limit.",
                provider=entry.provider,
                category=ErrorCategory.BUDGET,
            )
        request = GenerationRequest(
            system=system,
            user=user,
            temperature=spec.temperature if entry.temperature is not None else None,
            max_tokens=entry.max_output_tokens,
            images=spec.images(payload),
            options=dict(entry.options),
        )
        try:
            completion = await asyncio.wait_for(provider.generate(request), timeout=entry.timeout_s)
        except TimeoutError as exc:
            raise ProviderError(
                f"{entry.id} timed out.", provider=entry.provider, category=ErrorCategory.TIMEOUT
            ) from exc

        try:
            output = spec.parse_text(completion.text, payload)
        except caps.CapabilityError as exc:
            # Keep real usage on the failed attempt's record.
            exc.tokens_in = completion.input_tokens  # type: ignore[attr-defined]
            exc.tokens_out = completion.output_tokens  # type: ignore[attr-defined]
            self.tokens_used += (completion.input_tokens or 0) + (completion.output_tokens or 0)
            raise
        return output, completion.model or entry.api_model, completion.input_tokens, completion.output_tokens

    def _provider(self, entry: ModelEntry) -> Any:
        provider = self._providers.get(entry.id)
        if provider is None:
            provider = self._factory(entry, self.settings)
            self._providers[entry.id] = provider
        return provider

    def _record(
        self,
        capability: str,
        entry: ModelEntry,
        attempt: int,
        fallback_used: bool,
        fallback_reason: str | None,
        latency_ms: int | None,
        tokens_in: int | None,
        tokens_out: int | None,
        schema_valid: bool | None,
        quality_valid: bool | None,
        status: str,
        category: ErrorCategory | None,
        detail: str,
    ) -> DecisionRecord:
        record = DecisionRecord(
            job_id=self.job_id,
            capability=capability,
            provider=entry.provider,
            model=entry.api_model,
            attempt=attempt,
            fallback_used=fallback_used,
            fallback_reason=fallback_reason if fallback_used else None,
            latency_ms=latency_ms,
            input_tokens=tokens_in,
            output_tokens=tokens_out,
            schema_valid=schema_valid,
            quality_valid=quality_valid,
            status=status,
            error_category=category.value if category else None,
            detail=detail,
        )
        self.records.append(record)
        log.info(
            "AI %s via %s/%s attempt %d: %s%s",
            capability,
            entry.provider,
            entry.api_model,
            attempt,
            status,
            f" ({record.error_category})" if record.error_category else "",
        )
        if self._on_record is not None:
            try:
                self._on_record(record)
            except Exception:  # pragma: no cover - observability must not break a job
                log.exception("Could not persist a decision record.")
        return record


def _sum_or_none(values) -> int | None:
    values = list(values)
    if not values or any(v is None for v in values):
        return None
    return sum(values)


def _safe_detail(exc: ProviderError) -> str:
    """The error message without hints (which can quote config paths)."""
    return RuntimeError.__str__(exc)[:300]


_FRIENDLY = {
    ErrorCategory.RATE_LIMIT: (
        "The AI providers are temporarily rate-limited. HustlClip tried every available "
        "model; retry the job in a few minutes."
    ),
    ErrorCategory.AUTH: "An AI provider rejected its API key. Check the key in Settings.",
    ErrorCategory.NOT_CONFIGURED: "No AI provider is configured for this step. Add an API key in Settings.",
    ErrorCategory.TIMEOUT: "The AI providers did not respond in time. Retry the job.",
    ErrorCategory.CONNECTION: "HustlClip could not reach any AI provider. Check the internet connection.",
    ErrorCategory.UNAVAILABLE: "The AI providers are temporarily unavailable. Retry the job later.",
    ErrorCategory.BUDGET: "The job reached its AI token budget. Raise the limit in Settings or retry.",
}


def _failure_message(capability: str, category: ErrorCategory | None) -> str:
    friendly = _FRIENDLY.get(category) if category else None
    step = capability.replace("_", " ")
    if friendly:
        return f"{friendly} (step: {step})"
    return (
        f"Every available AI model returned unusable results for {step}. "
        "Retry the job, or enable another provider in Settings."
    )


def _no_model_message(capability: str) -> str:
    return (
        f"No AI model is available for {capability.replace('_', ' ')}. Add an NVIDIA, "
        "Anthropic, OpenAI or Gemini API key in Settings (or set NVIDIA_API_KEY)."
    )
