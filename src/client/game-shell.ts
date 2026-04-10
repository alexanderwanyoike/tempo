import type { App, AppLaunchOptions } from "./runtime/app";
import type { ClientConfig } from "./runtime/config";
import { clampFictionId, type EnvironmentFictionId } from "./runtime/fiction-id";
import { MenuPreview } from "./runtime/menu-preview";
import {
  clampCatalogFictions,
  loadSongCatalog,
  resolveSongLaunchUrls,
  type SongCatalog,
  type SongCatalogEntry,
} from "./runtime/song-catalog";

type ShellSongEntry = SongCatalogEntry & {
  custom?: boolean;
};

type QueryState = {
  requestedSongId: string | null;
  requestedSongPath: string | null;
  requestedMusicPath: string | null;
  seed: number | null;
  fictionId: EnvironmentFictionId;
  debugHud: boolean;
  autostart: boolean;
};

const FICTION_OPTIONS: Array<{ id: EnvironmentFictionId; label: string; blurb: string }> = [
  { id: 1, label: "Audio Reactor", blurb: "Neon transit geometry" },
  { id: 2, label: "Signal City", blurb: "Industrial corridor pressure" },
  { id: 3, label: "Data Cathedral", blurb: "Ceremonial spectral architecture" },
];

export class GameShell {
  private readonly raceHost = document.createElement("div");
  private readonly uiLayer = document.createElement("div");
  private readonly shell = document.createElement("div");
  private readonly previewHost = document.createElement("div");
  private readonly statusLine = document.createElement("div");
  private readonly songSelect = document.createElement("select");
  private readonly seedInput = document.createElement("input");
  private readonly playButton = document.createElement("button");
  private readonly songName = document.createElement("div");
  private readonly songInfo = document.createElement("div");
  private readonly trackStats = document.createElement("div");
  private readonly fictionDeck = document.createElement("div");
  private readonly previewTitle = document.createElement("div");
  private readonly previewSubline = document.createElement("div");
  private readonly shellBrand = document.createElement("div");
  private readonly fictionButtons = new Map<EnvironmentFictionId, HTMLButtonElement>();
  private readonly menuPreview: MenuPreview;

  private catalog: SongCatalog | null = null;
  private availableSongs: ShellSongEntry[] = [];
  private selectedSongId = "";
  private selectedFictionId: EnvironmentFictionId = 1;
  private seedOverride: number | null = null;
  private debugHud = false;
  private activeApp: App | null = null;
  private lastLaunch: AppLaunchOptions | null = null;
  private launchInFlight = false;
  private previewDebounce: number | null = null;
  private readonly preloadedMusic = new Set<string>();

  constructor(
    private readonly root: HTMLElement,
    private readonly config: ClientConfig,
  ) {
    this.injectStyles();
    this.configureLayout();
    this.menuPreview = new MenuPreview(this.previewHost);
    this.buildShellUi();
  }

  async start(): Promise<void> {
    this.root.replaceChildren(this.raceHost, this.uiLayer);
    this.menuPreview.start();
    this.setStatus("Loading circuit database...");

    try {
      this.catalog = await loadSongCatalog(this.config);
      this.availableSongs = this.catalog.songs.map((song) => ({ ...song }));
    } catch (error) {
      console.error(error);
      this.setStatus("Song catalog failed to load.");
      this.statusLine.style.color = "#df4040";
      return;
    }

    const queryState = this.readQueryState();
    this.debugHud = queryState.debugHud;
    this.seedOverride = queryState.seed;
    this.selectedFictionId = queryState.fictionId;
    this.selectedSongId = this.resolveInitialSongId(queryState);

    this.populateSongSelect();
    this.renderFictionButtons();
    this.renderSelection();
    this.syncUrl();

    if (queryState.autostart) {
      await this.launchRace();
      return;
    }

    this.setStatus("Circuit armed. Select and launch.");
  }

