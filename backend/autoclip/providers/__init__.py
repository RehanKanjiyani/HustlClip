"""AI provider adapters.

Text-generating adapters share one interface (:class:`LLMProvider`).
``openai`` is the widest: its configurable base URL also serves OpenRouter,
Groq, DeepSeek, Together, and any local OpenAI-compatible server; ``nvidia`` is
the same adapter pointed at NVIDIA's hosted catalogue. ``typesafe`` (Jev) is a
structured-decision provider with its own interface.

Pipeline code never builds providers directly for AI work — it asks the AI
manager (:mod:`autoclip.intelligence`) for a capability.
"""

from __future__ import annotations

from ..config import Settings, get_secret
from .anthropic_provider import AnthropicProvider
from .base import (
    Completion,
    DetectionConfig,
    ErrorCategory,
    GenerationRequest,
    ImageInput,
    LLMProvider,
    ProviderError,
    ProviderStatus,
    TranscriptWindow,
)
from .gemini_provider import GeminiProvider
from .ollama_provider import OllamaProvider
from .openai_provider import NvidiaProvider, OpenAIProvider
from .typesafe_provider import TypeSafeProvider

__all__ = [
    "DECISION_PROVIDERS",
    "PROVIDERS",
    "AnthropicProvider",
    "Completion",
    "DetectionConfig",
    "ErrorCategory",
    "GeminiProvider",
    "GenerationRequest",
    "ImageInput",
    "LLMProvider",
    "NvidiaProvider",
    "OllamaProvider",
    "OpenAIProvider",
    "ProviderError",
    "ProviderStatus",
    "TranscriptWindow",
    "TypeSafeProvider",
    "build_decision_provider",
    "build_provider",
    "detection_config",
    "provider_names",
]

PROVIDERS: dict[str, type[LLMProvider]] = {
    "anthropic": AnthropicProvider,
    "openai": OpenAIProvider,
    "gemini": GeminiProvider,
    "ollama": OllamaProvider,
    "nvidia": NvidiaProvider,
}

#: Providers that answer typed questions instead of generating text.
DECISION_PROVIDERS: dict[str, type[TypeSafeProvider]] = {
    "typesafe": TypeSafeProvider,
}


def provider_names() -> list[str]:
    return list(PROVIDERS)


def build_provider(
    name: str | None = None, settings: Settings | None = None, *, model: str | None = None
) -> LLMProvider:
    """Construct a configured text provider.

    Pulls the model and base URL from settings and the API key from the keyring,
    so callers never handle secrets themselves. ``model`` overrides the settings
    model — the AI manager uses it to address registry entries.
    """
    from ..config import load

    settings = settings if settings is not None else load()
    key = name or settings.active_provider

    provider_cls = PROVIDERS.get(key)
    if provider_cls is None:
        raise ProviderError(
            f"Unknown provider '{key}'.",
            category=ErrorCategory.NOT_CONFIGURED,
            hint=f"Available providers: {', '.join(PROVIDERS)}",
        )

    provider_settings = settings.provider(key)
    api_key = get_secret(key, settings) if provider_cls.requires_key else None

    return provider_cls(
        model or provider_settings.model,
        api_key=api_key,
        base_url=provider_settings.base_url,
    )


def build_decision_provider(
    name: str, settings: Settings | None = None, *, model: str | None = None
) -> TypeSafeProvider:
    from ..config import load

    settings = settings if settings is not None else load()
    provider_cls = DECISION_PROVIDERS.get(name)
    if provider_cls is None:
        raise ProviderError(
            f"Unknown decision provider '{name}'.", category=ErrorCategory.NOT_CONFIGURED
        )
    provider_settings = settings.provider(name)
    return provider_cls(
        model or provider_settings.model,
        api_key=get_secret(name, settings),
        base_url=provider_settings.base_url,
    )


def detection_config(settings: Settings | None = None) -> DetectionConfig:
    """Build a :class:`DetectionConfig` from user settings."""
    from ..config import load

    settings = settings if settings is not None else load()
    return DetectionConfig(
        min_duration_s=settings.clips.min_duration_s,
        max_duration_s=settings.clips.max_duration_s,
        max_clips=settings.clips.max_clips,
        language=settings.whisper.language,
    )
