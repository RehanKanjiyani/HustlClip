"""Full-pipeline integration test against real media.

Runs every stage for real — ffmpeg, faster-whisper, MediaPipe, libass — on an
actual video with actual faces and speech. Only the language model's *answer* is
scripted, because clip selection is a judgement call that needs an API key and
would make the test non-deterministic anyway. Everything the pipeline does with
that answer is exercised end to end.

This is the test that catches integration failures unit tests structurally
cannot: a crop path whose segments don't tile the clip, a caption offset that
desyncs on a real transcript, an export that succeeds on synthetic colour bars
and fails on real footage.

Point it at a file to run it::

    set AUTOCLIP_E2E_MEDIA=C:\\path\\to\\clip.mp4
    pytest -m e2e -q

Use something short — a few minutes. Transcription dominates the runtime.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from autoclip.config import Settings
from autoclip.db import store
from autoclip.db.models import Job, new_id
from autoclip.intelligence import capabilities as caps
from autoclip.pipeline import Stage, ingest
from autoclip.pipeline.export import ratio_dimensions
from autoclip.pipeline.ffmpeg import probe
from autoclip.pipeline.reframe.croppath import CropPath
from autoclip.pipeline.runner import JobWorkspace, PipelineRunner
from autoclip.pipeline.transcript import Transcript

pytestmark = [pytest.mark.slow, pytest.mark.e2e]

ENV_MEDIA = "AUTOCLIP_E2E_MEDIA"


def media_path() -> Path:
    raw = os.environ.get(ENV_MEDIA)
    if not raw:
        pytest.skip(f"Set {ENV_MEDIA} to a media file to run the end-to-end test.")
    path = Path(raw)
    if not path.exists():
        pytest.skip(f"{ENV_MEDIA} points at {path}, which does not exist.")
    return path


class _Result:
    def __init__(self, output) -> None:
        self.output = output
        self.provider = "scripted"
        self.model = "scripted"
        self.fallback_used = False
        self.records: list = []


class ScriptedManager:
    """Stands in for the AI manager, answering from the real transcript.

    Discovery deliberately returns two overlapping candidates and one that is
    far too short, so dedupe and duration clamping are exercised rather than
    bypassed. Scoring and judgment answer every candidate they are shown, so
    the whole funnel runs; titles are left blank so discovery titles survive.
    """

    def __init__(self) -> None:
        self.calls = 0

    def available(self, capability: str) -> bool:
        return capability in (caps.CANDIDATE_DISCOVERY, caps.TEXT_SCORING, caps.FINAL_JUDGMENT)

    async def run(self, capability: str, payload):
        self.calls += 1
        if capability == caps.CANDIDATE_DISCOVERY:
            return _Result(self._discover(payload))
        if capability == caps.TEXT_SCORING:
            return _Result(
                {
                    item.candidate_id: caps.CandidateScore(
                        dimensions=dict.fromkeys(caps.SCORE_DIMENSIONS, 7.0),
                        overall=0.7,
                        moment_type="insight",
                        topic="",
                        title="",
                        self_contained=True,
                    )
                    for item in payload.items
                }
            )
        if capability == caps.FINAL_JUDGMENT:
            return _Result(
                {
                    item.candidate_id: caps.Verdict(keep=True, score=0.8, title="", reason="kept")
                    for item in payload.finalists
                }
            )
        raise AssertionError(f"unexpected capability {capability}")

    def _discover(self, request: caps.DiscoveryRequest) -> caps.DiscoveryResult:
        first, last = request.first_word, request.last_word
        span = max(1, (last - first) // 4)
        spans = [
            (first, min(last, first + span), "Opening stretch", 0.91),
            # Overlaps the first by design — dedupe must drop it.
            (first + span // 4, min(last, first + span), "Overlapping duplicate", 0.60),
            (min(last - 1, first + 2 * span), min(last, first + 3 * span), "Later stretch", 0.78),
            # Two words long — must be dropped or extended, never exported as a
            # sub-second clip.
            (first, min(last, first + 2), "Far too short", 0.55),
        ]
        return caps.DiscoveryResult(
            content_type="general",
            candidates=[
                caps.DiscoveredCandidate(start, end, "insight", score, title=title, hook="h")
                for start, end, title, score in spans
                if end > start
            ],
        )


@pytest.fixture(scope="module", autouse=True)
def autoclip_home(tmp_path_factory):
    """One throwaway home for the whole module.

    Shadows the function-scoped autouse fixture in conftest by name. Without
    this the pipeline runs once and then every assertion looks at a fresh empty
    database, because the shared fixture repoints AUTOCLIP_HOME per test.
    """
    from _pytest.monkeypatch import MonkeyPatch
    from autoclip import db, paths

    patcher = MonkeyPatch()
    home = tmp_path_factory.mktemp("e2e_home")
    patcher.setenv(paths.ENV_HOME, str(home))
    db.reset_connections()

    yield home

    patcher.undo()
    db.reset_connections()


@pytest.fixture(scope="module")
def pipeline_result(autoclip_home):
    """Run the whole pipeline once; every test below inspects the result."""
    from autoclip import db
    from autoclip.pipeline import runner as runner_module

    source_file = media_path()
    db.init()

    source = store.create_source(ingest.ingest_file(source_file, title="E2E source"))

    settings = Settings()
    settings.whisper.model = "tiny"  # keeps the run to a couple of minutes
    settings.clips.max_clips = 3
    settings.clips.min_duration_s = 12.0
    settings.clips.max_duration_s = 45.0
    settings.export.caption_style = "bold_pop"
    settings.export.ratio = "9:16"

    job = store.create_job(Job(id=new_id(), source_id=source.id, provider="scripted", settings={}))

    provider = ScriptedManager()
    original = runner_module.build_manager
    runner_module.build_manager = lambda *args, **kwargs: provider

    events: list = []
    try:
        pipeline_runner = PipelineRunner(job, source, settings=settings, on_progress=events.append)
        import asyncio

        clips = asyncio.run(pipeline_runner.run())
    finally:
        runner_module.build_manager = original

    return {
        "source": source,
        "job": job,
        "clips": clips,
        "events": events,
        "workspace": JobWorkspace(job.id),
        "settings": settings,
        "provider": provider,
    }


class TestPipelineCompletes:
    def test_job_reaches_done(self, pipeline_result) -> None:
        job = store.get_job(pipeline_result["job"].id)

        assert job is not None
        assert job.status == "done"
        assert job.error is None
        assert job.progress == pytest.approx(1.0)

    def test_every_stage_reported_progress(self, pipeline_result) -> None:
        stages = {event.stage for event in pipeline_result["events"]}

        assert stages == set(Stage)

    def test_progress_never_goes_backwards(self, pipeline_result) -> None:
        overall = [event.overall for event in pipeline_result["events"]]

        assert overall == sorted(overall)
        assert overall[-1] == pytest.approx(1.0)


class TestTranscription:
    def test_transcript_has_word_timings(self, pipeline_result) -> None:
        transcript = Transcript.load(pipeline_result["workspace"].transcript)

        assert len(transcript.words) > 50
        assert all(word.end >= word.start for word in transcript.words)

    def test_words_are_chronological(self, pipeline_result) -> None:
        transcript = Transcript.load(pipeline_result["workspace"].transcript)
        starts = [word.start for word in transcript.words]

        assert starts == sorted(starts)

    def test_transcript_row_matches_the_file(self, pipeline_result) -> None:
        transcript = Transcript.load(pipeline_result["workspace"].transcript)
        row = store.get_transcript(pipeline_result["job"].id)

        assert row is not None
        assert row.word_count == len(transcript.words)

    def test_silence_map_was_built(self, pipeline_result) -> None:
        assert pipeline_result["workspace"].silences.exists()


class TestClipSelection:
    def test_clips_were_produced(self, pipeline_result) -> None:
        assert len(pipeline_result["clips"]) > 0

    def test_exactly_the_configured_count(self, pipeline_result) -> None:
        # Python owns the count: the scripted discovery proposes a different
        # number per window, and selection must still land on the target.
        assert len(pipeline_result["clips"]) == pipeline_result["settings"].clips.max_clips

    def test_selected_clips_are_distinct(self, pipeline_result) -> None:
        clips = sorted(pipeline_result["clips"], key=lambda c: c.start_s)

        for earlier, later in zip(clips, clips[1:], strict=False):
            overlap = max(0.0, earlier.end_s - later.start_s)
            assert overlap <= 0.15 * min(earlier.duration_s, later.duration_s) + 0.01

    def test_decision_trail_lives_in_the_clip_details(self, pipeline_result) -> None:
        for clip in pipeline_result["clips"]:
            assert clip.details["tier"] in {"judged_keep", "scored", "fallback", "discovered"}
            assert "selection" in clip.details

    def test_overlapping_duplicate_was_deduped(self, pipeline_result) -> None:
        titles = {clip.title for clip in pipeline_result["clips"]}

        assert "Overlapping duplicate" not in titles

    def test_every_clip_respects_the_duration_range(self, pipeline_result) -> None:
        settings = pipeline_result["settings"]

        for clip in pipeline_result["clips"]:
            assert settings.clips.min_duration_s - 1.0 <= clip.duration_s
            assert clip.duration_s <= settings.clips.max_duration_s + 1.0

    def test_clips_are_ranked_by_score(self, pipeline_result) -> None:
        scores = [clip.score for clip in pipeline_result["clips"]]

        assert scores == sorted(scores, reverse=True)
        assert [c.rank for c in pipeline_result["clips"]] == list(
            range(1, len(pipeline_result["clips"]) + 1)
        )

    def test_boundaries_lie_inside_the_source(self, pipeline_result) -> None:
        duration = pipeline_result["source"].duration_s

        for clip in pipeline_result["clips"]:
            assert 0 <= clip.start_s < clip.end_s <= duration + 1.0

    def test_word_indices_map_back_to_the_transcript(self, pipeline_result) -> None:
        transcript = Transcript.load(pipeline_result["workspace"].transcript)

        for clip in pipeline_result["clips"]:
            assert 0 <= clip.start_word <= clip.end_word < len(transcript.words)
            # The recorded seconds must agree with the words they point at,
            # which is the whole reason detection returns indices not times.
            word_start = transcript.words[clip.start_word].start
            assert abs(clip.start_s - word_start) < 2.0


class TestReframe:
    def test_a_crop_path_exists_per_clip(self, pipeline_result) -> None:
        workspace = pipeline_result["workspace"]

        for clip in pipeline_result["clips"]:
            assert workspace.crop_path(clip.id).exists()

    def test_segments_tile_the_clip_without_gaps(self, pipeline_result) -> None:
        workspace = pipeline_result["workspace"]

        for clip in pipeline_result["clips"]:
            path = CropPath.load(workspace.crop_path(clip.id))
            segments = path.segments

            assert segments
            assert segments[0].start_s == pytest.approx(0.0, abs=0.05)
            assert segments[-1].end_s == pytest.approx(clip.duration_s, abs=0.05)
            for earlier, later in zip(segments, segments[1:], strict=False):
                # A gap or overlap desyncs the concatenated render from audio.
                assert earlier.end_s == pytest.approx(later.start_s, abs=0.01)

    def test_crops_stay_inside_the_frame(self, pipeline_result) -> None:
        workspace = pipeline_result["workspace"]

        for clip in pipeline_result["clips"]:
            path = CropPath.load(workspace.crop_path(clip.id))
            for segment in path.segments:
                assert segment.width <= path.source_width
                assert segment.height <= path.source_height
                for keyframe in segment.keyframes:
                    assert -1 <= keyframe.x <= path.source_width - segment.width + 1
                    assert -1 <= keyframe.y <= path.source_height - segment.height + 1

    def test_crop_dimensions_are_even(self, pipeline_result) -> None:
        # Odd dimensions fail an h264 yuv420p encode.
        workspace = pipeline_result["workspace"]

        for clip in pipeline_result["clips"]:
            for segment in CropPath.load(workspace.crop_path(clip.id)).segments:
                assert segment.width % 2 == 0
                assert segment.height % 2 == 0

    def test_faces_were_actually_found(self, pipeline_result) -> None:
        """At least one clip should track a subject, not centre-crop everything.

        A talking-head source that produces only GENERAL segments means face
        detection silently did nothing — the failure this whole stage exists to
        avoid.
        """
        from autoclip.pipeline.reframe.croppath import Strategy

        workspace = pipeline_result["workspace"]
        strategies = {
            segment.strategy
            for clip in pipeline_result["clips"]
            for segment in CropPath.load(workspace.crop_path(clip.id)).segments
        }

        assert strategies & {Strategy.TRACK, Strategy.WIDE}, (
            f"No subject was tracked in any clip (strategies: {strategies}). "
            "Face detection produced nothing on real talking-head footage."
        )


class TestExports:
    def test_one_export_per_clip(self, pipeline_result) -> None:
        for clip in pipeline_result["clips"]:
            assert len(store.list_exports(clip.id)) == 1

    def test_exported_files_exist_and_are_not_empty(self, pipeline_result) -> None:
        for clip in pipeline_result["clips"]:
            path = Path(store.list_exports(clip.id)[0].path)
            assert path.exists()
            assert path.stat().st_size > 10_000

    def test_exports_are_vertical_with_audio(self, pipeline_result) -> None:
        expected = ratio_dimensions("9:16")

        for clip in pipeline_result["clips"]:
            info = probe(Path(store.list_exports(clip.id)[0].path))
            assert (info.width, info.height) == expected
            assert info.has_audio
            assert info.video_codec == "h264"

    def test_export_duration_matches_the_clip(self, pipeline_result) -> None:
        for clip in pipeline_result["clips"]:
            info = probe(Path(store.list_exports(clip.id)[0].path))
            assert info.duration_s == pytest.approx(clip.duration_s, abs=0.6)

    def test_clips_are_marked_exported(self, pipeline_result) -> None:
        for clip in pipeline_result["clips"]:
            assert store.get_clip(clip.id).status == "exported"


class TestResume:
    def test_rerunning_reuses_completed_stages(self, pipeline_result) -> None:
        """A second run must not redo transcription.

        Resume is the difference between a rate-limit retry costing seconds and
        costing another full transcription pass.
        """
        from autoclip.pipeline import runner as runner_module

        workspace = pipeline_result["workspace"]
        transcript_mtime = workspace.transcript.stat().st_mtime

        # Re-running the *same* job is exactly what the retry endpoint does; a
        # new job id would get a fresh workspace and prove nothing.
        job = pipeline_result["job"]

        provider = ScriptedManager()
        original = runner_module.build_manager
        runner_module.build_manager = lambda *args, **kwargs: provider
        try:
            import asyncio

            runner = PipelineRunner(
                job, pipeline_result["source"], settings=pipeline_result["settings"]
            )
            asyncio.run(runner.run())
        finally:
            runner_module.build_manager = original

        assert workspace.transcript.stat().st_mtime == transcript_mtime
        assert provider.calls == 0, "Highlight detection re-ran despite existing clips."