  private injectStyles(): void {
    if (document.getElementById("tempo-shell-styles")) return;

    const style = document.createElement("style");
    style.id = "tempo-shell-styles";
    style.textContent = `
      .tempo-shell-ui {
        position: absolute;
        inset: 0;
        overflow: hidden;
        background:
          radial-gradient(circle at 18% 12%, rgba(103, 201, 215, 0.08), transparent 48%),
          radial-gradient(circle at 82% 88%, rgba(185, 144, 229, 0.06), transparent 52%),
          #06080b;
        color: #f3f5f2;
        font-family: ui-sans-serif, -apple-system, "Inter", "Helvetica Neue", Arial, sans-serif;
        --tempo-accent: #67c9d7;
      }

      .tempo-shell-ui[data-fiction="2"] { --tempo-accent: #d78b73; }
      .tempo-shell-ui[data-fiction="3"] { --tempo-accent: #b990e5; }

      .tempo-shell {
        position: relative;
        z-index: 1;
        display: grid;
        grid-template-rows: auto 1fr;
        min-height: 100%;
        padding: 40px 56px 36px;
        gap: 32px;
      }

      .tempo-shell-topline {
        display: flex;
        align-items: baseline;
        gap: 18px;
      }

      .tempo-shell-brand {
        font-size: clamp(34px, 4vw, 52px);
        font-weight: 800;
        letter-spacing: -0.04em;
        line-height: 1;
        color: #f6f8f4;
      }

      .tempo-shell-tagline {
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        color: #6b757a;
      }

      .tempo-shell-main {
        display: grid;
        grid-template-columns: minmax(320px, 380px) minmax(0, 1fr);
        gap: 48px;
        align-items: stretch;
        min-height: 0;
      }

      .tempo-shell-left {
        display: flex;
        flex-direction: column;
        gap: 28px;
        min-width: 0;
      }

      .tempo-shell-right {
        display: block;
        min-width: 0;
        height: 100%;
        min-height: 0;
      }

      .tempo-shell-section {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .tempo-shell-label {
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.24em;
        text-transform: uppercase;
        color: #6b757a;
      }

      .tempo-shell-select,
      .tempo-shell-input {
        width: 100%;
        border: 1px solid rgba(243, 245, 242, 0.12);
        background: rgba(243, 245, 242, 0.03);
        color: #f3f5f2;
        padding: 12px 14px;
        font-size: 15px;
        font-weight: 500;
        letter-spacing: 0.01em;
        border-radius: 2px;
        font-family: inherit;
        transition: border-color 120ms ease;
      }

      .tempo-shell-select:focus,
      .tempo-shell-input:focus {
        outline: none;
        border-color: var(--tempo-accent);
      }

      .tempo-shell-select option {
        background: #0a0c10;
        color: #f3f5f2;
      }

      .tempo-shell-fictions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .tempo-shell-fiction {
        flex: 1 1 auto;
        padding: 10px 16px;
        border: 1px solid rgba(243, 245, 242, 0.14);
        background: transparent;
        color: #c3cacc;
        text-align: center;
        cursor: pointer;
        font-family: inherit;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        border-radius: 2px;
        transition: border-color 120ms ease, color 120ms ease;
      }

      .tempo-shell-fiction:hover {
        color: #f3f5f2;
        border-color: rgba(243, 245, 242, 0.32);
      }

      .tempo-shell-fiction.is-active {
        border-color: var(--tempo-accent);
        color: var(--tempo-accent);
      }

      .tempo-shell-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 14px;
      }

      .tempo-shell-stat {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .tempo-shell-stat-key {
        font-size: 9px;
        font-weight: 600;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: #6b757a;
      }

      .tempo-shell-stat-value {
        font-size: 16px;
        font-weight: 600;
        color: #f3f5f2;
      }

      .tempo-shell-play {
        margin-top: auto;
        border: 1px solid var(--tempo-accent);
        padding: 18px 22px;
        background: transparent;
        color: var(--tempo-accent);
        font-family: inherit;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        cursor: pointer;
        border-radius: 2px;
        transition: background-color 120ms ease, color 120ms ease;
      }

      .tempo-shell-play::before {
        content: ">>  ";
        letter-spacing: 0;
      }

      .tempo-shell-play:hover:not(:disabled) {
        background: var(--tempo-accent);
        color: #06080b;
      }

      .tempo-shell-play:disabled {
        cursor: wait;
        opacity: 0.5;
      }

      .tempo-shell-status {
        font-size: 10px;
        font-weight: 500;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: #6b757a;
        min-height: 14px;
      }

      .tempo-shell-preview-box {
        position: relative;
        width: 100%;
        height: min(72vh, 720px);
        min-height: 480px;
        border: 1px solid rgba(243, 245, 242, 0.08);
        background: #0a0c10;
        border-radius: 2px;
        overflow: hidden;
      }

      .tempo-shell-preview-canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }

      .tempo-shell-preview-head {
        position: absolute;
        top: 18px;
        left: 20px;
        right: 20px;
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
        pointer-events: none;
        z-index: 1;
      }

      .tempo-shell-song-name {
        font-size: clamp(22px, 2.2vw, 30px);
        font-weight: 700;
        letter-spacing: -0.015em;
        color: #f3f5f2;
        line-height: 1.1;
      }

      .tempo-shell-song-info {
        margin-top: 6px;
        font-size: 10px;
        font-weight: 500;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #8a9297;
      }

      .tempo-shell-preview-meta {
        text-align: right;
        font-size: 9px;
        font-weight: 600;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--tempo-accent);
      }

      @media (max-width: 980px) {
        .tempo-shell {
          padding: 28px 24px;
          gap: 24px;
        }

        .tempo-shell-main {
          grid-template-columns: 1fr;
          gap: 28px;
        }

        .tempo-shell-preview-box {
          min-height: 360px;
        }
      }
    `;

    document.head.appendChild(style);
  }

