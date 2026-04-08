"""Synthetic audio fixtures for song-analyser tests.

All WAV files are generated programmatically via numpy + soundfile
and placed in a session-scoped temp directory.
"""

from __future__ import annotations

import os
import tempfile

import numpy as np
import pytest
import soundfile as sf

_SR = 22050  # sample rate used for all fixtures


@pytest.fixture(scope="session")
def fixtures_dir():
    """Temp directory that lives for the entire test session."""
    with tempfile.TemporaryDirectory(prefix="song_analyser_fixtures_") as d:
        yield d


@pytest.fixture(scope="session")
def click_track_120bpm(fixtures_dir: str) -> str:
    """10-second WAV with sine-burst clicks at 120 BPM (every 0.5 s)."""
    duration = 10.0
    n_samples = int(duration * _SR)
    y = np.zeros(n_samples, dtype=np.float32)

    click_interval = 0.5  # seconds (120 BPM)
    click_len = int(0.02 * _SR)  # 20 ms burst
    t_click = np.linspace(0, 2 * np.pi * 1000 * 0.02, click_len, endpoint=False)
    click = (0.8 * np.sin(t_click)).astype(np.float32)

    t = 0.0
    while t < duration:
        idx = int(t * _SR)
        end = min(idx + click_len, n_samples)
        y[idx:end] += click[: end - idx]
        t += click_interval

    path = os.path.join(fixtures_dir, "click_120bpm.wav")
    sf.write(path, y, _SR)
    return path


@pytest.fixture(scope="session")
def loud_quiet_loud(fixtures_dir: str) -> str:
    """10-second WAV: 3 s loud white noise, 4 s near-silence, 3 s loud noise.

    Useful for drop-detection tests: the transition from quiet back to loud
    around the 7 s mark should register as a drop.
    """
    rng = np.random.default_rng(42)
    duration = 10.0
    n = int(duration * _SR)
    y = np.zeros(n, dtype=np.float32)

    loud_amp = 0.8
    quiet_amp = 0.02

    # 0-3 s loud
    seg1_end = int(3.0 * _SR)
    y[:seg1_end] = (rng.standard_normal(seg1_end) * loud_amp).astype(np.float32)

    # 3-7 s quiet
    seg2_start = seg1_end
    seg2_end = int(7.0 * _SR)
    y[seg2_start:seg2_end] = (rng.standard_normal(seg2_end - seg2_start) * quiet_amp).astype(np.float32)

    # 7-10 s loud
    seg3_start = seg2_end
    y[seg3_start:] = (rng.standard_normal(n - seg3_start) * loud_amp).astype(np.float32)

    path = os.path.join(fixtures_dir, "loud_quiet_loud.wav")
    sf.write(path, y, _SR)
    return path


@pytest.fixture(scope="session")
def energy_ramp(fixtures_dir: str) -> str:
    """10-second WAV with linearly increasing amplitude (white noise)."""
    rng = np.random.default_rng(99)
    duration = 10.0
    n = int(duration * _SR)
    envelope = np.linspace(0.01, 0.9, n, dtype=np.float32)
    noise = rng.standard_normal(n).astype(np.float32)
    y = noise * envelope

    path = os.path.join(fixtures_dir, "energy_ramp.wav")
    sf.write(path, y, _SR)
    return path


@pytest.fixture(scope="session")
def steady_clip(fixtures_dir: str) -> str:
    """10-second WAV at constant amplitude (white noise)."""
    rng = np.random.default_rng(7)
    duration = 10.0
    n = int(duration * _SR)
    y = (rng.standard_normal(n) * 0.4).astype(np.float32)

    path = os.path.join(fixtures_dir, "steady.wav")
    sf.write(path, y, _SR)
    return path
