# Claude Phase 4 Handoff

You are joining the `tempo` project on branch `feature/phase-4`.

Current git state:

- branch: `feature/phase-4`
- worktree: clean
- latest commits:
  - `ba4922b` `fix: compact car select with 3d preview`
  - `821bbca` `feat: add visual car select preview`
  - `1d64501` `fix: pin only selected track across genre filters`
  - `7de14b4` `fix: move music browser into modal`
  - `22e0549` `feat: add music-first track browser for solo and multiplayer`

## Phase 4 Workflow

The agreed workflow is strict:

1. choose one card only
2. write the plan
3. implement it
4. test it
5. commit it
6. move on

Do not silently start unrelated work.

## What Is Done

### P4-01 Music-First Track Select

Implemented and iterated:

- song browser moved into a modal instead of living in the left column
- genre filtering and search are working
- per-track audition uses a speaker icon on each row
- only the selected track stays pinned across genre filters
- catalog metadata now includes genre, album art, preview offsets, and search terms
- room listings show readable song info instead of raw ids where possible

Current genre taxonomy in use:

- `House`
- `Techno`
- `Drum & Bass`
- `Jungle`
- `Breaks`
- `Electro`
- `Big Beat`
- `Industrial`
- `Trance`
- `UKG`

Important product decisions already made:

- `Big Beat` and `Breaks` stay separate
- `UKG` is the browser label, not generic `Garage`
- `Industrial` can absorb `EBM` as a substyle/tag later
- each track gets one primary genre only

### P4-02 Car Select Preview

Implemented and corrected after user feedback:

- the first version was too bulky and used fake descriptive meta
- it was replaced with a compact selector and a lightweight real 3D car preview
- the left-side car UI is now compact and should conserve setup space
- the right-side preview uses `src/client/runtime/car-preview.ts`
- the user explicitly wanted a 3D preview, not a CSS mockup
- the cars are visual only right now, not stat-bearing gameplay choices

Important product constraints from the user:

- conserve space on both desktop and landscape mobile
- avoid long meta copy for cars
- do not turn visual flavor into fake gameplay stats

## Files Touched Recently

Primary shell work:

- `src/client/game-shell.ts`

Music browser support:

- `src/client/runtime/song-catalog.ts`
- `src/client/runtime/song-audition.ts`
- `public/song-catalog.json`
- `public/album-art/*.svg`

Car preview support:

- `src/client/runtime/car-preview.ts`

## What To Check First

Before changing anything, manually sanity-check current shell behavior:

- desktop layout
- narrow landscape/mobile layout
- music browser modal flow
- per-track audition buttons
- compact car selector behavior
- 3D car preview readability
- multiplayer host/client song selection behavior
- multiplayer per-player car selection behavior

If there are visible regressions, fix the active card before moving to a new one.

## Next Preferred Card

Next planned card is `P4-06` Custom Player Identity.

Card path:

- `.notes/cards/phase-4/P4-06-custom-player-identity.md`

High-level scope:

- let players set a custom visible name
- persist it locally per device
- show it in lobby, race, and results
- validate length and character set defensively

Do not jump into accounts or backend identity.

## If Continuing With P4-06

Recommended plan shape:

1. inspect where `"Pilot N"` names currently come from in client/server
2. define a local persistence key and validation rules
3. add an easy edit path in the shell
4. propagate the chosen name through lobby, race, and results
5. test refresh + host/join flow
6. commit only `P4-06`

## Tone / Expectations

- be direct and pragmatic
- do not defend bad UI if the user says it is broken
- when the user gives visual feedback, correct course instead of polishing the wrong concept
- keep each card self-contained
