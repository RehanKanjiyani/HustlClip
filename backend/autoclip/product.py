"""Product identity.

User-facing naming lives here so a future rename touches one file rather than
every help string. The Python package keeps its historical ``autoclip`` import
path on purpose: renaming it would break every import, test, and existing
install for a purely cosmetic gain.
"""

from __future__ import annotations

NAME = "HustlClip"
SLUG = "hustlclip"
TAGLINE = "Turn your VOD into 10 Shorts."
DESCRIPTION = "AI-assisted short-form clipper: one long video in, ten finished vertical Shorts out."
REPOSITORY = "https://github.com/RehanKanjiyani/HustlClip"
