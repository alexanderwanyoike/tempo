# Tempo

Music-driven racer for Levelsio Vibe Jam 2026. Combat arrives in phase 3.

Core idea:

- long music-shaped race tracks
- arcade hover handling
- boosts and punishments tied to the line you take
- browser-first multiplayer after the single-player submission build

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
- large song assets can be moved behind a bucket/CDN via `VITE_ASSET_BASE_URL`

## Local Env

Copy `.env.example` to `.env` and set:

- `VITE_WS_URL`
- `VITE_ASSET_BASE_URL` if songs/MP3s are hosted outside the Vite app
- `PORT`

## Local Run

```bash
yarn
yarn dev
```

Open `http://localhost:5173`.

The client now boots into a lightweight menu shell that:

- loads a curated `public/song-catalog.json`
- only fetches the selected song JSON and MP3 when you press Play
- supports `songId`, `fiction`, `seed`, and `debugHud=1` query params
- still accepts legacy deep links with `song=/songs/...json`

## Deploy

Target stack for the jam submission:

- Netlify for the static site
- Railway for the realtime websocket server
- Cloudflare R2 for music and analysis JSON

### 1. Cloudflare R2 bucket

1. Sign in to Cloudflare and open the R2 dashboard. R2 needs a card on file even on free tier.
2. Create a bucket named `tempo-assets` (region automatic).
3. Bucket → Settings → Public access → Allow access → enable the `r2.dev` subdomain. Copy the URL — it looks like `https://pub-<hash>.r2.dev`.
4. R2 overview → Manage R2 API Tokens → Create API token with "Object Read & Write" scoped to `tempo-assets`. Save the Access Key ID and Secret Access Key. Copy the Account ID from the R2 overview page.

### 2. Upload the audio

1. Copy `.env.example` to `.env`. `.env` is gitignored — do not commit it.
2. Fill the `CLOUDFLARE_R2_*` values from step 1.
3. Run `yarn upload:assets`. This walks `public/music/` and `public/songs/`, skips files already in the bucket, and uploads the rest. Pass `--force` to overwrite.
4. Verify in the browser: open `<r2-public-url>/music/firestarter.mp3` — it should stream.

### 3. Railway realtime server

1. Railway → New Project → Deploy from GitHub repo → pick this repo.
2. Create a dedicated service for the websocket server using the repo root as the source.
3. Railway will pick up [`railway.json`](./railway.json), which sets:
   - build command: `yarn build:server`
   - start command: `yarn start`
   - healthcheck path: `/health`
4. Ensure the service has public networking enabled. Railway injects `PORT`; the server already listens on `process.env.PORT`.
5. Deploy once and copy the public domain, for example `tempo-room-server.up.railway.app`.
6. Verify the healthcheck in a browser:
   - `https://<railway-domain>/health` should return `ok`
7. Verify websocket reachability with a real client after Netlify is pointed at it.

### 4. Netlify site

1. Netlify → Add new site → Import from Git → pick this repo.
2. Build command: `yarn build`. Publish directory: `dist`. (`netlify.toml` already sets these.)
3. Site settings → Environment variables:
   - `VITE_ASSET_BASE_URL` = the R2 public base URL from step 1
   - `VITE_WS_URL` = `wss://<railway-domain>`
4. **Set both before the first deploy** — Vite inlines env vars at build time, so a build done without them will point at the wrong asset or websocket origin.
5. Trigger the deploy. Open the Netlify URL. Menu should load, preview should render, solo should stream audio from `pub-<hash>.r2.dev`, and multiplayer should connect to Railway.

### Changing songs later

- If you add a song: drop its `.mp3` into `public/music/`, its analysis `.json` into `public/songs/`, add an entry to `public/song-catalog.json`, run `yarn upload:assets`, commit, push.
- If you re-analyse an existing song: `yarn upload:assets --force`.

## Status

Phase 2 gameplay is in place and Phase 2.5 submission hardening is underway:

- procedural music tracks
- boosts, obstacles, loops, and reactive visual fictions
- win/lose race loop without a full page refresh
- deploy-ready asset base indirection for moving audio off the main site
- Netlify + R2 deploy config for the client
- Railway config for the realtime multiplayer server
