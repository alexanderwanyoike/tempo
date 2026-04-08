"""Core audio analysis: BPM, energy curve, onset density, section boundaries, drop detection."""

from __future__ import annotations

import librosa
import numpy as np


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_ENERGY_HOP_HZ = 10  # approximate RMS sample rate
_MIN_SECTION_LEN = 5.0  # seconds
_BOUNDARY_DELTA = 0.15  # energy change threshold
_BOUNDARY_SUSTAIN = 2.0  # seconds the delta must be sustained
_DROP_JUMP = 0.25  # energy jump that marks a drop
_DROP_WINDOW = 1.5  # seconds within which the jump must happen


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def analyse_song(path: str, bpm_override: float | None = None) -> dict:
    """Analyse an audio file and return raw analysis data.

    Parameters
    ----------
    path : str
        Path to an audio file (MP3, WAV, etc.).
    bpm_override : float | None
        If provided, skip BPM detection and use this value.

    Returns
    -------
    dict with keys:
        bpm, duration, energy_curve, energy_times, onset_density,
        onset_times, boundaries, boundary_energies, drop_markers
    """
    y, sr = librosa.load(path, sr=None, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))

    # BPM -------------------------------------------------------------------
    if bpm_override is not None:
        bpm = float(bpm_override)
    else:
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        # librosa may return an ndarray with one element
        bpm = float(np.atleast_1d(tempo)[0])

    # Energy curve at ~10 Hz ------------------------------------------------
    hop_length = max(1, int(sr / _ENERGY_HOP_HZ))
    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    rms_max = rms.max() if rms.max() > 0 else 1.0
    energy_curve = (rms / rms_max).astype(float)
    energy_times = librosa.frames_to_time(
        np.arange(len(energy_curve)), sr=sr, hop_length=hop_length
    ).astype(float)

    # Onset density ---------------------------------------------------------
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
    onset_max = onset_env.max() if onset_env.max() > 0 else 1.0
    onset_density = (onset_env / onset_max).astype(float)
    onset_times = librosa.frames_to_time(
        np.arange(len(onset_density)), sr=sr, hop_length=hop_length
    ).astype(float)

    # Section boundaries ----------------------------------------------------
    boundaries = _detect_boundaries(energy_curve, energy_times, duration)

    # Per-section average energies ------------------------------------------
    boundary_energies = _section_averages(boundaries, energy_curve, energy_times)
    boundary_onsets = _section_averages(boundaries, onset_density, onset_times)

    # Drop markers ----------------------------------------------------------
    drop_markers = _detect_drops(boundaries, boundary_energies)

    return {
        "bpm": bpm,
        "duration": duration,
        "energy_curve": energy_curve.tolist(),
        "energy_times": energy_times.tolist(),
        "onset_density": onset_density.tolist(),
        "onset_times": onset_times.tolist(),
        "boundaries": boundaries,
        "boundary_energies": boundary_energies,
        "boundary_onsets": boundary_onsets,
        "drop_markers": drop_markers,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _detect_boundaries(
    energy: np.ndarray, times: np.ndarray, duration: float
) -> list[float]:
    """Return a sorted list of section boundary timestamps (always includes 0 and duration)."""
    boundaries: list[float] = [0.0]
    sustain_frames = max(1, int(_BOUNDARY_SUSTAIN * _ENERGY_HOP_HZ))

    # Smooth the energy curve to avoid spurious splits
    kernel_size = max(3, sustain_frames)
    if len(energy) > kernel_size:
        smoothed = np.convolve(energy, np.ones(kernel_size) / kernel_size, mode="same")
    else:
        smoothed = energy

    i = 0
    while i < len(smoothed) - sustain_frames:
        window = smoothed[i : i + sustain_frames]
        delta = abs(float(window[-1] - window[0]))
        if delta >= _BOUNDARY_DELTA:
            candidate = float(times[min(i + sustain_frames // 2, len(times) - 1)])
            # Enforce minimum section length from the last boundary
            if candidate - boundaries[-1] >= _MIN_SECTION_LEN:
                boundaries.append(candidate)
                i += sustain_frames
                continue
        i += 1

    # Ensure the last section is long enough; merge if not
    if duration - boundaries[-1] < _MIN_SECTION_LEN and len(boundaries) > 1:
        boundaries.pop()

    boundaries.append(duration)
    return boundaries


def _section_averages(
    boundaries: list[float], curve: np.ndarray, times: np.ndarray
) -> list[float]:
    """Compute the mean of *curve* within each section defined by *boundaries*."""
    averages: list[float] = []
    for start, end in zip(boundaries[:-1], boundaries[1:]):
        mask = (times >= start) & (times < end)
        if mask.any():
            averages.append(float(curve[mask].mean()))
        else:
            averages.append(0.0)
    return averages


def _detect_drops(boundaries: list[float], energies: list[float]) -> list[float]:
    """Return timestamps where energy jumps by more than DROP_JUMP from one section to the next."""
    drops: list[float] = []
    for i in range(1, len(energies)):
        jump = energies[i] - energies[i - 1]
        section_gap = boundaries[i] - boundaries[i - 1]
        if jump >= _DROP_JUMP and section_gap <= _DROP_WINDOW * 10:
            # The drop lands at the start of the high-energy section
            drops.append(boundaries[i])
    return drops
