"""The intelligence funnel end to end, with scripted AI.

``ScriptedManager`` stands in for the AI manager and answers each capability
from the payload it receives — so these tests exercise the funnel's own logic
(windowing, normalisation, shortlists, artifacts, fallback, exact count). One
test at the bottom runs the *real* AI manager against a fake provider that
reads the rendered prompt, to prove the glue between them.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import pytest
from autoclip.config import Settings
from autoclip.db.models import Source
from autoclip.intelligence import AIManager, CapabilityUnavailable
from autoclip.intelligence import capabilities as caps
from autoclip.pipeline import selection
from autoclip.pipeline.candidates import time_overlap_fraction
from autoclip.pipeline.funnel import Funnel, FunnelError
from autoclip.pipeline.transcript import Transcript, Word
from autoclip.providers.base import Completion, ErrorCategory

TOPICS = [
    "money",
    "fitness",
    "travel",
    "cooking",
    "music",
    "games",
    "family",
    "school",
    "career",
    "health",
    "sports",
    "movies",
    "science",
    "history",
    "art",
    "tech",
]


def make_transcript(minutes: float, *, rate: float = 2.6) -> Transcript:
    """Sentences of 9-13 words; each minute talks about a different topic."""
    words: list[Word] = []
    t = 0.0
    s = 0
    while t < minutes * 60:
        topic = TOPICS[int(t // 60) % len(TOPICS)]
        length = 9 + s % 5
        for w in range(length):
            token = topic if w == 2 else f"w{s}_{w}"
            text = token + (
                "?" if w == length - 1 and s % 7 == 0 else "." if w == length - 1 else ""
            )
            words.append(Word(text=text, start=round(t, 3), end=round(t + 0.28, 3)))
            t += 1 / rate
        t += 0.45
        s += 1
    return Transcript(words=words, language="en")


class ScriptedResult:
    def __init__(self, output) -> None:
        self.output = output
        self.provider = "scripted"
        self.model = "scripted"
        self.fallback_used = False
        self.records: list = []


class ScriptedManager:
    """Answers each capability deterministically from its payload."""

    def __init__(
        self,
        *,
        fail: set[str] | None = None,
        discovery_per_window: int = 6,
        reject_all: bool = False,
    ) -> None:
        self.fail = fail or set()
        self.per_window = discovery_per_window
        self.reject_all = reject_all
        self.calls: dict[str, int] = {}

    def available(self, capability: str) -> bool:
        return capability not in self.fail

    async def run(self, capability: str, payload):
        self.calls[capability] = self.calls.get(capability, 0) + 1
        if capability in self.fail:
            raise CapabilityUnavailable(
                capability, "scripted outage", category=ErrorCategory.UNAVAILABLE
            )
        return ScriptedResult(getattr(self, capability)(payload))

    def candidate_discovery(self, p: caps.DiscoveryRequest):
        span = p.last_word - p.first_word
        found = []
        for i in range(self.per_window):
            start = p.first_word + 5 + i * span // max(1, self.per_window)
            found.append(
                caps.DiscoveredCandidate(
                    start_word_index=start,
                    end_word_index=min(p.last_word, start + 110),
                    moment_type="insight" if i % 2 else "story_payoff",
                    initial_score=0.5 + (start % 37) / 100,
                    title=f"moment {start}",
                )
            )
        # The same moment proposed twice with sloppy edges: must merge.
        found.append(
            caps.DiscoveredCandidate(
                found[0].start_word_index + 3, found[0].end_word_index - 2, "insight", 0.4
            )
        )
        return caps.DiscoveryResult(content_type="podcast", candidates=found)

    def candidate_triage(self, p: caps.TriageRequest):
        return {
            item.candidate_id: caps.TriageDecision(
                keep=item.initial_score,
                needs_visual=0.0,
                needs_deep_reasoning=0.0,
                priority=item.initial_score,
            )
            for item in p.items
        }

    def text_scoring(self, p: caps.ScoringRequest):
        out = {}
        for item in p.items:
            seed = int(item.candidate_id[1:].split("_")[0])
            overall = 0.4 + (seed % 53) / 100
            out[item.candidate_id] = caps.CandidateScore(
                dimensions=dict.fromkeys(caps.SCORE_DIMENSIONS, 5 + seed % 5),
                overall=overall,
                moment_type="insight",
                topic=_topic_of(item.tagged_text),
                title=f"Scored {seed}",
                self_contained=True,
            )
        return out

    def visual_understanding(self, p: caps.VisualRequest):
        return caps.VisualAssessment(5, False, True, "", "")

    def final_judgment(self, p: caps.JudgmentRequest):
        verdicts = {}
        for i, item in enumerate(p.finalists):
            keep = not self.reject_all and i % 3 != 2
            verdicts[item.candidate_id] = caps.Verdict(
                keep=keep,
                score=0.9 - i * 0.02,
                title=f"Judged {item.candidate_id}",
                reason="scripted",
            )
        return verdicts

    def duplicate_risk(self, p: caps.DuplicateRequest):
        return {(pair.a_id, pair.b_id): 0.1 for pair in p.pairs}


def _topic_of(tagged: str) -> str:
    for word in re.findall(r"\](\w+)", tagged):
        if word in TOPICS:
            return word
    return "misc"


def make_funnel(
    tmp_path: Path, transcript: Transcript, manager, *, target: int = 10, has_video: bool = False
) -> Funnel:
    settings = Settings()
    settings.clips.min_duration_s = 20
    settings.clips.max_duration_s = 60
    source = Source(
        id="s1",
        type="upload",
        path=str(tmp_path / "missing.mp4"),
        duration_s=transcript.duration,
        has_video=has_video,
    )
    return Funnel(
        manager=manager,
        transcript=transcript,
        silences=[],
        source=source,
        settings=settings,
        workdir=tmp_path / "intel",
        target=target,
    )


async def run_all(funnel: Funnel):
    found, content_type = await funnel.discover()
    pool = await funnel.evaluate(found, content_type)
    return await funnel.select(pool)


def assert_valid(picks, transcript: Transcript, target: int) -> None:
    assert len(picks) == target
    ids = [p.candidate.id for p in picks]
    assert len(set(ids)) == target
    for i, a in enumerate(picks):
        assert 20 - 0.01 <= a.candidate.duration_s <= 60 + 0.01
        assert 0 <= a.candidate.start_word < a.candidate.end_word < len(transcript.words)
        for b in picks[i + 1 :]:
            assert time_overlap_fraction(a.candidate, b.candidate) <= selection.MAX_OVERLAP


class TestExactlyTen:
    async def test_long_source_yields_exactly_ten_distinct_clips(self, tmp_path) -> None:
        transcript = make_transcript(40)
        # Enough proposals that the pool exceeds the shortlist and triage runs.
        manager = ScriptedManager(discovery_per_window=10)

        picks = await run_all(make_funnel(tmp_path, transcript, manager))

        assert_valid(picks, transcript, 10)
        assert all(p.tier != "fallback" for p in picks)
        # The funnel narrowed before the expensive steps: triage on the whole
        # pool, scoring only on the shortlist, one judgment call.
        assert manager.calls[caps.CANDIDATE_TRIAGE] >= 1
        assert manager.calls[caps.TEXT_SCORING] <= 40 // 6 + 1
        assert manager.calls[caps.FINAL_JUDGMENT] == 1

    async def test_small_pools_skip_triage(self, tmp_path) -> None:
        manager = ScriptedManager(discovery_per_window=4)

        await run_all(make_funnel(tmp_path, make_transcript(20), manager))

        assert caps.CANDIDATE_TRIAGE not in manager.calls

    async def test_sparse_discovery_is_filled_with_fallback_windows(self, tmp_path) -> None:
        transcript = make_transcript(20)
        manager = ScriptedManager(discovery_per_window=1)

        picks = await run_all(make_funnel(tmp_path, transcript, manager))

        assert_valid(picks, transcript, 10)
        tiers = [p.tier for p in picks]
        assert "fallback" in tiers
        # Every AI-found moment outranks every fallback window.
        assert tiers.index("fallback") == len([t for t in tiers if t != "fallback"])

    async def test_judge_rejecting_everything_still_delivers_ten(self, tmp_path) -> None:
        transcript = make_transcript(30)

        picks = await run_all(make_funnel(tmp_path, transcript, ScriptedManager(reject_all=True)))

        assert_valid(picks, transcript, 10)

    @pytest.mark.parametrize(
        "outage",
        [caps.CANDIDATE_TRIAGE, caps.TEXT_SCORING, caps.FINAL_JUDGMENT, caps.DUPLICATE_RISK],
    )
    async def test_optional_step_outage_degrades_but_completes(self, tmp_path, outage) -> None:
        transcript = make_transcript(30)

        picks = await run_all(make_funnel(tmp_path, transcript, ScriptedManager(fail={outage})))

        assert_valid(picks, transcript, 10)

    async def test_short_source_returns_fewer_rather_than_duplicates(self, tmp_path) -> None:
        transcript = make_transcript(2.5)

        picks = await run_all(make_funnel(tmp_path, transcript, ScriptedManager()))

        assert 0 < len(picks) < 10
        for i, a in enumerate(picks):
            for b in picks[i + 1 :]:
                assert time_overlap_fraction(a.candidate, b.candidate) <= selection.MAX_OVERLAP


class TestFailuresAndResume:
    async def test_discovery_outage_fails_with_the_managers_message(self, tmp_path) -> None:
        funnel = make_funnel(
            tmp_path, make_transcript(10), ScriptedManager(fail={caps.CANDIDATE_DISCOVERY})
        )

        with pytest.raises(FunnelError, match="scripted outage"):
            await funnel.discover()

    async def test_rerun_reuses_every_artifact_without_ai_calls(self, tmp_path) -> None:
        transcript = make_transcript(30)
        first = await run_all(make_funnel(tmp_path, transcript, ScriptedManager()))

        everything_down = ScriptedManager(fail=set(caps.SPECS))
        second = await run_all(make_funnel(tmp_path, transcript, everything_down))

        assert [p.candidate.id for p in second] == [p.candidate.id for p in first]
        assert everything_down.calls == {}

    async def test_failure_after_discovery_does_not_repeat_discovery(self, tmp_path) -> None:
        transcript = make_transcript(30)
        funnel = make_funnel(tmp_path, transcript, ScriptedManager())
        await funnel.discover()

        retry_manager = ScriptedManager()
        await run_all(make_funnel(tmp_path, transcript, retry_manager))

        assert caps.CANDIDATE_DISCOVERY not in retry_manager.calls

    async def test_artifacts_are_plain_json(self, tmp_path) -> None:
        await run_all(make_funnel(tmp_path, make_transcript(20), ScriptedManager()))

        for name in ("discovery", "candidates", "scores", "judgment", "selection"):
            json.loads((tmp_path / "intel" / f"{name}.json").read_text(encoding="utf-8"))


# --------------------------------------------------------------------------
# Glue: the real AI manager, a fake provider reading real prompts
# --------------------------------------------------------------------------


class PromptReadingProvider:
    """Answers from the rendered prompt, as a real model would have to."""

    def __init__(self) -> None:
        self.requests = []

    async def generate(self, request):
        self.requests.append(request)
        user = request.user
        if "Transcript section, words" in user:
            first, last = map(int, re.search(r"words (\d+) to (\d+)", user).groups())
            mid = (first + last) // 2
            body = {
                "content_type": "podcast",
                "candidates": [
                    {
                        "start_word_index": first + 10,
                        "end_word_index": first + 120,
                        "type": "insight",
                        "initial_score": 0.7,
                    },
                    {
                        "start_word_index": mid,
                        "end_word_index": mid + 100,
                        "type": "story_payoff",
                        "initial_score": 0.8,
                    },
                    # A hallucinated reference, which must be dropped, not trusted.
                    {
                        "start_word_index": last + 5000,
                        "end_word_index": last + 5100,
                        "type": "insight",
                    },
                ],
            }
        elif "Proposed clip: words" in user:
            ids = re.findall(r"candidate_id: (\S+)", user)
            body = {
                "scores": [
                    dict(
                        dict.fromkeys(caps.SCORE_DIMENSIONS, 7),
                        candidate_id=i,
                        overall=70,
                        topic="t",
                        title="x",
                    )
                    for i in ids
                ]
            }
        elif "finalists follow" in user:
            ids = re.findall(r"### (\S+) \|", user)
            body = {
                "verdicts": [
                    {
                        "candidate_id": i,
                        "keep": True,
                        "score": 80,
                        "title": "T",
                        "reason": "r",
                        "same_story_as": [],
                    }
                    for i in ids
                ]
            }
        else:
            body = {}
        return Completion(text=json.dumps(body), input_tokens=100, output_tokens=50)


async def test_real_manager_glue_produces_measured_distinct_clips(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-test")
    provider = PromptReadingProvider()
    records = []
    manager = AIManager(
        Settings(), job_id="j", provider_factory=lambda e, s: provider, on_record=records.append
    )
    transcript = make_transcript(25)

    picks = await run_all(make_funnel(tmp_path, transcript, manager))

    assert_valid(picks, transcript, 10)
    assert all(r.status == "success" for r in records)
    assert {r.capability for r in records} >= {
        caps.CANDIDATE_DISCOVERY,
        caps.TEXT_SCORING,
        caps.FINAL_JUDGMENT,
    }
    # Only the capability's minimum context was sent: no discovery prompt
    # contained the whole transcript.
    discovery_prompts = [r.user for r in provider.requests if "Transcript section" in r.user]
    assert all(len(p) < len(transcript.text) for p in discovery_prompts)


def test_cancellation_stops_the_funnel(tmp_path) -> None:
    from autoclip.pipeline.runner import JobCancelled

    funnel = make_funnel(tmp_path, make_transcript(20), ScriptedManager())
    funnel._is_cancelled = lambda: True

    with pytest.raises(JobCancelled):
        asyncio.run(funnel.discover())
