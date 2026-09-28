"""HustlClip's intelligence layer: capabilities, model registry, AI manager.

The pipeline depends on capability names and normalised results only; which
provider or model served a request is recorded, never assumed.
"""

from __future__ import annotations

from . import capabilities
from .manager import (
    AIManager,
    CapabilityResult,
    CapabilityUnavailable,
    DecisionRecord,
    HealthTracker,
)
from .registry import ModelEntry, build_registry

__all__ = [
    "AIManager",
    "CapabilityResult",
    "CapabilityUnavailable",
    "DecisionRecord",
    "HealthTracker",
    "ModelEntry",
    "build_registry",
    "capabilities",
]
