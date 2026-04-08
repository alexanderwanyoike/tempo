"""Pure functions that map energy/position data to section types and biases."""

from __future__ import annotations


def classify_sections(
    boundaries: list[float],
    energies: list[float],
    onset_densities: list[float],
    duration: float,
) -> list[dict]:
    """Classify each section based on energy profile and position in the song.

    Parameters
    ----------
    boundaries : list[float]
        Sorted section boundary timestamps including 0 and *duration*.
    energies : list[float]
        Average energy (0-1) for each section (length = len(boundaries) - 1).
    onset_densities : list[float]
        Average onset density (0-1) for each section.
    duration : float
        Total song duration in seconds.

    Returns
    -------
    list[dict]
        One dict per section with keys: type, startTime, endTime, energy,
        density, hazardBias, pickupBias, tags.
    """
    n = len(energies)
    if n == 0:
        raise ValueError("At least one section is required")

    # Pre-compute which sections are drops (highest energy).
    # A section qualifies as a drop if its energy is above the 75th percentile
    # and it is not the first or last section.
    sorted_e = sorted(energies)
    p75 = sorted_e[max(0, int(len(sorted_e) * 0.75))]
    drop_threshold = max(p75, 0.55)

    drop_indices: set[int] = set()
    for i in range(n):
        if energies[i] >= drop_threshold and i != 0 and i != n - 1:
            drop_indices.add(i)

    # If no drops detected (e.g. very uniform song), promote the highest
    # non-first, non-last section if there are at least 3 sections.
    if not drop_indices and n >= 3:
        best = max(range(1, n - 1), key=lambda j: energies[j])
        if energies[best] > 0.3:
            drop_indices.add(best)

    # Normalize onset densities for the density field
    max_onset = max(onset_densities) if onset_densities and max(onset_densities) > 0 else 1.0
    norm_onsets = [d / max_onset for d in onset_densities]

    sections: list[dict] = []
    for i in range(n):
        start = boundaries[i]
        end = boundaries[i + 1]
        energy = _clamp(energies[i])
        density = _clamp(norm_onsets[i])
        hazard_bias = _clamp(energy * 0.8)
        pickup_bias = _clamp((1.0 - energy) * 0.6)

        sec_type = _assign_type(
            index=i,
            total=n,
            energy=energy,
            is_drop=(i in drop_indices),
            drop_indices=drop_indices,
            energies=energies,
        )

        sections.append(
            {
                "type": sec_type,
                "startTime": round(start, 3),
                "endTime": round(end, 3),
                "energy": round(energy, 3),
                "density": round(density, 3),
                "hazardBias": round(hazard_bias, 3),
                "pickupBias": round(pickup_bias, 3),
                "tags": [],
            }
        )

    return sections


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _assign_type(
    index: int,
    total: int,
    energy: float,
    is_drop: bool,
    drop_indices: set[int],
    energies: list[float],
) -> str:
    # First section is always intro
    if index == 0:
        return "intro"

    # Last section is always finale
    if index == total - 1:
        return "finale"

    # Explicit drop
    if is_drop:
        return "drop"

    # Section immediately before a drop with rising energy is a build
    if (index + 1) in drop_indices and energy < energies[index + 1]:
        return "build"

    # Low energy right after a drop is a breakdown
    if (index - 1) in drop_indices and energy < 0.45:
        return "breakdown"

    # Bridge: low-medium energy between two higher sections
    if energy < 0.45:
        higher_before = any(energies[j] > energy + 0.1 for j in range(index))
        higher_after = any(energies[j] > energy + 0.1 for j in range(index + 1, total))
        if higher_before and higher_after:
            return "bridge"

    # Default to verse for medium/steady energy
    return "verse"


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))
