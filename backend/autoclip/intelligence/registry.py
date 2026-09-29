"""The model registry — the one place model identities live.

Pipeline code asks for a *capability*; the registry says which models can serve
it and in what order. Changing which model does candidate discovery is an edit
here (or a user override in settings), never a pipeline change.

Priorities are "lower runs first". Default routing follows the product spec:

=====================  ==================================================
capability             default order
=====================  ==================================================
candidate_discovery    Nemotron 3.5 Lightning → GLM-5.3 Flash → Kimi K3
text_scoring           GLM-5.3 Flash → Kimi K3
visual_understanding   Kimi K3 → DeepSeek V4.1 Flash → GLM-5.3 Flash
final_judgment         configured premium model → Kimi K3
decision capabilities  Jev → GLM-5.3 Flash → Nemotron (LLM JSON path)
=====================  ==================================================

The provider API identifiers were checked against NVIDIA's public catalogue
(``GET https://integrate.api.nvidia.com/v1/models``) on 2026-09-29. Catalogues
rename things, so each is overridable via ``settings.ai.models[id].api_model``,
and an unknown model is simply skipped at runtime (``model_unavailable``).
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from ..config import Settings, get_secret
from . import capabilities as caps

# Tiers describe cost/strength, and are used only for the efficiency/quality
# routing strategies — never to pick a specific model.
FAST, MID, STRONG, PREMIUM, DECISION = "fast", "mid", "strong", "premium", "decision"

TEXT = "text"
IMAGE = "image"


@dataclass(frozen=True)
class ModelEntry:
    #: Stable registry id, e.g. "nvidia/kimi-k3". Used in settings and logs.
    id: str
    #: Provider adapter name (see autoclip.providers).
    provider: str
    #: Identifier the provider's API expects.
    api_model: str
    display_name: str
    #: capability -> priority (lower first).
    capabilities: dict[str, int]
    tier: str = MID
    input_modalities: tuple[str, ...] = (TEXT,)
    enabled: bool = True
    #: Wall-clock limit for one attempt, enforced by the manager.
    timeout_s: float = 180.0
    #: Retries on this model before falling back (safe categories only).
    max_retries: int = 1
    max_output_tokens: int = 8000
    #: Rough ceiling on prompt size this model should be sent, in tokens. The
    #: manager gates on a character-based estimate; it is never recorded as usage.
    max_input_tokens: int = 100_000
    temperature: float | None = 0.2
    #: Provider-specific request extras (e.g. {"effort": "high"} for Claude).
    options: dict[str, Any] = field(default_factory=dict)
    #: May this model be used as a fallback for another model's failure?
    fallback_eligible: bool = True

    def serves(self, capability: str) -> bool:
        return capability in self.capabilities

    def accepts(self, modality: str) -> bool:
        return modality in self.input_modalities


def default_models(settings: Settings) -> list[ModelEntry]:
    """The built-in registry before user overrides."""
    decision_llm = dict.fromkeys(caps.DECISION_CAPABILITIES, 30)
    decision_fast = dict.fromkeys(caps.DECISION_CAPABILITIES, 40)

    entries: list[ModelEntry] = [
        ModelEntry(
            id="nvidia/nemotron-3.5-lightning",
            provider="nvidia",
            api_model="nvidia/nemotron-3.5-lightning-30b-a3b",
            display_name="NVIDIA Nemotron 3.5 Lightning",
            capabilities={caps.CANDIDATE_DISCOVERY: 10, **decision_fast},
            tier=FAST,
            max_output_tokens=6000,
        ),
        ModelEntry(
            id="nvidia/glm-5.3-flash",
            provider="nvidia",
            api_model="z-ai/glm-5.3-flash",
            display_name="GLM-5.3 Flash (NVIDIA)",
            capabilities={
                caps.CANDIDATE_DISCOVERY: 20,
                caps.TEXT_SCORING: 10,
                caps.VISUAL_UNDERSTANDING: 30,
                **decision_llm,
            },
            tier=MID,
            # Listed for visual understanding by the routing policy; if the
            # hosted model rejects images the manager marks it unsupported.
            input_modalities=(TEXT, IMAGE),
        ),
        ModelEntry(
            id="nvidia/kimi-k3",
            provider="nvidia",
            api_model="moonshotai/kimi-k3",
            display_name="Kimi K3 (NVIDIA)",
            capabilities={
                caps.CANDIDATE_DISCOVERY: 30,
                caps.TEXT_SCORING: 20,
                caps.VISUAL_UNDERSTANDING: 10,
                caps.FINAL_JUDGMENT: 20,
                caps.DYNAMIC_COMPOSITION: 10,
            },
            tier=STRONG,
            input_modalities=(TEXT, IMAGE),
            timeout_s=300.0,
            max_output_tokens=12000,
        ),
        ModelEntry(
            id="nvidia/deepseek-v4.1-flash",
            provider="nvidia",
            api_model="deepseek-ai/deepseek-v4.1-flash",
            display_name="DeepSeek V4.1 Flash (NVIDIA)",
            capabilities={caps.VISUAL_UNDERSTANDING: 20},
            tier=MID,
            input_modalities=(TEXT, IMAGE),
        ),
        ModelEntry(
            id="typesafe/jev",
            provider="typesafe",
            api_model=settings.provider("typesafe").model or "jev-latest",
            display_name="TypeSafe Jev",
            capabilities=dict.fromkeys(caps.DECISION_CAPABILITIES, 10),
            tier=DECISION,
            timeout_s=30.0,
            # Documented: 32k tokens for state plus the longest question.
            max_input_tokens=30_000,
            temperature=None,
        ),
    ]

    entries.extend(_configured_provider_entries(settings))
    return entries


def _configured_provider_entries(settings: Settings) -> list[ModelEntry]:
    """Entries for the user's own configured text providers.

    The *active* provider is the "configured premium reasoning model": first in
    line for final judgment. The others are general fallbacks so a job still
    completes when only one key is configured.
    """
    entries: list[ModelEntry] = []
    for name in ("anthropic", "openai", "gemini", "ollama"):
        model = settings.provider(name).model
        if not model and name != "anthropic":
            continue
        active = settings.active_provider == name
        text_fallback = {
            caps.CANDIDATE_DISCOVERY: 70,
            caps.TEXT_SCORING: 60,
            caps.FINAL_JUDGMENT: 10 if active else 60,
            caps.DYNAMIC_COMPOSITION: 20 if active else 60,
            **dict.fromkeys(caps.DECISION_CAPABILITIES, 80),
        }
        modalities = (TEXT, IMAGE) if name in ("anthropic", "openai") else (TEXT,)
        if IMAGE in modalities:
            text_fallback[caps.VISUAL_UNDERSTANDING] = 50
        entries.append(
            ModelEntry(
                id=f"{name}/configured",
                provider=name,
                api_model=model,
                display_name=f"{name.title()} ({model or 'default model'})",
                capabilities=text_fallback,
                tier=PREMIUM if active else STRONG,
                input_modalities=modalities,
                timeout_s=300.0,
                max_output_tokens=16000,
                # Local models run on the same GPU as the rest of the pipeline.
                max_input_tokens=24_000 if name == "ollama" else 150_000,
            )
        )
    # Also allow NVIDIA as the "active provider" with an explicitly chosen model.
    nvidia_model = settings.provider("nvidia").model
    if settings.active_provider == "nvidia" and nvidia_model:
        entries.append(
            ModelEntry(
                id="nvidia/configured",
                provider="nvidia",
                api_model=nvidia_model,
                display_name=f"NVIDIA ({nvidia_model})",
                capabilities={caps.FINAL_JUDGMENT: 10, caps.DYNAMIC_COMPOSITION: 20},
                tier=PREMIUM,
                timeout_s=300.0,
                max_output_tokens=12000,
            )
        )
    return entries


def _apply_strategy(entry: ModelEntry, settings: Settings) -> ModelEntry:
    strategy = settings.ai.routing
    capabilities = dict(entry.capabilities)

    if strategy == "efficiency":
        # Keep premium tokens for nothing a strong mid-price model can do.
        if entry.tier == PREMIUM:
            capabilities = {c: p + 30 for c, p in capabilities.items()}
    elif strategy == "quality":
        # Let the strongest configured model score and look, not only judge.
        if entry.tier == PREMIUM:
            for capability in (caps.TEXT_SCORING, caps.VISUAL_UNDERSTANDING):
                if capability in capabilities:
                    capabilities[capability] = 5
        if entry.tier == FAST and caps.CANDIDATE_DISCOVERY in capabilities:
            capabilities[caps.CANDIDATE_DISCOVERY] += 25
    elif strategy == "custom":
        for capability, preferred in settings.ai.preferred.items():
            if entry.id in preferred and capability in capabilities:
                capabilities[capability] = -100 + preferred.index(entry.id)

    return replace(entry, capabilities=capabilities)


def build_registry(settings: Settings) -> list[ModelEntry]:
    """Defaults, then routing strategy, then per-model user overrides."""
    entries: list[ModelEntry] = []
    for entry in default_models(settings):
        entry = _apply_strategy(entry, settings)
        override = settings.ai.models.get(entry.id)
        if override is not None:
            if override.enabled is not None:
                entry = replace(entry, enabled=override.enabled)
            if override.api_model:
                entry = replace(entry, api_model=override.api_model)
        entries.append(entry)
    return entries


def provider_configured(provider: str, settings: Settings) -> bool:
    """Is a provider usable at all — key present (or none needed), not disabled?"""
    if provider in settings.ai.disabled_providers:
        return False
    if provider == "ollama":
        # No key; treated as configured only when the user chose it, since
        # probing a local server on every routing decision would be wasteful.
        return settings.active_provider == "ollama"
    return get_secret(provider, settings) is not None


def candidates_for(
    registry: list[ModelEntry],
    capability: str,
    *,
    modality: str = TEXT,
    settings: Settings,
) -> list[ModelEntry]:
    """Eligible entries for a capability in priority order (stable by id)."""
    eligible = [
        entry
        for entry in registry
        if entry.enabled
        and entry.serves(capability)
        and entry.accepts(modality)
        and provider_configured(entry.provider, settings)
        and (entry.provider != "typesafe" or capability in caps.DECISION_CAPABILITIES)
    ]
    return sorted(eligible, key=lambda e: (e.capabilities[capability], e.id))
