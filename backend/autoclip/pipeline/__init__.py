"""Video processing pipeline stages."""

from __future__ import annotations

__all__ = ["STAGES", "Stage"]

from enum import StrEnum


class Stage(StrEnum):
    """Ordered pipeline stages.

    Stage order matters: a job that fails at ``REFRAME`` resumes from
    ``REFRAME``, reusing the artifacts every earlier stage left in
    ``work/{job_id}/``.
    """

    PREPARE = "prepare"
    TRANSCRIBE = "transcribe"
    #: Candidate discovery + normalisation. The value is kept from the
    #: pre-HustlClip single highlight stage so existing job rows stay valid.
    HIGHLIGHTS = "highlights"
    EVALUATE = "evaluate"
    SELECT = "select"
    REFRAME = "reframe"
    CAPTIONS = "captions"
    EXPORT = "export"

    @property
    def label(self) -> str:
        return {
            Stage.PREPARE: "Preparing",
            Stage.TRANSCRIBE: "Transcribing",
            Stage.HIGHLIGHTS: "Finding moments",
            Stage.EVALUATE: "Evaluating moments",
            Stage.SELECT: "Selecting the best clips",
            Stage.REFRAME: "Reframing",
            Stage.CAPTIONS: "Adding captions",
            Stage.EXPORT: "Rendering",
        }[self]


#: Canonical stage order.
STAGES: tuple[Stage, ...] = tuple(Stage)
