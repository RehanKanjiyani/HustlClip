"""Canonical clip candidates and their deterministic normalisation.

Everything an AI stage proposes arrives here as word indices and leaves as a
:class:`Candidate` whose timing is *measured*: word index → Faster-Whisper
timestamp → sentence snap → duration clamp → silence alignment
(:func:`boundaries.refine`). Models never supply seconds.

This module is pure Python and has no provider dependencies, so every rule in
it — what counts as a duplicate, how features are computed, how fallback
windows are cut — is unit-testable.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from . import boundaries
from .prepare import Silence
from .transcript import Transcript

#: Two proposals sharing this much of their words are the same moment.
DUPLICATE_IOU = 0.4

#: Each extra independent proposal of the same moment (overlapping windows,
#: repeated discovery) nudges its prior up, capped.
AGREEMENT_BONUS = 0.03
AGREEMENT_BONUS_CAP = 0.09

_WORD = re.compile(r"[a-z0-9']+")

#: High-frequency words carry no topical signal for similarity checks.
STOPWORDS = frozenset(
    """
    a an the and or but if then so to of in on at for with from by as is are was were
    be been being it its this that these those i you he she we they me him her us them
    my your his our their what which who whom when where why how all any both each few
    more most other some such no nor not only own same than too very can will just don
    should now do does did doing have has had having would could there here about into
    over under again further once up down out off like yeah um uh oh okay ok really
    know think mean gonna got get going right well also even still because thing things
    lot kind sort
    """.split()  # noqa: SIM905 - a word list reads better as prose
)


@dataclass
class Candidate:
    """The canonical internal representation of one potential clip."""

    id: str
    start_word: int
    end_word: int
    start_s: float
    end_s: float
    moment_type: str = "other"
    #: "ai" for model-discovered, "fallback" for deterministic sentence windows.
    source: str = "ai"
    #: Discovery's prior, 0..1.
    initial_score: float = 0.5
    title: str = ""
    hook: str = ""
    reason: str = ""
    proposals: int = 1
    speaker_count: int = 0
    speech_density: float = 0.0
    silence_ratio: float = 0.0
    #: Stage outputs, filled as the funnel runs. Plain dicts so the whole
    #: candidate round-trips through a JSON artifact.
    triage: dict[str, Any] | None = None
    scores: dict[str, Any] | None = None
    visual: dict[str, Any] | None = None
    verdict: dict[str, Any] | None = None
    adjusted: bool = False

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Candidate:
        known = set(cls.__dataclass_fields__)  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class Proposal:
    """A raw word-range proposal from discovery, before normalisation."""

    start_word: int
    end_word: int
    moment_type: str = "other"
    initial_score: float = 0.5
    title: str = ""
    hook: str = ""
    reason: str = ""


@dataclass
class NormalizationReport:
    proposed: int = 0
    no_valid_boundary: int = 0
    merged_duplicates: int = 0
    kept: int = 0
    reasons: list[str] = field(default_factory=list)


def candidate_id(start_word: int, end_word: int) -> str:
    return f"c{start_word}_{end_word}"


def word_iou(a_start: int, a_end: int, b_start: int, b_end: int) -> float:
    """Intersection over union of two inclusive word ranges."""
    intersection = max(0, min(a_end, b_end) - max(a_start, b_start) + 1)
    if intersection == 0:
        return 0.0
    union = (a_end - a_start + 1) + (b_end - b_start + 1) - intersection
    return intersection / union if union else 0.0


def time_overlap_fraction(a: Candidate, b: Candidate) -> float:
    """Overlap as a fraction of the shorter clip — 1.0 when one contains the other."""
    overlap = max(0.0, min(a.end_s, b.end_s) - max(a.start_s, b.start_s))
    shorter = min(a.duration_s, b.duration_s)
    return overlap / shorter if shorter > 0 else 0.0


def normalize(
    transcript: Transcript,
    proposals: list[Proposal],
    *,
    silences: list[Silence],
    min_duration_s: float,
    max_duration_s: float,
    source: str = "ai",
) -> tuple[list[Candidate], NormalizationReport]:
    """Resolve proposals into measured, deduplicated candidates.

    Order of operations matters: proposals are refined *before* dedupe, since
    two proposals with different sloppy edges often snap to the same sentences.
    """
    report = NormalizationReport(proposed=len(proposals))
    refined: list[Candidate] = []

    last_index = len(transcript.words) - 1
    for proposal in proposals:
        if last_index < 0 or proposal.end_word <= proposal.start_word:
            report.no_valid_boundary += 1
            continue
        start = max(0, min(proposal.start_word, last_index))
        end = max(0, min(proposal.end_word, last_index))
        boundary = boundaries.refine(
            transcript,
            start,
            end,
            silences=silences,
            min_duration_s=min_duration_s,
            max_duration_s=max_duration_s,
        )
        if boundary is None:
            report.no_valid_boundary += 1
            continue
        refined.append(
            build_candidate(
                transcript,
                boundary,
                silences=silences,
                moment_type=proposal.moment_type,
                source=source,
                initial_score=proposal.initial_score,
                title=proposal.title,
                hook=proposal.hook,
                reason=proposal.reason,
            )
        )

    merged = merge_duplicates(refined)
    report.merged_duplicates = len(refined) - len(merged)
    report.kept = len(merged)
    return merged, report


def build_candidate(
    transcript: Transcript,
    boundary: boundaries.Boundary,
    *,
    silences: list[Silence],
    **fields: Any,
) -> Candidate:
    words = transcript.slice(boundary.start_word, boundary.end_word)
    duration = max(0.001, boundary.end_s - boundary.start_s)
    speakers = {w.speaker for w in words if w.speaker}
    return Candidate(
        id=candidate_id(boundary.start_word, boundary.end_word),
        start_word=boundary.start_word,
        end_word=boundary.end_word,
        start_s=round(boundary.start_s, 3),
        end_s=round(boundary.end_s, 3),
        speaker_count=len(speakers) or (1 if words else 0),
        speech_density=round(len(words) / duration, 3),
        silence_ratio=round(
            _silence_inside(boundary.start_s, boundary.end_s, silences) / duration, 3
        ),
        **fields,
    )


def merge_duplicates(candidates: list[Candidate], *, iou: float = DUPLICATE_IOU) -> list[Candidate]:
    """Collapse near-identical candidates, keeping the strongest prior.

    Deterministic: ordered by prior, then position, then id. The survivor
    inherits the proposal count, which is a mild agreement signal.
    """
    ordered = sorted(candidates, key=lambda c: (-c.initial_score, c.start_s, c.id))
    kept: list[Candidate] = []
    for candidate in ordered:
        match = next(
            (
                existing
                for existing in kept
                if word_iou(
                    candidate.start_word, candidate.end_word, existing.start_word, existing.end_word
                )
                > iou
            ),
            None,
        )
        if match is None:
            kept.append(candidate)
            continue
        match.proposals += candidate.proposals
        bonus = min(AGREEMENT_BONUS_CAP, AGREEMENT_BONUS * (match.proposals - 1))
        match.initial_score = min(1.0, max(match.initial_score, candidate.initial_score) + bonus)
    return sorted(kept, key=lambda c: (c.start_s, c.id))


def _silence_inside(start: float, end: float, silences: list[Silence]) -> float:
    total = 0.0
    for silence in silences:
        overlap = min(end, silence.end) - max(start, silence.start)
        if overlap > 0:
            total += overlap
    return total


# --------------------------------------------------------------------------
# Text helpers
# --------------------------------------------------------------------------


def content_words(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in STOPWORDS and len(w) > 2}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def text_of(transcript: Transcript, candidate: Candidate) -> str:
    return transcript.text_between(candidate.start_word, candidate.end_word)


def tagged_text(transcript: Transcript, first: int, last: int) -> str:
    """``[index]word`` rendering, with speaker changes marked."""
    parts: list[str] = []
    current: str | None = None
    for index in range(max(0, first), min(last, len(transcript.words) - 1) + 1):
        word = transcript.words[index]
        if word.speaker and word.speaker != current:
            current = word.speaker
            parts.append(f"\n<{word.speaker}>")
        parts.append(f"[{index}]{word.text.strip()}")
    return " ".join(parts).strip()


# --------------------------------------------------------------------------
# Deterministic fallback windows
# --------------------------------------------------------------------------


_NUMBER = re.compile(r"\d")


def fallback_candidates(
    transcript: Transcript,
    *,
    silences: list[Silence],
    min_duration_s: float,
    max_duration_s: float,
    avoid: list[Candidate] | None = None,
) -> list[Candidate]:
    """Sentence-bounded windows cut by code, for when the AI funnel runs short.

    These exist so a job can still deliver its full clip count from material
    the models passed over. They are marked ``source="fallback"`` and scored by
    a transparent heuristic well below typical AI scores, so selection only
    reaches for them after every usable AI candidate.
    """
    if not transcript.words:
        return []
    avoid = avoid or []
    target = min(max_duration_s, max(min_duration_s * 1.5, (min_duration_s + max_duration_s) / 3))

    sentence_starts = [0] + [
        i for i in range(1, len(transcript.words)) if transcript.words[i - 1].ends_sentence
    ]

    produced: list[Candidate] = []
    last_end_s = -1.0
    for start in sentence_starts:
        start_s = transcript.words[start].start
        if start_s < last_end_s:
            continue
        end_guess = transcript.index_at_time(start_s + target)
        boundary = boundaries.refine(
            transcript,
            start,
            max(start + 1, end_guess),
            silences=silences,
            min_duration_s=min_duration_s,
            max_duration_s=max_duration_s,
        )
        if boundary is None:
            continue
        candidate = build_candidate(
            transcript,
            boundary,
            silences=silences,
            moment_type="other",
            source="fallback",
            initial_score=0.0,
            title=transcript.text_between(
                boundary.start_word, min(boundary.end_word, boundary.start_word + 7)
            ),
        )
        # Compare the padded clip edges, not word times: silence alignment
        # widens each clip, and adjacent windows must not share audio.
        if candidate.start_s < last_end_s:
            continue
        if any(time_overlap_fraction(candidate, other) > 0 for other in avoid):
            continue
        candidate.initial_score = heuristic_score(transcript, candidate)
        produced.append(candidate)
        last_end_s = candidate.end_s

    return produced


def heuristic_score(transcript: Transcript, candidate: Candidate) -> float:
    """A transparent 0..0.45 prior for fallback windows.

    Deliberately capped below AI-scored candidates. It prefers dense speech and
    lines with questions, exclamations, or numbers — weak but honest signals.
    """
    text = text_of(transcript, candidate)
    score = 0.15
    score += 0.12 * min(1.0, candidate.speech_density / 3.0)
    score += 0.06 if "?" in text else 0.0
    score += 0.05 if "!" in text else 0.0
    score += 0.04 if _NUMBER.search(text) else 0.0
    score -= 0.10 * min(1.0, candidate.silence_ratio * 2)
    return round(max(0.0, min(0.45, score)), 4)
