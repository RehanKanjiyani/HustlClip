"""TypeSafe (Jev) adapter against the documented /v1/systemone contract.

Normal tests use httpx.MockTransport. The live test at the bottom runs only
with TYPESAFE_LIVE=1 and a real TYPESAFE_API_KEY in the environment.
"""

from __future__ import annotations

import json
import os

import httpx
import pytest
from autoclip.intelligence import capabilities as caps
from autoclip.providers.base import ErrorCategory, ProviderError
from autoclip.providers.typesafe_provider import TypeSafeProvider, parse_response

# Read at import: the autouse fixture in conftest scrubs key variables per test.
LIVE_KEY = os.environ.get("TYPESAFE_API_KEY") if os.environ.get("TYPESAFE_LIVE") == "1" else None

QUESTIONS = {
    "urgent": {"type": "noul", "instructions": "Is this urgent?"},
    "team": {
        "type": "choice",
        "instructions": "Which team?",
        "criteria": {"billing": "money", "technical": "bugs"},
    },
    "mood": {"type": "score", "instructions": "How upset?", "criteria": ["calm", "upset", "angry"]},
}

GOOD_BODY = {
    "model": "jev-1.13.0",
    "answers": {
        "urgent": {"type": "noul", "noul": 0.95},
        "team": {
            "type": "choice",
            "choice": "billing",
            "probabilities": {"billing": 0.88, "technical": 0.12},
            "confidence": 0.81,
        },
        "mood": {
            "type": "score",
            "score": 1.05,
            "legend": {"0": "calm", "1": "upset", "2": "angry"},
            "probabilities": {"0": 0.0, "1": 0.95, "2": 0.05},
            "confidence": 0.92,
        },
    },
    "usage": {"input_tokens": 304, "output_tokens": 18},
}


def provider_with(handler) -> TypeSafeProvider:
    return TypeSafeProvider(api_key="ts-test", transport=httpx.MockTransport(handler))


class TestRequest:
    async def test_posts_the_documented_shape(self) -> None:
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["auth"] = request.headers.get("authorization")
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json=GOOD_BODY)

        await provider_with(handler).evaluate({"text": "payouts failing"}, QUESTIONS)

        assert seen["url"] == "https://api.typesafe.ai/v1/systemone"
        assert seen["auth"] == "Bearer ts-test"
        assert seen["body"]["model"] == "jev-latest"
        assert seen["body"]["state"] == {"text": "payouts failing"}
        assert set(seen["body"]["questions"]) == set(QUESTIONS)

    async def test_missing_key_is_a_configuration_error(self) -> None:
        with pytest.raises(ProviderError) as info:
            await TypeSafeProvider().evaluate("x", QUESTIONS)

        assert info.value.category == ErrorCategory.NOT_CONFIGURED

    async def test_malformed_questions_are_rejected_before_sending(self) -> None:
        bad = {"mood": {"type": "score", "instructions": "?", "criteria": ["only one"]}}

        with pytest.raises(ProviderError) as info:
            await provider_with(lambda r: httpx.Response(200, json={})).evaluate("x", bad)

        assert info.value.category == ErrorCategory.BAD_REQUEST


class TestResponseNormalisation:
    async def test_all_three_answer_types_and_usage(self) -> None:
        result = await provider_with(lambda r: httpx.Response(200, json=GOOD_BODY)).evaluate(
            "x", QUESTIONS
        )

        assert result.model == "jev-1.13.0"
        assert result.answers["urgent"].value == pytest.approx(0.95)
        assert result.answers["team"].choice == "billing"
        assert result.answers["team"].confidence == pytest.approx(0.81)
        assert result.answers["mood"].value == pytest.approx(1.05)
        assert (result.input_tokens, result.output_tokens) == (304, 18)

    def test_missing_answer_is_incomplete(self) -> None:
        body = json.loads(json.dumps(GOOD_BODY))
        del body["answers"]["mood"]

        with pytest.raises(ProviderError) as info:
            parse_response(body, QUESTIONS)

        assert info.value.category == ErrorCategory.INCOMPLETE

    def test_wrong_answer_type_is_a_schema_failure(self) -> None:
        body = json.loads(json.dumps(GOOD_BODY))
        body["answers"]["urgent"] = {"type": "choice", "choice": "billing"}

        with pytest.raises(ProviderError) as info:
            parse_response(body, QUESTIONS)

        assert info.value.category == ErrorCategory.SCHEMA

    @pytest.mark.parametrize(
        ("key", "answer"),
        [
            ("urgent", {"type": "noul", "noul": 1.7}),
            ("team", {"type": "choice", "choice": "sales", "confidence": 0.5}),
            ("mood", {"type": "score", "score": 7.0, "confidence": 0.5}),
        ],
    )
    def test_out_of_range_values_are_rejected(self, key: str, answer: dict) -> None:
        body = json.loads(json.dumps(GOOD_BODY))
        body["answers"][key] = answer

        with pytest.raises(ProviderError) as info:
            parse_response(body, QUESTIONS)

        assert info.value.category == ErrorCategory.INVALID_SCORES

    def test_missing_usage_is_null_not_zero(self) -> None:
        body = json.loads(json.dumps(GOOD_BODY))
        del body["usage"]

        result = parse_response(body, QUESTIONS)

        assert result.input_tokens is None and result.output_tokens is None

    async def test_non_json_body_is_malformed(self) -> None:
        provider = provider_with(lambda r: httpx.Response(200, text="<html>oops</html>"))

        with pytest.raises(ProviderError) as info:
            await provider.evaluate("x", QUESTIONS)

        assert info.value.category == ErrorCategory.MALFORMED


