"""Anthropic (Claude) provider."""

from __future__ import annotations

import logging
import re

from .base import (
    Completion,
    DetectionConfig,
    ErrorCategory,
    GenerationRequest,
    LLMProvider,
    ProviderError,
    ProviderStatus,
)

log = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-opus-5"

#: Shown in the settings UI. Kept short and current rather than exhaustive.
SUGGESTED_MODELS = [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
]

#: Current Claude generations reject ``temperature`` (and assistant prefill)
#: with a 400. Older generations still accept sampling parameters.
_NO_SAMPLING = re.compile(r"^claude-(opus-5|opus-4-[78]|sonnet-5|fable|mythos)")

JSON_ONLY = (
    "\n\nRespond with ONLY the JSON object described above: no prose before or after it, "
    "no markdown fences."
)


def accepts_sampling(model: str) -> bool:
    return not _NO_SAMPLING.match(model)


class AnthropicProvider(LLMProvider):
    name = "anthropic"
    requires_key = True
    supports_images = True

    def __init__(self, model: str = "", *, api_key: str | None = None, base_url: str | None = None):
        super().__init__(model or DEFAULT_MODEL, api_key=api_key, base_url=base_url)

    def _client(self):
        try:
            from anthropic import AsyncAnthropic
        except ImportError as exc:  # pragma: no cover - anthropic is a core dep
            raise ProviderError(
                "The anthropic package is not installed.", provider=self.name
            ) from exc

        if not self.api_key:
            raise ProviderError(
                "No Anthropic API key is set.",
                provider=self.name,
                category=ErrorCategory.NOT_CONFIGURED,
                hint="Add one with `hustlclip config set-secret anthropic`.",
            )

        # Retries belong to the AI manager, which can fall back to another
        # model instead of waiting on this one; one SDK retry smooths blips.
        kwargs = {"api_key": self.api_key, "max_retries": 1}
        if self.base_url:
            kwargs["base_url"] = self.base_url
        return AsyncAnthropic(**kwargs)

    async def _complete(self, system: str, user: str, config: DetectionConfig) -> str:
        completion = await self.generate(
            GenerationRequest(system=system, user=user, temperature=config.temperature)
        )
        return completion.text

    async def generate(self, request: GenerationRequest) -> Completion:
        client = self._client()

        # No assistant prefill: current models reject it. The JSON-only
        # instruction plus tolerant extraction does the same job.
        content: list[dict] = [
            {
                "type": "image",
                "source": {"type": "base64", "media_type": image.media_type, "data": image.b64()},
            }
            for image in request.images
        ]
        content.append({"type": "text", "text": request.user + JSON_ONLY})

        params: dict = {
            "model": self.model,
            "max_tokens": request.max_tokens,
            "system": request.system,
            "messages": [{"role": "user", "content": content}],
        }
        if request.temperature is not None and accepts_sampling(self.model):
            params["temperature"] = request.temperature
        effort = request.options.get("effort")
        if effort:
            # Passed through extra_body so an older SDK doesn't reject the field.
            params["extra_body"] = {"output_config": {"effort": effort}}

        try:
            message = await client.messages.create(**params)
        except Exception as exc:
            raise _translate(exc, self.name, self.model) from exc

        if message.stop_reason == "refusal":
            raise ProviderError(
                "Claude declined this request.",
                provider=self.name,
                category=ErrorCategory.REFUSAL,
            )
        if message.stop_reason == "max_tokens":
            raise ProviderError(
                "Claude's response was cut off at the output limit.",
                provider=self.name,
                category=ErrorCategory.INCOMPLETE,
            )

        text = "".join(
            block.text for block in message.content if getattr(block, "type", "") == "text"
        )
        usage = getattr(message, "usage", None)
        return Completion(
            text=text,
            model=getattr(message, "model", None) or self.model,
            input_tokens=getattr(usage, "input_tokens", None),
            output_tokens=getattr(usage, "output_tokens", None),
            stop_reason=message.stop_reason,
        )

    async def health_check(self) -> ProviderStatus:
        if not self.api_key:
            return ProviderStatus(
                name=self.name, available=False, detail="No API key set", models=SUGGESTED_MODELS
            )
        try:
            client = self._client()
            await client.messages.create(
                model=self.model,
                max_tokens=1,
                messages=[{"role": "user", "content": "ok"}],
            )
        except Exception as exc:
            return ProviderStatus(
                name=self.name, available=False, detail=str(exc)[:200], models=SUGGESTED_MODELS
            )
        return ProviderStatus(
            name=self.name, available=True, detail=self.model, models=SUGGESTED_MODELS
        )


