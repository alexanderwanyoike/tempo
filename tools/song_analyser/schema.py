"""Format analysis output to match the SongDefinition Zod schema in shared/song-schema.ts."""

from __future__ import annotations

import hashlib
import re


def to_song_definition(
    analysis: dict,
    title: str,
    artist: str,
    classified_sections: list[dict],
) -> dict:
    """Build a SongDefinition dict ready for JSON serialisation.

    Parameters
    ----------
    analysis : dict
        Raw output from ``analyser.analyse_song``.
    title : str
        Song title.
    artist : str
        Artist name.
    classified_sections : list[dict]
        Output from ``classifier.classify_sections``.

    Returns
    -------
    dict matching the SongDefinition Zod schema.
    """
    bpm = analysis["bpm"]
    duration = analysis["duration"]
    base_seed = _base_seed(title, bpm)

    # Stamp each section with an id
    sections: list[dict] = []
    for idx, sec in enumerate(classified_sections):
        section = {
            "id": f"section-{idx}",
            "type": sec["type"],
            "startTime": sec["startTime"],
            "endTime": sec["endTime"],
            "energy": sec["energy"],
            "density": sec["density"],
            "hazardBias": sec["hazardBias"],
            "pickupBias": sec["pickupBias"],
            "tags": sec.get("tags", []),
        }
        sections.append(section)

    song_id = _slugify(f"{artist}-{title}")

    definition: dict = {
        "id": song_id,
        "title": title,
        "artist": artist,
        "bpm": round(bpm, 2),
        "duration": round(duration, 3),
        "baseSeed": base_seed,
        "sections": sections,
        "dropMarkers": [round(t, 3) for t in analysis.get("drop_markers", [])],
        "chunkBias": [],
    }

    _validate(definition)
    return definition


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _validate(defn: dict) -> None:
    """Raise ValueError if the definition is obviously invalid."""
    required_keys = {
        "id", "title", "artist", "bpm", "duration",
        "baseSeed", "sections", "dropMarkers", "chunkBias",
    }
    missing = required_keys - set(defn.keys())
    if missing:
        raise ValueError(f"Missing top-level keys: {missing}")

    if defn["bpm"] <= 0:
        raise ValueError("bpm must be positive")
    if defn["duration"] <= 0:
        raise ValueError("duration must be positive")
    if defn["baseSeed"] < 0:
        raise ValueError("baseSeed must be non-negative")
    if len(defn["sections"]) < 1:
        raise ValueError("At least one section is required")

    section_keys = {
        "id", "type", "startTime", "endTime", "energy",
        "density", "hazardBias", "pickupBias", "tags",
    }
    valid_types = {"intro", "verse", "build", "drop", "bridge", "breakdown", "finale"}

    for sec in defn["sections"]:
        sec_missing = section_keys - set(sec.keys())
        if sec_missing:
            raise ValueError(f"Section {sec.get('id', '?')} missing keys: {sec_missing}")
        if sec["type"] not in valid_types:
            raise ValueError(f"Invalid section type: {sec['type']}")
        for field in ("energy", "density", "hazardBias", "pickupBias"):
            v = sec[field]
            if not (0.0 <= v <= 1.0):
                raise ValueError(f"{field} out of range [0,1]: {v}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _base_seed(title: str, bpm: float) -> int:
    """Deterministic positive integer seed from title + bpm."""
    raw = hashlib.sha256((title + str(bpm)).encode()).hexdigest()
    return int(raw[:8], 16)  # 32-bit positive int


def _slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")
