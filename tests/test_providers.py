"""Provider contract handling.

The tolerant JSON extraction and score coercion are what keep small and
reasoning models usable, so both are tested against the specific malformed
shapes models actually emit. (The retry-with-feedback loop now lives in the AI
manager; see test_ai_manager.py.)
"""

from __future__ import annotations

import pytest
from autoclip.providers.base import (
    ProviderError,
    extract_json_object,
    strip_reasoning,
)


class TestJsonExtraction:
    def test_plain_object(self) -> None:
        assert extract_json_object('{"clips":[]}') == {"clips": []}

    def test_markdown_fenced(self) -> None:
        raw = '```json\n{"clips":[{"start_word_index":1,"end_word_index":2}]}\n```'

        assert len(extract_json_object(raw)["clips"]) == 1

    def test_unlabelled_fence(self) -> None:
        assert extract_json_object('```\n{"clips":[]}\n```') == {"clips": []}

    def test_leading_prose_is_ignored(self) -> None:
        raw = 'Here are the clips I found:\n{"clips":[]}'

        assert extract_json_object(raw) == {"clips": []}

    def test_trailing_prose_is_ignored(self) -> None:
        raw = '{"clips":[]}\n\nLet me know if you want more.'

        assert extract_json_object(raw) == {"clips": []}

    def test_bare_array_is_wrapped(self) -> None:
        # Some models skip the wrapper object entirely.
        raw = '[{"start_word_index":1,"end_word_index":2}]'

        assert len(extract_json_object(raw)["clips"]) == 1

    def test_braces_inside_strings_do_not_confuse_matching(self) -> None:
        raw = '{"clips":[{"start_word_index":1,"end_word_index":2,"title":"a } brace"}]}'

        assert extract_json_object(raw)["clips"][0]["title"] == "a } brace"

    def test_escaped_quotes_inside_strings(self) -> None:
        raw = '{"clips":[{"start_word_index":1,"end_word_index":2,"title":"say \\"hi\\""}]}'

        assert extract_json_object(raw)["clips"][0]["title"] == 'say "hi"'

    def test_no_json_raises(self) -> None:
        with pytest.raises(ValueError):
            extract_json_object("I could not find any clips in this transcript.")


class TestReasoningIsStripped:
    """Reasoning models on OpenAI-compatible APIs often think out loud inline."""

    def test_think_block_with_braces_is_ignored(self) -> None:
        raw = '<think>maybe {"clips": [1]} no...</think>\n{"clips": []}'

        assert extract_json_object(raw) == {"clips": []}

    def test_unclosed_opener_keeps_text_after_the_close(self) -> None:
        raw = 'let me consider {a} </think> {"scores": []}'

        assert extract_json_object(raw) == {"scores": []}

    def test_plain_answers_are_untouched(self) -> None:
        assert strip_reasoning('{"a": 1}') == '{"a": 1}'


class TestScoreCoercion:
    """Models emit 0-1, 0-10 and 0-100 scales despite the schema; all normalise.

    (Previously covered by the single-model ClipCandidate model, which the
    capability parsers replaced.)
    """

    def _discover(self, candidate: dict) -> list:
        from autoclip.intelligence import capabilities as caps

        request = caps.DiscoveryRequest(
            text="",
            first_word=0,
            last_word=100,
            min_duration_s=20,
            max_duration_s=90,
            max_candidates=5,
        )
        raw = '{"candidates": [' + __import__("json").dumps(candidate) + "]}"
        return caps.DiscoverySpec().parse_text(raw, request).candidates

    @pytest.mark.parametrize(("given", "expected"), [(0.87, 0.87), (87, 0.87), (8.7, 0.87)])
    def test_prior_scales_are_normalised(self, given, expected) -> None:
        found = self._discover(
            {"start_word_index": 1, "end_word_index": 50, "initial_score": given}
        )

        assert found[0].initial_score == pytest.approx(expected)

    def test_out_of_range_score_is_clamped(self) -> None:
        found = self._discover({"start_word_index": 1, "end_word_index": 50, "score": 250})

        assert found[0].initial_score == 1.0

    def test_missing_score_defaults_to_the_middle(self) -> None:
        found = self._discover({"start_word_index": 1, "end_word_index": 50})

        assert found[0].initial_score == 0.5

    def test_null_text_fields_become_empty_strings(self) -> None:
        found = self._discover({"start_word_index": 1, "end_word_index": 50, "title": None})

        assert found[0].title == ""

    def test_zero_length_and_reversed_ranges_are_dropped(self) -> None:
        from autoclip.intelligence import capabilities as caps

        request = caps.DiscoveryRequest(
            text="",
            first_word=0,
            last_word=100,
            min_duration_s=20,
            max_duration_s=90,
            max_candidates=5,
        )
        raw = (
            '{"candidates": [{"start_word_index": 50, "end_word_index": 50},'
            '{"start_word_index": 60, "end_word_index": 40},'
            '{"start_word_index": 10, "end_word_index": 40}]}'
        )

        found = caps.DiscoverySpec().parse_text(raw, request)

        assert [(c.start_word_index, c.end_word_index) for c in found.candidates] == [(10, 40)]
        assert found.invalid_references == 2

    def test_partially_outside_range_is_clamped_into_the_window(self) -> None:
        found = self._discover({"start_word_index": 90, "end_word_index": 400})

        assert (found[0].start_word_index, found[0].end_word_index) == (90, 100)

    def test_empty_list_is_a_valid_answer(self) -> None:
        from autoclip.intelligence import capabilities as caps

        request = caps.DiscoveryRequest(
            text="",
            first_word=0,
            last_word=100,
            min_duration_s=20,
            max_duration_s=90,
            max_candidates=5,
        )

        assert caps.DiscoverySpec().parse_text('{"candidates": []}', request).candidates == []


class TestRegistry:
    def test_all_text_providers_are_registered(self) -> None:
        from autoclip.providers import DECISION_PROVIDERS, PROVIDERS

        assert set(PROVIDERS) == {"anthropic", "openai", "gemini", "ollama", "nvidia"}
        assert set(DECISION_PROVIDERS) == {"typesafe"}

    def test_nvidia_defaults_to_its_hosted_endpoint(self) -> None:
        from autoclip.providers import NvidiaProvider

        provider = NvidiaProvider("z-ai/glm-5.3-flash", api_key="k")

        assert provider.base_url == "https://integrate.api.nvidia.com/v1"
        # Hosted catalogues truncate JSON without an explicit completion limit.
        assert provider.send_max_tokens is True

    def test_ollama_needs_no_key(self) -> None:
        from autoclip.providers import OllamaProvider

        assert OllamaProvider.requires_key is False

    def test_unknown_provider_raises(self) -> None:
        from autoclip.providers import build_provider

        with pytest.raises(ProviderError, match="Unknown provider"):
            build_provider("not-a-provider")

    def test_openai_provider_accepts_a_custom_base_url(self) -> None:
        from autoclip.providers import OpenAIProvider

        provider = OpenAIProvider("llama-3.1", base_url="https://openrouter.ai/api/v1")

        assert provider.base_url == "https://openrouter.ai/api/v1"