  private configureLayout(): void {
    this.root.style.position = "relative";
    this.root.style.width = "100vw";
    this.root.style.height = "100vh";
    this.root.style.overflow = "hidden";

    this.raceHost.style.position = "absolute";
    this.raceHost.style.inset = "0";

    this.uiLayer.className = "tempo-shell-ui";
    this.shell.className = "tempo-shell";
    this.uiLayer.appendChild(this.shell);
  }

  private buildShellUi(): void {
    const topline = document.createElement("div");
    topline.className = "tempo-shell-topline";

    this.shellBrand.className = "tempo-shell-brand";
    this.shellBrand.textContent = "TEMPO";

    const tagline = document.createElement("div");
    tagline.className = "tempo-shell-tagline";
    tagline.textContent = "Music Driven Racer";

    topline.append(this.shellBrand, tagline);

    const main = document.createElement("div");
    main.className = "tempo-shell-main";

    const left = document.createElement("div");
    left.className = "tempo-shell-left";

    const songSection = createSection("Tune");
    this.songSelect.className = "tempo-shell-select";
    this.songSelect.addEventListener("change", () => {
      this.selectedSongId = this.songSelect.value;
      const song = this.getSelectedSong();
      if (song) {
        this.selectedFictionId = clampCatalogFictions(song, this.selectedFictionId);
      }
      this.seedOverride = null;
      this.seedInput.value = "";
      this.renderFictionButtons();
      this.renderSelection();
      this.syncUrl();
      this.setStatus("");
    });
    songSection.appendChild(this.songSelect);

    const fictionSection = createSection("Fiction");
    this.fictionDeck.className = "tempo-shell-fictions";
    for (const fiction of FICTION_OPTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tempo-shell-fiction";
      button.textContent = fiction.label;
      button.addEventListener("click", () => {
        this.selectedFictionId = fiction.id;
        this.renderFictionButtons();
        this.renderSelection();
        this.syncUrl();
      });
      this.fictionButtons.set(fiction.id, button);
      this.fictionDeck.appendChild(button);
    }
    fictionSection.appendChild(this.fictionDeck);

    const seedSection = createSection("Seed");
    this.seedInput.className = "tempo-shell-input";
    this.seedInput.type = "number";
    this.seedInput.placeholder = "Default";
    this.seedInput.addEventListener("input", () => {
      this.seedOverride = parseInteger(this.seedInput.value);
      this.renderSelection();
      this.syncUrl();
    });
    seedSection.appendChild(this.seedInput);

    const statsSection = document.createElement("div");
    statsSection.className = "tempo-shell-section";
    this.trackStats.className = "tempo-shell-stats";
    statsSection.appendChild(this.trackStats);

    this.playButton.type = "button";
    this.playButton.className = "tempo-shell-play";
    this.playButton.textContent = "LAUNCH";
    this.playButton.addEventListener("click", () => {
      void this.launchRace();
    });

    this.statusLine.className = "tempo-shell-status";

    left.append(songSection, fictionSection, seedSection, statsSection, this.playButton, this.statusLine);

    const right = document.createElement("div");
    right.className = "tempo-shell-right";

    const previewBox = document.createElement("div");
    previewBox.className = "tempo-shell-preview-box";
    this.previewHost.className = "tempo-shell-preview-canvas";

    const previewHead = document.createElement("div");
    previewHead.className = "tempo-shell-preview-head";

    const previewInfo = document.createElement("div");
    this.songName.className = "tempo-shell-song-name";
    this.songInfo.className = "tempo-shell-song-info";
    previewInfo.append(this.songName, this.songInfo);

    const previewMeta = document.createElement("div");
    previewMeta.className = "tempo-shell-preview-meta";
    previewMeta.append(this.previewTitle, this.previewSubline);

    previewHead.append(previewInfo, previewMeta);

    previewBox.append(this.previewHost, previewHead);
    right.append(previewBox);

    main.append(left, right);
    this.shell.append(topline, main);
  }

