"""BPM detection tests."""

from tools.song_analyser.analyser import analyse_song


def test_click_track_detects_120bpm(click_track_120bpm: str):
    """A synthetic click track at 120 BPM should be detected within +-2 BPM."""
    result = analyse_song(click_track_120bpm)
    assert abs(result["bpm"] - 120.0) <= 2.0, f"Expected ~120 BPM, got {result['bpm']}"


def test_bpm_override(click_track_120bpm: str):
    """When bpm_override is given, the analyser must use it verbatim."""
    result = analyse_song(click_track_120bpm, bpm_override=140.0)
    assert result["bpm"] == 140.0
