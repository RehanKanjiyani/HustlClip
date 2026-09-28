"""The AI manager: routing, health, retry, fallback, budgets, decision records.

Providers are scripted fakes — no network. Each fake returns queued responses
(strings, Completions, or exceptions) so every branch of the routing algorithm
is exercised deliberately rather than by accident.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace

import pytest
from autoclip.config import ModelOverride, Settings
from autoclip.intelligence import AIManager, CapabilityUnavailable, HealthTracker, build_registry
from autoclip.intelligence import capabilities as caps
from autoclip.providers.base import Completion, ErrorCategory, ImageInput, ProviderError
from autoclip.providers.typesafe_provider import DecisionAnswer, DecisionResponse

# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------


class FakeText:
    def __init__(self, entry_id: str, script: list) -> None:
        self.entry_id = entry_id
        self.script = list(script)
        self.requests: list = []

    async def generate(self, request):
        self.requests.append(request)
        item = self.script.pop(0) if self.script else AssertionError(f"{self.entry_id} over-called")
        if isinstance(item, BaseException):
            raise item
        if isinstance(item, float):  # a delay, to trip the timeout
            await asyncio.sleep(item)
            return Completion(text="{}")
        if isinstance(item, Completion):
            return item
        return Completion(text=item, model=self.entry_id)


class FakeDecision:
    kind = "decision"

    def __init__(self, script: list) -> None:
        self.script = list(script)
        self.calls: list = []

    async def evaluate(self, state, questions):
        self.calls.append((state, questions))
        item = self.script.pop(0) if self.script else None
        if isinstance(item, BaseException):
            raise item
        if item is not None:
            return item
        return _triage_response()


def _triage_response(keep: float = 0.9, priority_level: float = 3.0) -> DecisionResponse:
    return DecisionResponse(
        model="jev-1.13.0",
        answers={
            "keep": DecisionAnswer(type="noul", value=keep),
            "needs_visual": DecisionAnswer(type="noul", value=0.2),
            "needs_deep_reasoning": DecisionAnswer(type="noul", value=0.1),
            "priority": DecisionAnswer(type="score", value=priority_level, confidence=0.8),
            "moment_type": DecisionAnswer(type="choice", choice="story_payoff", confidence=0.7),
        },
        input_tokens=300,
        output_tokens=20,
    )


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def make_manager(settings: Settings, scripts: dict, *, registry=None, clock=None):
    fakes: dict = {}

    def factory(entry, _settings):
        if entry.id not in fakes:
            script = scripts.get(entry.id, [])
            fakes[entry.id] = (
                FakeDecision(script) if entry.provider == "typesafe" else FakeText(entry.id, script)
            )
        return fakes[entry.id]

    records: list = []
    manager = AIManager(
        settings,
        job_id="job1",
        registry=registry,
        provider_factory=factory,
        on_record=records.append,
        health=HealthTracker(clock=clock) if clock else None,
    )
    return manager, fakes, records


@pytest.fixture
def nvidia_only(monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-test")
    return Settings()


@pytest.fixture
def all_keys(monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-test")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("TYPESAFE_API_KEY", "ts-test")
    return Settings()


def discovery_payload() -> caps.DiscoveryRequest:
    return caps.DiscoveryRequest(
        text="[100]hello [101]world ...",
        first_word=100,
        last_word=400,
        min_duration_s=20,
        max_duration_s=90,
        max_candidates=5,
    )


GOOD_DISCOVERY = json.dumps(
    {
        "content_type": "podcast",
        "candidates": [
            {
                "start_word_index": 120,
                "end_word_index": 200,
                "type": "story_payoff",
                "initial_score": 0.8,
                "title": "T",
                "hook": "h",
                "reason": "r",
            }
        ],
    }
)


def triage_payload(n: int = 2) -> caps.TriageRequest:
    return caps.TriageRequest(
        items=[
            caps.TriageItem(
                candidate_id=f"c{i}",
                duration_s=40.0,
                transcript="some words " * 20,
                moment_type="insight",
                initial_score=0.6,
                speaker_count=1,
                speech_density=2.4,
                silence_ratio=0.05,
            )
            for i in range(n)
        ]
    )


# --------------------------------------------------------------------------
# Routing
# --------------------------------------------------------------------------


class TestRouting:
    async def test_highest_priority_model_serves_the_capability(self, nvidia_only) -> None:
        manager, fakes, _ = make_manager(
            nvidia_only, {"nvidia/nemotron-3.5-lightning": [GOOD_DISCOVERY]}
        )

        result = await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert result.provider == "nvidia"
        assert result.fallback_used is False
        assert result.output.candidates[0].start_word_index == 120
        assert list(fakes) == ["nvidia/nemotron-3.5-lightning"]

    async def test_unconfigured_providers_are_never_tried(self, monkeypatch) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
        manager, fakes, _ = make_manager(Settings(), {"anthropic/configured": [GOOD_DISCOVERY]})

        result = await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert result.provider == "anthropic"
        assert all(not key.startswith("nvidia") for key in fakes)

    async def test_no_configured_provider_raises_a_readable_error(self) -> None:
        manager, _, _ = make_manager(Settings(), {})

        with pytest.raises(CapabilityUnavailable) as info:
            await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert info.value.category == ErrorCategory.NOT_CONFIGURED
        assert "API key" in str(info.value)

    async def test_premium_model_judges_first_and_kimi_is_the_fallback(self, all_keys) -> None:
        order = [e.id for e in AIManager(all_keys).eligible(caps.FINAL_JUDGMENT)]

        assert order[:2] == ["anthropic/configured", "nvidia/kimi-k3"]

    async def test_efficiency_routing_moves_premium_behind_kimi(self, all_keys) -> None:
        all_keys.ai.routing = "efficiency"

        order = [e.id for e in AIManager(all_keys).eligible(caps.FINAL_JUDGMENT)]

        assert order[0] == "nvidia/kimi-k3"

    async def test_custom_routing_puts_preferred_model_first(self, all_keys) -> None:
        all_keys.ai.routing = "custom"
        all_keys.ai.preferred = {caps.TEXT_SCORING: ["nvidia/kimi-k3"]}

        order = [e.id for e in AIManager(all_keys).eligible(caps.TEXT_SCORING)]

        assert order[0] == "nvidia/kimi-k3"

    async def test_disabled_model_override_is_skipped(self, nvidia_only) -> None:
        nvidia_only.ai.models["nvidia/nemotron-3.5-lightning"] = ModelOverride(enabled=False)
        manager, fakes, _ = make_manager(nvidia_only, {"nvidia/glm-5.3-flash": [GOOD_DISCOVERY]})

        result = await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert result.model == "nvidia/glm-5.3-flash"
        assert "nvidia/nemotron-3.5-lightning" not in fakes

    def test_api_model_override_changes_the_requested_model(self, nvidia_only) -> None:
        nvidia_only.ai.models["nvidia/kimi-k3"] = ModelOverride(api_model="moonshotai/kimi-k3.1")

        entry = next(e for e in build_registry(nvidia_only) if e.id == "nvidia/kimi-k3")

        assert entry.api_model == "moonshotai/kimi-k3.1"

    async def test_disabled_provider_is_skipped(self, all_keys) -> None:
        all_keys.ai.disabled_providers = ["nvidia"]

        order = [e.id for e in AIManager(all_keys).eligible(caps.CANDIDATE_DISCOVERY)]

        assert order and all(not i.startswith("nvidia") for i in order)

    async def test_images_route_only_to_vision_models(self, all_keys) -> None:
        order = [e.id for e in AIManager(all_keys).eligible(caps.VISUAL_UNDERSTANDING)]

        assert "nvidia/nemotron-3.5-lightning" not in order
        assert order[0] == "nvidia/kimi-k3"


# --------------------------------------------------------------------------
# Failure handling
# --------------------------------------------------------------------------


def _err(category: ErrorCategory, retry_after: float | None = None) -> ProviderError:
    return ProviderError("boom", provider="nvidia", category=category, retry_after_s=retry_after)


class TestFallback:
    async def test_rate_limit_falls_back_and_cools_the_model(self, nvidia_only) -> None:
        clock = Clock()
        manager, _, records = make_manager(
            nvidia_only,
            {
                "nvidia/nemotron-3.5-lightning": [
                    _err(ErrorCategory.RATE_LIMIT, 30),
                    GOOD_DISCOVERY,
                ],
                "nvidia/glm-5.3-flash": [GOOD_DISCOVERY, GOOD_DISCOVERY],
            },
            clock=clock,
        )

        first = await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())
        second = await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert first.fallback_used is True
        assert first.model == "nvidia/glm-5.3-flash"
        # Still cooling down: the rate-limited model is skipped, not retried.
        assert second.model == "nvidia/glm-5.3-flash"
        assert records[0].error_category == "rate_limit"
        assert records[1].fallback_used is True
        assert "rate_limit" in (records[1].fallback_reason or "")

        clock.now += 31
        third = await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())
        # The cooldown expired; the preferred model is rechecked, not banned.
        assert third.model == "nvidia/nemotron-3.5-lightning"

    async def test_timeout_is_retried_once_then_falls_back(self, nvidia_only) -> None:
        registry = [
            replace(e, timeout_s=0.05) if e.id == "nvidia/nemotron-3.5-lightning" else e
            for e in build_registry(nvidia_only)
        ]
        manager, fakes, records = make_manager(
            nvidia_only,
            {
                "nvidia/nemotron-3.5-lightning": [1.0, 1.0],
                "nvidia/glm-5.3-flash": [GOOD_DISCOVERY],
            },
            registry=registry,
        )

        result = await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert result.model == "nvidia/glm-5.3-flash"
        timeouts = [r for r in records if r.error_category == "timeout"]
        assert len(timeouts) == 2  # one try + one safe retry, never a loop
        assert len(fakes["nvidia/nemotron-3.5-lightning"].requests) == 2

    async def test_malformed_json_gets_one_repair_retry_with_the_error(self, nvidia_only) -> None:
        manager, fakes, _ = make_manager(
            nvidia_only,
            {"nvidia/nemotron-3.5-lightning": ["definitely not json", GOOD_DISCOVERY]},
        )

        result = await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert result.fallback_used is False
        retry_prompt = fakes["nvidia/nemotron-3.5-lightning"].requests[1].user
        assert "could not be used" in retry_prompt

    async def test_repeated_bad_answers_downgrade_the_model_for_the_job(self, nvidia_only) -> None:
        manager, fakes, _ = make_manager(
            nvidia_only,
            {
                "nvidia/nemotron-3.5-lightning": ["nope", "still nope"],
                "nvidia/glm-5.3-flash": [GOOD_DISCOVERY, GOOD_DISCOVERY],
            },
        )

        await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())
        again = await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert again.model == "nvidia/glm-5.3-flash"
        # Two strikes: not asked a third time this job.
        assert len(fakes["nvidia/nemotron-3.5-lightning"].requests) == 2

    async def test_hallucinated_indices_are_a_quality_failure(self, nvidia_only) -> None:
        outside = json.dumps(
            {"candidates": [{"start_word_index": 5000, "end_word_index": 5100, "type": "insight"}]}
        )
        manager, _, records = make_manager(
            nvidia_only,
            {
                "nvidia/nemotron-3.5-lightning": [outside, GOOD_DISCOVERY],
            },
        )

        result = await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert records[0].error_category == "invalid_references"
        assert records[0].quality_valid is False
        assert result.output.candidates

    async def test_auth_failure_disables_every_model_of_that_provider(self, all_keys) -> None:
        manager, fakes, _ = make_manager(
            all_keys,
            {
                "nvidia/nemotron-3.5-lightning": [_err(ErrorCategory.AUTH)],
                "anthropic/configured": [GOOD_DISCOVERY],
            },
        )

        result = await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert result.provider == "anthropic"
        assert "nvidia/glm-5.3-flash" not in fakes
        assert "nvidia/kimi-k3" not in fakes

    async def test_unknown_model_disables_only_that_model(self, nvidia_only) -> None:
        manager, _, _ = make_manager(
            nvidia_only,
            {
                "nvidia/nemotron-3.5-lightning": [_err(ErrorCategory.MODEL_UNAVAILABLE)],
                "nvidia/glm-5.3-flash": [GOOD_DISCOVERY],
            },
        )

        result = await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert result.model == "nvidia/glm-5.3-flash"

    async def test_bad_request_is_not_retried(self, nvidia_only) -> None:
        manager, fakes, _ = make_manager(
            nvidia_only,
            {
                "nvidia/nemotron-3.5-lightning": [_err(ErrorCategory.BAD_REQUEST)],
                "nvidia/glm-5.3-flash": [GOOD_DISCOVERY],
            },
        )

        await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert len(fakes["nvidia/nemotron-3.5-lightning"].requests) == 1

    async def test_unsupported_modality_falls_through_to_next_vision_model(
        self, nvidia_only
    ) -> None:
        payload = caps.VisualRequest(
            candidate_id="c1",
            transcript="words",
            duration_s=30,
            frames=[ImageInput(data=b"\xff\xd8fake")],
            frame_times_s=[1.0],
        )
        good = json.dumps({"visual_score": 7, "has_reaction": True, "transcript_sufficient": True})
        manager, _, _ = make_manager(
            nvidia_only,
            {
                "nvidia/kimi-k3": [_err(ErrorCategory.UNSUPPORTED_MODALITY)],
                "nvidia/deepseek-v4.1-flash": [good],
            },
        )

        result = await manager.run(caps.VISUAL_UNDERSTANDING, payload)

        assert result.model == "nvidia/deepseek-v4.1-flash"
        assert result.output.visual_score == 7

    async def test_every_model_failing_raises_with_a_friendly_message(self, nvidia_only) -> None:
        manager, _, _ = make_manager(
            nvidia_only,
            {
                "nvidia/nemotron-3.5-lightning": [_err(ErrorCategory.RATE_LIMIT)],
                "nvidia/glm-5.3-flash": [_err(ErrorCategory.RATE_LIMIT)],
                "nvidia/kimi-k3": [_err(ErrorCategory.RATE_LIMIT)],
            },
        )

        with pytest.raises(CapabilityUnavailable) as info:
            await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        message = str(info.value)
        assert "rate-limited" in message
        assert "HTTP" not in message and "boom" not in message

    async def test_token_budget_stops_further_calls(self, nvidia_only) -> None:
        nvidia_only.ai.job_token_budget = 100
        used = Completion(text=GOOD_DISCOVERY, input_tokens=90, output_tokens=20)
        manager, _, records = make_manager(
            nvidia_only, {"nvidia/nemotron-3.5-lightning": [used, GOOD_DISCOVERY]}
        )

        await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())
        with pytest.raises(CapabilityUnavailable) as info:
            await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert info.value.category == ErrorCategory.BUDGET
        assert records[-1].error_category == "token_budget_exceeded"


# --------------------------------------------------------------------------
# Decision records
# --------------------------------------------------------------------------


class TestDecisionRecords:
    async def test_reported_usage_is_recorded(self, nvidia_only) -> None:
        completion = Completion(text=GOOD_DISCOVERY, input_tokens=1234, output_tokens=210)
        manager, _, records = make_manager(
            nvidia_only, {"nvidia/nemotron-3.5-lightning": [completion]}
        )

        await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        record = records[0]
        assert (record.input_tokens, record.output_tokens) == (1234, 210)
        assert record.status == "success"
        assert record.schema_valid is True and record.quality_valid is True
        assert record.job_id == "job1"
        assert record.latency_ms is not None

    async def test_unreported_usage_stays_null(self, nvidia_only) -> None:
        manager, _, records = make_manager(
            nvidia_only, {"nvidia/nemotron-3.5-lightning": [GOOD_DISCOVERY]}
        )

        await manager.run(caps.CANDIDATE_DISCOVERY, discovery_payload())

        assert records[0].input_tokens is None
        assert records[0].output_tokens is None


# --------------------------------------------------------------------------
# Decision capabilities: Jev and its LLM fallback
# --------------------------------------------------------------------------


class TestDecisionCapabilities:
    async def test_jev_serves_triage_first(self, all_keys) -> None:
        manager, fakes, records = make_manager(all_keys, {})

        result = await manager.run(caps.CANDIDATE_TRIAGE, triage_payload(3))

        assert result.provider == "typesafe"
        assert set(result.output) == {"c0", "c1", "c2"}
        decision = result.output["c0"]
        assert decision.keep == pytest.approx(0.9)
        assert decision.priority == pytest.approx(0.75)  # level 3 of 0..4
        assert decision.moment_type == "story_payoff"
        # One request per candidate, usage summed from what Jev reported.
        assert len(fakes["typesafe/jev"].calls) == 3
        assert records[0].input_tokens == 900

    async def test_jev_only_receives_compact_state(self, all_keys) -> None:
        manager, fakes, _ = make_manager(all_keys, {})
        payload = triage_payload(1)
        payload.items[0].transcript = "x" * 50_000

        await manager.run(caps.CANDIDATE_TRIAGE, payload)

        state, questions = fakes["typesafe/jev"].calls[0]
        assert len(state["transcript"]) <= caps.TRIAGE_TRANSCRIPT_CHARS
        assert set(questions) == {
            "keep",
            "needs_visual",
            "needs_deep_reasoning",
            "priority",
            "moment_type",
        }

    async def test_jev_outage_falls_back_to_an_llm_with_the_same_result_shape(
        self, all_keys
    ) -> None:
        llm_answer = json.dumps(
            {
                "decisions": [
                    {
                        "candidate_id": "c0",
                        "keep": 0.7,
                        "priority": 0.6,
                        "needs_visual": 0.1,
                        "needs_deep_reasoning": 0.3,
                        "moment_type": "insight",
                    },
                    {
                        "candidate_id": "c1",
                        "keep": 0.2,
                        "priority": 0.1,
                        "needs_visual": 0.0,
                        "needs_deep_reasoning": 0.0,
                        "moment_type": "other",
                    },
                ]
            }
        )
        manager, _, records = make_manager(
            all_keys,
            {
                "typesafe/jev": [_err(ErrorCategory.UNAVAILABLE)],
                "nvidia/glm-5.3-flash": [llm_answer],
            },
        )

        result = await manager.run(caps.CANDIDATE_TRIAGE, triage_payload(2))

        assert result.provider == "nvidia"
        assert result.fallback_used is True
        assert isinstance(result.output["c0"], caps.TriageDecision)
        assert result.output["c1"].keep == pytest.approx(0.2)
        assert records[0].provider == "typesafe"
        assert records[0].error_category == "provider_unavailable"

    async def test_jev_is_never_used_for_text_generation(self, all_keys) -> None:
        order = [e.id for e in AIManager(all_keys).eligible(caps.CANDIDATE_DISCOVERY)]

        assert "typesafe/jev" not in order

    async def test_llm_triage_missing_most_candidates_is_rejected(self, nvidia_only) -> None:
        partial = json.dumps({"decisions": [{"candidate_id": "c0", "keep": 0.5, "priority": 0.5}]})
        full = json.dumps(
            {
                "decisions": [
                    {"candidate_id": f"c{i}", "keep": 0.5, "priority": 0.5} for i in range(4)
                ]
            }
        )
        manager, _, records = make_manager(nvidia_only, {"nvidia/glm-5.3-flash": [partial, full]})

        result = await manager.run(caps.CANDIDATE_TRIAGE, triage_payload(4))

        assert records[0].error_category == "incomplete_response"
        assert len(result.output) == 4
