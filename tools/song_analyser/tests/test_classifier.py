"""Classifier pure-function tests -- no audio files needed."""

import pytest

from tools.song_analyser.classifier import classify_sections


def _make_sections(boundaries, energies, onset_densities=None):
    n = len(energies)
    if onset_densities is None:
        onset_densities = [0.5] * n
    duration = boundaries[-1]
    return classify_sections(boundaries, energies, onset_densities, duration)


class TestSectionTypes:
    def test_first_section_is_intro(self):
        sections = _make_sections([0, 5, 10], [0.3, 0.5])
        assert sections[0]["type"] == "intro"

    def test_last_section_is_finale(self):
        sections = _make_sections([0, 5, 10], [0.5, 0.3])
        assert sections[-1]["type"] == "finale"

    def test_high_energy_middle_section_is_drop(self):
        # intro(low) -> drop(high) -> finale(low)
        sections = _make_sections([0, 10, 20, 30], [0.2, 0.9, 0.3])
        types = [s["type"] for s in sections]
        assert "drop" in types

    def test_build_before_drop(self):
        # intro -> build -> drop -> finale
        sections = _make_sections(
            [0, 10, 20, 30, 40],
            [0.2, 0.5, 0.9, 0.3],
        )
        types = [s["type"] for s in sections]
        assert types[2] == "drop"
        assert types[1] == "build"

    def test_breakdown_after_drop(self):
        # intro -> drop -> breakdown -> finale
        sections = _make_sections(
            [0, 10, 20, 30, 40],
            [0.2, 0.9, 0.3, 0.4],
        )
        types = [s["type"] for s in sections]
        assert types[1] == "drop"
        assert types[2] == "breakdown"

    def test_single_section(self):
        sections = _make_sections([0, 10], [0.5])
        assert len(sections) == 1
        # Single section must be intro (it is both first and last; first wins)
        assert sections[0]["type"] == "intro"

    def test_verse_for_medium_energy(self):
        # intro -> verse -> verse -> finale
        # Energy spread must be wide enough that the promotion fallback
        # doesn't force a drop. Use clearly low-energy middle sections.
        sections = _make_sections(
            [0, 10, 20, 30, 40],
            [0.2, 0.28, 0.25, 0.22],
        )
        types = [s["type"] for s in sections]
        assert types[0] == "intro"
        assert types[-1] == "finale"
        # Middle sections should be verse or bridge (low uniform energy)
        for t in types[1:-1]:
            assert t in ("verse", "bridge")


class TestBiases:
    def test_hazard_bias_formula(self):
        sections = _make_sections([0, 10], [0.6])
        expected = round(0.6 * 0.8, 3)
        assert sections[0]["hazardBias"] == expected

    def test_pickup_bias_formula(self):
        sections = _make_sections([0, 10], [0.6])
        expected = round((1.0 - 0.6) * 0.6, 3)
        assert sections[0]["pickupBias"] == expected

    def test_biases_in_valid_range(self):
        sections = _make_sections(
            [0, 5, 10, 15, 20],
            [0.0, 0.5, 1.0, 0.3],
        )
        for sec in sections:
            assert 0.0 <= sec["hazardBias"] <= 1.0
            assert 0.0 <= sec["pickupBias"] <= 1.0


class TestEdgeCases:
    def test_empty_energies_raises(self):
        with pytest.raises(ValueError):
            classify_sections([0, 10], [], [], 10.0)
