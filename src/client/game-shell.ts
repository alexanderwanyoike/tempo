import type {
  RaceResults,
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
import { SongAuditionPlayer, type SongAuditionState } from "./runtime/song-audition";
import {
  buildSongSearchText,
  clampCatalogFictions,
  loadSongCatalog,
  resolveSongAlbumArtUrl,
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
type ShellPanelView = "setup" | "settings";

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

const STEERING_PRESETS = [
  { id: "balanced", label: "Balanced", value: 1.0 },
  { id: "responsive", label: "Responsive", value: 2.05 },
  { id: "sharp", label: "Sharp", value: 2.45 },
] as const;

const STEERING_STORAGE_KEY = "tempo.steering-preset";
const DEFAULT_STEERING_PRESET = "responsive";
const SONG_FILTER_ALL = "All";
const SONG_GENRE_ORDER = [
  "House",
  "Techno",
  "Drum & Bass",
  "Jungle",
  "Breaks",
  "Electro",
  "Big Beat",
  "Industrial",
  "Trance",
  "UKG",
] as const;

export class GameShell {
  private static readonly MULTIPLAYER_RESULTS_DWELL_MS = 4500;
  private static readonly DIRECTORY_PAGE_SIZE = 5;
  private static readonly DIRECTORY_POLL_MS = 20000;

  private readonly raceHost = document.createElement("div");
  private readonly uiLayer = document.createElement("div");
  private readonly shell = document.createElement("div");
  private readonly previewHost = document.createElement("div");
  private readonly statusLine = document.createElement("div");
  private readonly modeDeck = document.createElement("div");
  private readonly panelToggleRow = document.createElement("div");
  private readonly panelToggleButton = document.createElement("button");
  private readonly songSection = document.createElement("div");
  private readonly songBrowserHint = document.createElement("div");
  private readonly songSearchInput = document.createElement("input");
  private readonly songGenreDeck = document.createElement("div");
  private readonly songBrowserList = document.createElement("div");
  private readonly songActionRow = document.createElement("div");
  private readonly songPreviewButton = document.createElement("button");
  private readonly songSelectionMeta = document.createElement("div");
  private readonly seedSection = document.createElement("div");
  private readonly seedInput = document.createElement("input");
  private readonly fictionSection = document.createElement("div");
  private readonly fictionDeck = document.createElement("div");
  private readonly fictionButtons = new Map<EnvironmentFictionId, HTMLButtonElement>();
  private readonly playerCapSelect = document.createElement("select");
  private readonly playerCapSection = document.createElement("div");
  private readonly carSection = document.createElement("div");
  private readonly carSelect = document.createElement("select");
  private readonly steeringSection = document.createElement("div");
  private readonly steeringSelect = document.createElement("select");
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
  private readonly directoryPager = document.createElement("div");
  private readonly rosterPanel = document.createElement("div");
  private readonly roomMeta = document.createElement("div");
  private readonly trackStats = document.createElement("div");
  private readonly songArt = document.createElement("img");
  private readonly songName = document.createElement("div");
  private readonly songInfo = document.createElement("div");
  private readonly previewTitle = document.createElement("div");
  private readonly previewSubline = document.createElement("div");
  private readonly rotatePrompt = document.createElement("div");
  private readonly menuPreview: MenuPreview;
  private readonly auditionPlayer = new SongAuditionPlayer();

  private orientationQuery: MediaQueryList | null = null;
  private catalog: SongCatalog | null = null;
  private availableSongs: ShellSongEntry[] = [];
  private selectedSongId = "";
  private browseSongId = "";
  private songSearchQuery = "";
  private songGenreFilter = SONG_FILTER_ALL;
  private auditionState: SongAuditionState = { songId: null, status: "idle", error: null };
  private selectedFictionId: EnvironmentFictionId = 1;
  private seedOverride: number | null = null;
  private selectedPlayerCap = 4;
  private selectedCarVariant: CarVariant = "vector";
  private selectedSteeringPreset = loadSteeringPresetPreference();
  private panelView: ShellPanelView = "setup";
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
  private latestRaceResults: RaceResults | null = null;
  private resultsReturnTimer: number | null = null;
  private directoryPollTimer: number | null = null;
  private currentDirectoryPage = 1;
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
    this.auditionPlayer.onStateChange = (state) => {
      this.auditionState = state;
      this.renderSongBrowser();
    };
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
    this.browseSongId = this.selectedSongId;

    this.populatePlayerCapSelect();
    this.populateCarSelect();
    this.populateSteeringSelect();
    this.renderFictionButtons();
    this.renderSongBrowser();
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
      .tempo-shell-song-search {
        width:100%;
        border:1px solid rgba(243,245,242,0.12);
        background:rgba(243,245,242,0.03);
        color:#f3f5f2;
        padding:12px 14px;
        font-size:14px;
        font-weight:500;
        border-radius:2px;
        font-family:inherit;
      }
      .tempo-shell-song-search:focus { outline:none; border-color:var(--tempo-accent); }
      .tempo-shell-song-hint {
        font-size:10px;
        line-height:1.55;
        letter-spacing:0.14em;
        text-transform:uppercase;
        color:#8e9aa0;
      }
      .tempo-shell-song-genres {
        display:flex;
        flex-wrap:wrap;
        gap:8px;
      }
      .tempo-shell-song-list {
        display:flex;
        flex-direction:column;
        gap:8px;
        max-height:340px;
        overflow-y:auto;
        padding-right:4px;
      }
      .tempo-shell-song-card {
        width:100%;
        display:grid;
        grid-template-columns:64px minmax(0, 1fr) auto;
        gap:12px;
        align-items:center;
        padding:10px;
        border:1px solid rgba(243,245,242,0.1);
        background:rgba(243,245,242,0.03);
        color:inherit;
        text-align:left;
        cursor:pointer;
      }
      .tempo-shell-song-card:hover {
        border-color:rgba(243,245,242,0.22);
        background:rgba(243,245,242,0.05);
      }
      .tempo-shell-song-card.is-selected {
        border-color:var(--tempo-accent);
        background:rgba(103, 201, 215, 0.08);
      }
      .tempo-shell-song-card.is-focused:not(.is-selected) {
        border-color:rgba(243,245,242,0.22);
      }
      .tempo-shell-song-card.is-locked {
        opacity:0.92;
      }
      .tempo-shell-song-card-art {
        width:64px;
        height:64px;
        border-radius:2px;
        object-fit:cover;
        background:#0a0d12;
        border:1px solid rgba(243,245,242,0.08);
      }
      .tempo-shell-song-card-meta {
        min-width:0;
        display:flex;
        flex-direction:column;
        gap:5px;
      }
      .tempo-shell-song-card-title {
        font-size:15px;
        font-weight:700;
        line-height:1.2;
        color:#f3f5f2;
      }
      .tempo-shell-song-card-sub {
        font-size:10px;
        font-weight:500;
        letter-spacing:0.18em;
        text-transform:uppercase;
        color:#8a9297;
      }
      .tempo-shell-song-card-tags {
        display:flex;
        flex-wrap:wrap;
        gap:6px;
      }
      .tempo-shell-song-card-tag {
        border:1px solid rgba(243,245,242,0.12);
        padding:4px 6px;
        font-size:9px;
        font-weight:700;
        letter-spacing:0.14em;
        text-transform:uppercase;
        color:#d8dfe4;
      }
      .tempo-shell-song-card-status {
        justify-self:end;
        display:flex;
        flex-direction:column;
        align-items:flex-end;
        gap:6px;
      }
      .tempo-shell-song-card-pill {
        padding:4px 6px;
        font-size:9px;
        font-weight:700;
        letter-spacing:0.18em;
        text-transform:uppercase;
        color:#8f9aa1;
        border:1px solid rgba(243,245,242,0.12);
      }
      .tempo-shell-song-card-pill.is-accent {
        color:var(--tempo-accent);
        border-color:rgba(103, 201, 215, 0.45);
      }
      .tempo-shell-song-actions {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
      }
      .tempo-shell-song-selection-meta {
        min-width:0;
        font-size:10px;
        line-height:1.45;
        letter-spacing:0.14em;
        text-transform:uppercase;
        color:#8e9aa0;
      }
      .tempo-shell-song-empty {
        padding:14px;
        border:1px solid rgba(243,245,242,0.1);
        background:rgba(243,245,242,0.03);
        font-size:11px;
        letter-spacing:0.14em;
        text-transform:uppercase;
        color:#8e9aa0;
      }
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
      .tempo-shell-panel-toggle {
        display:flex;
        justify-content:flex-end;
        margin-top:-6px;
      }
      .tempo-shell-panel-button {
        border:0;
        border-bottom:1px solid rgba(243,245,242,0.18);
        background:transparent;
        color:#9fb2ba;
        display:inline-flex;
        align-items:center;
        gap:8px;
        font:600 10px/1 inherit;
        letter-spacing:0.18em;
        text-transform:uppercase;
        padding:6px 0;
        cursor:pointer;
      }
      .tempo-shell-panel-button:hover {
        color:var(--tempo-accent);
        border-color:var(--tempo-accent);
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
        display:grid;
        grid-template-columns:minmax(0, 1fr) auto;
        align-items:center;
        gap:12px;
        padding:10px 12px;
        border:1px solid rgba(243,245,242,0.1);
        background:rgba(243,245,242,0.03);
      }
      .tempo-shell-room-card-meta {
        min-width:0;
        display:flex;
        flex-direction:column;
        gap:4px;
      }
      .tempo-shell-room-card-title {
        font:700 12px/1.35 ui-sans-serif, -apple-system, "Inter", "Helvetica Neue", Arial, sans-serif;
        color:#f3f5f2;
        word-break:break-word;
      }
      .tempo-shell-room-card-summary {
        font:600 11px/1.45 ui-monospace, monospace;
        color:#d9f7ff;
        word-break:break-word;
      }
      .tempo-shell-directory-pager {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        padding-top:8px;
      }
      .tempo-shell-directory-page {
        font-size:10px;
        font-weight:600;
        letter-spacing:0.16em;
        text-transform:uppercase;
        color:#7f8b91;
      }
      .tempo-shell-room-meta { font-size:11px; line-height:1.55; color:#98a5ab; text-transform:uppercase; letter-spacing:0.12em; min-height:16px; }
      .tempo-shell-stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(86px, 1fr)); gap:14px; }
      .tempo-shell-stat { display:flex; flex-direction:column; gap:4px; }
      .tempo-shell-stat-key { font-size:9px; font-weight:600; letter-spacing:0.2em; text-transform:uppercase; color:#6b757a; }
      .tempo-shell-stat-value { font-size:16px; font-weight:600; color:#f3f5f2; }
      .tempo-shell-play { margin-top:auto; padding:18px 22px; font-size:14px; font-weight:700; letter-spacing:0.22em; }
      .tempo-shell-status { font-size:10px; font-weight:500; letter-spacing:0.16em; text-transform:uppercase; color:#6b757a; min-height:14px; }
      .tempo-shell-preview-box {
        position:relative;
        width:100%;
        height:min(72vh, 720px);
        min-height:480px;
        border:1px solid rgba(243,245,242,0.08);
        background:
          radial-gradient(circle at 18% 14%, rgba(96, 224, 255, 0.08), transparent 26%),
          radial-gradient(circle at 84% 82%, rgba(96, 224, 255, 0.05), transparent 32%),
          linear-gradient(180deg, rgba(16, 20, 26, 0.96), rgba(7, 10, 15, 0.98)),
          #080b10;
        border-radius:2px;
        overflow:hidden;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
      }
      .tempo-shell-preview-canvas { position:absolute; inset:0; width:100%; height:100%; z-index:1; }
      .tempo-shell-preview-fx,
      .tempo-shell-preview-head { position:absolute; inset:0; pointer-events:none; }
      .tempo-shell-preview-fx { z-index:2; }
      .tempo-shell-preview-head {
        top:18px;
        left:20px;
        right:20px;
        bottom:auto;
        display:flex;
        justify-content:space-between;
        align-items:flex-start;
        gap:16px;
        z-index:3;
      }
      .tempo-shell-preview-grid {
        position:absolute;
        inset:0;
        z-index:0;
        opacity:0.48;
        background:
          linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px),
          linear-gradient(0deg, rgba(255,255,255,0.026) 1px, transparent 1px);
        background-size:72px 72px, 72px 72px;
        mask-image:linear-gradient(180deg, rgba(0,0,0,0.85), rgba(0,0,0,0.14));
      }
      .tempo-shell-preview-scan {
        position:absolute;
        inset:-20% -8%;
        z-index:1;
        background:linear-gradient(110deg, transparent 0%, rgba(255,255,255,0.035) 40%, rgba(255,255,255,0.15) 48%, rgba(255,255,255,0.03) 54%, transparent 72%);
        mix-blend-mode:screen;
        opacity:0.5;
        animation:tempo-preview-scan 9.5s linear infinite;
      }
      .tempo-shell-preview-vignette {
        position:absolute;
        inset:0;
        z-index:2;
        background:
          linear-gradient(180deg, rgba(4, 8, 12, 0.16), transparent 18%, transparent 82%, rgba(4, 8, 12, 0.24)),
          linear-gradient(90deg, rgba(4, 8, 12, 0.22), transparent 14%, transparent 86%, rgba(4, 8, 12, 0.22));
      }
      .tempo-shell-preview-frame {
        position:absolute;
        inset:14px;
        z-index:3;
        border:1px solid rgba(255,255,255,0.045);
      }
      .tempo-shell-preview-frame::before,
      .tempo-shell-preview-frame::after {
        content:"";
        position:absolute;
        left:20px;
        right:20px;
        height:1px;
        background:linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent);
      }
      .tempo-shell-preview-frame::before { top:54px; }
      .tempo-shell-preview-frame::after { bottom:24px; }
      .tempo-shell-preview-corner {
        position:absolute;
        z-index:4;
        width:26px;
        height:26px;
        border-color:rgba(116, 239, 255, 0.68);
        border-style:solid;
        border-width:0;
        filter:drop-shadow(0 0 10px rgba(116,239,255,0.2));
      }
      .tempo-shell-preview-corner.tl { top:14px; left:14px; border-top-width:1px; border-left-width:1px; }
      .tempo-shell-preview-corner.tr { top:14px; right:14px; border-top-width:1px; border-right-width:1px; }
      .tempo-shell-preview-corner.bl { bottom:14px; left:14px; border-bottom-width:1px; border-left-width:1px; }
      .tempo-shell-preview-corner.br { bottom:14px; right:14px; border-bottom-width:1px; border-right-width:1px; }
      .tempo-shell-preview-caption {
        position:absolute;
        z-index:4;
        left:24px;
        bottom:20px;
        display:flex;
        flex-wrap:wrap;
        gap:12px;
        align-items:center;
        font-size:9px;
        font-weight:600;
        letter-spacing:0.22em;
        text-transform:uppercase;
        color:rgba(152, 165, 171, 0.92);
      }
      .tempo-shell-preview-caption::before {
        content:"";
        display:block;
        width:48px;
        height:1px;
        background:linear-gradient(90deg, rgba(116,239,255,0.85), transparent);
      }
      .tempo-shell-song-name {
        font-size:clamp(22px, 2.2vw, 30px);
        font-weight:700;
        letter-spacing:-0.015em;
        line-height:1.05;
        text-shadow:0 0 18px rgba(255,255,255,0.08);
      }
      .tempo-shell-preview-info {
        display:flex;
        align-items:flex-start;
        gap:14px;
        min-width:0;
      }
      .tempo-shell-song-art {
        width:76px;
        height:76px;
        object-fit:cover;
        border-radius:2px;
        border:1px solid rgba(243,245,242,0.1);
        background:#0a0d12;
        box-shadow:0 0 24px rgba(0,0,0,0.25);
      }
      .tempo-shell-song-copy {
        min-width:0;
      }
      .tempo-shell-song-info { margin-top:7px; font-size:10px; font-weight:500; letter-spacing:0.2em; text-transform:uppercase; color:#8a9297; }
      .tempo-shell-preview-meta {
        text-align:right;
        font-size:9px;
        font-weight:700;
        letter-spacing:0.22em;
        text-transform:uppercase;
        color:var(--tempo-accent);
        text-shadow:0 0 14px rgba(116, 239, 255, 0.22);
      }
      @keyframes tempo-preview-scan {
        0% { transform:translate3d(-18%, -10%, 0); }
        100% { transform:translate3d(18%, 10%, 0); }
      }
      .tempo-hidden { display:none !important; }
      @media (max-width: 980px) {
        .tempo-shell-ui { overflow-y:auto; overscroll-behavior:contain; }
        .tempo-shell { padding:24px 22px; }
        .tempo-shell-main { grid-template-columns:1fr; gap:24px; }
        .tempo-shell-preview-box { min-height:340px; }
        .tempo-shell-preview-grid { background-size:52px 52px, 52px 52px; }
        .tempo-shell-preview-caption { left:20px; bottom:16px; letter-spacing:0.18em; }
        .tempo-shell-room-card {
          grid-template-columns:1fr;
          padding:12px;
          gap:10px;
        }
        .tempo-shell-room-card-meta {
          font-size:12px;
          line-height:1.55;
        }
        .tempo-shell-room-card .tempo-shell-action,
        .tempo-shell-room-card .tempo-shell-chip {
          width:100%;
          min-height:44px;
        }
        .tempo-shell-directory { max-height:42vh; overflow-y:auto; }
        .tempo-shell-song-list { max-height:44vh; }
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
        .tempo-shell-preview-grid,
        .tempo-shell-preview-scan { opacity:0.32; }
        .tempo-shell-preview-caption { display:none; }
        .tempo-shell-directory { max-height:38vh; }
        .tempo-shell-room-block { padding:10px; }
        .tempo-shell-song-search,
        .tempo-shell-select,
        .tempo-shell-input,
        .tempo-shell-code { padding:10px 12px; font-size:14px; }
        .tempo-shell-song-card {
          grid-template-columns:56px minmax(0, 1fr);
        }
        .tempo-shell-song-card-status {
          grid-column:2;
          align-items:flex-start;
          justify-self:start;
          flex-direction:row;
          flex-wrap:wrap;
        }
        .tempo-shell-preview-info { gap:10px; }
        .tempo-shell-song-art { width:58px; height:58px; }
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

    this.panelToggleRow.className = "tempo-shell-panel-toggle";
    this.panelToggleButton.type = "button";
    this.panelToggleButton.className = "tempo-shell-panel-button";
    this.panelToggleButton.addEventListener("click", () => {
      this.panelView = this.panelView === "setup" ? "settings" : "setup";
      this.renderMode();
    });
    this.panelToggleRow.appendChild(this.panelToggleButton);

    this.songSection.className = "tempo-shell-section";
    const songLabel = document.createElement("div");
    songLabel.className = "tempo-shell-label";
    songLabel.textContent = "Music Browser";
    this.songBrowserHint.className = "tempo-shell-song-hint";
    this.songSearchInput.className = "tempo-shell-song-search";
    this.songSearchInput.type = "search";
    this.songSearchInput.placeholder = "Search title or artist";
    this.songSearchInput.addEventListener("input", () => {
      this.songSearchQuery = this.songSearchInput.value.trim().toLowerCase();
      this.renderSongBrowser();
    });
    this.songGenreDeck.className = "tempo-shell-song-genres";
    this.songBrowserList.className = "tempo-shell-song-list";
    this.songActionRow.className = "tempo-shell-song-actions";
    this.songPreviewButton.type = "button";
    this.songPreviewButton.className = "tempo-shell-action";
    this.songPreviewButton.addEventListener("click", () => {
      void this.toggleSongAudition();
    });
    this.songSelectionMeta.className = "tempo-shell-song-selection-meta";
    this.songActionRow.append(this.songPreviewButton, this.songSelectionMeta);
    this.songSection.append(
      songLabel,
      this.songBrowserHint,
      this.songSearchInput,
      this.songGenreDeck,
      this.songBrowserList,
      this.songActionRow,
    );

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

    this.steeringSection.className = "tempo-shell-section";
    const steeringLabel = document.createElement("div");
    steeringLabel.className = "tempo-shell-label";
    steeringLabel.textContent = "Steering";
    this.steeringSelect.className = "tempo-shell-select";
    this.steeringSelect.addEventListener("change", () => {
      this.selectedSteeringPreset = normalizeSteeringPreset(this.steeringSelect.value);
      savePreference(STEERING_STORAGE_KEY, this.selectedSteeringPreset);
    });
    this.steeringSection.append(steeringLabel, this.steeringSelect);

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
      this.currentDirectoryPage = 1;
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
    this.directoryPager.className = "tempo-shell-directory-pager";
    this.rosterPanel.className = "tempo-shell-roster";
    this.multiplayerPanel.append(
      this.roomMeta,
      this.roomActionRow,
      this.rosterPanel,
      this.roomViewDeck,
      this.hostRoomSection,
      this.browseRoomsSection,
      this.directoryPanel,
      this.directoryPager,
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
      this.panelToggleRow,
      this.carSection,
      this.steeringSection,
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
    const previewFx = document.createElement("div");
    previewFx.className = "tempo-shell-preview-fx";
    const previewGrid = document.createElement("div");
    previewGrid.className = "tempo-shell-preview-grid";
    const previewSweep = document.createElement("div");
    previewSweep.className = "tempo-shell-preview-scan";
    const previewVignette = document.createElement("div");
    previewVignette.className = "tempo-shell-preview-vignette";
    const previewFrame = document.createElement("div");
    previewFrame.className = "tempo-shell-preview-frame";
    for (const corner of ["tl", "tr", "bl", "br"]) {
      const element = document.createElement("div");
      element.className = `tempo-shell-preview-corner ${corner}`;
      previewFx.appendChild(element);
    }
    const previewCaption = document.createElement("div");
    previewCaption.className = "tempo-shell-preview-caption";
    previewCaption.textContent = "Circuit schematic projection";
    const previewHead = document.createElement("div");
    previewHead.className = "tempo-shell-preview-head";
    const previewInfo = document.createElement("div");
    previewInfo.className = "tempo-shell-preview-info";
    this.songArt.className = "tempo-shell-song-art";
    this.songArt.alt = "";
    const previewCopy = document.createElement("div");
    previewCopy.className = "tempo-shell-song-copy";
    this.songName.className = "tempo-shell-song-name";
    this.songInfo.className = "tempo-shell-song-info";
    previewCopy.append(this.songName, this.songInfo);
    previewInfo.append(this.songArt, previewCopy);
    const previewMeta = document.createElement("div");
    previewMeta.className = "tempo-shell-preview-meta";
    previewMeta.append(this.previewTitle, this.previewSubline);
    previewHead.append(previewInfo, previewMeta);
    previewFx.append(previewGrid, previewSweep, previewVignette, previewFrame, previewCaption);
    previewBox.append(this.previewHost, previewFx, previewHead);
    right.append(previewBox);

    main.append(left, right);
    this.shell.append(topline, main);
  }

  private renderSongBrowser(): void {
    const selectedSong = this.getSelectedSong();
    const focusedSong = this.getFocusedSong();
    const canCommit = this.canEditSongSelection();

    this.songBrowserHint.textContent = this.describeSongBrowserMode();
    this.songGenreDeck.replaceChildren();
    for (const genre of [SONG_FILTER_ALL, ...this.listAvailableGenres()]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tempo-shell-chip";
      button.textContent = genre;
      button.classList.toggle("is-active", this.songGenreFilter === genre);
      button.addEventListener("click", () => {
        this.songGenreFilter = genre;
        this.renderSongBrowser();
      });
      this.songGenreDeck.appendChild(button);
    }

    this.songBrowserList.replaceChildren();
    const visibleSongs = this.listVisibleSongs();
    if (visibleSongs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tempo-shell-song-empty";
      empty.textContent = "No tracks match this search.";
      this.songBrowserList.appendChild(empty);
    }

    for (const song of visibleSongs) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tempo-shell-song-card";
      row.classList.toggle("is-selected", song.id === selectedSong?.id);
      row.classList.toggle("is-focused", song.id === focusedSong?.id);
      row.classList.toggle("is-locked", !canCommit && song.id !== selectedSong?.id);
      row.addEventListener("click", () => {
        this.handleSongActivation(song.id);
      });

      const art = document.createElement("img");
      art.className = "tempo-shell-song-card-art";
      art.alt = "";
      art.src = this.getSongAlbumArtUrl(song);

      const meta = document.createElement("div");
      meta.className = "tempo-shell-song-card-meta";
      const title = document.createElement("div");
      title.className = "tempo-shell-song-card-title";
      title.textContent = song.title;
      const sub = document.createElement("div");
      sub.className = "tempo-shell-song-card-sub";
      sub.textContent = `${song.artist} / ${song.genre}`;
      const tags = document.createElement("div");
      tags.className = "tempo-shell-song-card-tags";
      tags.append(
        createSongTag(song.genre),
        createSongTag(`${song.bpm.toFixed(0)} BPM`),
        createSongTag(formatDuration(song.duration)),
      );
      meta.append(title, sub, tags);

      const status = document.createElement("div");
      status.className = "tempo-shell-song-card-status";
      if (song.id === selectedSong?.id) {
        status.appendChild(createSongPill(this.mode === "multiplayer" ? "Room" : "Selected", true));
      }
      if (song.id === focusedSong?.id && song.id !== selectedSong?.id) {
        status.appendChild(createSongPill("Browsing"));
      }
      if (!canCommit && song.id !== selectedSong?.id) {
        status.appendChild(createSongPill("Local"));
      }
      if (this.songShouldBePinned(song)) {
        status.appendChild(createSongPill("Pinned"));
      }

      row.append(art, meta, status);
      this.songBrowserList.appendChild(row);
    }

    this.songPreviewButton.disabled = !focusedSong || this.launchInFlight;
    if (focusedSong && this.auditionState.songId === focusedSong.id) {
      this.songPreviewButton.textContent = this.auditionState.status === "playing"
        ? "Stop Preview"
        : this.auditionState.status === "loading"
          ? "Loading Preview"
          : "Retry Preview";
    } else {
      this.songPreviewButton.textContent = "Audition";
    }

    this.songSelectionMeta.textContent = this.describeSongSelectionMeta(selectedSong, focusedSong, canCommit);
  }

  private listAvailableGenres(): string[] {
    const genres = new Set(this.availableSongs.map((song) => song.genre));
    return SONG_GENRE_ORDER.filter((genre) => genres.has(genre));
  }

  private listVisibleSongs(): ShellSongEntry[] {
    const filtered = this.availableSongs.filter((song) => {
      if (this.songGenreFilter !== SONG_FILTER_ALL && song.genre !== this.songGenreFilter) return false;
      if (!this.songSearchQuery) return true;
      return buildSongSearchText(song).includes(this.songSearchQuery);
    }).sort(compareSongsForBrowser);

    const pinned = [this.getSelectedSong(), this.getFocusedSong()].filter((song): song is ShellSongEntry => Boolean(song));
    const visible = new Map<string, ShellSongEntry>();
    for (const song of pinned) {
      if (!filtered.includes(song)) {
        visible.set(song.id, song);
      }
    }
    for (const song of filtered) {
      visible.set(song.id, song);
    }
    return [...visible.values()];
  }

  private handleSongActivation(songId: string): void {
    const song = this.findSongById(songId);
    if (!song) return;

    this.browseSongId = song.id;
    if (this.canEditSongSelection()) {
      this.selectedSongId = song.id;
      this.selectedFictionId = clampCatalogFictions(song, this.selectedFictionId);
      this.seedOverride = null;
      this.seedInput.value = "";
      this.renderFictionButtons();
      this.syncUrl();
      this.syncRoomSetup();
    }

    this.renderSelection();
    this.renderSongBrowser();
  }

  private describeSongBrowserMode(): string {
    if (this.mode === "solo") {
      return "Browse by genre, search by title or artist, then audition the selected track.";
    }
    if (!this.roomCode && this.multiplayerView === "host") {
      return "Host setup uses the same browser as solo. Lock the room after choosing a track.";
    }
    if (!this.roomCode) {
      return "Join rooms below or browse the catalog locally before hosting.";
    }
    if (this.roomHostId === this.clientId) {
      return "Host control is live. Track changes update every client in the lobby.";
    }
    return "Host controls the selected track. You can still browse locally and audition without changing room state.";
  }

  private describeSongSelectionMeta(
    selectedSong: ShellSongEntry | null,
    focusedSong: ShellSongEntry | null,
    canCommit: boolean,
  ): string {
    if (!selectedSong) return "No track selected.";
    const focusedLine = focusedSong && focusedSong.id !== selectedSong.id
      ? `Browsing ${focusedSong.title} locally.`
      : `Locked on ${selectedSong.title}.`;
    if (this.auditionState.error && focusedSong && this.auditionState.songId === focusedSong.id) {
      return `${focusedLine} ${this.auditionState.error}`;
    }
    if (canCommit) {
      return `${focusedLine} ${selectedSong.genre} / ${selectedSong.bpm.toFixed(0)} BPM.`;
    }
    return `Room track: ${selectedSong.title}. ${focusedLine}`;
  }

  private canEditSongSelection(): boolean {
    if (this.mode === "solo") return true;
    if (!this.roomCode) return this.multiplayerView === "host";
    return this.roomHostId === this.clientId && this.roomPhase === "lobby";
  }

  private getFocusedSong(): ShellSongEntry | null {
    return this.findSongById(this.browseSongId) ?? this.getSelectedSong();
  }

  private findSongById(songId: string | null): ShellSongEntry | null {
    if (!songId) return null;
    return this.availableSongs.find((song) => song.id === songId) ?? null;
  }

  private songShouldBePinned(song: ShellSongEntry): boolean {
    const matchesFilter = (this.songGenreFilter === SONG_FILTER_ALL || song.genre === this.songGenreFilter)
      && (!this.songSearchQuery || buildSongSearchText(song).includes(this.songSearchQuery));
    if (matchesFilter) return false;
    return song.id === this.selectedSongId || song.id === this.browseSongId;
  }

  private getSongAlbumArtUrl(song: ShellSongEntry): string {
    return resolveSongAlbumArtUrl(this.config, song) ?? buildFallbackAlbumArt(song);
  }

  private async toggleSongAudition(): Promise<void> {
    const song = this.getFocusedSong();
    if (!song) return;
    unlockAudioContext();
    const { musicUrl } = resolveSongLaunchUrls(this.config, song);
    await this.auditionPlayer.toggle(song.id, musicUrl, song.previewStartTime);
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

  private populateSteeringSelect(): void {
    this.steeringSelect.replaceChildren();
    for (const preset of STEERING_PRESETS) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      this.steeringSelect.appendChild(option);
    }
    this.steeringSelect.value = this.selectedSteeringPreset;
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
    const showSongBrowser = this.mode === "solo" || this.multiplayerView === "host" || inRoom;
    const showSetupPanel = this.panelView === "setup";
    const showSettingsPanel = this.panelView === "settings";
    this.panelToggleButton.textContent = showSettingsPanel ? "← Back" : "⚙ Settings";

    this.multiplayerPanel.classList.toggle("tempo-hidden", this.mode !== "multiplayer");
    this.roomSection.classList.toggle("tempo-hidden", this.mode !== "multiplayer");
    this.songSection.classList.toggle("tempo-hidden", !showSetupPanel || !showSongBrowser);
    this.fictionSection.classList.toggle("tempo-hidden", !showSetupPanel || !showHostSetup);
    this.seedSection.classList.toggle("tempo-hidden", !showSetupPanel || !showHostSetup);
    this.playerCapSection.classList.toggle("tempo-hidden", !showSetupPanel || !showHostSetup || this.mode !== "multiplayer");
    this.carSection.classList.toggle("tempo-hidden", !showSetupPanel);
    this.roomSection.classList.toggle("tempo-hidden", this.mode !== "multiplayer" || !showSetupPanel);
    this.steeringSection.classList.toggle("tempo-hidden", !showSettingsPanel);
    this.trackStats.parentElement?.classList.toggle("tempo-hidden", !showSetupPanel);
    this.roomViewDeck.classList.toggle("tempo-hidden", this.mode !== "multiplayer" || inRoom);
    this.hostRoomSection.classList.toggle("tempo-hidden", !showHostSetup || inRoom || this.mode !== "multiplayer");
    this.browseRoomsSection.classList.toggle("tempo-hidden", !showJoinBrowser);
    this.directoryPanel.classList.toggle("tempo-hidden", !showJoinBrowser);
    this.directoryPager.classList.toggle("tempo-hidden", !showJoinBrowser);
    this.roomActionRow.classList.toggle("tempo-hidden", this.mode !== "multiplayer" || !inRoom);
    this.rosterPanel.classList.toggle("tempo-hidden", this.mode !== "multiplayer" || !inRoom);
    this.playerCapSelect.disabled = this.mode !== "multiplayer" || !showHostSetup || setupLocked;
    this.songSearchInput.disabled = !showSetupPanel || !showSongBrowser;
    this.seedInput.disabled = this.mode === "multiplayer" ? !showHostSetup || setupLocked : false;
    const song = this.getSelectedSong();
    for (const button of this.fictionButtons.values()) {
      const fictionId = Number(button.dataset.fictionId ?? "0") as EnvironmentFictionId;
      const enabled = (song?.fictionIds ?? [1, 2, 3]).includes(fictionId);
      button.disabled = (this.mode === "multiplayer" ? !showHostSetup || setupLocked : false) || !enabled;
    }
    this.playButton.classList.toggle("tempo-hidden", this.mode !== "solo");
    if (this.mode === "solo") {
      this.playButton.classList.toggle("tempo-hidden", !showSetupPanel);
    }

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
    const song = this.getFocusedSong();
    if (!song) return;

    const fiction = FICTION_OPTIONS.find((candidate) => candidate.id === this.selectedFictionId) ?? FICTION_OPTIONS[0];
    const seed = !this.canEditSongSelection() && song.id !== this.selectedSongId
      ? song.baseSeed
      : (this.seedOverride ?? song.baseSeed);
    const resolved = resolveSongLaunchUrls(this.config, song);
    const albumArtUrl = this.getSongAlbumArtUrl(song);

    this.uiLayer.dataset.fiction = String(fiction.id);
    this.songName.textContent = song.title;
    this.songInfo.textContent = `${song.artist} / ${song.genre} / ${song.bpm.toFixed(0)} BPM / ${formatDuration(song.duration)}`;
    this.songArt.src = albumArtUrl;
    this.songArt.alt = `${song.title} cover art`;
    this.songArt.style.display = "";
    this.previewTitle.textContent = fiction.label;
    this.previewSubline.textContent = fiction.blurb;
    this.trackStats.replaceChildren(
      createStat("Genre", song.genre),
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
      this.renderSongBrowser();
      this.renderMode();
      return;
    }

    const lines: string[] = [];
    if (this.latestRaceResults && this.latestRaceResults.roomCode === this.roomCode) {
      const winner = this.latestRaceResults.entries[0];
      lines.push("Latest Results");
      lines.push(
        winner
          ? `${winner.name} won the race.`
          : "Race complete.",
      );
      lines.push("");
      for (const [index, entry] of this.latestRaceResults.entries.entries()) {
        const role = index === 0 ? "WINNER" : "LOSER ";
        const time = entry.finishTimeMs === null ? "DNF" : formatDuration(entry.finishTimeMs / 1000);
        lines.push(`${role} ${entry.placement}. ${entry.name.padEnd(8, " ")} ${time}`);
      }
      lines.push("");
    }

    lines.push(...this.roomPlayers.map((player) => {
      const flags = [
        player.clientId === this.roomHostId ? "HOST" : "    ",
        player.ready ? "RDY" : "   ",
        player.isActiveRacer ? "GRID" : "----",
      ];
      return `${flags.join(" ")}  ${player.name.padEnd(8, " ")} ${player.carVariant.toUpperCase()}`;
    }));
    const selectedSong = this.getSelectedSong();
    const songLabel = selectedSong ? `${selectedSong.title} / ${selectedSong.genre}` : this.selectedSongId;
    this.roomMeta.textContent = `${this.roomName || "Room"} / ${this.roomPhase?.toUpperCase() ?? "LOBBY"} / ${songLabel}`;
    this.rosterPanel.textContent = lines.join("\n");
    this.renderDirectory();
    this.renderSongBrowser();
    this.renderMode();
  }

  private renderDirectory(): void {
    this.directoryPanel.replaceChildren();
    this.directoryPager.replaceChildren();
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
      .filter((room) => {
        if (query.length === 0) return true;
        const roomSong = this.findSongById(room.songId);
        const songSearch = roomSong ? buildSongSearchText(roomSong) : room.songId.toLowerCase();
        return room.roomName.toLowerCase().includes(query)
          || room.hostName.toLowerCase().includes(query)
          || room.songId.toLowerCase().includes(query)
          || songSearch.includes(query);
      });
    const pageCount = Math.max(1, Math.ceil(waitingRooms.length / GameShell.DIRECTORY_PAGE_SIZE));
    this.currentDirectoryPage = Math.min(this.currentDirectoryPage, pageCount);
    const pageStart = (this.currentDirectoryPage - 1) * GameShell.DIRECTORY_PAGE_SIZE;
    const visibleRooms = waitingRooms.slice(pageStart, pageStart + GameShell.DIRECTORY_PAGE_SIZE);
    if (waitingRooms.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tempo-shell-room-meta";
      empty.textContent = query.length === 0
        ? "No open rooms. Host one to seed the list."
        : "No matching rooms.";
      this.directoryPanel.appendChild(empty);
      return;
    }

    for (const room of visibleRooms) {
      const row = document.createElement("div");
      row.className = "tempo-shell-room-card";
      const meta = document.createElement("div");
      meta.className = "tempo-shell-room-card-meta";
      const title = document.createElement("div");
      title.className = "tempo-shell-room-card-title";
      title.textContent = room.roomName;
      const summary = document.createElement("div");
      summary.className = "tempo-shell-room-card-summary";
      const roomSong = this.findSongById(room.songId);
      const roomSongLabel = roomSong ? `${roomSong.title} / ${roomSong.genre}` : room.songId;
      summary.textContent = `Host ${room.hostName} / ${room.playerCount}/${room.playerCap} / ${roomSongLabel}`;
      meta.append(title, summary);
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

    const prevButton = document.createElement("button");
    prevButton.type = "button";
    prevButton.className = "tempo-shell-action";
    prevButton.textContent = "Prev";
    prevButton.disabled = this.currentDirectoryPage <= 1;
    prevButton.addEventListener("click", () => {
      if (this.currentDirectoryPage <= 1) return;
      this.currentDirectoryPage -= 1;
      this.renderDirectory();
    });

    const pageLabel = document.createElement("div");
    pageLabel.className = "tempo-shell-directory-page";
    pageLabel.textContent = `${waitingRooms.length} rooms / page ${this.currentDirectoryPage} of ${pageCount}`;

    const nextButton = document.createElement("button");
    nextButton.type = "button";
    nextButton.className = "tempo-shell-action";
    nextButton.textContent = "Next";
    nextButton.disabled = this.currentDirectoryPage >= pageCount;
    nextButton.addEventListener("click", () => {
      if (this.currentDirectoryPage >= pageCount) return;
      this.currentDirectoryPage += 1;
      this.renderDirectory();
    });

    this.directoryPager.append(prevButton, pageLabel, nextButton);
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
      genre: "Breaks",
      bpm: 120,
      duration: 180,
      baseSeed: 0,
      songPath,
      musicPath: musicPath ?? songPath.replace(/\.json$/i, ".mp3").replace("/songs/", "/music/"),
      albumArtPath: "",
      previewStartTime: 0,
      searchTerms: ["linked", "custom"],
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
    this.stopSongAudition();
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
    if (this.mode === "solo" || this.multiplayerView === "host") {
      this.browseSongId = this.selectedSongId;
    }
    this.renderSongBrowser();
    this.renderSelection();
    this.renderMode();
    this.setStatus(mode === "solo" ? "Solo launch armed." : "Room browser ready.");
  }

  private async ensureRoomClient(): Promise<RoomClient> {
    if (!this.roomClient) {
      this.roomClient = new RoomClient(this.config.websocketUrl);
      this.roomClient.onMessage = (message) => this.handleServerMessage(message);
      this.roomClient.onClose = () => {
        this.stopSongAudition();
        this.roomCode = null;
        this.roomName = "";
        this.roomPhase = null;
        this.roomPlayers = [];
        this.roomDirectory = [];
        this.roomHostId = null;
        this.roomBrowserReady = false;
        this.currentDirectoryPage = 1;
        this.browseSongId = this.selectedSongId;
        this.renderRoomState();
        this.setStatus("Room connection closed.");
      };
    }
    await this.roomClient.ensureConnected();
    this.startDirectoryPolling();
    this.requestDirectoryRefresh();
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
    this.clearResultsReturnTimer();
    this.stopSongAudition();
    this.roomClient?.send({ type: "room.leave" });
    this.roomCode = null;
    this.roomName = "";
    this.roomPhase = null;
    this.roomPlayers = [];
    this.roomHostId = null;
    this.multiplayerView = "join";
    this.multiplayerResultsActive = false;
    this.pendingLobbyStatus = null;
    this.currentDirectoryPage = 1;
    this.browseSongId = this.selectedSongId;
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
    this.clearResultsReturnTimer();
    this.stopSongAudition();
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
      steeringSensitivity: steeringPresetValue(this.selectedSteeringPreset),
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
    this.clearResultsReturnTimer();
    this.stopSongAudition();
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
        steeringSensitivity: steeringPresetValue(this.selectedSteeringPreset),
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
    this.clearResultsReturnTimer();
    this.stopSongAudition();
    await this.stopActiveRace();
    this.uiLayer.style.display = "";
    this.menuPreview.start();
    this.mode = "multiplayer";
    this.multiplayerResultsActive = false;
    this.renderSongBrowser();
    this.renderMode();
    this.renderSelection();
    this.renderRoomState();
    this.setStatus(statusMessage ?? (this.roomName ? `${this.roomName} back on shell.` : "Lobby shell ready."));
  }

  private async showMenu(): Promise<void> {
    this.clearResultsReturnTimer();
    this.stopSongAudition();
    await this.stopActiveRace();
    this.uiLayer.style.display = "";
    this.menuPreview.start();
    this.browseSongId = this.selectedSongId;
    this.renderSongBrowser();
    this.renderSelection();
    this.setStatus("Circuit select ready.");
  }

  private stopSongAudition(): void {
    this.auditionPlayer.stop();
  }

  private async stopActiveRace(): Promise<void> {
    if (!this.activeApp) return;
    this.activeApp.destroy();
    this.activeApp = null;
    this.raceHost.replaceChildren();
  }

  private clearResultsReturnTimer(): void {
    if (this.resultsReturnTimer === null) return;
    window.clearTimeout(this.resultsReturnTimer);
    this.resultsReturnTimer = null;
  }

  private startDirectoryPolling(): void {
    if (this.directoryPollTimer !== null) return;
    this.directoryPollTimer = window.setInterval(() => {
      this.requestDirectoryRefresh();
    }, GameShell.DIRECTORY_POLL_MS);
  }

  private requestDirectoryRefresh(): void {
    this.roomClient?.send({ type: "room.directory.request" });
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
        const previousSelectedSongId = this.selectedSongId;
        const previousRoomCode = this.roomCode;
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
        const keepDetachedBrowse =
          previousRoomCode === message.roomCode
          && message.hostId !== this.clientId
          && this.browseSongId.length > 0
          && this.browseSongId !== previousSelectedSongId;
        if (!keepDetachedBrowse || !this.findSongById(this.browseSongId)) {
          this.browseSongId = this.selectedSongId;
        }
        this.seedInput.value = String(this.seedOverride);
        this.playerCapSelect.value = String(this.selectedPlayerCap);
        this.renderFictionButtons();
        this.renderSongBrowser();
        this.renderSelection();
        this.renderRoomState();
        if (message.phase === "staging" || message.phase === "countdown" || message.phase === "running") {
          this.latestRaceResults = null;
        }
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
        if (this.activeApp && this.mode === "multiplayer" && !this.multiplayerResultsActive) {
          this.activeApp.setRoomState(message.players, this.mapAppPhase(message.phase));
        }
        return;
      case "room.directory":
        this.roomBrowserReady = true;
        this.roomDirectory = message.rooms;
        this.currentDirectoryPage = Math.min(
          this.currentDirectoryPage,
          Math.max(1, Math.ceil(
            this.roomDirectory.filter((room) => room.phase === "lobby").length / GameShell.DIRECTORY_PAGE_SIZE,
          )),
        );
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
          this.latestRaceResults = message.results;
          this.setStatus("Race complete. Winner locked.");
          this.activeApp?.showResults(message.results);
          this.clearResultsReturnTimer();
          this.resultsReturnTimer = window.setTimeout(() => {
            this.resultsReturnTimer = null;
            void this.showLobby("Race complete. Winner locked.");
          }, GameShell.MULTIPLAYER_RESULTS_DWELL_MS);
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

function createSongTag(value: string): HTMLDivElement {
  const tag = document.createElement("div");
  tag.className = "tempo-shell-song-card-tag";
  tag.textContent = value;
  return tag;
}

function createSongPill(value: string, accent = false): HTMLDivElement {
  const pill = document.createElement("div");
  pill.className = "tempo-shell-song-card-pill";
  pill.classList.toggle("is-accent", accent);
  pill.textContent = value;
  return pill;
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

function savePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures; defaults still work.
  }
}

function loadSteeringPresetPreference(): string {
  try {
    return normalizeSteeringPreset(window.localStorage.getItem(STEERING_STORAGE_KEY));
  } catch {
    return DEFAULT_STEERING_PRESET;
  }
}

function normalizeSteeringPreset(value: string | null): string {
  return STEERING_PRESETS.some((preset) => preset.id === value) ? (value as string) : DEFAULT_STEERING_PRESET;
}

function steeringPresetValue(presetId: string): number {
  return STEERING_PRESETS.find((preset) => preset.id === presetId)?.value ?? STEERING_PRESETS[1].value;
}

function compareSongsForBrowser(a: SongCatalogEntry, b: SongCatalogEntry): number {
  const genreIndexA = SONG_GENRE_ORDER.indexOf(a.genre as (typeof SONG_GENRE_ORDER)[number]);
  const genreIndexB = SONG_GENRE_ORDER.indexOf(b.genre as (typeof SONG_GENRE_ORDER)[number]);
  const normalizedGenreIndexA = genreIndexA === -1 ? SONG_GENRE_ORDER.length : genreIndexA;
  const normalizedGenreIndexB = genreIndexB === -1 ? SONG_GENRE_ORDER.length : genreIndexB;
  if (normalizedGenreIndexA !== normalizedGenreIndexB) {
    return normalizedGenreIndexA - normalizedGenreIndexB;
  }
  if (Math.abs(a.bpm - b.bpm) > 0.01) {
    return b.bpm - a.bpm;
  }
  return a.title.localeCompare(b.title);
}

function buildFallbackAlbumArt(song: Pick<SongCatalogEntry, "title" | "artist" | "genre">): string {
  const accent = accentForGenre(song.genre);
  const safeTitle = escapeSvgText(song.title.toUpperCase());
  const safeArtist = escapeSvgText(song.artist.toUpperCase());
  const safeGenre = escapeSvgText(song.genre.toUpperCase());
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">
      <rect width="320" height="320" fill="#071017"/>
      <circle cx="74" cy="72" r="84" fill="${accent}" fill-opacity="0.16"/>
      <rect x="30" y="30" width="260" height="260" fill="none" stroke="${accent}" stroke-opacity="0.38" stroke-width="2"/>
      <rect x="46" y="188" width="228" height="88" fill="#0d151d" fill-opacity="0.92"/>
      <text x="56" y="228" fill="#f5f7fa" font-family="Arial, sans-serif" font-size="30" font-weight="700">${safeTitle}</text>
      <text x="56" y="252" fill="#95a1ab" font-family="Arial, sans-serif" font-size="12" letter-spacing="3">${safeArtist}</text>
      <text x="56" y="272" fill="${accent}" font-family="Arial, sans-serif" font-size="12" letter-spacing="4">${safeGenre}</text>
    </svg>
  `.trim();
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function accentForGenre(genre: string): string {
  switch (genre) {
    case "House":
      return "#66e0ff";
    case "Techno":
      return "#ff8366";
    case "Drum & Bass":
      return "#7dff74";
    case "Jungle":
      return "#ffd35a";
    case "Breaks":
      return "#ff7bc7";
    case "Electro":
      return "#76ffd8";
    case "Big Beat":
      return "#ff735c";
    case "Industrial":
      return "#d6dde6";
    case "Trance":
      return "#c59aff";
    case "UKG":
      return "#6ec2ff";
    default:
      return "#67c9d7";
  }
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
