"""OpenAI-compatible provider.

Deliberately the widest adapter. Because ``base_url`` is configurable and the
Chat Completions shape is a de-facto standard, this one class also covers
OpenRouter, Groq, DeepSeek, Together, Fireworks, vLLM, a local LM Studio server
— and, through :class:`NvidiaProvider`, NVIDIA's hosted model catalogue.
"""

from __future__ import annotations

import logging

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

DEFAULT_MODEL = "gpt-4o"

SUGGESTED_MODELS = [
    "gpt-4o",
    "gpt-4o-mini",
    "o4-mini",
]

#: Ready-made endpoints for the settings UI. Users can enter any other URL.
KNOWN_ENDPOINTS = {
    "OpenAI": "https://api.openai.com/v1",
    "NVIDIA": "https://integrate.api.nvidia.com/v1",
    "OpenRouter": "https://openrouter.ai/api/v1",
    "Groq": "https://api.groq.com/openai/v1",
    "DeepSeek": "https://api.deepseek.com/v1",
    "Together": "https://api.together.xyz/v1",
    "LM Studio (local)": "http://localhost:1234/v1",
}


class OpenAIProvider(LLMProvider):
    name = "openai"
    requires_key = True
    supports_images = True

    #: Ask for ``response_format=json_object``. Only OpenAI's own endpoint
    #: reliably honours it; a 400 on it is retried once without.
    json_response_format = True
    #: Send ``max_tokens``. OpenAI's reasoning models reject it, but some
    #: hosted catalogues default to a small completion limit that truncates JSON.
    send_max_tokens = False
    default_base_url: str | None = None
    #: Settings key for this adapter's API key.
    secret_key = "openai"

    def __init__(self, model: str = "", *, api_key: str | None = None, base_url: str | None = None):
        super().__init__(
            model or self._default_model(), api_key=api_key, base_url=base_url or self.default_base_url
        )

    def _default_model(self) -> str:
        return DEFAULT_MODEL

    def _client(self):
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:  # pragma: no cover - openai is a core dep
            raise ProviderError("The openai package is not installed.", provider=self.name) from exc

        # Local servers ignore the key but the SDK still requires a non-empty
        # value, so supply a placeholder rather than failing the request.
        key = self.api_key or ("not-needed" if self._is_local() else None)
        if not key:
            raise ProviderError(
                f"No API key is set for the {self.name} provider.",
                provider=self.name,
                category=ErrorCategory.NOT_CONFIGURED,
                hint=f"Add one with `hustlclip config set-secret {self.secret_key}`.",
            )

        # One SDK retry; model fallback is the AI manager's job.
        kwargs = {"api_key": key, "max_retries": 1}
        if self.base_url:
            kwargs["base_url"] = self.base_url
        return AsyncOpenAI(**kwargs)

    def _is_local(self) -> bool:
        return bool(self.base_url) and (
            "localhost" in self.base_url or "127.0.0.1" in self.base_url
        )

    async def _complete(self, system: str, user: str, config: DetectionConfig) -> str:
        completion = await self.generate(
            GenerationRequest(system=system, user=user, temperature=config.temperature)
        )
        return completion.text

    async def generate(self, request: GenerationRequest) -> Completion:
        client = self._client()

        if request.images:
            user_content: str | list[dict] = [{"type": "text", "text": request.user}] + [
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{image.media_type};base64,{image.b64()}"},
                }
                for image in request.images
            ]
        else:
            user_content = request.user

        params: dict = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": user_content},
            ],
        }
        if request.temperature is not None:
            params["temperature"] = request.temperature
        if self.send_max_tokens:
            params["max_tokens"] = request.max_tokens

        try:
            if self.json_response_format and not request.images:
                try:
                    response = await client.chat.completions.create(
                        **params, response_format={"type": "json_object"}
                    )
                except Exception as exc:
                    if not _is_unsupported_parameter(exc):
                        raise
                    log.debug("Endpoint rejected response_format; retrying without it.")
                    response = await client.chat.completions.create(**params)
            else:
                response = await client.chat.completions.create(**params)
        except Exception as exc:
            raise _translate(exc, self.name, self.model, bool(request.images)) from exc

        choices = response.choices or []
        if not choices:
            raise ProviderError(
                "The endpoint returned no choices.",
                provider=self.name,
                category=ErrorCategory.INCOMPLETE,
            )
        choice = choices[0]
        text = choice.message.content or ""
        finish = getattr(choice, "finish_reason", None)
        if finish == "length":
            raise ProviderError(
                "The response was cut off at the output limit.",
                provider=self.name,
                category=ErrorCategory.INCOMPLETE,
            )

        usage = getattr(response, "usage", None)
        return Completion(
            text=text,
            model=getattr(response, "model", None) or self.model,
            input_tokens=getattr(usage, "prompt_tokens", None),
            output_tokens=getattr(usage, "completion_tokens", None),
            stop_reason=finish,
        )

    async def health_check(self) -> ProviderStatus:
        if not self.api_key and not self._is_local():
            return ProviderStatus(
                name=self.name, available=False, detail="No API key set", models=SUGGESTED_MODELS
            )
        try:
            client = self._client()
            models = await client.models.list()
            names = sorted(m.id for m in models.data)[:50]
        except Exception as exc:
            return ProviderStatus(name=self.name, available=False, detail=str(exc)[:200])
        return ProviderStatus(
            name=self.name,
            available=True,
            detail=self.base_url or "https://api.openai.com/v1",
            models=names or SUGGESTED_MODELS,
        )


