"""Deterministic global selection: the final set of clips, owned by code.

Models score and judge; this module decides. It is a greedy selector with
explicit, logged penalties — chosen over a black-box optimiser because every
pick can be explained ("chosen: 0.81 quality, -0.06 for sharing a topic with
#2") and the behaviour is easy to test.

Rules, in order:

1. **Hard constraint — distinct.** Two selected clips may not overlap by more
   than ``MAX_OVERLAP`` of the shorter one. No duplicate is ever used to reach
   the target count.
2. **Quality.** Each candidate's composite score (see :func:`composite_score`)
   plus a tier adjustment: judge-kept clips first, deterministic fallback
   windows and judge-rejected clips last.
3. **Diversity penalties** against everything already selected: same story
   (judge said so, or duplicate-risk probability), topic similarity, same
   moment type, and temporal crowding. Penalties are soft, so an exceptional
   candidate can outweigh them — a same-story penalty is large but not a veto.
4. **Exact count.** Selection continues until the target is reached or no
   non-overlapping candidate remains. Callers top up the pool with fallback
   windows before accepting fewer.

The final list is ranked by quality (not pick order) so rank 1 is the best clip.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .candidates import Candidate, content_words, jaccard, time_overlap_fraction

#: Max overlap between two selected clips, as a fraction of the shorter.
MAX_OVERLAP = 0.15

TIER_JUDGED_KEEP = 0.12
TIER_JUDGED_REJECT = -0.30
TIER_FALLBACK = -0.25

SAME_STORY_PENALTY = 0.40
DUPLICATE_RISK_THRESHOLD = 0.5
TOPIC_PENALTY = 0.20
TYPE_PENALTY = 0.03
CROWDING_WINDOW_S = 45.0
CROWDING_PENALTY = 0.05

#: Weights for the mid-tier dimension scores (sum to 1).
DIMENSION_WEIGHTS: dict[str, float] = {
    "hook": 0.17,
    "payoff": 0.15,
    "retention": 0.12,
    "context": 0.09,
    "completeness": 0.09,
    "opening": 0.07,
    "ending": 0.07,
    "curiosity": 0.05,
    "emotion": 0.05,
    "quotability": 0.05,
    "surprise": 0.04,
    "storytelling": 0.03,
    "usefulness": 0.02,
}


def composite_score(candidate: Candidate) -> float:
    """Combine every available signal into one 0..1 quality estimate.

    Later, stronger stages dominate earlier ones: judge > mid-tier scoring >
    triage > discovery prior. Missing stages simply don't contribute.
    """
    score = candidate.initial_score

    if candidate.triage:
        t = candidate.triage
        score = 0.5 * t.get("priority", score) + 0.3 * t.get("keep", score) + 0.2 * score

    if candidate.scores:
        dims = candidate.scores.get("dimensions") or {}
        weighted = sum(DIMENSION_WEIGHTS[k] * dims[k] for k in DIMENSION_WEIGHTS if k in dims)
        weight_total = sum(DIMENSION_WEIGHTS[k] for k in DIMENSION_WEIGHTS if k in dims)
        dim_score = (weighted / weight_total) / 10 if weight_total else score
        mid = 0.6 * candidate.scores.get("overall", score) + 0.4 * dim_score
        if candidate.scores.get("self_contained") is False:
            mid -= 0.08
        score = 0.85 * mid + 0.15 * score

    if candidate.visual:
        visual = candidate.visual.get("visual_score", 5.0) / 10
        weight = 0.25 if candidate.visual.get("transcript_sufficient") is False else 0.1
        score = (1 - weight) * score + weight * visual

    if candidate.verdict:
        score = 0.65 * candidate.verdict.get("score", score) + 0.35 * score

    return max(0.0, min(1.0, score))


def tier(candidate: Candidate) -> str:
    if candidate.source == "fallback":
        return "fallback"
    if candidate.verdict:
        return "judged_keep" if candidate.verdict.get("keep") else "judged_reject"
    if candidate.scores:
        return "scored"
    if candidate.triage:
        return "triaged"
    return "discovered"


#: Discovery priors are optimistic and unreviewed, so a candidate that only
#: discovery has seen must not outrank one a stronger stage vetted on equal
#: numbers.
TIER_DISCOVERED = -0.10
TIER_TRIAGED = -0.05

_TIER_ADJUST = {
    "judged_keep": TIER_JUDGED_KEEP,
    "judged_reject": TIER_JUDGED_REJECT,
    "fallback": TIER_FALLBACK,
    "discovered": TIER_DISCOVERED,
    "triaged": TIER_TRIAGED,
}


@dataclass
class Pick:
    candidate: Candidate
    quality: float
    adjusted: float
    penalties: dict[str, float] = field(default_factory=dict)
    rank: int = 0

    @property
    def tier(self) -> str:
        return tier(self.candidate)

    @property
    def final(self) -> float:
        """Quality after the tier adjustment — what ranks and what users see."""
        return max(0.0, min(1.0, self.quality + _TIER_ADJUST.get(self.tier, 0.0)))

    def explain(self) -> str:
        parts = [f"quality {self.quality:.2f} ({self.tier})"]
        parts += [f"-{v:.2f} {k}" for k, v in sorted(self.penalties.items()) if v > 0]
        return ", ".join(parts)


@dataclass
class SelectionContext:
    """Pairwise signals the selector may consult."""

    #: Candidate text by id, for topic similarity.
    texts: dict[str, str] = field(default_factory=dict)
    #: (a, b) -> probability the pair is the same story (duplicate_risk).
    duplicate_risk: dict[tuple[str, str], float] = field(default_factory=dict)

    def dup(self, a: str, b: str) -> float:
        return max(self.duplicate_risk.get((a, b), 0.0), self.duplicate_risk.get((b, a), 0.0))


def select(
    candidates: list[Candidate],
    target: int,
    context: SelectionContext | None = None,
) -> list[Pick]:
    """Pick up to ``target`` distinct clips. Deterministic for a given input."""
    context = context or SelectionContext()
    words = {c.id: content_words(context.texts.get(c.id, c.title)) for c in candidates}
    topics = {c.id: content_words((c.scores or {}).get("topic", "")) for c in candidates}

    pool = sorted(
        (
            Pick(candidate=c, quality=composite_score(c), adjusted=0.0)
            for c in _dedupe_ids(candidates)
        ),
        key=lambda p: (-p.quality, p.candidate.start_s, p.candidate.id),
    )

    chosen: list[Pick] = []
    while len(chosen) < target:
        best: Pick | None = None
        for pick in pool:
            if any(p.candidate.id == pick.candidate.id for p in chosen):
                continue
            if any(
                time_overlap_fraction(pick.candidate, p.candidate) > MAX_OVERLAP for p in chosen
            ):
                continue
            penalties = _penalties(pick.candidate, chosen, context, words, topics)
            adjusted = pick.quality + _TIER_ADJUST.get(pick.tier, 0.0) - sum(penalties.values())
            if best is None or (adjusted, -pick.candidate.start_s) > (
                best.adjusted,
                -best.candidate.start_s,
            ):
                best = Pick(
                    candidate=pick.candidate,
                    quality=pick.quality,
                    adjusted=adjusted,
                    penalties=penalties,
                )
        if best is None:
            break
        chosen.append(best)

    ranked = sorted(chosen, key=lambda p: (-p.final, p.candidate.start_s, p.candidate.id))
    for rank, pick in enumerate(ranked, start=1):
        pick.rank = rank
    return ranked


def _penalties(
    candidate: Candidate,
    chosen: list[Pick],
    context: SelectionContext,
    words: dict[str, set[str]],
    topics: dict[str, set[str]],
) -> dict[str, float]:
    same_story = topic = moment = crowding = 0.0
    same_as = set((candidate.verdict or {}).get("same_story_as") or [])

    for pick in chosen:
        other = pick.candidate
        other_same = set((other.verdict or {}).get("same_story_as") or [])
        risk = context.dup(candidate.id, other.id)
        if other.id in same_as or candidate.id in other_same or risk >= DUPLICATE_RISK_THRESHOLD:
            same_story = max(same_story, SAME_STORY_PENALTY * max(risk, 0.75))

        similarity = max(
            jaccard(words[candidate.id], words[other.id]),
            jaccard(topics[candidate.id], topics[other.id]) if topics[candidate.id] else 0.0,
        )
        topic = max(topic, TOPIC_PENALTY * min(1.0, similarity * 2))

        if candidate.moment_type == other.moment_type and candidate.moment_type != "other":
            moment += TYPE_PENALTY

        gap = max(other.start_s - candidate.end_s, candidate.start_s - other.end_s, 0.0)
        if gap < CROWDING_WINDOW_S:
            crowding = max(crowding, CROWDING_PENALTY * (1 - gap / CROWDING_WINDOW_S))

    return {
        "same_story": round(same_story, 4),
        "topic": round(topic, 4),
        "moment_type": round(min(moment, 0.09), 4),
        "crowding": round(crowding, 4),
    }


def _dedupe_ids(candidates: list[Candidate]) -> list[Candidate]:
    seen: set[str] = set()
    out: list[Candidate] = []
    for candidate in candidates:
        if candidate.id not in seen:
            seen.add(candidate.id)
            out.append(candidate)
    return out
