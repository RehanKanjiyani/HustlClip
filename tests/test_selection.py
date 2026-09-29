"""Global selection: exact count, distinctness, diversity, determinism."""

from __future__ import annotations

import random

import pytest
from autoclip.pipeline import selection
from autoclip.pipeline.candidates import (
    Candidate,
    Proposal,
    fallback_candidates,
    merge_duplicates,
    normalize,
    time_overlap_fraction,
)
from autoclip.pipeline.selection import SelectionContext, composite_score, select
from autoclip.pipeline.transcript import Transcript, Word


def cand(
    cid: str,
    start: float,
    end: float,
    score: float,
    *,
    moment: str = "insight",
    topic: str = "",
    verdict: dict | None = None,
    source: str = "ai",
    scored: bool = True,
) -> Candidate:
    return Candidate(
        id=cid,
        start_word=int(start * 3),
        end_word=int(end * 3),
        start_s=start,
        end_s=end,
        moment_type=moment,
        source=source,
        initial_score=score,
        scores={"overall": score, "dimensions": {}, "topic": topic} if scored else None,
        verdict=verdict,
    )


def spread(n: int, *, score: float = 0.7, gap: float = 100.0) -> list[Candidate]:
    return [
        cand(f"c{i}", i * gap, i * gap + 40, score - i * 0.001, topic=f"subject{i}")
        for i in range(n)
    ]


def assert_distinct(picks) -> None:
    ids = [p.candidate.id for p in picks]
    assert len(ids) == len(set(ids))
    for i, a in enumerate(picks):
        for b in picks[i + 1 :]:
            assert time_overlap_fraction(a.candidate, b.candidate) <= selection.MAX_OVERLAP


class TestExactCount:
    def test_selects_exactly_the_target_when_enough_material_exists(self) -> None:
        picks = select(spread(25), 10)

        assert len(picks) == 10
        assert_distinct(picks)

    def test_never_duplicates_to_reach_the_target(self) -> None:
        # Five distinct moments proposed twice each: only five can be chosen.
        pool = spread(5) + [cand(f"d{i}", i * 100 + 2, i * 100 + 41, 0.9) for i in range(5)]

        picks = select(pool, 10)

        assert len(picks) == 5
        assert_distinct(picks)

    def test_identical_ids_count_once(self) -> None:
        pool = spread(3)
        picks = select(pool + pool, 10)

        assert len(picks) == 3

    def test_ranks_are_one_to_n_by_quality(self) -> None:
        picks = select(spread(12), 10)

        assert [p.rank for p in picks] == list(range(1, 11))
        finals = [p.final for p in picks]
        assert finals == sorted(finals, reverse=True)


class TestQualityAndDiversity:
    def test_overlapping_candidates_keep_the_stronger(self) -> None:
        strong = cand("strong", 0, 40, 0.9)
        weak = cand("weak", 5, 45, 0.6)

        picks = select([weak, strong], 2)

        assert [p.candidate.id for p in picks] == ["strong"]

    def test_same_story_verdict_prefers_a_different_story(self) -> None:
        a = cand("a", 0, 40, 0.90, verdict={"keep": True, "score": 0.9, "same_story_as": ["b"]})
        b = cand("b", 500, 540, 0.88, verdict={"keep": True, "score": 0.88, "same_story_as": ["a"]})
        c = cand("c", 1000, 1040, 0.80, verdict={"keep": True, "score": 0.80, "same_story_as": []})

        picks = select([a, b, c], 2)

        assert {p.candidate.id for p in picks} == {"a", "c"}

    def test_duplicate_risk_from_a_decision_provider_is_honoured(self) -> None:
        a, b, c = cand("a", 0, 40, 0.9), cand("b", 500, 540, 0.88), cand("c", 1000, 1040, 0.8)
        context = SelectionContext(duplicate_risk={("a", "b"): 0.92})

        picks = select([a, b, c], 2, context)

        assert {p.candidate.id for p in picks} == {"a", "c"}

    def test_an_exceptional_candidate_outweighs_a_topic_penalty(self) -> None:
        texts = {
            "a": "startup funding rounds investors valuation dilution",
            "b": "startup funding rounds investors valuation terms",
            "c": "cooking pasta sauce",
        }
        a = cand("a", 0, 40, 0.80)
        b = cand("b", 500, 540, 0.97)
        c = cand("c", 1000, 1040, 0.55)

        picks = select([a, b, c], 2, SelectionContext(texts=texts))

        # b is far better than c, so sharing a topic with a doesn't sink it.
        assert {p.candidate.id for p in picks} == {"a", "b"}

    def test_topic_penalty_decides_between_near_equals(self) -> None:
        texts = {
            "a": "startup funding rounds investors valuation dilution",
            "b": "startup funding rounds investors valuation terms",
            "c": "cooking pasta sauce garlic",
        }
        a, b, c = cand("a", 0, 40, 0.80), cand("b", 500, 540, 0.79), cand("c", 1000, 1040, 0.78)

        picks = select([a, b, c], 2, SelectionContext(texts=texts))

        assert {p.candidate.id for p in picks} == {"a", "c"}

    def test_judge_rejected_clips_are_used_only_after_kept_ones(self) -> None:
        kept = [
            cand(f"k{i}", i * 100, i * 100 + 40, 0.6, verdict={"keep": True, "score": 0.6})
            for i in range(3)
        ]
        rejected = [
            cand(
                f"r{i}", 5000 + i * 100, 5040 + i * 100, 0.8, verdict={"keep": False, "score": 0.3}
            )
            for i in range(3)
        ]

        picks = select(rejected + kept, 3)

        assert {p.candidate.id for p in picks} == {"k0", "k1", "k2"}

    def test_fallback_windows_come_last(self) -> None:
        ai = spread(2)
        fallback = [
            cand(f"f{i}", 5000 + i * 100, 5040 + i * 100, 0.45, source="fallback", scored=False)
            for i in range(5)
        ]

        picks = select(fallback + ai, 4)

        assert [p.tier for p in picks][:2] != ["fallback", "fallback"]
        assert {p.candidate.id for p in picks} >= {"c0", "c1"}
        assert sum(p.tier == "fallback" for p in picks) == 2

    def test_unreviewed_discovery_does_not_outrank_scored_candidates(self) -> None:
        scored = cand("scored", 0, 40, 0.70)
        unreviewed = cand("raw", 500, 540, 0.72, scored=False)

        picks = select([unreviewed, scored], 1)

        assert picks[0].candidate.id == "scored"

    def test_selection_is_deterministic(self) -> None:
        pool = spread(30)
        shuffled = pool[:]
        random.Random(7).shuffle(shuffled)

        assert [p.candidate.id for p in select(pool, 10)] == [
            p.candidate.id for p in select(shuffled, 10)
        ]

    def test_every_pick_can_be_explained(self) -> None:
        picks = select(spread(4), 3)

        assert all("quality" in p.explain() for p in picks)