  private populateSongSelect(): void {
    this.songSelect.replaceChildren();
    for (const song of this.availableSongs) {
      const option = document.createElement("option");
      option.value = song.id;
      option.textContent = `${song.title} / ${song.artist}`;
      this.songSelect.appendChild(option);
    }
    this.songSelect.value = this.selectedSongId;
  }

  private renderFictionButtons(): void {
    const song = this.getSelectedSong();
    const allowed = song?.fictionIds ?? [1, 2, 3];
    this.selectedFictionId = allowed.includes(this.selectedFictionId) ? this.selectedFictionId : allowed[0];

    for (const fiction of FICTION_OPTIONS) {
      const button = this.fictionButtons.get(fiction.id);
      if (!button) continue;
      const enabled = allowed.includes(fiction.id);
      button.style.display = enabled ? "" : "none";
      button.disabled = !enabled;
      button.classList.toggle("is-active", enabled && fiction.id === this.selectedFictionId);
    }
  }

  private renderSelection(): void {
    const song = this.getSelectedSong();
    if (!song) return;

    const fiction = FICTION_OPTIONS.find((candidate) => candidate.id === this.selectedFictionId) ?? FICTION_OPTIONS[0];
    const seed = this.seedOverride ?? song.baseSeed;
    const resolved = resolveSongLaunchUrls(this.config, song);
    this.preloadMusic(resolved.musicUrl);

    this.uiLayer.dataset.fiction = String(fiction.id);
    this.songName.textContent = song.title;
    this.songInfo.textContent = `${song.artist} / ${song.bpm.toFixed(0)} BPM / ${formatDuration(song.duration)}`;
    this.previewTitle.textContent = fiction.label;
    this.previewSubline.textContent = fiction.blurb;

    this.trackStats.replaceChildren(
      createStat("Length", formatDuration(song.duration)),
      createStat("Tempo", `${song.bpm.toFixed(0)} BPM`),
      createStat("Seed", seed.toString()),
    );

    const selection = {
      songId: song.id,
      songUrl: resolved.songUrl,
      fictionId: fiction.id,
      seed,
    };

    if (this.previewDebounce !== null) {
      window.clearTimeout(this.previewDebounce);
    }
    this.previewDebounce = window.setTimeout(() => {
      this.previewDebounce = null;
      void this.menuPreview.setSelection(selection).catch((error) => {
        console.error("Menu preview failed:", error);
        this.previewSubline.textContent = "Preview unavailable for this selection";
        this.setStatus("Preview failed. Race launch still works.");
      });
    }, 120);
  }

  private readQueryState(): QueryState {
    const params = new URL(location.href).searchParams;
    return {
      requestedSongId: params.get("songId"),
      requestedSongPath: params.get("song"),
      requestedMusicPath: params.get("music"),
      seed: parseInteger(params.get("seed")),
      fictionId: clampFictionId(parseInteger(params.get("fiction")) ?? 1),
      debugHud: params.get("debugHud") === "1",
      autostart: params.get("autostart") === "1" || params.has("song"),
    };
  }

  private resolveInitialSongId(queryState: QueryState): string {
    const byId = queryState.requestedSongId
      ? this.availableSongs.find((song) => song.id === queryState.requestedSongId)
      : null;
    if (byId) return byId.id;

    const byPath = queryState.requestedSongPath
      ? this.availableSongs.find((song) => song.songPath === queryState.requestedSongPath)
      : null;
    if (byPath) return byPath.id;

    if (queryState.requestedSongPath) {
      const customSong = this.createCustomSong(queryState.requestedSongPath, queryState.requestedMusicPath);
      this.availableSongs.unshift(customSong);
      return customSong.id;
    }

    const defaultSong = this.catalog?.songs.find((song) => song.id === this.catalog?.defaultSongId)
      ?? this.availableSongs[0];
    return defaultSong.id;
  }

  private createCustomSong(songPath: string, musicPath: string | null): ShellSongEntry {
    const filename = songPath.split("/").pop()?.replace(/\.json$/i, "") ?? "linked-track";
    return {
      id: `custom-${filename}`,
      title: filename.replace(/[-_]+/g, " "),
      artist: "Linked Track",
      bpm: 120,
      duration: 180,
      baseSeed: 0,
      songPath,
      musicPath: musicPath ?? songPath.replace(/\.json$/i, ".mp3").replace("/songs/", "/music/"),
      fictionIds: [1, 2, 3],
      custom: true,
    };
  }

