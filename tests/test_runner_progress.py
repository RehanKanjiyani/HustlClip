"""The overall progress bar must never move backwards."""

from __future__ import annotations

import pytest
from autoclip.config import Settings
from autoclip.db import store
from autoclip.db.models import Job, Source, new_id
from autoclip.pipeline import Stage
from autoclip.pipeline.runner import PipelineRunner


def test_overshooting_substep_reports_never_move_the_bar_back(initialised_db) -> None:
    source = store.create_source(Source(id=new_id(), type="upload", path="x.mp4", duration_s=60))
    job = store.create_job(Job(id=new_id(), source_id=source.id))
    events: list = []
    runner = PipelineRunner(job, source, settings=Settings(), on_progress=events.append)

    # ffmpeg's time-based progress can overshoot a clip slightly, and the next
    # clip then starts from zero: exactly the sequence the e2e run caught.
    runner._emit(Stage.EXPORT, 0.51)
    runner._emit(Stage.EXPORT, 0.50)
    runner._emit(Stage.EXPORT, 0.75)

    overall = [event.overall for event in events]
    assert overall == sorted(overall)
    # Stored rounded to four places for the UI.
    assert store.get_job(job.id).progress == pytest.approx(overall[-1], abs=1e-4)
