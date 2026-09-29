"""Optional dynamic composition: AI chooses layouts, code executes them.

Standard mode is the reframe stage's crop path as-is. With dynamic composition
on, a model sees a compact description of the clip (length, shots from shot
detection and face tracking, transcript) and returns an edit-decision
timeline::

    [{"start": 0.0, "end": 4.2, "layout": "speaker_full"},
     {"start": 4.2, "end": 31.0, "layout": "wide_fit"}]

This module validates and normalises that timeline deterministically — clamps
it to the clip, fills gaps, snaps edges to nearby shot boundaries, merges
fragments shorter than a few seconds — and rewrites the crop path. The renderer
executes the result like any other crop path; the model never touches frames.

Layouts are limited to what the renderer genuinely supports:

* ``speaker_full`` — the tracked/locked 9:16 crop the reframe stage computed.
* ``wide_fit`` — the whole source frame fitted over a blurred fill.
"""

from __future__ import annotations

import logging
from dataclasses import replace

from ..intelligence import capabilities as caps
from .reframe.croppath import CropKeyframe, CropPath, CropSegment, Strategy

log = logging.getLogger(__name__)

SUPPORTED_LAYOUTS = ("speaker_full", "wide_fit")

#: Layout changes closer together than this read as flicker.
MIN_SEGMENT_S = 3.0
#: A timeline edge this close to a shot boundary moves onto it: layout changes
#: on a cut are invisible, mid-shot changes are not.
SNAP_TO_SHOT_S = 0.75


def shots_for_prompt(path: CropPath) -> list[caps.CompositionShot]:
    """Describe the crop path's segments for the model, without pixels."""
    faces = {Strategy.TRACK: 1, Strategy.WIDE: 2, Strategy.GENERAL: 0}
    return [
        caps.CompositionShot(
            start_s=s.start_s,
            end_s=s.end_s,
            faces=faces.get(s.strategy, 0),
            strategy="fit" if s.fit else s.strategy.value,
        )
        for s in path.segments
    ]


def normalise_timeline(
    timeline: list[caps.CompositionSegment], duration_s: float, shot_edges: list[float]
) -> list[caps.CompositionSegment]:
    """Turn a model's timeline into a clean, gap-free tiling of the clip."""
    usable = sorted(
        (
            caps.CompositionSegment(
                start_s=max(0.0, min(s.start_s, duration_s)),
                end_s=max(0.0, min(s.end_s, duration_s)),
                layout=s.layout,
            )
            for s in timeline
            if s.layout in SUPPORTED_LAYOUTS
        ),
        key=lambda s: s.start_s,
    )
    usable = [s for s in usable if s.end_s > s.start_s]
    if not usable:
        return [caps.CompositionSegment(0.0, duration_s, "speaker_full")]

    # Tile: every change point is the start of the next segment; gaps take the
    # following segment's layout, the first segment starts at zero.
    edges = [0.0] + [s.start_s for s in usable[1:]] + [duration_s]
    edges = [_snap(edge, shot_edges) for edge in edges]
    edges[0], edges[-1] = 0.0, duration_s
    tiled = [
        caps.CompositionSegment(edges[i], edges[i + 1], usable[i].layout)
        for i in range(len(usable))
        if edges[i + 1] > edges[i]
    ]

    # Merge neighbours with the same layout, then absorb fragments.
    merged: list[caps.CompositionSegment] = []
    for segment in tiled:
        if merged and merged[-1].layout == segment.layout:
            merged[-1] = caps.CompositionSegment(merged[-1].start_s, segment.end_s, segment.layout)
        else:
            merged.append(segment)

    changed = True
    while changed and len(merged) > 1:
        changed = False
        for i, segment in enumerate(merged):
            if segment.end_s - segment.start_s >= MIN_SEGMENT_S:
                continue
            # Absorb into the longer neighbour.
            if i == 0:
                target = 1
            elif i == len(merged) - 1:
                target = i - 1
            else:
                before, after = merged[i - 1], merged[i + 1]
                target = (
                    i - 1
                    if (before.end_s - before.start_s) >= (after.end_s - after.start_s)
                    else i + 1
                )
            keep = merged[target]
            start = min(keep.start_s, segment.start_s)
            end = max(keep.end_s, segment.end_s)
            merged[target] = caps.CompositionSegment(start, end, keep.layout)
            del merged[i]
            # Re-merge equal neighbours created by the absorption.
            collapsed: list[caps.CompositionSegment] = []
            for s in merged:
                if collapsed and collapsed[-1].layout == s.layout:
                    collapsed[-1] = caps.CompositionSegment(
                        collapsed[-1].start_s, s.end_s, s.layout
                    )
                else:
                    collapsed.append(s)
            merged = collapsed
            changed = True
            break

    return merged


def apply(path: CropPath, timeline: list[caps.CompositionSegment]) -> CropPath:
    """Rewrite a crop path so each timeline span renders in its layout.

    ``speaker_full`` spans keep the reframe stage's crop for the underlying
    shot; ``wide_fit`` spans become fitted segments. Segments are split at
    every timeline edge, so the result still tiles the clip exactly.
    """
    result: list[CropSegment] = []
    for span in timeline:
        for segment in path.segments:
            start = max(span.start_s, segment.start_s)
            end = min(span.end_s, segment.end_s)
            if end - start <= 0.01:
                continue
            if span.layout == "wide_fit":
                result.append(
                    CropSegment(
                        start_s=start,
                        end_s=end,
                        width=path.source_width,
                        height=path.source_height,
                        keyframes=[CropKeyframe(t=start, x=0.0, y=0.0)],
                        strategy=Strategy.WIDE,
                        fit=True,
                    )
                )
            else:
                result.append(replace(segment, start_s=start, end_s=end))

    if not result:
        return path
    result[0].start_s = 0.0
    result[-1].end_s = path.duration_s
    for i in range(len(result) - 1):
        result[i].end_s = result[i + 1].start_s
    return CropPath(
        source_width=path.source_width, source_height=path.source_height, segments=result
    )


def _snap(edge: float, shot_edges: list[float]) -> float:
    nearest = min(shot_edges, key=lambda s: abs(s - edge), default=edge)
    return nearest if abs(nearest - edge) <= SNAP_TO_SHOT_S else edge