  private getSelectedSong(): ShellSongEntry | null {
    return this.availableSongs.find((song) => song.id === this.selectedSongId) ?? null;
  }

  private async launchRace(reuseLastLaunch = false): Promise<void> {
    if (this.launchInFlight) return;

    const song = this.getSelectedSong();
    if (!song && !reuseLastLaunch) {
      this.setStatus("Pick a valid circuit before launch.");
      return;
    }

    this.launchInFlight = true;
    this.playButton.disabled = true;
    this.setStatus("");

    try {
      await this.stopActiveRace();

      const launchOptions = reuseLastLaunch && this.lastLaunch
        ? this.lastLaunch
        : this.buildLaunchOptions(song!);

      const runtime = await import("./runtime/app");
      const app = await runtime.App.create(this.raceHost, this.config, launchOptions);
      this.activeApp = app;
      this.lastLaunch = launchOptions;
      this.uiLayer.style.display = "none";
      this.menuPreview.stop();
      app.start();
    } catch (error) {
      console.error(error);
      this.uiLayer.style.display = "";
      this.menuPreview.start();
      this.setStatus("Launch failed.");
    } finally {
      this.launchInFlight = false;
      this.playButton.disabled = false;
      this.playButton.textContent = "LAUNCH";
    }
  }

  private buildLaunchOptions(song: ShellSongEntry): AppLaunchOptions {
    const fictionId = clampCatalogFictions(song, this.selectedFictionId);
    const seed = this.seedOverride ?? song.baseSeed;
    const resolved = resolveSongLaunchUrls(this.config, song);

    this.selectedFictionId = fictionId;
    this.renderFictionButtons();
    this.syncUrl();

    return {
      songUrl: resolved.songUrl,
      musicUrl: resolved.musicUrl,
      seed,
      fictionId,
      debugHud: this.debugHud,
      onRetry: () => {
        void this.launchRace(true);
      },
      onBackToMenu: () => {
        void this.showMenu();
      },
    };
  }

  private async showMenu(): Promise<void> {
    await this.stopActiveRace();
    this.uiLayer.style.display = "";
    this.menuPreview.start();
    this.renderSelection();
    this.setStatus("Circuit select ready.");
  }

  private async stopActiveRace(): Promise<void> {
    if (!this.activeApp) return;
    this.activeApp.destroy();
    this.activeApp = null;
    this.raceHost.replaceChildren();
  }

  private syncUrl(): void {
    const params = new URLSearchParams();
    const song = this.getSelectedSong();
    if (song) {
      if (song.custom) params.set("song", song.songPath);
      else params.set("songId", song.id);
    }

    if (this.seedOverride !== null) params.set("seed", this.seedOverride.toString());
    if (this.selectedFictionId !== 1) params.set("fiction", this.selectedFictionId.toString());
    if (this.debugHud) params.set("debugHud", "1");

    const nextUrl = params.size > 0 ? `${location.pathname}?${params.toString()}` : location.pathname;
    history.replaceState(null, "", nextUrl);
  }

  private setStatus(message: string): void {
    this.statusLine.textContent = message;
  }

  private preloadMusic(musicUrl: string): void {
    if (!musicUrl || this.preloadedMusic.has(musicUrl)) return;
    this.preloadedMusic.add(musicUrl);
    void fetch(musicUrl).then((response) => {
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const drain = (): Promise<void> =>
        reader.read().then(({ done }) => (done ? undefined : drain()));
      return drain();
    }).catch(() => {
      this.preloadedMusic.delete(musicUrl);
    });
  }
}

function createSection(label: string): HTMLDivElement {
  const section = document.createElement("div");
  section.className = "tempo-shell-section";
  const title = document.createElement("div");
  title.className = "tempo-shell-label";
  title.textContent = label;
  section.appendChild(title);
  return section;
}

function createStat(key: string, value: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "tempo-shell-stat";
  const keyEl = document.createElement("div");
  keyEl.className = "tempo-shell-stat-key";
  keyEl.textContent = key;
  const valueEl = document.createElement("div");
  valueEl.className = "tempo-shell-stat-value";
  valueEl.textContent = value;
  row.append(keyEl, valueEl);
  return row;
}

function parseInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDuration(durationSeconds: number): string {
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = Math.round(durationSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