def _translate(exc: Exception, provider: str, model: str) -> ProviderError:
    """Map SDK exceptions to categorised provider errors.

    Typed exception classes first; the string checks below them cover SDK
    versions or proxies that surface errors differently.
    """
    import anthropic

    # APITimeoutError subclasses APIConnectionError, so it must be checked first.
    if isinstance(exc, anthropic.APITimeoutError):
        return ProviderError(
            "Anthropic timed out.", provider=provider, category=ErrorCategory.TIMEOUT
        )
    if isinstance(exc, anthropic.APIConnectionError):
        return ProviderError(
            "Could not reach Anthropic.", provider=provider, category=ErrorCategory.CONNECTION
        )
    if isinstance(exc, anthropic.RateLimitError):
        return ProviderError(
            "Anthropic rate limit reached.",
            provider=provider,
            category=ErrorCategory.RATE_LIMIT,
            retry_after_s=_retry_after(exc),
            hint="Wait a moment and retry the job, or switch to a different provider.",
        )
    if isinstance(exc, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return ProviderError(
            "Anthropic rejected the API key.",
            provider=provider,
            category=ErrorCategory.AUTH,
            hint="Re-add it with `hustlclip config set-secret anthropic`.",
        )
    if isinstance(exc, anthropic.NotFoundError):
        return ProviderError(
            f"Anthropic does not recognise the model '{model}'.",
            provider=provider,
            category=ErrorCategory.MODEL_UNAVAILABLE,
            hint=f"Try one of: {', '.join(SUGGESTED_MODELS)}",
        )
    if isinstance(exc, anthropic.BadRequestError):
        return ProviderError(
            f"Anthropic rejected the request: {exc}",
            provider=provider,
            category=ErrorCategory.BAD_REQUEST,
        )
    if isinstance(exc, anthropic.APIStatusError) and exc.status_code >= 500:
        return ProviderError(
            "Anthropic is temporarily unavailable.",
            provider=provider,
            category=ErrorCategory.UNAVAILABLE,
        )

    message = str(exc)
    lowered = message.lower()

    if "authentication" in lowered or "invalid x-api-key" in lowered or "401" in lowered:
        return ProviderError(
            "Anthropic rejected the API key.",
            provider=provider,
            category=ErrorCategory.AUTH,
            hint="Re-add it with `hustlclip config set-secret anthropic`.",
        )
    if "rate limit" in lowered or "429" in lowered:
        return ProviderError(
            "Anthropic rate limit reached.",
            provider=provider,
            category=ErrorCategory.RATE_LIMIT,
            hint="Wait a moment and retry the job, or switch to a different provider.",
        )
    if "not_found" in lowered or "model" in lowered and "404" in lowered:
        return ProviderError(
            f"Anthropic does not recognise the model '{model}'.",
            provider=provider,
            category=ErrorCategory.MODEL_UNAVAILABLE,
            hint=f"Try one of: {', '.join(SUGGESTED_MODELS)}",
        )
    if "credit" in lowered or "billing" in lowered:
        return ProviderError(
            "Anthropic reports a billing or credit problem.",
            provider=provider,
            category=ErrorCategory.AUTH,
            hint="Check your plan at console.anthropic.com.",
        )
    return ProviderError(f"Anthropic request failed: {message}", provider=provider)


def _retry_after(exc: Exception) -> float | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None) or {}
    try:
        value = headers.get("retry-after")
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None
