"""API additions for HustlClip: download-all, AI status, decision records, AI
settings, clip metadata, per-job settings, and static-file containment."""

from __future__ import annotations

import io
import zipfile
from collections.abc import Iterator

import pytest
from autoclip import app as app_module
from autoclip import config, paths
from autoclip.app import create_app
from autoclip.db import store
from autoclip.db.models import AIDecision, Clip, Export, Job, Source, new_id
from autoclip.pipeline.runner import job_settings
from fastapi.testclient import TestClient


@pytest.fixture
def client(autoclip_home, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv(app_module.ENV_NO_WORKER, "1")
    with TestClient(create_app()) as test_client:
        yield test_client


@pytest.fixture
def job(client) -> Job:
    source = store.create_source(
        Source(id=new_id(), type="upload", path="C:/media/v.mp4", title="S", duration_s=900.0)
    )
    return store.create_job(Job(id=new_id(), source_id=source.id, status="done"))


def add_clips(job: Job, *specs: tuple[int, str, bool]) -> list[Clip]:
    """Insert clips (rank, quality, exported) in one go.

    One replace_clips call: it deletes and re-inserts, and the delete cascades
    to exports, so adding clips one by one would silently drop earlier exports.
    """
    clips = [
        Clip(
            id=new_id(),
            job_id=job.id,
            start_s=rank * 60.0,
            end_s=rank * 60.0 + 30,
            rank=rank,
            title=f"Clip / number {rank}?",
            details={"moment_type": "story_payoff", "topic": "money", "quality": quality},
        )
        for rank, quality, _ in specs
    ]
    store.replace_clips(job.id, clips)
    folder = paths.exports_dir() / job.id
    folder.mkdir(parents=True, exist_ok=True)
    for clip, (rank, _, exported) in zip(clips, specs, strict=True):
        if exported:
            file = folder / f"clip{rank}.mp4"
            file.write_bytes(b"\x00\x00\x00\x18ftypmp42" + bytes([rank]) * 64)
            store.create_export(Export(id=new_id(), clip_id=clip.id, path=str(file), size_bytes=80))
    return clips


class TestDownloadAll:
    def test_zip_contains_every_rendered_clip_in_rank_order(self, client, job) -> None:
        add_clips(job, (2, "selected", True), (1, "selected", True), (3, "selected", True))

        response = client.get(f"/api/jobs/{job.id}/download-all")

        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"
        names = sorted(zipfile.ZipFile(io.BytesIO(response.content)).namelist())
        assert names == [
            "01 - Clip  number 1.mp4",
            "02 - Clip  number 2.mp4",
            "03 - Clip  number 3.mp4",
        ]

    def test_unrendered_clips_are_skipped(self, client, job) -> None:
        add_clips(job, (1, "selected", True), (2, "selected", False))

        response = client.get(f"/api/jobs/{job.id}/download-all")

        assert len(zipfile.ZipFile(io.BytesIO(response.content)).namelist()) == 1

    def test_nothing_rendered_is_404(self, client, job) -> None:
        add_clips(job, (1, "selected", False))

        assert client.get(f"/api/jobs/{job.id}/download-all").status_code == 404

    def test_unknown_job_is_404(self, client) -> None:
        assert client.get("/api/jobs/nope/download-all").status_code == 404


class TestClipMetadata:
    def test_clip_exposes_moment_type_and_quality(self, client, job) -> None:
        add_clips(job, (1, "selected", True), (2, "fallback", True))

        clips = client.get(f"/api/jobs/{job.id}/clips").json()

        assert clips[0]["moment_type"] == "story_payoff"
        assert clips[0]["topic"] == "money"
        assert [c["quality"] for c in clips] == ["selected", "fallback"]


class TestAIStatus:
    def test_reports_states_without_key_material(self, client, fake_keyring) -> None:
        client.put("/api/settings/secrets", json={"key": "nvidia", "value": "nvapi-SECRET123"})

        response = client.get("/api/ai/status")

        assert response.status_code == 200
        assert "SECRET123" not in response.text
        body = response.json()
        states = {p["name"]: p["state"] for p in body["providers"]}
        assert states["nvidia"] == "configured"
        assert states["typesafe"] == "not_configured"
        assert body["routes"]["candidate_discovery"][0] == "nvidia/nemotron-3.5-lightning"
        assert body["routing"] == "automatic"

    def test_disabled_provider_is_reported_and_unrouted(self, client, fake_keyring) -> None:
        client.put("/api/settings/secrets", json={"key": "nvidia", "value": "nvapi-x"})
        client.put("/api/settings", json={"ai": {"disabled_providers": ["nvidia"]}})

        body = client.get("/api/ai/status").json()

        assert {p["name"]: p["state"] for p in body["providers"]}["nvidia"] == "disabled"
        assert body["routes"]["candidate_discovery"] == []


class TestAISettings:
    def test_routing_strategy_round_trips(self, client) -> None:
        response = client.put("/api/settings", json={"ai": {"routing": "efficiency"}})

        assert response.status_code == 200
        assert client.get("/api/settings").json()["ai"]["routing"] == "efficiency"

    def test_invalid_strategy_is_rejected(self, client) -> None:
        assert client.put("/api/settings", json={"ai": {"routing": "yolo"}}).status_code == 400

    def test_unknown_model_id_is_rejected(self, client) -> None:
        response = client.put(
            "/api/settings", json={"ai": {"models": {"made/up": {"enabled": False}}}}
        )

        assert response.status_code == 400
        assert "made/up" in response.json()["detail"]

    def test_model_can_be_disabled(self, client) -> None:
        response = client.put(
            "/api/settings", json={"ai": {"models": {"nvidia/kimi-k3": {"enabled": False}}}}
        )

        assert response.status_code == 200
        models = {m["id"]: m for m in client.get("/api/ai/status").json()["models"]}
        assert models["nvidia/kimi-k3"]["enabled"] is False

    def test_secrets_are_accepted_for_the_new_providers(self, client, fake_keyring) -> None:
        for key in ("nvidia", "typesafe"):
            assert (
                client.put("/api/settings/secrets", json={"key": key, "value": "x"}).status_code
                == 204
            )
        assert config.get_secret("typesafe") == "x"


class TestDecisionRecords:
    def test_records_and_totals(self, client, job) -> None:
        store.add_ai_decision(
            AIDecision(
                job_id=job.id,
                capability="candidate_discovery",
                provider="nvidia",
                model="m1",
                attempt=1,
                status="error",
                error_category="rate_limit",
            )
        )
        store.add_ai_decision(
            AIDecision(
                job_id=job.id,
                capability="candidate_discovery",
                provider="nvidia",
                model="m2",
                attempt=2,
                status="success",
                fallback_used=True,
                input_tokens=1000,
                output_tokens=200,
            )
        )
        store.add_ai_decision(
            AIDecision(
                job_id=job.id,
                capability="final_judgment",
                provider="anthropic",
                model="m3",
                attempt=1,
                status="success",
            )
        )

        body = client.get(f"/api/jobs/{job.id}/ai-decisions").json()

        assert len(body["decisions"]) == 3
        assert body["input_tokens"] == 1000  # unreported usage is not counted as zero
        assert body["output_tokens"] == 200
        assert body["fallbacks"] == 1
        assert body["failures"] == 1
        assert body["decisions"][2]["input_tokens"] is None


class TestJobSettings:
    def test_per_job_overrides_reach_the_pipeline(self, client, job) -> None:
        response = client.post(
            "/api/jobs",
            json={
                "source_id": job.source_id,
                "settings": {"max_clips": 7, "caption_style": "boxed", "dynamic_composition": True},
            },
        )
        created = store.get_job(response.json()["id"])

        effective = job_settings(created)

        assert effective.clips.max_clips == 7
        assert effective.export.caption_style == "boxed"
        assert effective.ai.dynamic_composition is True

    def test_routing_changes_apply_to_existing_jobs_on_retry(self, client, job) -> None:
        response = client.post("/api/jobs", json={"source_id": job.source_id})
        created = store.get_job(response.json()["id"])
        client.put("/api/settings", json={"ai": {"routing": "quality"}})

        assert job_settings(created).ai.routing == "quality"


class TestStaticContainment:
    def test_parent_directory_paths_never_escape_the_bundle(self, client, tmp_path, monkeypatch):
        bundle = tmp_path / "bundle"
        (bundle / "assets").mkdir(parents=True)
        (bundle / "index.html").write_text("<html>app</html>", encoding="utf-8")
        (tmp_path / "secret.txt").write_text("do not serve", encoding="utf-8")
        monkeypatch.setattr(app_module, "static_dir", lambda: bundle)

        with TestClient(create_app()) as fresh:
            response = fresh.get("/..%2Fsecret.txt")

        assert "do not serve" not in response.text
