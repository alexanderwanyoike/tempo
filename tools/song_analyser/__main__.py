"""CLI entry point: python -m tools.song_analyser input.mp3 -o output.json"""

from __future__ import annotations

import argparse
import json
import os
import sys


def _title_artist_from_filename(path: str) -> tuple[str, str]:
    """Best-effort title/artist from a filename like 'Artist - Title.mp3'."""
    base = os.path.splitext(os.path.basename(path))[0]
    if " - " in base:
        parts = base.split(" - ", 1)
        return parts[1].strip(), parts[0].strip()
    return base.strip(), "Unknown"


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="song_analyser",
        description="Analyse an audio file and produce Tempo song metadata JSON.",
    )
    parser.add_argument("input", help="Path to an audio file (MP3, WAV, etc.)")
    parser.add_argument("-o", "--output", default=None, help="Output JSON path (default: stdout)")
    parser.add_argument("--bpm-override", type=float, default=None, help="Force a specific BPM")
    parser.add_argument("--title", default=None, help="Song title (derived from filename if omitted)")
    parser.add_argument("--artist", default=None, help="Artist name (derived from filename if omitted)")

    args = parser.parse_args(argv)

    if not os.path.isfile(args.input):
        print(f"Error: file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    # Lazy imports so argparse --help stays fast even without librosa installed
    from .analyser import analyse_song  # noqa: E402
    from .classifier import classify_sections  # noqa: E402
    from .schema import to_song_definition  # noqa: E402

    title = args.title
    artist = args.artist
    if title is None or artist is None:
        derived_title, derived_artist = _title_artist_from_filename(args.input)
        title = title or derived_title
        artist = artist or derived_artist

    analysis = analyse_song(args.input, bpm_override=args.bpm_override)

    classified = classify_sections(
        boundaries=analysis["boundaries"],
        energies=analysis["boundary_energies"],
        onset_densities=analysis["boundary_onsets"],
        duration=analysis["duration"],
    )

    definition = to_song_definition(analysis, title=title, artist=artist, classified_sections=classified)

    json_str = json.dumps(definition, indent=2)

    if args.output:
        with open(args.output, "w") as f:
            f.write(json_str + "\n")
        print(f"Wrote {args.output}", file=sys.stderr)
    else:
        print(json_str)


if __name__ == "__main__":
    main()
