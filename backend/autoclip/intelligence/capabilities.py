"""Capability contracts: what each AI step is asked, and what counts as an answer.

Each capability defines

* its payload (the minimum context the decision needs),
* how to ask a text model (prompt) and, for decision capabilities, how to ask a
  structured-decision provider such as TypeSafe Jev (typed questions),
* validation that turns an HTTP-200 response into either a normalised internal
  result or a :class:`CapabilityError` — schema, references, score ranges.

Both execution paths of a decision capability normalise to the *same* result
type, which is what lets the AI manager fall back from Jev to an LLM (or the
other way round) without the pipeline noticing.

Deterministic capabilities — transcription (Faster-Whisper) and candidate
normalisation (Python) — are deliberately not here: they are never routed to a
model. The spec's finer-grained decision names map onto ``candidate_triage``'s
fields: ``should_keep`` (quality gate), ``priority``, ``needs_visual_analysis``
(visual_analysis_required), ``needs_deep_reasoning`` and ``moment_type``
(candidate_classification).
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from typing import Any

from ..providers.base import ErrorCategory, ImageInput, extract_json_object, load_prompt
from ..providers.typesafe_provider import DecisionResponse

# --------------------------------------------------------------------------
# Names
# --------------------------------------------------------------------------

CANDIDATE_DISCOVERY = "candidate_discovery"
CANDIDATE_TRIAGE = "candidate_triage"
TEXT_SCORING = "text_scoring"
VISUAL_UNDERSTANDING = "visual_understanding"
FINAL_JUDGMENT = "final_judgment"
DUPLICATE_RISK = "duplicate_risk"
DYNAMIC_COMPOSITION = "dynamic_composition"

#: Capabilities a structured-decision provider (Jev) can serve.
DECISION_CAPABILITIES: tuple[str, ...] = (CANDIDATE_TRIAGE, DUPLICATE_RISK)

MOMENT_TYPES: dict[str, str] = {
    "strong_opening": "An opening line that grabs attention immediately",
    "surprising_statement": "A surprising or counterintuitive claim",
    "controversial_opinion": "A strong or controversial opinion",
    "emotional_moment": "A genuine emotional beat",
    "admission": "An unexpected personal admission or confession",
    "punchline": "A joke or funny moment that lands",
    "story_payoff": "A story that reaches its payoff",
    "insight": "A strong insight, lesson, or explanation",
    "advice": "Concrete, useful advice",
    "curiosity_gap": "Sets up a question the viewer needs answered",
    "disagreement": "A disagreement or debate between people",
    "revelation": "A reveal, transformation, or impressive result",
    "question_answer": "A question followed by an answer with a payoff",
    "gameplay_highlight": "A clutch play, kill, comeback, fail, or unexpected game event",
    "reaction": "A strong reaction (rage, shock, joy)",
    "other": "Something else worth clipping",
}

CONTENT_TYPES = ("podcast", "interview", "gaming", "educational", "commentary", "general")

SCORE_DIMENSIONS = (
    "hook",
    "context",
    "payoff",
    "emotion",
    "curiosity",
    "quotability",
    "usefulness",
    "surprise",
    "storytelling",
    "retention",
    "opening",
    "ending",
    "completeness",
)


class CapabilityError(Exception):
    """A response arrived but is not usable (schema, references, quality)."""

    def __init__(self, message: str, category: ErrorCategory, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.category = category
        self.retryable = retryable


def _unit(value: Any, default: float | None = None) -> float | None:
    """Coerce a probability-like value to [0, 1]. Accepts 0-100 and 0-10 scales."""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(number):
        return default
    if number > 10:
        number /= 100
    elif number > 1:
        number /= 10
    return max(0.0, min(1.0, number))


def _ten(value: Any) -> float | None:
    """Coerce a 0-10 dimension score. Accepts 0-1 and 0-100 scales."""
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number):
        return None
    if number > 10:
        number /= 10
    elif 0 < number <= 1 and not float(number).is_integer():
        number *= 10
    return max(0.0, min(10.0, number))


def _text(value: Any, limit: int = 200) -> str:
    return ("" if value is None else str(value)).strip()[:limit]


def _items(payload: dict[str, Any], *keys: str) -> list[Any]:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, list):
            return value
    return []


def _parse_json(text: str) -> dict[str, Any]:
    try:
        return extract_json_object(text)
    except (ValueError, json.JSONDecodeError) as exc:
        raise CapabilityError(
            f"Response is not valid JSON: {exc}", ErrorCategory.MALFORMED
        ) from exc


# --------------------------------------------------------------------------
# Spec base
# --------------------------------------------------------------------------


class CapabilitySpec:
    name: str = ""
    #: "text" or "image" — images route only to models accepting them.
    modality: str = "text"
    prompt: str = ""
    temperature: float | None = 0.2

    def build_prompt(self, payload: Any, repair: str | None = None) -> tuple[str, str]:
        system = load_prompt(self.prompt)
        user = self.render(payload)
        if repair:
            user += (
                "\n\nYour previous response could not be used:\n"
                f"{repair}\n"
                "Respond again with ONLY the corrected JSON object."
            )
        return system, user

    def render(self, payload: Any) -> str:  # pragma: no cover - abstract
        raise NotImplementedError

    def parse_text(self, text: str, payload: Any) -> Any:  # pragma: no cover - abstract
        raise NotImplementedError

    def images(self, payload: Any) -> list[ImageInput]:
        return []

    # Decision path — only decision capabilities implement these.
    def build_decisions(self, payload: Any) -> list[tuple[Any, dict[str, dict]]] | None:
        return None

    def parse_decisions(self, responses: list[DecisionResponse], payload: Any) -> Any:
        raise NotImplementedError  # pragma: no cover

    def describe(self, payload: Any) -> str:
        """Short, secret-free description of the payload for decision records."""
        return ""


# --------------------------------------------------------------------------
# candidate_discovery
# --------------------------------------------------------------------------


@dataclass
class DiscoveryRequest:
    #: Transcript rendered as ``[index]word``.
    text: str
    first_word: int
    last_word: int
    min_duration_s: float
    max_duration_s: float
    max_candidates: int
    speakers: list[str] = field(default_factory=list)


@dataclass
class DiscoveredCandidate:
    start_word_index: int
    end_word_index: int
    moment_type: str
    initial_score: float
    title: str = ""
    hook: str = ""
    reason: str = ""


@dataclass
class DiscoveryResult:
    content_type: str
    candidates: list[DiscoveredCandidate]
    invalid_references: int = 0


class DiscoverySpec(CapabilitySpec):
    name = CANDIDATE_DISCOVERY
    prompt = "candidate_discovery_v1"
    temperature = 0.3

    def render(self, payload: DiscoveryRequest) -> str:
        speaker_note = ""
        if payload.speakers:
            speaker_note = (
                f"\nThis section has {len(payload.speakers)} speakers "
                f"({', '.join(payload.speakers)}); labels are shown inline.\n"
            )
        return (
            f"Transcript section, words {payload.first_word} to {payload.last_word}. "
            "Each word is tagged [index]word.\n"
            f"{speaker_note}"
            f"Target clip length: {payload.min_duration_s:.0f}-{payload.max_duration_s:.0f} s.\n"
            f"Return at most {payload.max_candidates} candidates, strongest first.\n\n"
            f"---\n{payload.text}\n---"
        )

    def parse_text(self, text: str, payload: DiscoveryRequest) -> DiscoveryResult:
        data = _parse_json(text)
        raw = _items(data, "candidates", "clips")
        content_type = _text(data.get("content_type"), 30).lower()
        if content_type not in CONTENT_TYPES:
            content_type = "general"

        found: list[DiscoveredCandidate] = []
        invalid = 0
        for item in raw:
            if not isinstance(item, dict):
                invalid += 1
                continue
            start_ref = _optional_int(item.get("start_word_index"))
            end_ref = _optional_int(item.get("end_word_index"))
            if start_ref is None or end_ref is None:
                invalid += 1
                continue
            start, end = start_ref, end_ref
            # A reference wholly outside the section is hallucinated; a partial
            # overlap is a sloppy edge and is clamped.
            if end < payload.first_word or start > payload.last_word:
                invalid += 1
                continue
            start = max(payload.first_word, start)
            end = min(payload.last_word, end)
            if end <= start:
                invalid += 1
                continue
            moment_type = _text(item.get("type") or item.get("moment_type"), 40).lower()
            found.append(
                DiscoveredCandidate(
                    start_word_index=start,
                    end_word_index=end,
                    moment_type=moment_type if moment_type in MOMENT_TYPES else "other",
                    initial_score=_unit(item.get("initial_score", item.get("score")), 0.5) or 0.0,
                    title=_text(item.get("title"), 80),
                    hook=_text(item.get("hook"), 200),
                    reason=_text(item.get("reason"), 300),
                )
            )

        if raw and not found:
            raise CapabilityError(
                f"All {len(raw)} candidates referenced words outside the section.",
                ErrorCategory.INVALID_REFERENCES,
            )
        return DiscoveryResult(
            content_type=content_type,
            candidates=found[: max(1, payload.max_candidates)],
            invalid_references=invalid,
        )

    def describe(self, payload: DiscoveryRequest) -> str:
        return f"words {payload.first_word}-{payload.last_word}"


# --------------------------------------------------------------------------
# candidate_triage (decision capability)
# --------------------------------------------------------------------------


@dataclass
class TriageItem:
    candidate_id: str
    duration_s: float
    transcript: str
    moment_type: str
    initial_score: float
    speaker_count: int
    speech_density: float
    silence_ratio: float
    overlap_with_existing: float = 0.0
    candidate_source: str = "fast_ai"


@dataclass
class TriageRequest:
    items: list[TriageItem]


@dataclass
class TriageDecision:
    keep: float
    needs_visual: float
    needs_deep_reasoning: float
    priority: float
    moment_type: str | None = None
    confidence: float | None = None


TRIAGE_PRIORITY_LEVELS = [
    "Weak: no real hook or payoff",
    "Below average: something is there but it would not hold a stranger",
    "Decent: watchable, with a hook or a payoff but not both",
    "Strong: clear hook and a payoff that lands",
    "Exceptional: grabs immediately, pays off, and is quotable or shareable",
]

#: Transcript text sent to a decision provider is capped: a clip-length
#: excerpt fits easily, and Jev's accuracy is documented to drop as state grows.
TRIAGE_TRANSCRIPT_CHARS = 2400


class TriageSpec(CapabilitySpec):
    name = CANDIDATE_TRIAGE
    prompt = "triage_v1"
    temperature = 0.1

    def render(self, payload: TriageRequest) -> str:
        items = [
            {
                "candidate_id": item.candidate_id,
                "duration_s": round(item.duration_s, 1),
                "moment_type": item.moment_type,
                "speakers": item.speaker_count,
                "transcript": item.transcript[:TRIAGE_TRANSCRIPT_CHARS],
            }
            for item in payload.items
        ]
        return "Candidates:\n" + json.dumps(items, ensure_ascii=False, indent=1)

    def parse_text(self, text: str, payload: TriageRequest) -> dict[str, TriageDecision]:
        data = _parse_json(text)
        known = {item.candidate_id for item in payload.items}
        decisions: dict[str, TriageDecision] = {}
        for raw in _items(data, "decisions", "candidates", "clips"):
            if not isinstance(raw, dict) or raw.get("candidate_id") not in known:
                continue
            keep = _unit(raw.get("keep"))
            priority = _unit(raw.get("priority"))
            if keep is None or priority is None:
                continue
            moment_type = _text(raw.get("moment_type"), 40).lower()
            decisions[raw["candidate_id"]] = TriageDecision(
                keep=keep,
                needs_visual=_unit(raw.get("needs_visual"), 0.0) or 0.0,
                needs_deep_reasoning=_unit(raw.get("needs_deep_reasoning"), 0.0) or 0.0,
                priority=priority,
                moment_type=moment_type if moment_type in MOMENT_TYPES else None,
            )
        _require_coverage(len(decisions), len(known), minimum=0.5)
        return decisions

    def build_decisions(self, payload: TriageRequest) -> list[tuple[Any, dict[str, dict]]]:
        requests = []
        for item in payload.items:
            state = asdict(item)
            state["transcript"] = item.transcript[:TRIAGE_TRANSCRIPT_CHARS]
            state["duration_s"] = round(item.duration_s, 1)
            state["speech_density"] = round(item.speech_density, 2)
            state["silence_ratio"] = round(item.silence_ratio, 2)
            state["overlap_with_existing"] = round(item.overlap_with_existing, 2)
            requests.append((state, TRIAGE_QUESTIONS))
        return requests

    def parse_decisions(
        self, responses: list[DecisionResponse], payload: TriageRequest
    ) -> dict[str, TriageDecision]:
        decisions: dict[str, TriageDecision] = {}
        for item, response in zip(payload.items, responses, strict=True):
            answers = response.answers
            priority = answers["priority"]
            moment = answers["moment_type"]
            decisions[item.candidate_id] = TriageDecision(
                keep=float(answers["keep"].value or 0.0),
                needs_visual=float(answers["needs_visual"].value or 0.0),
                needs_deep_reasoning=float(answers["needs_deep_reasoning"].value or 0.0),
                priority=float(priority.value or 0.0) / (len(TRIAGE_PRIORITY_LEVELS) - 1),
                moment_type=moment.choice,
                confidence=priority.confidence,
            )
        return decisions

    def describe(self, payload: TriageRequest) -> str:
        return f"{len(payload.items)} candidates"


TRIAGE_QUESTIONS: dict[str, dict[str, Any]] = {
    "keep": {
        "type": "noul",
        "instructions": (
            "Would `transcript` work as a standalone short-form video (TikTok, Reels, "
            "Shorts) that a stranger with no context would watch to the end?"
        ),
        "criteria": {
            "true": "Self-contained, with a hook and a payoff a stranger would understand",
            "false": "Needs outside context, has no payoff, or is filler",
        },
    },
    "needs_visual": {
        "type": "noul",
        "instructions": (
            "Does this moment depend on what is shown on screen (a play, a reaction, a "
            "demonstration) more than on what is said in `transcript`?"
        ),
    },
    "needs_deep_reasoning": {
        "type": "noul",
        "instructions": (
            "Is it genuinely unclear whether `transcript` is strong enough to post, so it "
            "needs careful comparison against other moments?"
        ),
    },
    "priority": {
        "type": "score",
        "instructions": "How strong is `transcript` as a short-form clip?",
        "criteria": TRIAGE_PRIORITY_LEVELS,
    },
    "moment_type": {
        "type": "choice",
        "instructions": "What kind of moment is `transcript`?",
        "criteria": dict(MOMENT_TYPES),
    },
}


# --------------------------------------------------------------------------
# text_scoring
# --------------------------------------------------------------------------


@dataclass
class ScoringItem:
    candidate_id: str
    #: Candidate plus surrounding context, rendered as ``[index]word``.
    tagged_text: str
    candidate_first: int
    candidate_last: int
    context_first: int
    context_last: int
    duration_s: float
    moment_type: str


@dataclass
class ScoringRequest:
    items: list[ScoringItem]
    content_type: str
    min_duration_s: float
    max_duration_s: float


@dataclass
class CandidateScore:
    dimensions: dict[str, float]
    overall: float
    moment_type: str | None
    topic: str
    title: str
    self_contained: bool | None
    #: Boundary suggestion as word indices, validated to lie in the context.
    start_word_index: int | None = None
    end_word_index: int | None = None


CONTENT_EMPHASIS = {
    "podcast": "Podcast: favour unexpected answers, personal stories, strong opinions, "
    "and quotable lines.",
    "interview": "Interview: favour unexpected answers, disagreements, and confessions.",
    "gaming": "Gaming: favour clutch plays, fails, comebacks, and strong reactions; the "
    "transcript may understate what happens on screen.",
    "educational": "Educational: favour surprising facts, misconceptions corrected, and "
    "concise problem-to-solution explanations.",
    "commentary": "Commentary: favour strong takes with a clear point.",
    "general": "Use the universal rubric.",
}


class ScoringSpec(CapabilitySpec):
    name = TEXT_SCORING
    prompt = "scoring_v1"
    temperature = 0.2

    def render(self, payload: ScoringRequest) -> str:
        blocks = []
        for item in payload.items:
            blocks.append(
                f"### candidate_id: {item.candidate_id}\n"
                f"Proposed clip: words {item.candidate_first}-{item.candidate_last} "
                f"({item.duration_s:.0f} s). Context shown: words "
                f"{item.context_first}-{item.context_last}. Proposed type: {item.moment_type}.\n"
                f"{item.tagged_text}"
            )
        emphasis = CONTENT_EMPHASIS.get(payload.content_type, CONTENT_EMPHASIS["general"])
        return (
            f"Content type: {payload.content_type}. {emphasis}\n"
            f"Clip length limits: {payload.min_duration_s:.0f}-{payload.max_duration_s:.0f} s.\n\n"
            + "\n\n".join(blocks)
        )

    def parse_text(self, text: str, payload: ScoringRequest) -> dict[str, CandidateScore]:
        data = _parse_json(text)
        by_id = {item.candidate_id: item for item in payload.items}
        scores: dict[str, CandidateScore] = {}
        for raw in _items(data, "scores", "candidates"):
            if not isinstance(raw, dict):
                continue
            cid = raw.get("candidate_id")
            item = by_id.get(cid) if isinstance(cid, str) else None
            if item is None:
                continue
            nested = raw.get("scores")
            source: dict[str, Any] = nested if isinstance(nested, dict) else raw
            dimensions = {
                name: value
                for name in SCORE_DIMENSIONS
                if (value := _ten(source.get(name))) is not None
            }
            overall = _unit(raw.get("overall"))
            if overall is None or len(dimensions) < len(SCORE_DIMENSIONS) // 2:
                continue
            start, end = (
                _optional_int(raw.get("start_word_index")),
                _optional_int(raw.get("end_word_index")),
            )
            if not (
                start is not None
                and end is not None
                and item.context_first <= start < end <= item.context_last
            ):
                start = end = None
            moment_type = _text(raw.get("moment_type"), 40).lower()
            self_contained = raw.get("self_contained")
            scores[item.candidate_id] = CandidateScore(
                dimensions=dimensions,
                overall=overall,
                moment_type=moment_type if moment_type in MOMENT_TYPES else None,
                topic=_text(raw.get("topic"), 60),
                title=_text(raw.get("title"), 80),
                self_contained=self_contained if isinstance(self_contained, bool) else None,
                start_word_index=start,
                end_word_index=end,
            )
        _require_coverage(len(scores), len(by_id), minimum=0.67)
        return scores

    def describe(self, payload: ScoringRequest) -> str:
        return f"{len(payload.items)} candidates"


# --------------------------------------------------------------------------
# visual_understanding
# --------------------------------------------------------------------------


@dataclass
class VisualRequest:
    candidate_id: str
    transcript: str
    duration_s: float
    frames: list[ImageInput]
    frame_times_s: list[float]


@dataclass
class VisualAssessment:
    visual_score: float
    has_reaction: bool
    transcript_sufficient: bool
    visual_event: str
    notes: str


class VisualSpec(CapabilitySpec):
    name = VISUAL_UNDERSTANDING
    modality = "image"
    prompt = "visual_v1"
    temperature = 0.2

    def render(self, payload: VisualRequest) -> str:
        times = ", ".join(f"{t:.1f}s" for t in payload.frame_times_s)
        return (
            f"Clip length {payload.duration_s:.0f} s. The attached frames are taken at {times} "
            "into the clip, in order.\n\nTranscript of the clip:\n"
            f"{payload.transcript[:3000]}"
        )

    def images(self, payload: VisualRequest) -> list[ImageInput]:
        return payload.frames

    def parse_text(self, text: str, payload: VisualRequest) -> VisualAssessment:
        data = _parse_json(text)
        score = _ten(data.get("visual_score"))
        if score is None:
            raise CapabilityError("visual_score is missing or invalid.", ErrorCategory.SCHEMA)
        return VisualAssessment(
            visual_score=score,
            has_reaction=bool(data.get("has_reaction")),
            transcript_sufficient=bool(data.get("transcript_sufficient", True)),
            visual_event=_text(data.get("visual_event"), 160),
            notes=_text(data.get("notes"), 300),
        )

    def describe(self, payload: VisualRequest) -> str:
        return f"candidate {payload.candidate_id}, {len(payload.frames)} frames"


# --------------------------------------------------------------------------
# final_judgment
# --------------------------------------------------------------------------


@dataclass
class FinalistItem:
    candidate_id: str
    start_label: str
    duration_s: float
    moment_type: str
    topic: str
    mid_score: float
    text: str
    visual_note: str = ""


@dataclass
class JudgmentRequest:
    finalists: list[FinalistItem]
    target_count: int
    content_type: str


@dataclass
class Verdict:
    keep: bool
    score: float
    title: str
    reason: str
    same_story_as: list[str] = field(default_factory=list)


class JudgmentSpec(CapabilitySpec):
    name = FINAL_JUDGMENT
    prompt = "judgment_v1"
    temperature = 0.2

    def render(self, payload: JudgmentRequest) -> str:
        blocks = []
        for item in payload.finalists:
            visual = f" Visual: {item.visual_note}" if item.visual_note else ""
            blocks.append(
                f"### {item.candidate_id} | at {item.start_label} | {item.duration_s:.0f} s | "
                f"{item.moment_type} | topic: {item.topic or 'n/a'} | "
                f"screening score {item.mid_score:.0f}/100.{visual}\n{item.text}"
            )
        return (
            f"Content type: {payload.content_type}. The editor will publish "
            f"{payload.target_count} clips from this video.\n"
            f"{len(payload.finalists)} finalists follow.\n\n" + "\n\n".join(blocks)
        )

    def parse_text(self, text: str, payload: JudgmentRequest) -> dict[str, Verdict]:
        data = _parse_json(text)
        known = {item.candidate_id for item in payload.finalists}
        verdicts: dict[str, Verdict] = {}
        for raw in _items(data, "verdicts", "candidates", "clips"):
            if not isinstance(raw, dict) or raw.get("candidate_id") not in known:
                continue
            score = _unit(raw.get("score"))
            keep = raw.get("keep")
            if score is None or not isinstance(keep, bool):
                continue
            same = raw.get("same_story_as") or []
            verdicts[raw["candidate_id"]] = Verdict(
                keep=keep,
                score=score,
                title=_text(raw.get("title"), 80),
                reason=_text(raw.get("reason"), 300),
                same_story_as=[
                    s
                    for s in same
                    if isinstance(s, str) and s in known and s != raw["candidate_id"]
                ]
                if isinstance(same, list)
                else [],
            )
        _require_coverage(len(verdicts), len(known), minimum=0.7)
        return verdicts

    def describe(self, payload: JudgmentRequest) -> str:
        return f"{len(payload.finalists)} finalists"


# --------------------------------------------------------------------------
# duplicate_risk (decision capability)
# --------------------------------------------------------------------------


@dataclass
class DuplicatePair:
    a_id: str
    a_text: str
    b_id: str
    b_text: str


@dataclass
class DuplicateRequest:
    pairs: list[DuplicatePair]


DUPLICATE_TEXT_CHARS = 1800

DUPLICATE_QUESTION = {
    "same_story": {
        "type": "noul",
        "instructions": (
            "Do `clip_a` and `clip_b` tell the same story or make the same point, so that "
            "posting both would feel repetitive to a follower?"
        ),
        "criteria": {
            "true": "Same story, same point, or the same moment retold",
            "false": "Different stories or clearly different points",
        },
    }
}


class DuplicateSpec(CapabilitySpec):
    name = DUPLICATE_RISK
    prompt = "duplicate_v1"
    temperature = 0.0

    def render(self, payload: DuplicateRequest) -> str:
        pairs = [
            {
                "a": pair.a_id,
                "clip_a": pair.a_text[:DUPLICATE_TEXT_CHARS],
                "b": pair.b_id,
                "clip_b": pair.b_text[:DUPLICATE_TEXT_CHARS],
            }
            for pair in payload.pairs
        ]
        return "Pairs:\n" + json.dumps(pairs, ensure_ascii=False, indent=1)

    def parse_text(self, text: str, payload: DuplicateRequest) -> dict[tuple[str, str], float]:
        data = _parse_json(text)
        wanted = {(p.a_id, p.b_id) for p in payload.pairs}
        result: dict[tuple[str, str], float] = {}
        for raw in _items(data, "pairs"):
            if not isinstance(raw, dict):
                continue
            key = (raw.get("a"), raw.get("b"))
            if key not in wanted:
                key = (raw.get("b"), raw.get("a"))
            if key not in wanted:
                continue
            value = _unit(raw.get("same_story"))
            if value is not None:
                result[key] = value
        _require_coverage(len(result), len(wanted), minimum=0.5)
        return result

    def build_decisions(self, payload: DuplicateRequest) -> list[tuple[Any, dict[str, dict]]]:
        return [
            (
                {
                    "clip_a": pair.a_text[:DUPLICATE_TEXT_CHARS],
                    "clip_b": pair.b_text[:DUPLICATE_TEXT_CHARS],
                },
                DUPLICATE_QUESTION,
            )
            for pair in payload.pairs
        ]

    def parse_decisions(
        self, responses: list[DecisionResponse], payload: DuplicateRequest
    ) -> dict[tuple[str, str], float]:
        return {
            (pair.a_id, pair.b_id): float(response.answers["same_story"].value or 0.0)
            for pair, response in zip(payload.pairs, responses, strict=True)
        }

    def describe(self, payload: DuplicateRequest) -> str:
        return f"{len(payload.pairs)} pairs"


# --------------------------------------------------------------------------
# dynamic_composition
# --------------------------------------------------------------------------


LAYOUTS: dict[str, str] = {
    "speaker_full": "Full-frame vertical crop following the active speaker",
    "wide_fit": "The whole original frame fitted into the vertical canvas over a blurred fill",
    "two_speaker_stacked": "Two speakers stacked top and bottom",
}


@dataclass
class CompositionShot:
    start_s: float
    end_s: float
    faces: int
    strategy: str


@dataclass
class CompositionRequest:
    candidate_id: str
    duration_s: float
    transcript: str
    speaker_count: int
    shots: list[CompositionShot]
    allowed_layouts: list[str]


@dataclass
class CompositionSegment:
    start_s: float
    end_s: float
    layout: str


class CompositionSpec(CapabilitySpec):
    name = DYNAMIC_COMPOSITION
    prompt = "composition_v1"
    temperature = 0.1

    def render(self, payload: CompositionRequest) -> str:
        layouts = {k: v for k, v in LAYOUTS.items() if k in payload.allowed_layouts}
        shots = [
            {
                "start_s": round(s.start_s, 2),
                "end_s": round(s.end_s, 2),
                "faces": s.faces,
                "tracker": s.strategy,
            }
            for s in payload.shots
        ]
        return (
            f"Clip length {payload.duration_s:.2f} s, {payload.speaker_count} speaker(s).\n"
            f"Allowed layouts: {json.dumps(layouts)}\n"
            f"Shots (from shot detection and face tracking): {json.dumps(shots)}\n\n"
            f"Transcript:\n{payload.transcript[:2500]}"
        )

    def parse_text(self, text: str, payload: CompositionRequest) -> list[CompositionSegment]:
        data = _parse_json(text)
        segments: list[CompositionSegment] = []
        for raw in _items(data, "segments", "timeline"):
            if not isinstance(raw, dict):
                continue
            layout = raw.get("layout")
            if layout not in payload.allowed_layouts:
                raise CapabilityError(f"Layout {layout!r} is not allowed.", ErrorCategory.SCHEMA)
            try:
                start, end = float(raw["start"]), float(raw["end"])
            except (KeyError, TypeError, ValueError) as exc:
                raise CapabilityError("Segment times are missing.", ErrorCategory.SCHEMA) from exc
            segments.append(CompositionSegment(start_s=start, end_s=end, layout=layout))
        if not segments:
            raise CapabilityError("No composition segments returned.", ErrorCategory.INCOMPLETE)
        return segments

    def describe(self, payload: CompositionRequest) -> str:
        return f"candidate {payload.candidate_id}"


# --------------------------------------------------------------------------
# Registry of specs
# --------------------------------------------------------------------------


def _require_coverage(got: int, expected: int, *, minimum: float) -> None:
    if expected == 0:
        return
    if got == 0:
        raise CapabilityError("The response contained no usable entries.", ErrorCategory.SCHEMA)
    if got / expected < minimum:
        raise CapabilityError(
            f"Only {got} of {expected} entries were usable.", ErrorCategory.INCOMPLETE
        )


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


SPECS: dict[str, CapabilitySpec] = {
    spec.name: spec
    for spec in (
        DiscoverySpec(),
        TriageSpec(),
        ScoringSpec(),
        VisualSpec(),
        JudgmentSpec(),
        DuplicateSpec(),
        CompositionSpec(),
    )
}
