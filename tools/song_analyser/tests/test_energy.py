"""Energy curve tests."""

import numpy as np

from tools.song_analyser.analyser import analyse_song


def test_steady_clip_energy_roughly_constant(steady_clip: str):
    """A constant-amplitude clip should produce a nearly flat energy curve."""
    result = analyse_song(steady_clip)
    curve = np.array(result["energy_curve"])
    # Trim the first and last 10% to avoid edge effects
    trim = int(len(curve) * 0.1)
    trimmed = curve[trim:-trim]
    assert trimmed.std() < 0.15, f"Energy std too high for steady clip: {trimmed.std():.4f}"


def test_ramp_energy_increases_monotonically(energy_ramp: str):
    """A linearly ramping clip should have a generally increasing energy curve."""
    result = analyse_song(energy_ramp)
    curve = np.array(result["energy_curve"])
    # Divide into 5 chunks and check that the mean of each is higher than the previous
    n_chunks = 5
    chunk_size = len(curve) // n_chunks
    means = [curve[i * chunk_size : (i + 1) * chunk_size].mean() for i in range(n_chunks)]
    for i in range(1, len(means)):
        assert means[i] >= means[i - 1] - 0.05, (
            f"Energy should generally increase: chunk {i - 1} mean={means[i - 1]:.3f}, "
            f"chunk {i} mean={means[i]:.3f}"
        )


def test_energy_curve_normalized_0_to_1(energy_ramp: str):
    """Energy values should be in [0, 1]."""
    result = analyse_song(energy_ramp)
    curve = np.array(result["energy_curve"])
    assert curve.min() >= 0.0
    assert curve.max() <= 1.0 + 1e-6