class NvidiaProvider(OpenAIProvider):
    """NVIDIA's hosted catalogue (build.nvidia.com), an OpenAI-compatible API.

    Model IDs are namespaced by publisher, e.g. ``moonshotai/kimi-k3``; the
    catalogue is listed at ``GET /v1/models``.
    """

    name = "nvidia"
    secret_key = "nvidia"
    default_base_url = "https://integrate.api.nvidia.com/v1"
    # Not all hosted models honour response_format, and a 400 on it would
    # cost a round trip per call; prompts already demand JSON.
    json_response_format = False
    # Hosted models default to a small completion limit that truncates JSON.
    send_max_tokens = True

    def _default_model(self) -> str:
        return "moonshotai/kimi-k3"

    async def health_check(self) -> ProviderStatus:
        # The catalogue listing is public, so it proves reachability but not
        # that the key is valid; the first real call does that.
        status = await super().health_check()
        if status.available:
            status.detail = "Reachable (key is checked on first use)"
        return status


def _is_unsupported_parameter(exc: Exception) -> bool:
    lowered = str(exc).lower()
    return "response_format" in lowered or "unsupported" in lowered or "unrecognized" in lowered


def _translate(exc: Exception, provider: str, model: str, had_images: bool = False) -> ProviderError:
    """Map SDK exceptions to categorised provider errors."""
    import openai

    status = getattr(exc, "status_code", None)
    # APITimeoutError subclasses APIConnectionError, so check it first.
    if isinstance(exc, openai.APITimeoutError):
        return ProviderError("The endpoint timed out.", provider=provider, category=ErrorCategory.TIMEOUT)
    if isinstance(exc, openai.APIConnectionError):
        return ProviderError(
            "Could not reach the endpoint.",
            provider=provider,
            category=ErrorCategory.CONNECTION,
            hint="Check the base URL in settings, and that any local server is running.",
        )
    if isinstance(exc, openai.RateLimitError):
        lowered = str(exc).lower()
        if "quota" in lowered or "billing" in lowered:
            return ProviderError(
                "The account has no remaining quota.", provider=provider, category=ErrorCategory.AUTH
            )
        return ProviderError(
            "Rate limit reached.",
            provider=provider,
            category=ErrorCategory.RATE_LIMIT,
            retry_after_s=_retry_after(exc),
            hint="Wait and retry, or switch providers.",
        )
    if isinstance(exc, (openai.AuthenticationError, openai.PermissionDeniedError)):
        return ProviderError(
            "The endpoint rejected the API key.",
            provider=provider,
            category=ErrorCategory.AUTH,
            hint=f"Re-add it with `hustlclip config set-secret {provider}`.",
        )
    if isinstance(exc, openai.NotFoundError):
        return ProviderError(
            f"The endpoint does not recognise the model '{model}'.",
            provider=provider,
            category=ErrorCategory.MODEL_UNAVAILABLE,
            hint="Check the model name against your provider's catalogue.",
        )
    if isinstance(exc, (openai.BadRequestError, openai.UnprocessableEntityError)):
        category = ErrorCategory.UNSUPPORTED_MODALITY if had_images else ErrorCategory.BAD_REQUEST
        return ProviderError(f"Request rejected: {exc}", provider=provider, category=category)
    if isinstance(status, int) and status >= 500:
        return ProviderError(
            "The endpoint is temporarily unavailable.",
            provider=provider,
            category=ErrorCategory.UNAVAILABLE,
        )

    message = str(exc)
    lowered = message.lower()

    if "401" in lowered or "invalid api key" in lowered or "incorrect api key" in lowered:
        return ProviderError(
            "The endpoint rejected the API key.",
            provider=provider,
            category=ErrorCategory.AUTH,
            hint=f"Re-add it with `hustlclip config set-secret {provider}`.",
        )
    if "429" in lowered or "rate limit" in lowered:
        return ProviderError(
            "Rate limit reached.",
            provider=provider,
            category=ErrorCategory.RATE_LIMIT,
            hint="Wait and retry, or switch providers.",
        )
    if "404" in lowered or "does not exist" in lowered or "model_not_found" in lowered:
        return ProviderError(
            f"The endpoint does not recognise the model '{model}'.",
            provider=provider,
            category=ErrorCategory.MODEL_UNAVAILABLE,
            hint="Check the model name against your provider's catalogue.",
        )
    if "connection" in lowered or "connect" in lowered:
        return ProviderError(
            "Could not reach the endpoint.",
            provider=provider,
            category=ErrorCategory.CONNECTION,
            hint="Check the base URL in settings, and that any local server is running.",
        )
    if "quota" in lowered or "billing" in lowered:
        return ProviderError(
            "The account has no remaining quota.", provider=provider, category=ErrorCategory.AUTH
        )

    return ProviderError(f"Request failed: {message}", provider=provider)


def _retry_after(exc: Exception) -> float | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None) or {}
    try:
        value = headers.get("retry-after")
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None
