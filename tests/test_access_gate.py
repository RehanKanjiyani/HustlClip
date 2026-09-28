"""The optional access gate used when HustlClip is reachable from the internet."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from autoclip import app as app_module
from autoclip.app import create_app
from fastapi.testclient import TestClient

TOKEN = "s3cret-token-value"


@pytest.fixture
def gated(autoclip_home, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv(app_module.ENV_NO_WORKER, "1")
    monkeypatch.setenv(app_module.ENV_ACCESS_TOKEN, TOKEN)
    with TestClient(create_app()) as client:
        yield client


def test_everything_but_health_needs_the_token(gated: TestClient) -> None:
    assert gated.get("/api/health").status_code == 200
    assert gated.get("/api/jobs").status_code == 401
    assert gated.get("/api/settings").status_code == 401
    assert (
        gated.post("/api/sources/url", json={"url": "https://example.com/v.mp4"}).status_code == 401
    )


def test_wrong_token_is_refused(gated: TestClient) -> None:
    response = gated.get("/api/jobs", headers={"Authorization": "Bearer nope"})

    assert response.status_code == 401
    assert TOKEN not in response.text


def test_bearer_token_works_for_api_clients(gated: TestClient) -> None:
    response = gated.get("/api/jobs", headers={"Authorization": f"Bearer {TOKEN}"})

    assert response.status_code == 200


def test_link_token_becomes_a_cookie_and_leaves_the_url(gated: TestClient) -> None:
    response = gated.get(f"/?token={TOKEN}&x=1", follow_redirects=False)

    assert response.status_code == 303
    assert response.headers["location"] == "/?x=1"
    cookie = response.headers["set-cookie"]
    assert "httponly" in cookie.lower()

    # The cookie now authorises ordinary requests.
    assert gated.get("/api/jobs").status_code == 200


def test_no_token_configured_means_no_gate(autoclip_home, monkeypatch) -> None:
    monkeypatch.setenv(app_module.ENV_NO_WORKER, "1")
    monkeypatch.delenv(app_module.ENV_ACCESS_TOKEN, raising=False)

    with TestClient(create_app()) as client:
        assert client.get("/api/jobs").status_code == 200
