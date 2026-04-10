"""Schema formatting and validation tests."""

import pytest

from tools.song_analyser.classifier import classify_sections
from tools.song_analyser.schema import to_song_definition


def _dummy_analysis(duration=30.0, bpm=128.0, n_sections=3):
    """Build a minimal analysis dict for testing."""
    step = duration / n_sections
    boundaries = [round(i * step, 3) for i in range(n_sections + 1)]
    energies = [0.3 + 0.2 * i for i in range(n_sections)]
    onsets = [0.4] * n_sections
    return {
        "bpm": bpm,
        "duration": duration,
        "boundaries": boundaries,
        "boundary_energies": energies,
        "boundary_onsets": onsets,
        "drop_markers": [20.0],
        "energy_curve": [],
        "energy_times": [],
        "onset_density": [],
        "onset_times": [],
    }


def _build_definition(duration=30.0, bpm=128.0, n_sections=3, title="TestSong", artist="TestArtist"):
    analysis = _dummy_analysis(duration, bpm, n_sections)
    classified = classify_sections(
        analysis["boundaries"],
        analysis["boundary_energies"],
        analysis["boundary_onsets"],
        analysis["duration"],
    )
    return to_song_definition(analysis, title=title, artist=artist, classified_sections=classified)


class TestTopLevelKeys:
    def test_all_required_keys_present(self):
        defn = _build_definition()
        required = {"id", "title", "artist", "bpm", "duration", "baseSeed", "sections", "dropMarkers", "chunkBias"}
        assert required.issubset(set(defn.keys()))

    def test_bpm_positive(self):
        defn = _build_definition()
        assert defn["bpm"] > 0

    def test_duration_positive(self):
        defn = _build_definition()
        assert defn["duration"] > 0

    def test_base_seed_non_negative_int(self):
        defn = _build_definition()
        assert isinstance(defn["baseSeed"], int)
        assert defn["baseSeed"] >= 0

    def test_base_seed_deterministic(self):
        d1 = _build_definition(title="A", bpm=120.0)
        d2 = _build_definition(title="A", bpm=120.0)
        assert d1["baseSeed"] == d2["baseSeed"]

    def test_base_seed_varies_with_title(self):
        d1 = _build_definition(title="A")
        d2 = _build_definition(title="B")
        assert d1["baseSeed"] != d2["baseSeed"]


class TestSections:
    def test_at_least_one_section(self):
        defn = _build_definition()
        assert len(defn["sections"]) >= 1

    def test_section_ids_sequential(self):
        defn = _build_definition(n_sections=4)
        for i, sec in enumerate(defn["sections"]):
            assert sec["id"] == f"section-{i}"

    def test_section_has_all_keys(self):
        defn = _build_definition()
        required = {"id", "type", "startTime", "endTime", "energy", "density", "hazardBias", "pickupBias", "tags"}
        for sec in defn["sections"]:
            assert required.issubset(set(sec.keys())), f"Missing keys in {sec['id']}"

    def test_section_values_in_range(self):
        defn = _build_definition()
        for sec in defn["sections"]:
            assert 0.0 <= sec["energy"] <= 1.0
            assert 0.0 <= sec["density"] <= 1.0
            assert 0.0 <= sec["hazardBias"] <= 1.0
            assert 0.0 <= sec["pickupBias"] <= 1.0

    def test_sections_cover_full_duration(self):
        defn = _build_definition(duration=30.0)
        assert defn["sections"][0]["startTime"] == 0.0
        assert abs(defn["sections"][-1]["endTime"] - 30.0) < 0.01

    def test_valid_section_types(self):
        valid = {"intro", "verse", "build", "drop", "bridge", "breakdown", "finale"}
        defn = _build_definition(n_sections=5)
        for sec in defn["sections"]:
            assert sec["type"] in valid, f"Invalid type: {sec['type']}"


class TestDropMarkers:
    def test_drop_markers_are_list(self):
        defn = _build_definition()
        assert isinstance(defn["dropMarkers"], list)

    def test_drop_markers_non_negative(self):
        defn = _build_definition()
        for t in defn["dropMarkers"]:
            assert t >= 0


class TestChunkBias:
    def test_chunk_bias_defaults_to_empty(self):
        defn = _build_definition()
        assert defn["chunkBias"] == []
