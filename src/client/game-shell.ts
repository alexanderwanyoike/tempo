import type {
  RaceSetup,
  RoomDirectoryEntry,
  RoomPhase,
  RoomPlayerState,
  SharedFictionId,
  CarVariant,
  ServerMessage,
} from "../../shared/network-types";
import type { App, AppLaunchOptions } from "./runtime/app";
import type { ClientConfig } from "./runtime/config";
import { clampFictionId, type EnvironmentFictionId } from "./runtime/fiction-id";
import { MenuPreview } from "./runtime/menu-preview";
import { unlockAudioContext } from "./runtime/music-sync";
import { RoomClient } from "./runtime/room-client";
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

type ShellMode = "solo" | "multiplayer";

const FICTION_OPTIONS: Array<{ id: EnvironmentFictionId; label: string; blurb: string }> = [
  { id: 1, label: "Audio Reactor", blurb: "Neon transit geometry" },
  { id: 2, label: "Signal City", blurb: "Industrial corridor pressure" },
  { id: 3, label: "Data Cathedral", blurb: "Ceremonial spectral architecture" },
];

const CAR_VARIANTS: Array<{ id: CarVariant; label: string }> = [
  { id: "vector", label: "Vector" },
  { id: "ember", label: "Ember" },
  { id: "nova", label: "Nova" },
  { id: "ghost", label: "Ghost" },
];

export class GameShell {
  private readonly raceHost = document.createElement("div");
  private readonly uiLayer = document.createElement("div");
  private readonly shell = document.createElement("div");
  private readonly previewHost = document.createElement("div");
  private readonly statusLine = document.createElement("div");
  private readonly modeDeck = document.createElement("div");
  private readonly songSection = document.createElement("div");
  private readonly songSelect = document.createElement("select");
  private readonly seedSection = document.createElement("div");
  private readonly seedInput = document.createElement("input");
  private readonly fictionSection = document.createElement("div");
  private readonly fictionDeck = document.createElement("div");
  private readonly fictionButtons = new Map<EnvironmentFictionId, HTMLButtonElement>();
  private readonly playerCapSelect = document.createElement("select");
  private readonly playerCapSection = document.createElement("div");
  private readonly carSection = document.createElement("div");
  private readonly carSelect = document.createElement("select");
  private readonly roomNameInput = document.createElement("input");
  private readonly roomSearchInput = document.createElement("input");
  private readonly createRoomButton = document.createElement("button");
  private readonly readyButton = document.createElement("button");
  private readonly startRoomButton = document.createElement("button");
  private readonly leaveRoomButton = document.createElement("button");
  private readonly playButton = document.createElement("button");
  private readonly multiplayerPanel = document.createElement("div");
  private readonly roomSection = document.createElement("div");
  private readonly roomViewDeck = document.createElement("div");
  private readonly joinRoomsButton = document.createElement("button");
  private readonly hostRoomButton = document.createElement("button");
  private readonly hostRoomSection = document.createElement("div");
  private readonly browseRoomsSection = document.createElement("div");
  private readonly roomActionRow = document.createElement("div");
  private readonly directoryPanel = document.createElement("div");
  private readonly rosterPanel = document.createElement("div");
  private readonly roomMeta = document.createElement("div");
  private readonly trackStats = document.createElement("div");
  private readonly songName = document.createElement("div");
  private readonly songInfo = document.createElement("div");
  private readonly previewTitle = document.createElement("div");
  private readonly previewSubline = document.createElement("div");
  private readonly rotatePrompt = document.createElement("div");
  private readonly menuPreview: MenuPreview;

