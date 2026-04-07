# Tempo

Multiplayer cyberpunk combat racer for Levelsio Vibe Jam 2026.

Core idea:

- long music-shaped race tracks
- arcade hover handling
- light combat pickups
- browser-first multiplayer

## Repo Shape

- `src/client` browser game code
- `src/server` websocket game server
- `shared` shared types and schemas
- `public` static files
- `assets` source assets
- `.notes` private planning docs, gitignored

## Branching

- `main` stable branch
- `dev` integration branch

Recommended workflow:

1. branch from `dev`
2. open small feature branches
3. merge back into `dev`
4. promote tested milestones to `main`

## Planned Stack

- `three.js`
- `TypeScript`
- `Vite`
- `Node.js`
- `ws`

## Hosting

- client on `Netlify`
- realtime websocket server on `Railway`

## Local Env

Copy `.env.example` to `.env` and set:

- `VITE_WS_URL`
- `PORT`

## Status

Scaffold only. Core systems are not implemented yet.
