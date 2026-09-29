"""Pipeline orchestration.

Runs a job stage by stage, writing each stage's artifacts into
``work/{job_id}/``. Because every stage's output is a file on disk, a retry
skips everything already done and resumes at the stage that failed — which
matters when stage two took eleven minutes and stage four hit a rate limit.

Progress is reported through a callback rather than written directly, so the
same runner serves the CLI (a progress bar) and the web API (an SSE stream).
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError

from .. import paths
from ..config import Settings
from ..config import load as load_settings
from ..db import store
from ..db.models import AIDecision, Clip, Export, Job, Source, new_id, utcnow
from ..db.models import Transcript as TranscriptRow
from ..intelligence import AIManager, DecisionRecord
from . import Stage, captions, export, ffmpeg, prepare, transcribe
from .candidates import Candidate
from .funnel import Funnel, FunnelError
from .prepare import Silence
from .reframe import ReframeConfig, build_crop_path
from .reframe.croppath import CropPath
from .selection import Pick
from .transcript import Transcript

log = logging.getLogger(__name__)

#: Weight of each stage in the overall progress bar. Rough proportions of wall
#: time on a mid-range machine — transcription and export dominate.
STAGE_WEIGHTS: dict[Stage, float] = {
    Stage.PREPARE: 0.05,
    Stage.TRANSCRIBE: 0.30,
    Stage.HIGHLIGHTS: 0.10,
    Stage.EVALUATE: 0.08,
    Stage.SELECT: 0.02,
    Stage.REFRAME: 0.20,
    Stage.CAPTIONS: 0.02,
    Stage.EXPORT: 0.23,
}


def build_manager(settings: Settings, job_id: str) -> AIManager:
    """The job's AI manager, persisting every decision record.

    Module-level so tests (and the e2e suite) can substitute a scripted manager
    the same way they used to substitute a provider.
    """

    def persist(record: DecisionRecord) -> None:
        store.add_ai_decision(AIDecision(**record.to_dict()))

    return AIManager(settings, job_id=job_id, on_record=persist)


def job_settings(job: Job) -> Settings:
    """Effective settings for a job.

    Creative choices (Whisper, clip length/count, captions, ratio, ingest) come
    from the snapshot taken when the job was created, so per-job overrides are
    honoured by the queue. Provider and AI routing configuration comes from the
    current settings, so fixing a key or disabling a provider takes effect on
    retry. Secrets are never part of a snapshot.
    """
    current = load_settings()
    if not job.settings:
        return current
    try:
        snapshot = Settings.model_validate(job.settings)
    except ValidationError:
        log.warning("Job %s has an unreadable settings snapshot; using current settings.", job.id)
        return current
    merged = current.model_copy(deep=True)
    merged.whisper = snapshot.whisper
    merged.clips = snapshot.clips
    merged.export = snapshot.export
    merged.ingest = snapshot.ingest
    # Composition is a per-job creative choice, unlike the rest of the AI
    # routing configuration.
    merged.ai.dynamic_composition = snapshot.ai.dynamic_composition
    merged._fallback_secrets = dict(current._fallback_secrets)
    return merged


class JobCancelled(RuntimeError):
    """The job was cancelled by the user."""


class PipelineError(RuntimeError):
    """A stage failed in a way the user should see."""

    def __init__(self, message: str, *, stage: Stage) -> None:
        super().__init__(message)
        self.stage = stage


@dataclass
class ProgressEvent:
    stage: Stage
    #: Progress within the stage, 0..1.
    stage_progress: float
    #: Progress across the whole job, 0..1.
    overall: float
    message: str = ""


ProgressHandler = Callable[[ProgressEvent], None]


class JobWorkspace:
    """Paths for one job's intermediate artifacts."""

    def __init__(self, job_id: str) -> None:
        self.root = paths.job_work_dir(job_id)
        self.root.mkdir(parents=True, exist_ok=True)

    @property
    def audio(self) -> Path:
        return self.root / "audio.wav"

    @property
    def transcript(self) -> Path:
        return self.root / "transcript.json"

    @property
    def silences(self) -> Path:
        return self.root / "silences.json"

    @property
    def thumbnails(self) -> Path:
        return self.root / "thumbnails"

    def crop_path(self, clip_id: str) -> Path:
        return self.root / "crops" / f"{clip_id}.json"

    @property
    def captions_dir(self) -> Path:
        return self.root / "captions"

    def composition(self, clip_id: str) -> Path:
        """Dynamic-composition timeline plus the crop path it produced."""
        return self.root / "composition" / f"{clip_id}.json"

    @property
    def intel(self) -> Path:
        """Artifacts of the intelligence funnel, one JSON file per step."""
        return self.root / "intel"