  private orientationQuery: MediaQueryList | null = null;
  private catalog: SongCatalog | null = null;
  private availableSongs: ShellSongEntry[] = [];
  private selectedSongId = "";
  private selectedFictionId: EnvironmentFictionId = 1;
  private seedOverride: number | null = null;
  private selectedPlayerCap = 4;
  private selectedCarVariant: CarVariant = "vector";
  private mode: ShellMode = "solo";
  private debugHud = false;
  private roomClient: RoomClient | null = null;
  private clientId: string | null = null;
  private roomCode: string | null = null;
  private roomName = "";
  private roomPhase: RoomPhase | null = null;
  private roomPlayers: RoomPlayerState[] = [];
  private roomDirectory: RoomDirectoryEntry[] = [];
  private roomHostId: string | null = null;
  private multiplayerView: "join" | "host" = "join";
  private roomBrowserReady = false;
  private multiplayerResultsActive = false;
  private pendingLobbyStatus: string | null = null;
  private activeApp: App | null = null;
  private lastLaunch: AppLaunchOptions | null = null;
  private previewDebounce: number | null = null;
  private launchInFlight = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly config: ClientConfig,
  ) {
    this.injectStyles();
    this.configureLayout();
    this.menuPreview = new MenuPreview(this.previewHost);
    this.buildShellUi();
    this.buildRotatePrompt();
    this.setupOrientationWatch();
  }

  async start(): Promise<void> {
    this.root.replaceChildren(this.raceHost, this.uiLayer, this.rotatePrompt);
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
    this.populatePlayerCapSelect();
    this.populateCarSelect();
    this.renderFictionButtons();
    this.renderSelection();
    this.renderMode();
    this.syncUrl();

    if (queryState.autostart) {
      await this.launchSoloRace();
      return;
    }

    this.setStatus("Circuit armed. Choose solo or lock a room.");
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
        padding: 36px 52px 32px;
        gap: 28px;
      }
      .tempo-shell-topline { display:flex; align-items:baseline; gap:18px; }
      .tempo-shell-brand { font-size: clamp(34px, 4vw, 52px); font-weight:800; letter-spacing:-0.04em; line-height:1; }
      .tempo-shell-tagline { font-size:11px; font-weight:500; letter-spacing:0.22em; text-transform:uppercase; color:#6b757a; }
      .tempo-shell-main { display:grid; grid-template-columns:minmax(330px, 420px) minmax(0, 1fr); gap:40px; min-height:0; }
      .tempo-shell-left { display:flex; flex-direction:column; gap:18px; min-width:0; }
      .tempo-shell-right { min-width:0; min-height:0; }
      .tempo-shell-section { display:flex; flex-direction:column; gap:10px; }
      .tempo-shell-label { font-size:10px; font-weight:600; letter-spacing:0.24em; text-transform:uppercase; color:#6b757a; }
      .tempo-shell-select, .tempo-shell-input, .tempo-shell-code {
        width:100%;
        border:1px solid rgba(243,245,242,0.12);
        background:rgba(243,245,242,0.03);
        color:#f3f5f2;
        padding:12px 14px;
        font-size:15px;
        font-weight:500;
        border-radius:2px;
        font-family:inherit;
      }
      .tempo-shell-select:focus, .tempo-shell-input:focus, .tempo-shell-code:focus { outline:none; border-color:var(--tempo-accent); }
      .tempo-shell-select option { background:#0a0c10; color:#f3f5f2; }
      .tempo-shell-modes, .tempo-shell-fictions, .tempo-shell-actions { display:flex; gap:8px; flex-wrap:wrap; }
      .tempo-shell-chip, .tempo-shell-action, .tempo-shell-play {
        border:1px solid rgba(243,245,242,0.16);
        background:transparent;
        color:#d4dadd;
        font:600 11px/1 inherit;
        letter-spacing:0.14em;
        text-transform:uppercase;
        border-radius:2px;
        padding:11px 14px;
        cursor:pointer;
      }
      .tempo-shell-chip.is-active, .tempo-shell-action.is-primary, .tempo-shell-play {
        border-color:var(--tempo-accent);
        color:var(--tempo-accent);
      }
      .tempo-shell-chip:disabled, .tempo-shell-action:disabled, .tempo-shell-play:disabled { opacity:0.45; cursor:wait; }
      .tempo-shell-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
      .tempo-shell-room-block {
        display:flex;
        flex-direction:column;
        gap:10px;
        padding:12px;
        border:1px solid rgba(243,245,242,0.1);
        background:rgba(243,245,242,0.03);
      }
      .tempo-shell-subhead {
        font-size:10px;
        font-weight:600;
        letter-spacing:0.18em;
        text-transform:uppercase;
        color:#98a5ab;
      }
      .tempo-shell-roster {
        min-height:84px;
        padding:12px 14px;
        border:1px solid rgba(243,245,242,0.1);
        background:rgba(243,245,242,0.03);
        white-space:pre;
        font:600 12px/1.55 ui-monospace, monospace;
        color:#d9f7ff;
      }
      .tempo-shell-directory { display:flex; flex-direction:column; gap:8px; }
      .tempo-shell-room-card {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        padding:10px 12px;
        border:1px solid rgba(243,245,242,0.1);
        background:rgba(243,245,242,0.03);
      }
      .tempo-shell-room-card-meta {
        font:600 11px/1.45 ui-monospace, monospace;
        color:#d9f7ff;
        white-space:pre;
      }
      .tempo-shell-room-meta { font-size:11px; line-height:1.55; color:#98a5ab; text-transform:uppercase; letter-spacing:0.12em; min-height:16px; }
      .tempo-shell-stats { display:grid; grid-template-columns:repeat(3, 1fr); gap:14px; }
      .tempo-shell-stat { display:flex; flex-direction:column; gap:4px; }
      .tempo-shell-stat-key { font-size:9px; font-weight:600; letter-spacing:0.2em; text-transform:uppercase; color:#6b757a; }
      .tempo-shell-stat-value { font-size:16px; font-weight:600; color:#f3f5f2; }
      .tempo-shell-play { margin-top:auto; padding:18px 22px; font-size:14px; font-weight:700; letter-spacing:0.22em; }
      .tempo-shell-status { font-size:10px; font-weight:500; letter-spacing:0.16em; text-transform:uppercase; color:#6b757a; min-height:14px; }
      .tempo-shell-preview-box { position:relative; width:100%; height:min(72vh, 720px); min-height:480px; border:1px solid rgba(243,245,242,0.08); background:#0a0c10; border-radius:2px; overflow:hidden; }
      .tempo-shell-preview-canvas { position:absolute; inset:0; width:100%; height:100%; }
      .tempo-shell-preview-head { position:absolute; top:18px; left:20px; right:20px; display:flex; justify-content:space-between; align-items:flex-start; gap:16px; pointer-events:none; z-index:1; }
      .tempo-shell-song-name { font-size:clamp(22px, 2.2vw, 30px); font-weight:700; letter-spacing:-0.015em; line-height:1.1; }
      .tempo-shell-song-info { margin-top:6px; font-size:10px; font-weight:500; letter-spacing:0.18em; text-transform:uppercase; color:#8a9297; }
      .tempo-shell-preview-meta { text-align:right; font-size:9px; font-weight:600; letter-spacing:0.18em; text-transform:uppercase; color:var(--tempo-accent); }
      .tempo-hidden { display:none !important; }
      @media (max-width: 980px) {
        .tempo-shell-ui { overflow-y:auto; overscroll-behavior:contain; }
        .tempo-shell { padding:24px 22px; }
        .tempo-shell-main { grid-template-columns:1fr; gap:24px; }
        .tempo-shell-preview-box { min-height:340px; }
        .tempo-shell-room-card {
          flex-wrap:wrap;
          padding:12px;
          gap:10px;
        }
        .tempo-shell-room-card-meta {
          font-size:12px;
          line-height:1.55;
          flex:1 1 100%;
          white-space:normal;
        }
        .tempo-shell-room-card .tempo-shell-action,
        .tempo-shell-room-card .tempo-shell-chip {
          flex:1 1 100%;
          min-height:44px;
        }
        .tempo-shell-directory { max-height:42vh; overflow-y:auto; }
      }
      @media (max-width: 900px) and (orientation: landscape) {
        .tempo-shell { padding:12px 20px 14px; gap:12px; min-height:100vh; }
        .tempo-shell-topline { gap:10px; }
        .tempo-shell-brand { font-size:22px; }
        .tempo-shell-tagline { display:none; }
        .tempo-shell-main { grid-template-columns:minmax(220px, 300px) minmax(0, 1fr); gap:18px; }
        .tempo-shell-left { gap:12px; }
        .tempo-shell-section { gap:6px; }
        .tempo-shell-select,
        .tempo-shell-input,
        .tempo-shell-code { padding:10px 12px; font-size:14px; }
        .tempo-shell-chip,
        .tempo-shell-action { padding:9px 12px; }
        .tempo-shell-stats { gap:10px; }
        .tempo-shell-stat-value { font-size:14px; }
        .tempo-shell-play { margin-top:4px; padding:12px 16px; font-size:12px; letter-spacing:0.18em; }
        .tempo-shell-preview-box { min-height:0; height:100%; }
        .tempo-shell-directory { max-height:38vh; }
        .tempo-shell-room-block { padding:10px; }
      }
      .tempo-rotate-prompt {
        position: fixed; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center;
        gap: 20px; background: #06080b; color: #f3f5f2; z-index: 9999; padding: 40px; text-align: center;
      }
      .tempo-rotate-prompt.is-visible { display:flex; }
      .tempo-rotate-prompt svg { width:88px; height:88px; opacity:0.85; }
      .tempo-rotate-prompt-title { font-size:18px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; }
      .tempo-rotate-prompt-sub { font-size:11px; font-weight:500; letter-spacing:0.2em; text-transform:uppercase; color:#8a9297; }
    `;
    document.head.appendChild(style);
  }

  private buildRotatePrompt(): void {
    this.rotatePrompt.className = "tempo-rotate-prompt";
    this.rotatePrompt.innerHTML = `
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="20" y="8" width="24" height="44" rx="4" ry="4" />
        <line x1="28" y1="46" x2="36" y2="46" />
        <path d="M 10 36 A 22 22 0 0 1 32 14" />
        <polyline points="6 30 10 36 16 32" />
      </svg>
      <div class="tempo-rotate-prompt-title">Rotate to landscape</div>
      <div class="tempo-rotate-prompt-sub">Tempo plays sideways</div>
    `;
  }

  private setupOrientationWatch(): void {
    if (typeof window.matchMedia !== "function") return;
    const coarse = window.matchMedia("(pointer: coarse)");
    if (!coarse.matches) return;
    this.orientationQuery = window.matchMedia("(orientation: portrait)");
    const sync = (): void => {
      this.rotatePrompt.classList.toggle("is-visible", this.orientationQuery?.matches === true);
    };
    this.orientationQuery.addEventListener("change", sync);
    sync();
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
    const brand = document.createElement("div");
    brand.className = "tempo-shell-brand";
    brand.textContent = "TEMPO";
    const tagline = document.createElement("div");
    tagline.className = "tempo-shell-tagline";
    tagline.textContent = "Music Driven Racer";
    topline.append(brand, tagline);

    const main = document.createElement("div");
    main.className = "tempo-shell-main";
    const left = document.createElement("div");
    left.className = "tempo-shell-left";
    const right = document.createElement("div");
    right.className = "tempo-shell-right";

    const modeSection = createSection("Mode");
    this.modeDeck.className = "tempo-shell-modes";
    for (const mode of ["solo", "multiplayer"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tempo-shell-chip";
      button.textContent = mode === "solo" ? "Solo" : "Multiplayer";
      button.addEventListener("click", () => {
        void this.setMode(mode);
      });
      button.dataset.mode = mode;
      this.modeDeck.appendChild(button);
    }
    modeSection.appendChild(this.modeDeck);

    this.songSection.className = "tempo-shell-section";
    const songLabel = document.createElement("div");
    songLabel.className = "tempo-shell-label";
    songLabel.textContent = "Tune";
    this.songSelect.className = "tempo-shell-select";
    this.songSelect.addEventListener("change", () => {
      this.selectedSongId = this.songSelect.value;
      const song = this.getSelectedSong();
      if (song) this.selectedFictionId = clampCatalogFictions(song, this.selectedFictionId);
      this.seedOverride = null;
      this.seedInput.value = "";
      this.renderFictionButtons();
      this.renderSelection();
      this.syncUrl();
      this.syncRoomSetup();
    });
    this.songSection.append(songLabel, this.songSelect);

    this.fictionSection.className = "tempo-shell-section";
    const fictionLabel = document.createElement("div");
    fictionLabel.className = "tempo-shell-label";
    fictionLabel.textContent = "Fiction";
    this.fictionDeck.className = "tempo-shell-fictions";
    for (const fiction of FICTION_OPTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tempo-shell-chip";
      button.textContent = fiction.label;
      button.dataset.fictionId = String(fiction.id);
      button.addEventListener("click", () => {
        this.selectedFictionId = fiction.id;
        this.renderFictionButtons();
        this.renderSelection();
        this.syncUrl();
        this.syncRoomSetup();
      });
      this.fictionButtons.set(fiction.id, button);
      this.fictionDeck.appendChild(button);
    }
    this.fictionSection.append(fictionLabel, this.fictionDeck);

    this.seedSection.className = "tempo-shell-section";
    const seedLabel = document.createElement("div");
    seedLabel.className = "tempo-shell-label";
    seedLabel.textContent = "Seed";
    this.seedInput.className = "tempo-shell-input";
    this.seedInput.type = "number";
    this.seedInput.placeholder = "Default";
    this.seedInput.addEventListener("input", () => {
      this.seedOverride = parseInteger(this.seedInput.value);
      this.renderSelection();
      this.syncUrl();
      this.syncRoomSetup();
    });
    this.seedSection.append(seedLabel, this.seedInput);

    this.carSection.className = "tempo-shell-section";
    const carLabel = document.createElement("div");
    carLabel.className = "tempo-shell-label";
    carLabel.textContent = "Car";
    this.carSelect.className = "tempo-shell-select";
    this.carSelect.addEventListener("change", () => {
      this.selectedCarVariant = this.carSelect.value as CarVariant;
      if (this.mode === "multiplayer" && this.roomClient && this.roomCode) {
        this.roomClient.send({ type: "room.selectCar", carVariant: this.selectedCarVariant });
      }
    });
    this.carSection.append(carLabel, this.carSelect);

    this.playerCapSection.className = "tempo-shell-section";
    const playerCapLabel = document.createElement("div");
    playerCapLabel.className = "tempo-shell-label";
    playerCapLabel.textContent = "Player Cap";
    this.playerCapSelect.className = "tempo-shell-select";
    this.playerCapSelect.addEventListener("change", () => {
      this.selectedPlayerCap = parseInt(this.playerCapSelect.value, 10) || 4;
      this.syncRoomSetup();
    });
    this.playerCapSection.append(playerCapLabel, this.playerCapSelect);

    this.roomSection.className = "tempo-shell-section";
    const roomLabel = document.createElement("div");
    roomLabel.className = "tempo-shell-label";
    roomLabel.textContent = "Rooms";

    this.roomViewDeck.className = "tempo-shell-modes";
    this.joinRoomsButton.type = "button";
    this.joinRoomsButton.className = "tempo-shell-chip";
    this.joinRoomsButton.textContent = "Join Room";
    this.joinRoomsButton.dataset.view = "join";
    this.joinRoomsButton.addEventListener("click", () => {
      this.multiplayerView = "join";
      this.renderRoomState();
    });
    this.hostRoomButton.type = "button";
    this.hostRoomButton.className = "tempo-shell-chip";
    this.hostRoomButton.textContent = "Host Room";
    this.hostRoomButton.dataset.view = "host";
    this.hostRoomButton.addEventListener("click", () => {
      this.multiplayerView = "host";
      this.renderRoomState();
    });
    this.roomViewDeck.append(this.joinRoomsButton, this.hostRoomButton);

    this.hostRoomSection.className = "tempo-shell-room-block";
    const hostSubhead = document.createElement("div");
    hostSubhead.className = "tempo-shell-subhead";
    hostSubhead.textContent = "Name the room, then host it";
    const createRow = document.createElement("div");
    createRow.className = "tempo-shell-grid2";
    this.roomNameInput.className = "tempo-shell-code";
    this.roomNameInput.placeholder = "Room Name";
    this.roomNameInput.maxLength = 32;
    this.createRoomButton.type = "button";
    this.createRoomButton.className = "tempo-shell-action is-primary";
    this.createRoomButton.textContent = "Host";
    this.createRoomButton.addEventListener("click", () => {
      void this.createRoom();
    });
    createRow.append(this.roomNameInput, this.createRoomButton);
    this.hostRoomSection.append(hostSubhead, createRow);

    this.browseRoomsSection.className = "tempo-shell-room-block";
    const browseSubhead = document.createElement("div");
    browseSubhead.className = "tempo-shell-subhead";
    browseSubhead.textContent = "Search waiting rooms";
    this.roomSearchInput.className = "tempo-shell-code";
    this.roomSearchInput.placeholder = "Search Rooms";
    this.roomSearchInput.addEventListener("input", () => {
      this.renderDirectory();
    });
    this.browseRoomsSection.append(browseSubhead, this.roomSearchInput);

    this.roomActionRow.className = "tempo-shell-actions";

    this.readyButton.type = "button";
    this.readyButton.className = "tempo-shell-action";
    this.readyButton.addEventListener("click", () => {
      this.toggleReady();
    });
    this.startRoomButton.type = "button";
    this.startRoomButton.className = "tempo-shell-action is-primary";
    this.startRoomButton.textContent = "Start Grid";
    this.startRoomButton.addEventListener("click", () => {
      this.roomClient?.send({ type: "room.start" });
    });
    this.leaveRoomButton.type = "button";
    this.leaveRoomButton.className = "tempo-shell-action";
    this.leaveRoomButton.textContent = "Leave";
    this.leaveRoomButton.addEventListener("click", () => {
      void this.leaveRoom();
    });
    this.roomActionRow.append(this.readyButton, this.startRoomButton, this.leaveRoomButton);

    this.roomMeta.className = "tempo-shell-room-meta";
    this.directoryPanel.className = "tempo-shell-directory";
    this.rosterPanel.className = "tempo-shell-roster";
    this.multiplayerPanel.append(
      this.roomMeta,
      this.roomActionRow,
      this.rosterPanel,
      this.roomViewDeck,
      this.hostRoomSection,
      this.browseRoomsSection,
      this.directoryPanel,
    );
    this.roomSection.append(roomLabel, this.multiplayerPanel);

    const statsSection = document.createElement("div");
    statsSection.className = "tempo-shell-section";
    this.trackStats.className = "tempo-shell-stats";
    statsSection.appendChild(this.trackStats);

    this.playButton.type = "button";
    this.playButton.className = "tempo-shell-play";
    this.playButton.textContent = "Launch Solo";
    this.playButton.addEventListener("click", () => {
      void this.launchSoloRace();
    });

    this.statusLine.className = "tempo-shell-status";

    left.append(
      modeSection,
      this.carSection,
      this.roomSection,
      this.songSection,
      this.fictionSection,
      this.seedSection,
      this.playerCapSection,
      statsSection,
      this.playButton,
      this.statusLine,
    );

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

  private populatePlayerCapSelect(): void {
    this.playerCapSelect.replaceChildren();
    for (const cap of [2, 4, 6, 8]) {
      const option = document.createElement("option");
      option.value = String(cap);
      option.textContent = `${cap} Racers`;
      this.playerCapSelect.appendChild(option);
    }
    this.playerCapSelect.value = String(this.selectedPlayerCap);
  }

  private populateCarSelect(): void {
    this.carSelect.replaceChildren();
    for (const car of CAR_VARIANTS) {
      const option = document.createElement("option");
      option.value = car.id;
      option.textContent = car.label;
      this.carSelect.appendChild(option);
    }
    this.carSelect.value = this.selectedCarVariant;
  }

  private renderMode(): void {
    for (const child of Array.from(this.modeDeck.children)) {
      if (!(child instanceof HTMLButtonElement)) continue;
      child.classList.toggle("is-active", child.dataset.mode === this.mode);
    }
    for (const child of Array.from(this.roomViewDeck.children)) {
      if (!(child instanceof HTMLButtonElement)) continue;
      child.classList.toggle("is-active", child.dataset.view === this.multiplayerView);
    }

    const inRoom = Boolean(this.roomCode);
    const isHost = this.roomHostId === this.clientId;
    const setupLocked = this.mode === "multiplayer" && inRoom && (!isHost || this.roomPhase !== "lobby");
    const showHostSetup = this.mode === "solo" || (this.mode === "multiplayer" && (isHost || (!inRoom && this.multiplayerView === "host")));
    const showJoinBrowser = this.mode === "multiplayer" && !inRoom && this.multiplayerView === "join";

    this.multiplayerPanel.classList.toggle("tempo-hidden", this.mode !== "multiplayer");
    this.roomSection.classList.toggle("tempo-hidden", this.mode !== "multiplayer");
    this.songSection.classList.toggle("tempo-hidden", !showHostSetup);
    this.fictionSection.classList.toggle("tempo-hidden", !showHostSetup);
    this.seedSection.classList.toggle("tempo-hidden", !showHostSetup);
    this.playerCapSection.classList.toggle("tempo-hidden", !showHostSetup || this.mode !== "multiplayer");
    this.roomViewDeck.classList.toggle("tempo-hidden", this.mode !== "multiplayer" || inRoom);
    this.hostRoomSection.classList.toggle("tempo-hidden", !showHostSetup || inRoom || this.mode !== "multiplayer");
    this.browseRoomsSection.classList.toggle("tempo-hidden", !showJoinBrowser);
    this.directoryPanel.classList.toggle("tempo-hidden", !showJoinBrowser);
    this.roomActionRow.classList.toggle("tempo-hidden", this.mode !== "multiplayer" || !inRoom);
    this.rosterPanel.classList.toggle("tempo-hidden", this.mode !== "multiplayer" || !inRoom);
    this.playerCapSelect.disabled = this.mode !== "multiplayer" || !showHostSetup || setupLocked;
    this.songSelect.disabled = this.mode === "multiplayer" ? !showHostSetup || setupLocked : false;
    this.seedInput.disabled = this.mode === "multiplayer" ? !showHostSetup || setupLocked : false;
    const song = this.getSelectedSong();
    for (const button of this.fictionButtons.values()) {
      const fictionId = Number(button.dataset.fictionId ?? "0") as EnvironmentFictionId;
      const enabled = (song?.fictionIds ?? [1, 2, 3]).includes(fictionId);
      button.disabled = (this.mode === "multiplayer" ? !showHostSetup || setupLocked : false) || !enabled;
    }
    this.playButton.classList.toggle("tempo-hidden", this.mode !== "solo");

    const localPlayer = this.roomPlayers.find((player) => player.clientId === this.clientId) ?? null;
    this.readyButton.textContent = localPlayer?.ready ? "Unready" : "Ready";
    this.readyButton.disabled = !inRoom || this.roomPhase !== "lobby";
    this.startRoomButton.disabled = !inRoom || !isHost || this.roomPhase !== "lobby";
    this.leaveRoomButton.disabled = !inRoom;
    this.createRoomButton.disabled = this.mode !== "multiplayer" || inRoom || this.multiplayerView !== "host";
    this.roomNameInput.disabled = this.mode !== "multiplayer" || inRoom || this.multiplayerView !== "host";
    this.roomSearchInput.disabled = !showJoinBrowser;
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
      button.classList.toggle("is-active", enabled && fiction.id === this.selectedFictionId);
    }
  }

  private renderSelection(): void {
    const song = this.getSelectedSong();
    if (!song) return;

    const fiction = FICTION_OPTIONS.find((candidate) => candidate.id === this.selectedFictionId) ?? FICTION_OPTIONS[0];
    const seed = this.seedOverride ?? song.baseSeed;
    const resolved = resolveSongLaunchUrls(this.config, song);

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

    if (this.previewDebounce !== null) {
      window.clearTimeout(this.previewDebounce);
    }
    this.previewDebounce = window.setTimeout(() => {
      this.previewDebounce = null;
      void this.menuPreview.setSelection({
        songId: song.id,
        songUrl: resolved.songUrl,
        fictionId: fiction.id,
        seed,
      }).catch((error) => {
        console.error("Menu preview failed:", error);
        this.previewSubline.textContent = "Preview unavailable";
      });
    }, 120);
  }

  private renderRoomState(): void {
    if (!this.roomCode) {
      this.roomMeta.textContent = this.multiplayerView === "host"
        ? "Host controls are active. Configure the track, name the room, then host it."
        : "Browse waiting rooms below and join one with a single tap.";
      this.rosterPanel.textContent = "";
      this.renderDirectory();
      this.renderMode();
      return;
    }

    const lines = this.roomPlayers.map((player) => {
      const flags = [
        player.clientId === this.roomHostId ? "HOST" : "    ",
        player.ready ? "RDY" : "   ",
        player.isActiveRacer ? "GRID" : "----",
      ];
      return `${flags.join(" ")}  ${player.name.padEnd(8, " ")} ${player.carVariant.toUpperCase()}`;
    });
    this.roomMeta.textContent = `${this.roomName || "Room"} / ${this.roomPhase?.toUpperCase() ?? "LOBBY"}`;
    this.rosterPanel.textContent = lines.join("\n");
    this.renderDirectory();
    this.renderMode();
  }

  private renderDirectory(): void {
    this.directoryPanel.replaceChildren();
    if (!this.roomBrowserReady) {
      const connecting = document.createElement("div");
      connecting.className = "tempo-shell-room-meta";
      connecting.textContent = "Connecting to room list...";
      this.directoryPanel.appendChild(connecting);
      return;
    }

    const query = this.roomSearchInput.value.trim().toLowerCase();
    const waitingRooms = this.roomDirectory
      .filter((room) => room.phase === "lobby")
      .filter((room) =>
        query.length === 0
        || room.roomName.toLowerCase().includes(query)
        || room.hostName.toLowerCase().includes(query)
        || room.songId.toLowerCase().includes(query)
      );
    if (waitingRooms.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tempo-shell-room-meta";
      empty.textContent = query.length === 0
        ? "No open rooms. Host one to seed the list."
        : "No matching rooms.";
      this.directoryPanel.appendChild(empty);
      return;
    }

    for (const room of waitingRooms) {
      const row = document.createElement("div");
      row.className = "tempo-shell-room-card";
      const meta = document.createElement("div");
      meta.className = "tempo-shell-room-card-meta";
      meta.textContent = `${room.roomName}\nHOST ${room.hostName} / ${room.playerCount}/${room.playerCap} / ${room.songId}`;
      const joinButton = document.createElement("button");
      joinButton.type = "button";
      joinButton.className = "tempo-shell-action";
      joinButton.textContent = this.roomCode === room.roomCode ? "Joined" : "Join";
      joinButton.disabled = this.roomCode === room.roomCode;
      joinButton.addEventListener("click", () => {
        void this.joinRoom(room.roomCode);
      });
      row.append(meta, joinButton);
      this.directoryPanel.appendChild(row);
    }
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

    return this.catalog?.songs.find((song) => song.id === this.catalog?.defaultSongId)?.id ?? this.availableSongs[0].id;
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

  private currentSetup(): RaceSetup {
    const song = this.getSelectedSong();
    return {
      songId: song?.id ?? this.catalog?.defaultSongId ?? "",
      fictionId: this.selectedFictionId as SharedFictionId,
      seed: this.seedOverride ?? song?.baseSeed ?? 0,
      playerCap: this.selectedPlayerCap,
    };
  }

  private async setMode(mode: ShellMode): Promise<void> {
    if (mode === this.mode) return;
    if (mode === "solo" && this.roomCode) {
      await this.leaveRoom();
    }
    this.mode = mode;
    if (mode === "multiplayer") {
      this.multiplayerView = "join";
      this.renderRoomState();
      try {
        await this.ensureRoomClient();
      } catch (error) {
        console.error(error);
        this.roomBrowserReady = false;
        this.renderRoomState();
        this.setStatus("Failed to connect to room browser.");
        return;
      }
    }
    this.renderMode();
    this.setStatus(mode === "solo" ? "Solo launch armed." : "Room browser ready.");
  }

  private async ensureRoomClient(): Promise<RoomClient> {
    if (!this.roomClient) {
      this.roomClient = new RoomClient(this.config.websocketUrl);
      this.roomClient.onMessage = (message) => this.handleServerMessage(message);
      this.roomClient.onClose = () => {
        this.roomCode = null;
        this.roomName = "";
        this.roomPhase = null;
        this.roomPlayers = [];
        this.roomDirectory = [];
        this.roomHostId = null;
        this.roomBrowserReady = false;
        this.renderRoomState();
        this.setStatus("Room connection closed.");
      };
    }
    await this.roomClient.ensureConnected();
    return this.roomClient;
  }

  private async createRoom(): Promise<void> {
    this.mode = "multiplayer";
    this.multiplayerView = "host";
    this.renderMode();
    const client = await this.ensureRoomClient();
    client.send({
      type: "room.create",
      roomName: this.roomNameInput.value.trim(),
      setup: this.currentSetup(),
      carVariant: this.selectedCarVariant,
    });
    this.setStatus("Creating room...");
  }

  private async joinRoom(roomCode: string): Promise<void> {
    this.mode = "multiplayer";
    this.multiplayerView = "join";
    this.renderMode();
    const code = roomCode.trim().toUpperCase();
    if (!code) {
      this.setStatus("Choose a room from the table first.");
      return;
    }
    const client = await this.ensureRoomClient();
    client.send({
      type: "room.join",
      roomCode: code,
      carVariant: this.selectedCarVariant,
    });
    this.setStatus("Joining room...");
  }

  private async leaveRoom(): Promise<void> {
    this.roomClient?.send({ type: "room.leave" });
    this.roomCode = null;
    this.roomName = "";
    this.roomPhase = null;
    this.roomPlayers = [];
    this.roomHostId = null;
    this.multiplayerView = "join";
    this.multiplayerResultsActive = false;
    this.pendingLobbyStatus = null;
    await this.stopActiveRace();
    this.uiLayer.style.display = "";
    this.menuPreview.start();
    this.renderRoomState();
    this.setStatus("Returned to shell.");
  }

  private toggleReady(): void {
    const player = this.roomPlayers.find((candidate) => candidate.clientId === this.clientId);
    if (!player) return;
    this.roomClient?.send({ type: "room.setReady", ready: !player.ready });
  }

  private syncRoomSetup(): void {
    if (this.mode !== "multiplayer") return;
    if (!this.roomCode || this.roomHostId !== this.clientId || this.roomPhase !== "lobby") return;
    this.roomClient?.send({
      type: "room.updateSetup",
      setup: this.currentSetup(),
    });
  }

  private async launchSoloRace(reuseLastLaunch = false): Promise<void> {
    if (this.launchInFlight) return;
    const song = this.getSelectedSong();
    if (!song && !reuseLastLaunch) {
      this.setStatus("Pick a valid circuit before launch.");
      return;
    }

    unlockAudioContext();
    this.launchInFlight = true;
    this.playButton.disabled = true;
    this.playButton.textContent = "Launching...";

    try {
      await this.stopActiveRace();
      const launchOptions = reuseLastLaunch && this.lastLaunch
        ? this.lastLaunch
        : this.buildSoloLaunchOptions(song!);
      const runtime = await import("./runtime/app");
      const app = await runtime.App.create(this.raceHost, this.config, launchOptions);
      this.activeApp = app;
      this.lastLaunch = launchOptions;
      this.uiLayer.style.display = "none";
      this.menuPreview.stop();
      app.start();
      this.roomPlayers = [];
      this.roomHostId = null;
      this.roomPhase = null;
    } catch (error) {
      console.error(error);
      this.setStatus("Launch failed.");
      this.uiLayer.style.display = "";
      this.menuPreview.start();
    } finally {
      this.launchInFlight = false;
      this.playButton.disabled = false;
      this.playButton.textContent = "Launch Solo";
    }
  }

  private buildSoloLaunchOptions(song: ShellSongEntry): AppLaunchOptions {
    const fictionId = clampCatalogFictions(song, this.selectedFictionId);
    const seed = this.seedOverride ?? song.baseSeed;
    const resolved = resolveSongLaunchUrls(this.config, song);
    return {
      mode: "solo",
      songUrl: resolved.songUrl,
      musicUrl: resolved.musicUrl,
      seed,
      fictionId,
      debugHud: this.debugHud,
      localPlayerId: "solo",
      carVariant: this.selectedCarVariant,
      onRetry: () => {
        void this.launchSoloRace(true);
      },
      onBackToMenu: () => {
        void this.showMenu();
      },
    };
  }

  private async startMultiplayerRace(): Promise<void> {
    if (this.launchInFlight || !this.roomCode) return;
    const song = this.getSelectedSong();
    if (!song) return;

    unlockAudioContext();
    this.multiplayerResultsActive = false;
    this.pendingLobbyStatus = null;
    this.launchInFlight = true;
    try {
      await this.stopActiveRace();
      const player = this.roomPlayers.find((candidate) => candidate.clientId === this.clientId);
      const resolved = resolveSongLaunchUrls(this.config, song);
      const runtime = await import("./runtime/app");
      const app = await runtime.App.create(this.raceHost, this.config, {
        mode: "multiplayer",
        songUrl: resolved.songUrl,
        musicUrl: resolved.musicUrl,
        seed: this.seedOverride ?? song.baseSeed,
        fictionId: this.selectedFictionId,
        debugHud: this.debugHud,
        localPlayerId: this.clientId,
        carVariant: player?.carVariant ?? this.selectedCarVariant,
        roster: this.roomPlayers,
        onSceneReady: () => {
          this.roomClient?.send({ type: "room.preload", sceneReady: true });
        },
        onAudioReady: () => {
          this.roomClient?.send({ type: "room.preload", audioReady: true });
        },
        onRaceReport: (report) => {
          this.roomClient?.send({ type: "race.report", ...report });
        },
        onFire: () => {
          this.roomClient?.send({ type: "race.fire" });
        },
        onShield: () => {
          this.roomClient?.send({ type: "race.shield" });
        },
        onBackToLobby: () => {
          void this.showLobby();
        },
        onBackToMenu: () => {
          void this.showMenu();
        },
      });
      this.activeApp = app;
      this.uiLayer.style.display = "none";
      this.menuPreview.stop();
      app.start();
      app.setRoomState(this.roomPlayers, this.mapAppPhase(this.roomPhase));
    } catch (error) {
      console.error(error);
      this.setStatus("Failed to stage multiplayer race.");
      this.uiLayer.style.display = "";
      this.menuPreview.start();
    } finally {
      this.launchInFlight = false;
    }
  }

  private async showLobby(statusMessage?: string): Promise<void> {
    await this.stopActiveRace();
    this.uiLayer.style.display = "";
    this.menuPreview.start();
    this.mode = "multiplayer";
    this.multiplayerResultsActive = false;
    this.renderMode();
    this.renderSelection();
    this.renderRoomState();
    this.setStatus(statusMessage ?? (this.roomName ? `${this.roomName} back on shell.` : "Lobby shell ready."));
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

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case "server.ready":
        this.clientId = message.clientId;
        this.renderRoomState();
        return;
      case "room.error":
        if (this.activeApp && this.mode === "multiplayer" && !this.multiplayerResultsActive) {
          this.pendingLobbyStatus = message.message;
        }
        this.setStatus(message.message);
        return;
      case "room.state":
        const previousPhase = this.roomPhase;
        this.roomCode = message.roomCode;
        this.roomName = message.roomName;
        this.roomPhase = message.phase;
        this.roomHostId = message.hostId;
        this.roomPlayers = message.players;
        this.multiplayerView = message.hostId === this.clientId ? "host" : "join";
        this.selectedSongId = message.setup.songId;
        this.selectedFictionId = clampFictionId(message.setup.fictionId);
        this.seedOverride = message.setup.seed;
        this.selectedPlayerCap = message.setup.playerCap;
        this.songSelect.value = this.selectedSongId;
        this.seedInput.value = String(this.seedOverride);
        this.playerCapSelect.value = String(this.selectedPlayerCap);
        this.renderFictionButtons();
        this.renderSelection();
        this.renderRoomState();
        if (
          this.activeApp
          && this.mode === "multiplayer"
          && message.phase === "lobby"
          && previousPhase !== null
          && previousPhase !== "lobby"
          && !this.multiplayerResultsActive
        ) {
          const status = this.pendingLobbyStatus ?? "Returned to lobby.";
          this.pendingLobbyStatus = null;
          void this.showLobby(status);
          return;
        }
        if ((message.phase === "staging" || message.phase === "countdown" || message.phase === "running") && !this.activeApp) {
          void this.startMultiplayerRace();
        }
        if (this.activeApp && this.mode === "multiplayer") {
          this.activeApp.setRoomState(message.players, this.mapAppPhase(message.phase));
        }
        return;
      case "room.directory":
        this.roomBrowserReady = true;
        this.roomDirectory = message.rooms;
        this.renderRoomState();
        return;
      case "race.countdown":
        if (this.mode === "multiplayer") {
          this.activeApp?.beginCountdown(message.startAt);
        }
        return;
      case "race.snapshot":
        if (this.mode === "multiplayer") {
          this.activeApp?.applyRaceSnapshot(message.players, message.pickups, message.checkpointCount);
        }
        return;
      case "race.event":
        if (this.mode === "multiplayer") {
          this.activeApp?.applyRaceEvent(message.event);
        }
        return;
      case "race.results":
        if (this.mode === "multiplayer") {
          this.multiplayerResultsActive = true;
          this.activeApp?.showResults(message.results);
          this.setStatus("Race complete. Winner locked.");
        }
        return;
      case "pong":
        return;
    }
  }

  private mapAppPhase(phase: RoomPhase | null): "staging" | "countdown" | "running" | "finished" | "lobby" {
    switch (phase) {
      case "countdown":
        return "countdown";
      case "running":
        return "running";
      case "staging":
        return "staging";
      case "lobby":
      default:
        return "lobby";
    }
  }

  private syncUrl(): void {
    const params = new URLSearchParams();
    const song = this.getSelectedSong();
    if (song) params.set(song.custom ? "song" : "songId", song.custom ? song.songPath : song.id);
    if (this.seedOverride !== null) params.set("seed", this.seedOverride.toString());
    if (this.selectedFictionId !== 1) params.set("fiction", this.selectedFictionId.toString());
    if (this.debugHud) params.set("debugHud", "1");
    history.replaceState(null, "", params.size > 0 ? `${location.pathname}?${params.toString()}` : location.pathname);
  }

  private setStatus(message: string): void {
    this.statusLine.textContent = message;
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
