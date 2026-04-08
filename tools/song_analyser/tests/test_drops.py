"""Drop detection tests using the loud-quiet-loud fixture."""

from tools.song_analyser.analyser import analyse_song


def test_loud_quiet_loud_has_drop_marker(loud_quiet_loud: str):
    """The loud-quiet-loud fixture should produce at least one drop marker
    near the 7-second mark where energy jumps from quiet back to loud."""
    result = analyse_song(loud_quiet_loud)
    drops = result["drop_markers"]
    assert len(drops) >= 1, "Expected at least one drop marker"

    # The drop should be somewhere in the 5-10 s range (where the
    # quiet-to-loud transition happens).
    found_near_7s = any(5.0 <= d <= 10.0 for d in drops)
    assert found_near_7s, f"Expected a drop near 7 s, got markers at: {drops}"


def test_steady_clip_no_drops(steady_clip: str):
    """A constant-amplitude clip should have no drop markers."""
    result = analyse_song(steady_clip)
    assert len(result["drop_markers"]) == 0, (
        f"Steady clip should have no drops, got: {result['drop_markers']}"
    )