class PipelineRunner:
    """Executes one job."""

    def __init__(
        self,
        job: Job,
        source: Source,
        *,
        settings: Settings | None = None,
        on_progress: ProgressHandler | None = None,
        is_cancelled: Callable[[], bool] | None = None,
    ) -> None:
        self.job = job
        self.source = source
        self.settings = settings or job_settings(job)
        self.on_progress = on_progress
        self._is_cancelled = is_cancelled or (lambda: False)
        self.workspace = JobWorkspace(job.id)
        self._completed_weight = 0.0
        self._last_overall = 0.0

    # -- progress ----------------------------------------------------------

    def _check_cancelled(self) -> None:
        if self._is_cancelled():
            raise JobCancelled("Job cancelled.")

    def _emit(
        self,
        stage: Stage,
        stage_progress: float,
        message: str = "",
        *,
        overall: float | None = None,
    ) -> None:
        if overall is None:
            overall = self._completed_weight + STAGE_WEIGHTS[stage] * stage_progress
        # Never move the bar backwards: sub-step reports (ffmpeg's time-based
        # progress can overshoot a clip, then the next clip starts at zero)
        # would otherwise show as tiny visible jumps back.
        overall = max(self._last_overall, min(1.0, overall))
        self._last_overall = overall
        store.update_job(self.job.id, current_stage=stage.value, progress=round(overall, 4))
        if self.on_progress:
            self.on_progress(
                ProgressEvent(
                    stage=stage,
                    stage_progress=stage_progress,
                    overall=overall,
                    message=message or stage.label,
                )
            )

    def _finish_stage(self, stage: Stage) -> None:
        """Mark a stage complete.

        ``overall`` is passed explicitly rather than derived. Deriving it after
        incrementing the accumulated weight counts the stage twice, so the bar
        jumped past the true total and then snapped backwards when the next
        stage reported 0 — visibly, at every stage boundary.
        """
        self._completed_weight += STAGE_WEIGHTS[stage]
        self._emit(stage, 1.0, overall=self._completed_weight)

    def _stage_progress(self, stage: Stage) -> Callable[[float], None]:
        def report(fraction: float) -> None:
            self._emit(stage, max(0.0, min(1.0, fraction)))

        return report

    # -- entry point -------------------------------------------------------

    async def run(self) -> list[Clip]:
        """Run the full pipeline and return the exported clips."""
        store.update_job(self.job.id, status="running", started_at=utcnow(), error=None)

        try:
            audio = self._stage_prepare()
            transcript = self._stage_transcribe(audio)
            silences = self._load_or_detect_silences(audio)
            clips = await self._stage_highlights(transcript, silences)
            crop_paths = self._stage_reframe(clips, transcript)
            if self.settings.ai.dynamic_composition:
                await self._compose(clips, transcript, crop_paths)
            self._stage_captions(clips, transcript)
            self._stage_export(clips, transcript, crop_paths)
        except JobCancelled:
            store.update_job(self.job.id, status="cancelled", finished_at=utcnow(), progress=0.0)
            raise
        except Exception as exc:
            log.exception("Job %s failed.", self.job.id)
            store.update_job(self.job.id, status="failed", error=str(exc), finished_at=utcnow())
            raise

        store.update_job(self.job.id, status="done", progress=1.0, finished_at=utcnow())
        return clips

    # -- stages ------------------------------------------------------------

    def _stage_prepare(self) -> Path:
        stage = Stage.PREPARE
        self._check_cancelled()
        source_path = Path(self.source.path)

        if self.workspace.audio.exists() and self.workspace.audio.stat().st_size > 0:
            log.info("Reusing existing audio for job %s.", self.job.id)
        else:
            self._emit(stage, 0.0, "Extracting audio")
            prepare.extract_audio(
                source_path,
                self.workspace.audio,
                duration_s=self.source.duration_s,
                on_progress=self._stage_progress(stage),
            )

        if self.source.has_video and not self.workspace.thumbnails.exists():
            prepare.generate_thumbnails(source_path, self.workspace.thumbnails)

        self._finish_stage(stage)
        return self.workspace.audio

    def _stage_transcribe(self, audio: Path) -> Transcript:
        stage = Stage.TRANSCRIBE
        self._check_cancelled()

        if self.workspace.transcript.exists():
            log.info("Reusing existing transcript for job %s.", self.job.id)
            transcript = Transcript.load(self.workspace.transcript)
            self._finish_stage(stage)
            return transcript

        self._emit(stage, 0.0, "Transcribing")
        transcript = transcribe.transcribe(
            audio,
            self.settings.whisper,
            duration_s=self.source.duration_s,
            on_progress=self._stage_progress(stage),
            cancelled=self._is_cancelled,
        )

        if self.settings.whisper.diarization:
            from ..config import HF_TOKEN_KEY, get_secret

            self._emit(stage, 0.95, "Identifying speakers")
            transcribe.diarize(audio, transcript, hf_token=get_secret(HF_TOKEN_KEY, self.settings))

        transcript.save(self.workspace.transcript)
        store.upsert_transcript(
            TranscriptRow(
                job_id=self.job.id,
                json_path=str(self.workspace.transcript),
                language=transcript.language,
                model=transcript.model,
                has_diarization=transcript.has_diarization,
                word_count=len(transcript.words),
                source=transcript.source,
            )
        )

        self._finish_stage(stage)
        return transcript

    def _load_or_detect_silences(self, audio: Path) -> list[Silence]:
        if self.workspace.silences.exists():
            raw = json.loads(self.workspace.silences.read_text(encoding="utf-8"))
            return [Silence(**item) for item in raw]

        silences = prepare.detect_silences(audio)
        self.workspace.silences.write_text(
            json.dumps([{"start": s.start, "end": s.end} for s in silences]),
            encoding="utf-8",
        )
        return silences

    async def _stage_highlights(
        self, transcript: Transcript, silences: list[Silence]
    ) -> list[Clip]:
        """Discovery → evaluation → selection, as three visible stages.

        Selected clips are the stage's durable output: once they exist, a retry
        goes straight to reframing. Inside, the funnel's own artifacts make each
        AI step resumable too.
        """
        existing = store.list_clips(self.job.id)
        if existing:
            log.info("Reusing %d existing clips for job %s.", len(existing), self.job.id)
            for stage in (Stage.HIGHLIGHTS, Stage.EVALUATE, Stage.SELECT):
                self._finish_stage(stage)
            return existing

        target = self.settings.clips.max_clips
        funnel = Funnel(
            manager=build_manager(self.settings, self.job.id),
            transcript=transcript,
            silences=silences,
            source=self.source,
            settings=self.settings,
            workdir=self.workspace.intel,
            target=target,
            is_cancelled=self._is_cancelled,
        )

        def reporter(stage: Stage):
            def report(fraction: float, message: str) -> None:
                self._emit(stage, max(0.0, min(1.0, fraction)), message)

            return report

        self._check_cancelled()
        self._emit(Stage.HIGHLIGHTS, 0.0, "Finding moments")
        try:
            found, content_type = await funnel.discover(reporter(Stage.HIGHLIGHTS))
        except FunnelError as exc:
            raise PipelineError(str(exc), stage=Stage.HIGHLIGHTS) from exc
        self._finish_stage(Stage.HIGHLIGHTS)

        self._check_cancelled()
        self._emit(Stage.EVALUATE, 0.0, "Evaluating moments")
        pool = await funnel.evaluate(found, content_type, reporter(Stage.EVALUATE))
        self._finish_stage(Stage.EVALUATE)

        self._check_cancelled()
        self._emit(Stage.SELECT, 0.0, f"Selecting the best {target}")
        picks = await funnel.select(pool, reporter(Stage.SELECT))
        if not picks:
            raise PipelineError(
                "No clip of the configured length fits in this video.", stage=Stage.SELECT
            )

        clips = [self._clip_from_pick(pick, transcript, content_type) for pick in picks]
        store.replace_clips(self.job.id, clips)
        self._finish_stage(Stage.SELECT)
        return clips

    def _clip_from_pick(self, pick: Pick, transcript: Transcript, content_type: str) -> Clip:
        candidate: Candidate = pick.candidate
        verdict = candidate.verdict or {}
        scores = candidate.scores or {}
        title = (
            verdict.get("title")
            or scores.get("title")
            or candidate.title
            or transcript.text_between(
                candidate.start_word, min(candidate.end_word, candidate.start_word + 8)
            )
        )
        hook = candidate.hook or transcript.text_between(
            candidate.start_word, min(candidate.end_word, candidate.start_word + 10)
        )
        return Clip(
            id=new_id(),
            job_id=self.job.id,
            start_s=candidate.start_s,
            end_s=candidate.end_s,
            start_word=candidate.start_word,
            end_word=candidate.end_word,
            rank=pick.rank,
            title=title.strip()[:120],
            hook=hook.strip()[:300],
            score=round(pick.final * 100),
            reason=(verdict.get("reason") or candidate.reason or "").strip(),
            details={
                "candidate_id": candidate.id,
                "moment_type": candidate.moment_type,
                "topic": scores.get("topic", ""),
                "tier": pick.tier,
                "quality": "fallback" if pick.tier == "fallback" else "selected",
                "content_type": content_type,
                "dimensions": scores.get("dimensions", {}),
                "visual": candidate.visual or None,
                "judge_kept": verdict.get("keep"),
                "boundary_adjusted": candidate.adjusted,
                "selection": pick.explain(),
            },
        )

    def _stage_reframe(self, clips: list[Clip], transcript: Transcript) -> dict[str, CropPath]:
        stage = Stage.REFRAME
        self._check_cancelled()
        source_path = Path(self.source.path)

        crop_paths: dict[str, CropPath] = {}

        if not self.source.has_video:
            # Audio-only sources render as captions on a solid background, so
            # there is nothing to reframe.
            self._finish_stage(stage)
            return crop_paths

        # `hustlclip clip --centre-crop` sets this; it was previously accepted
        # and silently ignored.
        centre_only = bool(self.settings.export.__dict__.get("centre_crop", False))
        config = ReframeConfig(
            aspect_w=9 if self.settings.export.ratio == "9:16" else 1,
            aspect_h=16 if self.settings.export.ratio == "9:16" else 1,
            centre_only=centre_only,
        )
        if self.settings.export.ratio == "16:9":
            config = ReframeConfig(aspect_w=16, aspect_h=9, centre_only=centre_only)

        for index, clip in enumerate(clips):
            self._check_cancelled()
            cached = self.workspace.crop_path(clip.id)
            if cached.exists():
                crop_paths[clip.id] = CropPath.load(cached)
            else:
                crop_paths[clip.id] = build_crop_path(
                    source_path,
                    start_s=clip.start_s,
                    end_s=clip.end_s,
                    transcript=transcript,
                    config=config,
                )
                crop_paths[clip.id].save(cached)

            self._emit(stage, (index + 1) / len(clips), f"Reframing clip {index + 1}")

        self._finish_stage(stage)
        return crop_paths

    async def _compose(
        self, clips: list[Clip], transcript: Transcript, crop_paths: dict[str, CropPath]
    ) -> None:
        """Optional dynamic composition, applied on top of the reframe result.

        The original crop path stays in ``crops/``; the composed one is kept
        with its timeline under ``composition/`` so a retry reuses it and the
        review player can show exactly what will render. Any failure keeps the
        standard framing for that clip — composition is never worth a failed job.
        """
        from ..intelligence import CapabilityUnavailable
        from ..intelligence import capabilities as caps
        from . import composition

        manager = build_manager(self.settings, self.job.id)
        if not manager.available(caps.DYNAMIC_COMPOSITION):
            log.info("Dynamic composition requested but no model can serve it; skipping.")
            return

        for index, clip in enumerate(clips):
            self._check_cancelled()
            path = crop_paths.get(clip.id)
            if path is None or not path.segments:
                continue
            marker = self.workspace.composition(clip.id)
            if marker.exists():
                crop_paths[clip.id] = CropPath.from_dict(
                    json.loads(marker.read_text(encoding="utf-8"))["crop_path"]
                )
                continue

            request = caps.CompositionRequest(
                candidate_id=clip.id,
                duration_s=clip.duration_s,
                transcript=transcript.text_between(clip.start_word, clip.end_word),
                speaker_count=len(
                    {
                        w.speaker
                        for w in transcript.slice(clip.start_word, clip.end_word)
                        if w.speaker
                    }
                )
                or 1,
                shots=composition.shots_for_prompt(path),
                allowed_layouts=list(composition.SUPPORTED_LAYOUTS),
            )
            # Reframe is already counted as finished; pass overall explicitly
            # so this message can't push the bar past its true position.
            self._emit(
                Stage.REFRAME,
                1.0,
                f"Choosing layouts for clip {index + 1}",
                overall=self._completed_weight,
            )
            try:
                result = await manager.run(caps.DYNAMIC_COMPOSITION, request)
            except CapabilityUnavailable as exc:
                log.warning(
                    "Composition failed for clip %s (%s); keeping standard framing.", clip.id, exc
                )
                continue

            edges = [s.start_s for s in path.segments] + [path.duration_s]
            timeline = composition.normalise_timeline(result.output, path.duration_s, edges)
            composed = composition.apply(path, timeline)
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(
                json.dumps(
                    {
                        "timeline": [t.__dict__ for t in timeline],
                        "crop_path": composed.to_dict(),
                    }
                ),
                encoding="utf-8",
            )
            crop_paths[clip.id] = composed

    def _stage_captions(self, clips: list[Clip], transcript: Transcript) -> None:
        stage = Stage.CAPTIONS
        self._check_cancelled()
        # Caption files are written during export, where the output dimensions
        # are known. This stage validates the style so a typo fails fast rather
        # than after the reframe work is already done.
        captions.get_style(self.settings.export.caption_style)
        self._finish_stage(stage)

    def _stage_export(
        self,
        clips: list[Clip],
        transcript: Transcript,
        crop_paths: dict[str, CropPath],
    ) -> None:
        stage = Stage.EXPORT
        self._check_cancelled()

        style = captions.get_style(self.settings.export.caption_style)
        ratio = self.settings.export.ratio
        source_path = Path(self.source.path)
        destination_dir = paths.exports_dir() / self.job.id
        destination_dir.mkdir(parents=True, exist_ok=True)

        for index, clip in enumerate(clips):
            self._check_cancelled()

            # A retry after a failed render resumes at the clip that failed:
            # clips already rendered with the same look are not encoded again.
            if any(
                e.ratio == ratio
                and e.style == style.key
                and Path(e.path).exists()
                and Path(e.path).stat().st_size > 0
                for e in store.list_exports(clip.id)
            ):
                self._emit(stage, (index + 1) / len(clips), f"Clip {index + 1} already rendered")
                continue

            crop_path = crop_paths.get(clip.id) or self._fallback_crop_path(clip, ratio)
            words = transcript.slice(clip.start_word, clip.end_word)
            # The rank prefix keeps names unique (two clips can share a title)
            # and sorts files in the order they were ranked.
            destination = destination_dir / export.output_filename(
                f"{clip.rank:02d} {clip.title or 'clip'}", ratio
            )

            request = export.ExportRequest(
                source=source_path,
                destination=destination,
                start_s=clip.start_s,
                end_s=clip.end_s,
                crop_path=crop_path,
                words=words,
                style=style,
                ratio=ratio,
            )

            def clip_progress(fraction: float, i: int = index) -> None:
                fraction = max(0.0, min(1.0, fraction))
                self._emit(stage, (i + fraction) / len(clips), f"Exporting clip {i + 1}")

            export.export_clip(
                request,
                work_dir=self.workspace.captions_dir,
                settings=self.settings.export,
                on_progress=clip_progress,
                cancelled=self._is_cancelled,
            )

            store.create_export(
                Export(
                    id=new_id(),
                    clip_id=clip.id,
                    path=str(destination),
                    ratio=ratio,
                    style=style.key,
                    size_bytes=destination.stat().st_size,
                )
            )
            store.update_clip(clip.id, status="exported")

        self._finish_stage(stage)

    def _fallback_crop_path(self, clip: Clip, ratio: str) -> CropPath:
        """Centre crop for sources with no reframe data (audio-only, or a failure)."""
        from .reframe.croppath import centre_crop

        width, height = export.ratio_dimensions(ratio)
        info = ffmpeg.probe(Path(self.source.path))
        return centre_crop(
            info.width or width,
            info.height or height,
            clip.end_s - clip.start_s,
            aspect_w=9 if ratio == "9:16" else (1 if ratio == "1:1" else 16),
            aspect_h=16 if ratio == "9:16" else (1 if ratio == "1:1" else 9),
        )


async def run_job(
    job_id: str,
    *,
    settings: Settings | None = None,
    on_progress: ProgressHandler | None = None,
    is_cancelled: Callable[[], bool] | None = None,
) -> list[Clip]:
    """Load a job and run it to completion."""
    job = store.get_job(job_id)
    if job is None:
        raise PipelineError(f"Job {job_id} not found.", stage=Stage.PREPARE)

    source = store.get_source(job.source_id)
    if source is None:
        raise PipelineError(f"Source {job.source_id} not found.", stage=Stage.PREPARE)

    runner = PipelineRunner(
        job, source, settings=settings, on_progress=on_progress, is_cancelled=is_cancelled
    )
    # The pipeline is mostly blocking work (ffmpeg, Whisper, MediaPipe) with one
    # async stage. Running it in a worker thread keeps the web server's event
    # loop responsive while a job is going.
    return await asyncio.get_running_loop().run_in_executor(None, _run_sync, runner)


def _run_sync(runner: PipelineRunner) -> list[Clip]:
    return asyncio.run(runner.run())
