"""Settings, secrets, provider health, and system status."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException

from .. import config, models, system
from ..intelligence import AIManager, build_registry, capabilities
from ..intelligence.registry import provider_configured
from ..providers import DECISION_PROVIDERS, PROVIDERS, build_decision_provider, build_provider
from ..providers.base import ProviderStatus
from .schemas import (
    AIModelOut,
    AIProviderOut,
    AIStatusOut,
    ProviderStatusOut,
    SecretIn,
    SettingsIn,
    SettingsOut,
    SystemOut,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["settings"])


def _settings_out(settings: config.Settings) -> SettingsOut:
    payload = settings.model_dump(mode="json")
    return SettingsOut(
        active_provider=payload["active_provider"],
        providers=payload["providers"],
        whisper=payload["whisper"],
        clips=payload["clips"],
        ingest=payload["ingest"],
        export=payload["export"],
        insecure_secret_storage=payload["insecure_secret_storage"],
        ai=payload["ai"],
        keys_present={
            name: config.get_secret(name, settings) is not None for name in config.KEYED_PROVIDERS
        }
        | {config.HF_TOKEN_KEY: config.get_secret(config.HF_TOKEN_KEY, settings) is not None},
    )


@router.get("/settings", response_model=SettingsOut)
async def get_settings() -> SettingsOut:
    return _settings_out(config.load())


@router.put("/settings", response_model=SettingsOut)
async def put_settings(payload: SettingsIn) -> SettingsOut:
    """Merge a partial settings update and persist it."""
    settings = config.load()
    updates = payload.model_dump(exclude_none=True)

    if "active_provider" in updates:
        if updates["active_provider"] not in PROVIDERS:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown provider. Available: {', '.join(PROVIDERS)}",
            )
        settings.active_provider = updates["active_provider"]

    for section in ("whisper", "clips", "ingest", "export"):
        if section in updates:
            current = getattr(settings, section)
            try:
                setattr(
                    settings,
                    section,
                    current.model_copy(update=updates[section]).model_validate(
                        current.model_dump() | updates[section]
                    ),
                )
            except Exception as exc:
                raise HTTPException(
                    status_code=400, detail=f"Invalid {section} settings: {exc}"
                ) from exc

    if "providers" in updates:
        for name, values in updates["providers"].items():
            provider_settings = settings.provider(name)
            settings.providers[name] = provider_settings.model_copy(update=values)

    if "ai" in updates:
        try:
            merged = settings.ai.model_dump() | updates["ai"]
            settings.ai = config.AISettings.model_validate(merged)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid AI settings: {exc}") from exc
        known_models = {entry.id for entry in build_registry(settings)}
        unknown = [m for m in settings.ai.models if m not in known_models] + [
            m for ids in settings.ai.preferred.values() for m in ids if m not in known_models
        ]
        if unknown:
            raise HTTPException(
                status_code=400, detail=f"Unknown model id(s): {', '.join(sorted(set(unknown)))}"
            )
        unknown_caps = [c for c in settings.ai.preferred if c not in capabilities.SPECS]
        if unknown_caps:
            raise HTTPException(
                status_code=400, detail=f"Unknown capability: {', '.join(unknown_caps)}"
            )

    if settings.clips.min_duration_s >= settings.clips.max_duration_s:
        raise HTTPException(
            status_code=400, detail="Minimum clip length must be below the maximum."
        )

    config.save(settings)
    return _settings_out(settings)


@router.put("/settings/secrets", status_code=204)
async def put_secret(payload: SecretIn) -> None:
    """Store an API key or token. Values are write-only — never read back."""
    valid = (*config.KEYED_PROVIDERS, config.HF_TOKEN_KEY)
    if payload.key not in valid:
        raise HTTPException(
            status_code=400, detail=f"Unknown secret. Expected one of: {', '.join(valid)}"
        )
    if not payload.value.strip():
        raise HTTPException(status_code=400, detail="The value cannot be empty.")

    config.set_secret(payload.key, payload.value.strip())


@router.delete("/settings/secrets/{key}", status_code=204)
async def delete_secret(key: str) -> None:
    config.delete_secret(key)


@router.get("/providers/status", response_model=list[ProviderStatusOut])
async def providers_status() -> list[ProviderStatusOut]:
    """Live health for every provider, checked concurrently."""
    settings = config.load()

    async def check(name: str) -> ProviderStatusOut:
        provider_cls = PROVIDERS[name]
        has_key = (
            config.get_secret(name, settings) is not None if provider_cls.requires_key else True
        )
        try:
            provider = build_provider(name, settings)
            status: ProviderStatus = await provider.health_check()
        except Exception as exc:
            status = ProviderStatus(name=name, available=False, detail=str(exc)[:200])

        return ProviderStatusOut(
            name=name,
            available=status.available,
            detail=status.detail,
            models=status.models,
            requires_key=provider_cls.requires_key,
            has_key=has_key,
        )

    async def check_decision(name: str) -> ProviderStatusOut:
        has_key = config.get_secret(name, settings) is not None
        try:
            status = await build_decision_provider(name, settings).health_check()
        except Exception as exc:
            status = ProviderStatus(name=name, available=False, detail=str(exc)[:200])
        return ProviderStatusOut(
            name=name,
            available=status.available,
            detail=status.detail,
            models=status.models,
            requires_key=True,
            has_key=has_key,
        )

    return list(
        await asyncio.gather(
            *(check(name) for name in PROVIDERS),
            *(check_decision(name) for name in DECISION_PROVIDERS),
        )
    )


@router.get("/ai/status", response_model=AIStatusOut)
async def ai_status() -> AIStatusOut:
    """Which providers and models the AI manager can use, and in what order.

    Computed from configuration only — no network calls — so it is cheap
    enough for the settings screen to poll. Key values are never included.
    """
    settings = config.load()
    registry = build_registry(settings)
    providers = sorted({entry.provider for entry in registry} | set(DECISION_PROVIDERS))

    def state(name: str) -> str:
        if name in settings.ai.disabled_providers:
            return "disabled"
        return "configured" if provider_configured(name, settings) else "not_configured"

    manager = AIManager(settings, registry=registry)
    return AIStatusOut(
        routing=settings.ai.routing,
        providers=[AIProviderOut(name=name, state=state(name)) for name in providers],
        models=[
            AIModelOut(
                id=entry.id,
                display_name=entry.display_name,
                provider=entry.provider,
                enabled=entry.enabled,
                configured=provider_configured(entry.provider, settings),
                capabilities=sorted(entry.capabilities),
                input_modalities=list(entry.input_modalities),
            )
            for entry in registry
        ],
        routes={name: [e.id for e in manager.eligible(name)] for name in capabilities.SPECS},
    )


@router.get("/system", response_model=SystemOut)
async def system_status() -> SystemOut:
    report = await asyncio.to_thread(system.refresh)
    return SystemOut(
        ready=report.ready,
        python_version=report.python_version,
        platform=report.platform,
        ffmpeg_version=report.ffmpeg.version,
        has_libass=report.ffmpeg.has_libass,
        nvenc_works=report.ffmpeg.nvenc_works,
        accel=report.gpu.accel,
        gpu_name=report.gpu.name,
        compute_type=report.gpu.compute_type,
        diarization_available=report.deps.whisperx,
    )


@router.post("/system/models", status_code=204)
async def fetch_models() -> None:
    """Download any missing ML model bundles."""
    for key in models.MODELS:
        if not models.is_available(key):
            try:
                await asyncio.to_thread(models.ensure, key)
            except models.ModelDownloadError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
