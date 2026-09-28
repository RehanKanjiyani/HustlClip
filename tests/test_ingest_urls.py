"""Generic video links: what may be fetched, and what never may."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from autoclip import app as app_module
from autoclip.app import create_app
from autoclip.pipeline.ingest import is_supported_url
from fastapi.testclient import TestClient


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/watch?v=abc",
        "https://www.twitch.tv/videos/123",
        "https://example.com/vod.mp4",
        "http://8.8.8.8/v.mp4",
    ],
)
def test_public_links_are_supported(url: str) -> None:
    assert is_supported_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/v.mp4",
        "http://localhost:8000/api/settings",
        "http://127.0.0.1/v.mp4",
        "http://10.0.0.5/v.mp4",
        "http://192.168.1.10/v.mp4",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/v.mp4",
        "http://printer.local/v.mp4",
        "http://intranet/v.mp4",
        "not a url",
        "",
    ],
)
def test_local_and_private_targets_are_refused(url: str) -> None:
    assert not is_supported_url(url)


@pytest.fixture
def client(autoclip_home, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv(app_module.ENV_NO_WORKER, "1")
    with TestClient(create_app()) as test_client:
        yield test_client


def test_url_endpoint_refuses_private_targets_before_fetching(client, monkeypatch) -> None:
    from autoclip.pipeline import ingest

    def must_not_fetch(*args, **kwargs):
        raise AssertionError("fetched a refused URL")

    monkeypatch.setattr(ingest, "ingest_youtube", must_not_fetch)

    response = client.post("/api/sources/url", json={"url": "http://169.254.169.254/x"})

    assert response.status_code == 400
    assert response.json()["detail"]["hint"]


def test_url_endpoint_accepts_non_youtube_links(client, monkeypatch, tmp_path) -> None:
    from autoclip.db.models import Source, new_id
    from autoclip.pipeline import ingest

    def fake_fetch(url, settings):
        return Source(
            id=new_id(),
            type="upload",
            url=url,
            path=str(tmp_path / "v.mp4"),
            title="VOD",
            duration_s=3600.0,
        )

    monkeypatch.setattr(ingest, "ingest_youtube", fake_fetch)

    response = client.post("/api/sources/url", json={"url": "https://www.twitch.tv/videos/1"})

    assert response.status_code == 201
    assert response.json()["url"] == "https://www.twitch.tv/videos/1"
