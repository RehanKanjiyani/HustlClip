"""The intelligence funnel: transcript in, exactly N selected candidates out.

::

    compact transcript windows ─► candidate_discovery (fast model, breadth)
          ─► normalisation (Python: measured timing, dedupe, features)
          ─► candidate_triage (Jev or cheap LLM; only when the pool is large)
          ─► text_scoring (mid-tier model, batches, with surrounding context)
          ─► visual_understanding (only flagged, promising candidates)
          ─► finalists ─► final_judgment (strong model, one compact call)
          ─► duplicate_risk (Jev or cheap LLM, ambiguous pairs only)
          ─► selection (Python: exact count, distinct, diverse)

Every step persists its output under ``work/{job_id}/intel/`` and reuses it on
a retry, so a rate limit during judgment never repeats discovery, let alone
transcription. Every model call goes through the AI manager; this module never
names a model or provider.

A failed optional step (triage, visual, judgment, duplicate risk) degrades the
job — logged and recorded — rather than failing it. Discovery is the one step
that must succeed at least partly: without it there is nothing to judge.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..config import Settings
from ..db.models import Source
from ..intelligence import AIManager, CapabilityUnavailable
from ..intelligence import capabilities as caps
from ..providers.base import ImageInput
from . import boundaries, ffmpeg, highlights, selection
from .candidates import (
    Candidate,
    NormalizationReport,
    Proposal,
    build_candidate,
    content_words,
    fallback_candidates,
    jaccard,
    normalize,
    tagged_text,
    text_of,
    time_overlap_fraction,
    word_iou,
)
from .prepare import Silence
from .transcript import Transcript

log = logging.getLogger(__name__)

DISCOVERY_CONCURRENCY = 3
SCORING_BATCH = 6
SCORING_CONCURRENCY = 2
TRIAGE_BATCH = 15
#: Words of context shown either side of a candidate when scoring.
CONTEXT_WORDS = 45
#: Characters of clip text shown to the judge per finalist.
JUDGE_TEXT_CHARS = 2400
VISUAL_FRAMES = (0.15, 0.5, 0.85)
VISUAL_FRAME_WIDTH = 512
MAX_DUPLICATE_PAIRS = 24


class FunnelError(RuntimeError):
    """The funnel could not produce any candidates."""


ProgressCallback = Callable[[float, str], None]


class Funnel:
    def __init__(
        self,
        *,
        manager: AIManager,
        transcript: Transcript,
        silences: list[Silence],
        source: Source,
        settings: Settings,
        workdir: Path,
        target: int,
        is_cancelled: Callable[[], bool] | None = None,
    ) -> None:
        self.manager = manager
        self.transcript = transcript
        self.silences = silences
        self.source = source
        self.settings = settings
        self.dir = workdir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.target = max(1, target)
        self.min_s = settings.clips.min_duration_s
        self.max_s = settings.clips.max_duration_s
        self._is_cancelled = is_cancelled or (lambda: False)

    # ------------------------------------------------------------------
    # artifacts
    # ------------------------------------------------------------------

    def _path(self, name: str) -> Path:
        return self.dir / f"{name}.json"

    def _load(self, name: str) -> Any | None:
        path = self._path(name)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            log.warning("Ignoring unreadable artifact %s; it will be rebuilt.", path.name)
            return None

    def _save(self, name: str, data: Any) -> None:
        path = self._path(name)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(path)

    def _check_cancelled(self) -> None:
        if self._is_cancelled():
            from .runner import JobCancelled

            raise JobCancelled("Job cancelled.")

    # ------------------------------------------------------------------
    # 1. discovery + normalisation
    # ------------------------------------------------------------------

    async def discover(
        self, on_progress: ProgressCallback | None = None
    ) -> tuple[list[Candidate], str]:
        cached = self._load("candidates")
        if cached is not None:
            return [Candidate.from_dict(c) for c in cached["candidates"]], cached["content_type"]

        windows = highlights.build_windows(self.transcript)
        if not windows:
            raise FunnelError("The transcript is empty, so there is nothing to clip.")

        stored = self._load("discovery") or {"windows": {}}
        results: dict[str, Any] = stored["windows"]
        pending = [w for w in windows if _window_key(w) not in results]
        failures: list[CapabilityUnavailable] = []
        done = len(windows) - len(pending)
        semaphore = asyncio.Semaphore(DISCOVERY_CONCURRENCY)
        lock = asyncio.Lock()

        async def run_window(window) -> None:
            nonlocal done
            async with semaphore:
                self._check_cancelled()
                request = caps.DiscoveryRequest(
                    text=window.text,
                    first_word=window.first_word,
                    last_word=window.last_word,
                    min_duration_s=self.min_s,
                    max_duration_s=self.max_s,
                    max_candidates=_candidates_per_window(window.duration_s),
                    speakers=window.speakers,
                )
                try:
                    result = await self.manager.run(caps.CANDIDATE_DISCOVERY, request)
                except CapabilityUnavailable as exc:
                    log.warning("Discovery failed for window %s: %s", _window_key(window), exc)
                    failures.append(exc)
                else:
                    async with lock:
                        results[_window_key(window)] = {
                            "content_type": result.output.content_type,
                            "candidates": [c.__dict__ for c in result.output.candidates],
                        }
                        self._save("discovery", {"windows": results})
                async with lock:
                    done += 1
                    if on_progress:
                        on_progress(done / len(windows), f"Finding moments ({done}/{len(windows)})")

        await asyncio.gather(*(run_window(w) for w in pending))
        self._check_cancelled()

        if not results:
            reason = str(failures[-1]) if failures else "No window could be analysed."
            raise FunnelError(reason)
        if failures:
            log.warning(
                "%d of %d transcript windows could not be analysed; continuing with the rest.",
                len(failures),
                len(windows),
            )

        proposals = [
            Proposal(
                start_word=c["start_word_index"],
                end_word=c["end_word_index"],
                moment_type=c["moment_type"],
                initial_score=c["initial_score"],
                title=c["title"],
                hook=c["hook"],
                reason=c["reason"],
            )
            for window in results.values()
            for c in window["candidates"]
        ]
        content_type = _majority_content_type(results)
        found, report = normalize(
            self.transcript,
            proposals,
            silences=self.silences,
            min_duration_s=self.min_s,
            max_duration_s=self.max_s,
        )
        log.info(
            "Discovery: %d proposals -> %d candidates (%d without a valid boundary, %d merged). "
            "Content type: %s.",
            report.proposed,
            report.kept,
            report.no_valid_boundary,
            report.merged_duplicates,
            content_type,
        )
        self._save(
            "candidates",
            {
                "content_type": content_type,
                "report": _report_dict(report),
                "candidates": [c.to_dict() for c in found],
            },
        )
        return found, content_type

    # ------------------------------------------------------------------
    # 2. evaluation: triage, scoring, visual, judgment
    # ------------------------------------------------------------------

    async def evaluate(
        self,
        found: list[Candidate],
        content_type: str,
        on_progress: ProgressCallback | None = None,
    ) -> list[Candidate]:
        report = on_progress or (lambda fraction, message: None)
        by_id = {c.id: c for c in found}

        report(0.0, "Evaluating moments")
        shortlist = await self._triage(found)
        self._check_cancelled()

        report(0.2, f"Scoring {len(shortlist)} moments")
        await self._score(
            shortlist, content_type, lambda f: report(0.2 + 0.5 * f, "Scoring moments")
        )
        self._check_cancelled()

        report(0.7, "Checking visuals")
        await self._visual(shortlist, content_type)
        self._check_cancelled()

        finalists = self._finalists(list(by_id.values()))
        report(0.8, f"Comparing {len(finalists)} finalists")
        await self._judge(finalists, content_type)
        self._check_cancelled()

        report(1.0, "Evaluation complete")
        return list(by_id.values())

    def _shortlist_size(self) -> int:
        return max(4 * self.target, 24)

    async def _triage(self, found: list[Candidate]) -> list[Candidate]:
        limit = self._shortlist_size()
        stored = self._load("triage")
        if stored is None:
            stored = {}
            if len(found) > limit and self.manager.available(caps.CANDIDATE_TRIAGE):
                items = [self._triage_item(c) for c in found]
                for start in range(0, len(items), TRIAGE_BATCH):
                    self._check_cancelled()
                    batch = caps.TriageRequest(items=items[start : start + TRIAGE_BATCH])
                    try:
                        result = await self.manager.run(caps.CANDIDATE_TRIAGE, batch)
                    except CapabilityUnavailable as exc:
                        log.warning("Triage unavailable (%s); ranking by discovery prior.", exc)
                        break
                    for cid, decision in result.output.items():
                        stored[cid] = decision.__dict__
                self._save("triage", stored)

        for candidate in found:
            if candidate.id in stored:
                candidate.triage = stored[candidate.id]
                moment = stored[candidate.id].get("moment_type")
                if moment and candidate.moment_type == "other":
                    candidate.moment_type = moment

        if len(found) <= limit:
            return list(found)
        ranked = sorted(found, key=lambda c: (-selection.composite_score(c), c.start_s, c.id))
        return ranked[:limit]

    def _triage_item(self, candidate: Candidate) -> caps.TriageItem:
        return caps.TriageItem(
            candidate_id=candidate.id,
            duration_s=candidate.duration_s,
            transcript=text_of(self.transcript, candidate),
            moment_type=candidate.moment_type,
            initial_score=round(candidate.initial_score, 3),
            speaker_count=candidate.speaker_count,
            speech_density=candidate.speech_density,
            silence_ratio=candidate.silence_ratio,
        )

    async def _score(
        self, shortlist: list[Candidate], content_type: str, progress: Callable[[float], None]
    ) -> None:
        stored: dict[str, Any] = self._load("scores") or {}
        pending = [c for c in shortlist if c.id not in stored]
        batches = [pending[i : i + SCORING_BATCH] for i in range(0, len(pending), SCORING_BATCH)]
        semaphore = asyncio.Semaphore(SCORING_CONCURRENCY)
        lock = asyncio.Lock()
        done = 0

        async def run_batch(batch: list[Candidate]) -> None:
            nonlocal done
            async with semaphore:
                self._check_cancelled()
                request = caps.ScoringRequest(
                    items=[self._scoring_item(c) for c in batch],
                    content_type=content_type,
                    min_duration_s=self.min_s,
                    max_duration_s=self.max_s,
                )
                try:
                    result = await self.manager.run(caps.TEXT_SCORING, request)
                except CapabilityUnavailable as exc:
                    log.warning("Scoring failed for %d candidates: %s", len(batch), exc)
                else:
                    async with lock:
                        for cid, score in result.output.items():
                            stored[cid] = score.__dict__
                        self._save("scores", stored)
                async with lock:
                    done += 1
                    progress(done / max(1, len(batches)))

        await asyncio.gather(*(run_batch(b) for b in batches))
        if pending and not any(c.id in stored for c in pending):
            log.warning("No candidate could be scored; selection will rely on earlier signals.")

        for candidate in shortlist:
            score = stored.get(candidate.id)
            if score is None:
                continue
            candidate.scores = score
            if score.get("moment_type"):
                candidate.moment_type = score["moment_type"]
            if score.get("title"):
                candidate.title = score["title"]
            self._apply_boundary_suggestion(candidate, score)

    def _scoring_item(self, candidate: Candidate) -> caps.ScoringItem:
        last = len(self.transcript.words) - 1
        first = max(0, candidate.start_word - CONTEXT_WORDS)
        final = min(last, candidate.end_word + CONTEXT_WORDS)
        return caps.ScoringItem(
            candidate_id=candidate.id,
            tagged_text=tagged_text(self.transcript, first, final),
            candidate_first=candidate.start_word,
            candidate_last=candidate.end_word,
            context_first=first,
            context_last=final,
            duration_s=candidate.duration_s,
            moment_type=candidate.moment_type,
        )

    def _apply_boundary_suggestion(self, candidate: Candidate, score: dict[str, Any]) -> None:
        """Context reconstruction: accept a model's better edges if code can cut them.

        The suggestion is word indices only. It must refine to a valid
        boundary within the duration limits and stay recognisably the same
        moment (word IoU >= 0.3); otherwise the original edges stand.
        """
        start, end = score.get("start_word_index"), score.get("end_word_index")
        if start is None or end is None or candidate.adjusted:
            return
        if (start, end) == (candidate.start_word, candidate.end_word):
            return
        boundary = boundaries.refine(
            self.transcript,
            start,
            end,
            silences=self.silences,
            min_duration_s=self.min_s,
            max_duration_s=self.max_s,
        )
        if boundary is None:
            return
        if (
            word_iou(
                boundary.start_word, boundary.end_word, candidate.start_word, candidate.end_word
            )
            < 0.3
        ):
            return
        rebuilt = build_candidate(self.transcript, boundary, silences=self.silences)
        candidate.start_word, candidate.end_word = rebuilt.start_word, rebuilt.end_word
        candidate.start_s, candidate.end_s = rebuilt.start_s, rebuilt.end_s
        candidate.speech_density = rebuilt.speech_density
        candidate.silence_ratio = rebuilt.silence_ratio
        candidate.speaker_count = rebuilt.speaker_count
        candidate.adjusted = True

    async def _visual(self, shortlist: list[Candidate], content_type: str) -> None:
        stored: dict[str, Any] | None = self._load("visual")
        if stored is None:
            stored = {}
            if (
                self.settings.ai.visual_analysis
                and self.source.has_video
                and self.manager.available(caps.VISUAL_UNDERSTANDING)
            ):
                for candidate in self._visual_candidates(shortlist, content_type):
                    self._check_cancelled()
                    frames, times = self._frames(candidate)
                    if not frames:
                        continue
                    request = caps.VisualRequest(
                        candidate_id=candidate.id,
                        transcript=text_of(self.transcript, candidate),
                        duration_s=candidate.duration_s,
                        frames=frames,
                        frame_times_s=times,
                    )
                    try:
                        result = await self.manager.run(caps.VISUAL_UNDERSTANDING, request)
                    except CapabilityUnavailable as exc:
                        log.warning("Visual analysis unavailable (%s); skipping the rest.", exc)
                        break
                    stored[candidate.id] = result.output.__dict__
            self._save("visual", stored)

        for candidate in shortlist:
            if candidate.id in stored:
                candidate.visual = stored[candidate.id]

    def _visual_candidates(self, shortlist: list[Candidate], content_type: str) -> list[Candidate]:
        """Only promising candidates whose value plausibly depends on the picture."""
        ranked = sorted(shortlist, key=lambda c: (-selection.composite_score(c), c.start_s))
        promising = ranked[: 2 * self.target]
        flagged = [
            c
            for c in promising
            if content_type == "gaming"
            or (c.triage or {}).get("needs_visual", 0.0) >= 0.5
            or (c.scores or {}).get("self_contained") is False
            or c.moment_type in ("gameplay_highlight", "reaction", "revelation")
        ]
        return flagged[: max(0, self.settings.ai.max_visual_candidates)]

    def _frames(self, candidate: Candidate) -> tuple[list[ImageInput], list[float]]:
        frame_dir = self.dir / "frames"
        frame_dir.mkdir(exist_ok=True)
        images: list[ImageInput] = []
        times: list[float] = []
        for i, fraction in enumerate(VISUAL_FRAMES):
            offset = candidate.duration_s * fraction
            path = frame_dir / f"{candidate.id}_{i}.jpg"
            if not path.exists():
                try:
                    ffmpeg.run(
                        [
                            "-ss",
                            f"{candidate.start_s + offset:.3f}",
                            "-i",
                            str(self.source.path),
                            "-frames:v",
                            "1",
                            "-vf",
                            f"scale={VISUAL_FRAME_WIDTH}:-2",
                            "-q:v",
                            "5",
                            str(path),
                        ]
                    )
                except ffmpeg.FFmpegError as exc:
                    log.warning("Could not extract a frame for %s: %s", candidate.id, exc)
                    continue
            if path.exists() and path.stat().st_size > 0:
                images.append(ImageInput(data=path.read_bytes(), media_type="image/jpeg"))
                times.append(round(offset, 2))
        return images, times

    def _finalists(self, pool: list[Candidate]) -> list[Candidate]:
        """The compact pool the strong model compares side by side."""
        size = min(len(pool), max(2 * self.target, self.target + 6), 24)
        ranked = sorted(pool, key=lambda c: (-selection.composite_score(c), c.start_s, c.id))
        finalists: list[Candidate] = []
        for candidate in ranked:
            if len(finalists) >= size:
                break
            if any(time_overlap_fraction(candidate, f) > selection.MAX_OVERLAP for f in finalists):
                continue
            finalists.append(candidate)
        return finalists

    async def _judge(self, finalists: list[Candidate], content_type: str) -> None:
        stored: dict[str, Any] | None = self._load("judgment")
        if stored is None:
            stored = {}
            if finalists and self.manager.available(caps.FINAL_JUDGMENT):
                request = caps.JudgmentRequest(
                    finalists=[self._finalist_item(c) for c in finalists],
                    target_count=self.target,
                    content_type=content_type,
                )
                try:
                    result = await self.manager.run(caps.FINAL_JUDGMENT, request)
                except CapabilityUnavailable as exc:
                    log.warning("Final judgment unavailable (%s); selecting on scores.", exc)
                else:
                    stored = {cid: verdict.__dict__ for cid, verdict in result.output.items()}
            self._save("judgment", stored)

        for candidate in finalists:
            verdict = stored.get(candidate.id)
            if verdict:
                candidate.verdict = verdict
                if verdict.get("title"):
                    candidate.title = verdict["title"]

    def _finalist_item(self, candidate: Candidate) -> caps.FinalistItem:
        visual = candidate.visual or {}
        note = visual.get("visual_event") or visual.get("notes") or ""
        return caps.FinalistItem(
            candidate_id=candidate.id,
            start_label=_timestamp(candidate.start_s),
            duration_s=candidate.duration_s,
            moment_type=candidate.moment_type,
            topic=(candidate.scores or {}).get("topic", ""),
            mid_score=round(selection.composite_score(candidate) * 100, 1),
            text=text_of(self.transcript, candidate)[:JUDGE_TEXT_CHARS],
            visual_note=note,
        )

    # ------------------------------------------------------------------
    # 3. selection
    # ------------------------------------------------------------------

    async def select(
        self, pool: list[Candidate], on_progress: ProgressCallback | None = None
    ) -> list[selection.Pick]:
        report = on_progress or (lambda fraction, message: None)
        texts = {c.id: text_of(self.transcript, c) for c in pool}

        report(0.1, "Checking for repeats")
        duplicate_risk = await self._duplicate_risk(pool, texts)
        context = selection.SelectionContext(texts=texts, duplicate_risk=duplicate_risk)

        report(0.6, f"Selecting the best {self.target}")
        picks = selection.select(pool, self.target, context)

        if len(picks) < self.target:
            extra = fallback_candidates(
                self.transcript,
                silences=self.silences,
                min_duration_s=self.min_s,
                max_duration_s=self.max_s,
                avoid=[p.candidate for p in picks],
            )
            log.info(
                "Only %d distinct AI candidates qualified; adding %d fallback windows.",
                len(picks),
                len(extra),
            )
            for candidate in extra:
                texts[candidate.id] = text_of(self.transcript, candidate)
            picks = selection.select(pool + extra, self.target, context)

        if len(picks) < self.target:
            log.warning(
                "The source only has room for %d distinct clips of %.0f-%.0f s (target %d).",
                len(picks),
                self.min_s,
                self.max_s,
                self.target,
            )

        self._save(
            "selection",
            [
                {
                    "rank": p.rank,
                    "candidate_id": p.candidate.id,
                    "tier": p.tier,
                    "quality": round(p.quality, 4),
                    "adjusted": round(p.adjusted, 4),
                    "penalties": p.penalties,
                    "explanation": p.explain(),
                }
                for p in picks
            ],
        )
        report(1.0, f"Selected {len(picks)} clips")
        return picks

    async def _duplicate_risk(
        self, pool: list[Candidate], texts: dict[str, str]
    ) -> dict[tuple[str, str], float]:
        stored = self._load("duplicates")
        if stored is not None:
            return {(row["a"], row["b"]): row["p"] for row in stored}

        ranked = sorted(pool, key=lambda c: (-selection.composite_score(c), c.start_s, c.id))
        top = ranked[: 2 * self.target]
        words = {c.id: content_words(texts[c.id]) for c in top}
        pairs: list[caps.DuplicatePair] = []
        for i, a in enumerate(top):
            for b in top[i + 1 :]:
                if time_overlap_fraction(a, b) > selection.MAX_OVERLAP:
                    continue  # never selectable together anyway
                similarity = jaccard(words[a.id], words[b.id])
                flagged = b.id in (a.verdict or {}).get("same_story_as", []) or a.id in (
                    b.verdict or {}
                ).get("same_story_as", [])
                # Ask only about genuinely ambiguous pairs: clearly different
                # ones cost tokens for nothing, obvious ones are already known.
                if not flagged and 0.12 <= similarity < 0.5:
                    pairs.append(
                        caps.DuplicatePair(
                            a_id=a.id, a_text=texts[a.id], b_id=b.id, b_text=texts[b.id]
                        )
                    )
        pairs = pairs[:MAX_DUPLICATE_PAIRS]

        result: dict[tuple[str, str], float] = {}
        if pairs and self.manager.available(caps.DUPLICATE_RISK):
            try:
                answer = await self.manager.run(
                    caps.DUPLICATE_RISK, caps.DuplicateRequest(pairs=pairs)
                )
            except CapabilityUnavailable as exc:
                log.warning("Duplicate check unavailable (%s); using text similarity only.", exc)
            else:
                result = dict(answer.output)
        self._save("duplicates", [{"a": a, "b": b, "p": p} for (a, b), p in result.items()])
        return result


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _window_key(window) -> str:
    return f"{window.first_word}-{window.last_word}"


def _candidates_per_window(duration_s: float) -> int:
    """Adaptive breadth: roughly one proposal per minute of speech, 4..12."""
    return max(4, min(12, round(duration_s / 60) + 2))


def _majority_content_type(results: dict[str, Any]) -> str:
    votes = Counter(r["content_type"] for r in results.values() if r.get("content_type"))
    if not votes:
        return "general"
    kind, count = votes.most_common(1)[0]
    return kind if count / sum(votes.values()) >= 0.6 else "general"


def _timestamp(seconds: float) -> str:
    seconds = int(seconds)
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def _report_dict(report: NormalizationReport) -> dict[str, int]:
    return {
        "proposed": report.proposed,
        "no_valid_boundary": report.no_valid_boundary,
        "merged_duplicates": report.merged_duplicates,
        "kept": report.kept,
    }
