"""Dynamic composition: shot-referenced layouts, deterministic timelines, and a
crop path the existing renderer can execute."""

from __future__ import annotations

import json

import pytest
from autoclip.intelligence import capabilities as caps
from autoclip.intelligence.capabilities import CapabilityError, CompositionSpec
from autoclip.pipeline import composition
from autoclip.pipeline.export import ExportRequest, build_video_filtergraph
from autoclip.pipeline.reframe.croppath import CropKeyframe, CropPath, CropSegment, Strategy


def path_with_shots(*edges: float) -> CropPath:
    segments = [
        CropSegment(
            start_s=a,
            end_s=b,
            width=608,
            height=1080,
            keyframes=[CropKeyframe(t=a, x=600.0, y=0.0)],
            strategy=Strategy.TRACK,
        )
        for a, b in zip(edges, edges[1:], strict=False)
    ]
    return CropPath(source_width=1920, source_height=1080, segments=segments)


def request_for(path: CropPath) -> caps.CompositionRequest:
    return caps.CompositionRequest(
        candidate_id="c1",
        duration_s=path.duration_s,
        transcript="words",
        speaker_count=1,
        shots=composition.shots_for_prompt(path),
        allowed_layouts=list(composition.SUPPORTED_LAYOUTS),
    )


class TestSpec:
    def test_layouts_are_referenced_by_shot_and_timed_by_code(self) -> None:
        path = path_with_shots(0, 6, 14, 30)
        answer = json.dumps({"shots": [{"shot": 1, "layout": "wide_fit"}]})

        timeline = CompositionSpec().parse_text(answer, request_for(path))

        assert [(t.start_s, t.end_s, t.layout) for t in timeline] == [
            (0, 6, "speaker_full"),
            (6, 14, "wide_fit"),
            (14, 30, "speaker_full"),
        ]

    def test_unknown_shot_is_an_invalid_reference(self) -> None:
        path = path_with_shots(0, 10)

        with pytest.raises(CapabilityError) as info:
            CompositionSpec().parse_text(
                json.dumps({"shots": [{"shot": 7, "layout": "wide_fit"}]}), request_for(path)
            )

        assert info.value.category.value == "invalid_references"

    def test_unsupported_layout_is_rejected(self) -> None:
        path = path_with_shots(0, 10)

        with pytest.raises(CapabilityError):
            CompositionSpec().parse_text(
                json.dumps({"shots": [{"shot": 0, "layout": "picture_in_picture"}]}),
                request_for(path),
            )

    def test_prompt_never_asks_for_seconds(self) -> None:
        system, _ = CompositionSpec().build_prompt(request_for(path_with_shots(0, 10)))

        assert "never give timestamps" in system


class TestTimeline:
    def test_short_flicker_is_absorbed(self) -> None:
        raw = [
            caps.CompositionSegment(0, 10, "speaker_full"),
            caps.CompositionSegment(10, 11.5, "wide_fit"),
            caps.CompositionSegment(11.5, 30, "speaker_full"),
        ]

        timeline = composition.normalise_timeline(raw, 30, [0, 10, 11.5, 30])

        assert [(t.start_s, t.end_s, t.layout) for t in timeline] == [(0, 30, "speaker_full")]

    def test_timeline_tiles_the_clip(self) -> None:
        raw = [
            caps.CompositionSegment(0, 8, "speaker_full"),
            caps.CompositionSegment(8, 20, "wide_fit"),
            caps.CompositionSegment(20, 31, "speaker_full"),
        ]

        timeline = composition.normalise_timeline(raw, 31, [0, 8, 20, 31])

        assert timeline[0].start_s == 0 and timeline[-1].end_s == 31
        for a, b in zip(timeline, timeline[1:], strict=False):
            assert a.end_s == b.start_s

    def test_nothing_usable_means_standard_framing(self) -> None:
        timeline = composition.normalise_timeline([], 20, [0, 20])

        assert [(t.start_s, t.end_s, t.layout) for t in timeline] == [(0, 20, "speaker_full")]


class TestApply:
    def test_wide_spans_become_fitted_segments_and_tile_exactly(self) -> None:
        path = path_with_shots(0, 6, 14, 30)
        timeline = [
            caps.CompositionSegment(0, 6, "speaker_full"),
            caps.CompositionSegment(6, 14, "wide_fit"),
            caps.CompositionSegment(14, 30, "speaker_full"),
        ]

        composed = composition.apply(path, timeline)

        assert [s.fit for s in composed.segments] == [False, True, False]
        assert composed.segments[0].start_s == 0
        assert composed.segments[-1].end_s == pytest.approx(30)
        for a, b in zip(composed.segments, composed.segments[1:], strict=False):
            assert a.end_s == pytest.approx(b.start_s)

    def test_composed_path_renders_through_the_existing_filtergraph(self, tmp_path) -> None:
        path = path_with_shots(0, 6, 14, 30)
        composed = composition.apply(
            path,
            [
                caps.CompositionSegment(0, 6, "speaker_full"),
                caps.CompositionSegment(6, 30, "wide_fit"),
            ],
        )
        from autoclip.pipeline.captions import get_style

        graph = build_video_filtergraph(
            ExportRequest(
                source=tmp_path / "in.mp4",
                destination=tmp_path / "out.mp4",
                start_s=100,
                end_s=130,
                crop_path=composed,
                words=[],
                style=get_style("bold_pop"),
            ),
            subtitle_name=None,
        )

        assert "boxblur" in graph  # the fitted layout
        assert "crop=w=608" in graph  # the tracked layout
        assert "concat=n=" in graph