class TestCompositeScore:
    def test_judge_dominates_screening(self) -> None:
        low_screen_high_judge = cand("a", 0, 40, 0.5, verdict={"keep": True, "score": 0.95})
        high_screen_low_judge = cand("b", 0, 40, 0.9, verdict={"keep": True, "score": 0.3})

        assert composite_score(low_screen_high_judge) > composite_score(high_screen_low_judge)

    def test_not_self_contained_is_penalised(self) -> None:
        good = cand("a", 0, 40, 0.8)
        orphan = cand("b", 0, 40, 0.8)
        orphan.scores["self_contained"] = False

        assert composite_score(orphan) < composite_score(good)


# --------------------------------------------------------------------------
# Normalisation
# --------------------------------------------------------------------------


def transcript_of(sentences: int, words_per_sentence: int = 10, rate: float = 2.5) -> Transcript:
    words: list[Word] = []
    t = 0.0
    for s in range(sentences):
        for w in range(words_per_sentence):
            text = f"word{s}x{w}" + ("." if w == words_per_sentence - 1 else "")
            words.append(Word(text=text, start=round(t, 3), end=round(t + 0.3, 3)))
            t += 1 / rate
        t += 0.4  # a pause between sentences
    return Transcript(words=words)


class TestNormalization:
    def test_indices_resolve_to_measured_timestamps(self) -> None:
        transcript = transcript_of(60)
        found, report = normalize(
            transcript,
            [Proposal(start_word=103, end_word=180)],
            silences=[],
            min_duration_s=20,
            max_duration_s=60,
        )

        assert report.kept == 1
        c = found[0]
        # Snapped to sentence starts/ends, timing read from the words.
        assert c.start_word % 10 == 0
        assert transcript.words[c.end_word].ends_sentence
        assert c.start_s == pytest.approx(transcript.words[c.start_word].start - 0.25, abs=0.01)
        assert 20 <= c.duration_s <= 60

    def test_invalid_ranges_are_dropped_and_counted(self) -> None:
        transcript = transcript_of(20)
        _, report = normalize(
            transcript,
            [Proposal(start_word=50, end_word=40), Proposal(start_word=10, end_word=12)],
            silences=[],
            min_duration_s=200,
            max_duration_s=300,
        )

        assert report.kept == 0
        assert report.no_valid_boundary == 2

    def test_near_duplicates_merge_and_record_agreement(self) -> None:
        transcript = transcript_of(60)
        found, report = normalize(
            transcript,
            [
                Proposal(start_word=100, end_word=190, initial_score=0.6),
                Proposal(start_word=102, end_word=188, initial_score=0.7),
            ],
            silences=[],
            min_duration_s=20,
            max_duration_s=60,
        )

        assert report.merged_duplicates == 1
        assert found[0].proposals == 2
        assert found[0].initial_score > 0.7

    def test_merge_is_order_independent(self) -> None:
        a = cand("a", 0, 40, 0.6)
        b = cand("b", 1, 41, 0.7)

        assert merge_duplicates([a, b])[0].id == merge_duplicates([b, a])[0].id


class TestFallbackWindows:
    def test_windows_are_distinct_valid_and_avoid_existing_picks(self) -> None:
        transcript = transcript_of(200)
        taken = cand("taken", 0, 60, 0.9)

        windows = fallback_candidates(
            transcript, silences=[], min_duration_s=20, max_duration_s=60, avoid=[taken]
        )

        assert windows
        assert all(w.source == "fallback" for w in windows)
        assert all(20 <= w.duration_s <= 60 for w in windows)
        assert all(time_overlap_fraction(w, taken) == 0 for w in windows)
        for i, a in enumerate(windows):
            for b in windows[i + 1 :]:
                assert time_overlap_fraction(a, b) == 0
        # Heuristic priors stay below what a reviewed AI candidate would get.
        assert max(w.initial_score for w in windows) <= 0.45