class TestErrors:
    @pytest.mark.parametrize(
        ("status", "category"),
        [
            (401, ErrorCategory.AUTH),
            (422, ErrorCategory.BAD_REQUEST),
            (429, ErrorCategory.RATE_LIMIT),
            (529, ErrorCategory.UNAVAILABLE),
            (503, ErrorCategory.UNAVAILABLE),
        ],
    )
    async def test_status_codes_map_to_categories(self, status: int, category) -> None:
        provider = provider_with(lambda r: httpx.Response(status, json={"detail": "x"}))

        with pytest.raises(ProviderError) as info:
            await provider.evaluate("x", QUESTIONS)

        assert info.value.category == category

    async def test_rate_limit_carries_retry_after(self) -> None:
        provider = provider_with(
            lambda r: httpx.Response(429, json={}, headers={"retry-after": "12"})
        )

        with pytest.raises(ProviderError) as info:
            await provider.evaluate("x", QUESTIONS)

        assert info.value.retry_after_s == 12.0

    async def test_timeout(self) -> None:
        def handler(request):
            raise httpx.ReadTimeout("slow", request=request)

        with pytest.raises(ProviderError) as info:
            await provider_with(handler).evaluate("x", QUESTIONS)

        assert info.value.category == ErrorCategory.TIMEOUT

    async def test_connection_failure(self) -> None:
        def handler(request):
            raise httpx.ConnectError("down", request=request)

        with pytest.raises(ProviderError) as info:
            await provider_with(handler).evaluate("x", QUESTIONS)

        assert info.value.category == ErrorCategory.CONNECTION

    async def test_errors_never_contain_the_key(self) -> None:
        provider = provider_with(lambda r: httpx.Response(401, json={"detail": "bad"}))

        with pytest.raises(ProviderError) as info:
            await provider.evaluate("x", QUESTIONS)

        assert "ts-test" not in str(info.value)


class TestHealth:
    async def test_missing_key_is_reported_without_a_request(self) -> None:
        status = await TypeSafeProvider().health_check()

        assert status.available is False
        assert "No API key" in status.detail

    async def test_models_listing(self) -> None:
        body = {"models": [{"name": "jev-latest", "description": "", "release_date": ""}]}
        status = await provider_with(lambda r: httpx.Response(200, json=body)).health_check()

        assert status.available is True
        assert status.models == ["jev-latest"]


@pytest.mark.skipif(LIVE_KEY is None, reason="Set TYPESAFE_LIVE=1 and TYPESAFE_API_KEY to run.")
async def test_live_triage_questions_round_trip() -> None:
    """One real request with HustlClip's own triage questions."""
    provider = TypeSafeProvider(api_key=LIVE_KEY)
    state = {
        "candidate_id": "live",
        "duration_s": 34.0,
        "transcript": (
            "I got promoted on a Monday and quit on the Friday. Everyone thought I was crazy. "
            "Here's what they didn't know: the promotion came with a non-compete that would "
            "have locked me out of the only thing I actually wanted to build."
        ),
        "moment_type": "story_payoff",
    }

    result = await provider.evaluate(state, caps.TRIAGE_QUESTIONS)

    assert set(result.answers) == set(caps.TRIAGE_QUESTIONS)
    assert result.input_tokens is not None
