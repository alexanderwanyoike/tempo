import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type {
  CarVariant,
  PickupSpawnState,
  RaceEvent,
  RacePlayerState,
  RaceResults,
  RoomPlayerState,
} from "../../../shared/network-types";
import type { SongDefinition } from "../../../shared/song-schema";
import type { ClientConfig } from "./config";
import { EnvironmentRuntime } from "./environment";
import { clampFictionId, type EnvironmentFictionId } from "./fiction-id";
import { VehicleInput } from "./input";
import { MusicSync, type ReactiveBands } from "./music-sync";
import loadingLoopSongData from "../../../assets/audio/loading-loop.json";
import { CombatVfx } from "./combat-vfx";
import { TouchControls } from "./touch-controls";

const LOBBY_SONG = loadingLoopSongData as unknown as SongDefinition;
const LOBBY_SEED = 0xfade;
const LOBBY_FICTION_ID: EnvironmentFictionId = 1;
import { loadSongDefinition } from "./song-loader";
import type { Track, TrackObject } from "./track-builder";
import { TestTrack } from "./track-builder";
import { TrackGenerator } from "./track-generator";
import { VehicleController, defaultVehicleTuning } from "./vehicle-controller";

type TrailSample = {
  position: Vector3;
  quaternion: Quaternion;
  boost: number;
};

type AppPhase = "staging" | "countdown" | "running" | "finished";
type AppMode = "solo" | "multiplayer";

type RemoteCarVisual = {
  id: string;
  variant: CarVariant;
  group: Group;
  bodyMaterial: MeshStandardMaterial;
  cockpitMaterial: MeshStandardMaterial;
  targetTrackU: number;
  targetLateralOffset: number;
  currentTrackU: number;
  currentLateralOffset: number;
};

type PickupVisual = {
  mesh: Mesh;
  kind: PickupSpawnState["kind"];
  u: number;
  lane: number;
};

type CarPalette = {
  body: Color;
  bodyEmissive: Color;
  cockpit: Color;
  cockpitEmissive: Color;
};

export type LocalRaceReport = {
  trackU: number;
  lateralOffset: number;
  speed: number;
};

export type AppLaunchOptions = {
  songUrl?: string;
  musicUrl?: string | null;
  seed?: number | null;
  fictionId?: EnvironmentFictionId;
  debugHud?: boolean;
  mode?: AppMode;
  localPlayerId?: string | null;
  carVariant?: CarVariant;
  roster?: RoomPlayerState[];
  onRetry?: (() => void) | null;
  onBackToMenu?: (() => void) | null;
  onBackToLobby?: (() => void) | null;
  onSceneReady?: (() => void) | null;
  onAudioReady?: (() => void) | null;
  onRaceReport?: ((report: LocalRaceReport) => void) | null;
  onFire?: (() => void) | null;
  onShield?: (() => void) | null;
};

const START_TRACK_U = 0.001;
const NOMINAL_HALF_WIDTH = 11;
// Mirrors server SHIELD_DURATION_MS. Purely cosmetic - the server is the
// source of truth for the actual shield window.
const SHIELD_VISUAL_DURATION_MS = 2500;

export class App {
  private static readonly WORLD_UP = new Vector3(0, 1, 0);
  private static readonly BOOST_COLOR = new Color("#8bff56");
  private static readonly BOOST_HOT_COLOR = new Color("#d8ff8a");
  private static readonly WIN_SFX_URL = new URL("../../../assets/audio/Win Backspin.wav", import.meta.url).href;
  private static readonly LOSE_SFX_URL = new URL("../../../assets/audio/Lose Backspin.wav", import.meta.url).href;

  private readonly renderer: WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly localVehicle: RemoteCarVisual;
  private readonly combatVfx: CombatVfx;
  private readonly pickupGroup = new Group();
  private readonly boostTrailGroup = new Group();
  private readonly boostTrailMeshes: Mesh[] = [];
  private readonly boostTrailMaterials: MeshBasicMaterial[] = [];
  private readonly boostTrailHistory: TrailSample[] = [];
  private readonly remoteCars = new Map<string, RemoteCarVisual>();
  private readonly pickupVisuals = new Map<string, PickupVisual>();
  private readonly winSfx = new Audio(App.WIN_SFX_URL);
  private readonly loseSfx = new Audio(App.LOSE_SFX_URL);
  private readonly input: VehicleInput;
  private readonly touchControls: TouchControls | null;
  private readonly vehicleController: VehicleController;
  private track: Track;
  private trackObjects: readonly TrackObject[];
  private readonly musicSync: MusicSync | null;
  private environment: EnvironmentRuntime;
  private fictionId: EnvironmentFictionId;
  private readonly songDuration: number | null;
  // Real race scene parameters stashed during App.create for multiplayer
  // warmup. Null for solo and for multiplayer sessions where no lobby swap
  // is required (e.g., song failed to load and we fell back to TestTrack).
  private deferredRaceSong: SongDefinition | null = null;
  private deferredRaceSeed = 0;
  private deferredRaceFictionId: EnvironmentFictionId = 1;
  private lobbyActive = false;
  private readonly debugHud: HTMLDivElement | null;
  private readonly hud: HTMLDivElement;
  private readonly placementHud: HTMLDivElement;
  private readonly checkpointHud: HTMLDivElement;
  private readonly inventoryHud: HTMLDivElement;
  private readonly rosterHud: HTMLDivElement;
  private readonly statusOverlay: HTMLDivElement;
  private readonly statusTitle: HTMLDivElement;
  private readonly statusSubtitle: HTMLDivElement;
  private readonly statusBody: HTMLDivElement;
  private readonly primaryButton: HTMLButtonElement;
  private readonly secondaryButton: HTMLButtonElement;
  private readonly orientMat = new Matrix4();
  private readonly targetCarQuaternion = new Quaternion();
  private readonly targetCameraQuaternion = new Quaternion();
  private readonly desiredCameraPosition = new Vector3();
  private readonly desiredCameraLookTarget = new Vector3();
  private readonly desiredCameraUp = new Vector3();
  private readonly smoothedCameraPosition = new Vector3();
  private readonly smoothedCameraLookTarget = new Vector3();
  private readonly smoothedCameraUp = new Vector3(0, 1, 0);
  private readonly tempVector = new Vector3();
  private readonly tempVectorB = new Vector3();
  private readonly trackObjectTriggers = new Set<string>();
  private readonly serverPlayers = new Map<string, RacePlayerState>();

  private animationFrameId: number | null = null;
  private destroyed = false;
  private visualsInitialized = false;
  private lastFrameTime = 0;
  private elapsedRaceTime = 0;
  private latestReactiveBands: ReactiveBands | null = null;
  private phase: AppPhase = "staging";
  private pendingStartAt = 0;
  private audioReady = false;
  private countdownStarted = false;
  private latestCheckpointCount = 1;
  private localPlacement = 1;
  private localCheckpointIndex = 0;
  private localOffensiveItem: PickupSpawnState["kind"] | null = null;
  private localDefensiveItem: PickupSpawnState["kind"] | null = null;
  private localTakenDownUntil = 0;
  private localRespawnRevision = 0;
  private countdownResetTrackU = START_TRACK_U;
  private countdownResetLateralOffset = 0;
  private countdownResetSpeed = 0;
  private lastReportedAt = 0;
  private lastFirePressed = false;
  private lastShieldPressed = false;
  private latestRoster: RoomPlayerState[] = [];
  private lastStatusMessage = "";

  static async create(
    root: HTMLElement,
    config: ClientConfig,
    launch: AppLaunchOptions = {},
  ): Promise<App> {
    const songUrl = launch.songUrl;
    const fictionId = clampFictionId(launch.fictionId ?? null);
    const isMultiplayer = launch.mode === "multiplayer";

    let track: Track;
    let musicSync: MusicSync | null = null;
    let scenePlanSong: SongDefinition | null = null;
    let sceneSeed = 0;
    let sceneFictionId = fictionId;
    let deferredRaceSong: SongDefinition | null = null;
    let deferredRaceSeed = 0;
    let deferredRaceFictionId: EnvironmentFictionId = fictionId;
    let musicReadyPromise: Promise<void> | null = null;

    if (songUrl) {
      const requestedMusicUrl = launch.musicUrl === null
        ? null
        : (launch.musicUrl ?? songUrl.replace(/\.json$/, ".mp3").replace("/songs/", "/music/"));
      const songPromise = loadSongDefinition(songUrl);

      if (requestedMusicUrl) {
        musicSync = new MusicSync();
        musicReadyPromise = musicSync.load(requestedMusicUrl);
      }

      try {
        const realSong = await songPromise;
        const realSeed = launch.seed ?? realSong.baseSeed;
        if (isMultiplayer) {
          // Multiplayer boots into a lobby "warmup lane" built from the
          // loading-loop song so the real race track stays hidden until
          // every peer has preloaded. beginCountdown() swaps to the real
          // scene using the stashed deferred params.
          scenePlanSong = LOBBY_SONG;
          sceneSeed = LOBBY_SEED;
          sceneFictionId = LOBBY_FICTION_ID;
          track = new TrackGenerator(LOBBY_SONG, LOBBY_SEED);
          deferredRaceSong = realSong;
          deferredRaceSeed = realSeed;
          deferredRaceFictionId = fictionId;
        } else {
          scenePlanSong = realSong;
          sceneSeed = realSeed;
          sceneFictionId = fictionId;
          track = new TrackGenerator(realSong, realSeed);
        }
      } catch {
        track = new TestTrack();
      }
    } else {
      track = new TestTrack();
    }

    return new App(
      root,
      config,
      track,
      musicSync,
      scenePlanSong,
      sceneSeed,
      sceneFictionId,
      launch,
      launch.debugHud ?? false,
      musicReadyPromise,
      deferredRaceSong,
      deferredRaceSeed,
      deferredRaceFictionId,
    );
  }

  private constructor(
    private readonly root: HTMLElement,
    private readonly config: ClientConfig,
    track: Track,
    musicSync: MusicSync | null,
    song: SongDefinition | null,
    seed: number,
    fictionId: EnvironmentFictionId,
    private readonly launch: AppLaunchOptions,
    debugHudEnabled: boolean,
    private readonly musicReadyPromise: Promise<void> | null,
    deferredRaceSong: SongDefinition | null,
    deferredRaceSeed: number,
    deferredRaceFictionId: EnvironmentFictionId,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new Scene();
    this.scene.background = new Color("#05070c");

    this.camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 1.0, 2000);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(
      new Vector2(window.innerWidth, window.innerHeight),
      0.58,
      0.42,
      0.3,
    ));

    this.localVehicle = this.createVehicleVisual(launch.carVariant ?? "vector");
    this.scene.add(this.localVehicle.group);

    this.input = new VehicleInput();
    this.touchControls = window.matchMedia("(pointer: coarse)").matches
      ? new TouchControls(this.input.state)
      : null;
    this.vehicleController = new VehicleController(defaultVehicleTuning);
    this.vehicleController.forceTrackState(START_TRACK_U);
    this.musicSync = musicSync;
    this.songDuration = deferredRaceSong?.duration ?? song?.duration ?? null;
    this.fictionId = fictionId;
    this.track = track;
    this.trackObjects = this.track.getTrackObjects();
    this.environment = new EnvironmentRuntime(this.scene, this.track, song, seed, fictionId);
    this.scene.add(this.environment.group);
    this.scene.add(this.track.meshGroup);
    this.deferredRaceSong = deferredRaceSong;
    this.deferredRaceSeed = deferredRaceSeed;
    this.deferredRaceFictionId = deferredRaceFictionId;
    this.lobbyActive = deferredRaceSong !== null;
    this.scene.add(this.pickupGroup);
    this.scene.add(this.boostTrailGroup);
    this.scene.add(this.camera);
    this.combatVfx = new CombatVfx(
      this.scene,
      (id) => this.getVehicleGroup(id),
      this.root,
    );
    this.createBoostTrailMeshes();
    this.configureSfx();

    this.vehicleController.setTrack(this.track);
    this.vehicleController.setTrackQuery((pos, hintU) => this.track.queryNearest(pos, hintU));
    this.vehicleController.forceTrackState(START_TRACK_U);

    this.debugHud = this.createDebugHud(debugHudEnabled);
    this.hud = this.createHud();
    this.placementHud = this.hud.querySelector(".tempo-hud-placement") as HTMLDivElement;
    this.checkpointHud = this.hud.querySelector(".tempo-hud-checkpoint") as HTMLDivElement;
    this.inventoryHud = this.hud.querySelector(".tempo-hud-inventory") as HTMLDivElement;
    this.rosterHud = this.hud.querySelector(".tempo-hud-roster") as HTMLDivElement;

    const statusUi = this.createStatusOverlay();
    this.statusOverlay = statusUi.overlay;
    this.statusTitle = statusUi.title;
    this.statusSubtitle = statusUi.subtitle;
    this.statusBody = statusUi.body;
    this.primaryButton = statusUi.primaryButton;
    this.secondaryButton = statusUi.secondaryButton;

    if (launch.mode === "multiplayer") {
      this.statusOverlay.style.display = "none";
      this.lastStatusMessage = "Warmup lane live. Audio buffering.";
    } else {
      this.setOverlayMessage(
        "Loading Track Audio",
        "Staging the real map while the track audio buffers.",
      );
    }
  }

  start(): void {
    this.root.append(this.renderer.domElement, this.hud, this.statusOverlay);
    if (this.debugHud) this.root.appendChild(this.debugHud);
    this.touchControls?.attach(this.root);
    this.setupScene();
    this.bindEvents();
    this.renderRoster();
    this.launch.onSceneReady?.();
    this.lastFrameTime = performance.now();
    this.render(this.lastFrameTime);
    void this.waitForAudioReady();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.input.detach();
    this.touchControls?.detach();
    this.combatVfx.dispose();
    this.musicSync?.stop();
    this.winSfx.pause();
    this.loseSfx.pause();
    this.renderer.dispose();
    this.disposeSceneGraph();
    this.root.replaceChildren();
  }

  setRoomState(players: RoomPlayerState[], phase: AppPhase | "lobby"): void {
    this.latestRoster = [...players];
    const nextPhase = phase === "lobby" ? "staging" : phase;
    if (this.launch.mode === "multiplayer" && nextPhase === "running") {
      this.enterRunningPhase();
    } else {
      this.phase = nextPhase;
    }
    this.renderRoster();

    if (this.launch.mode !== "multiplayer") return;
    if (phase === "lobby") return;

    const activePlayers = players.filter((player) => player.isActiveRacer);
    if (this.phase === "staging" && activePlayers.length > 0) {
      const readyCount = activePlayers.filter((player) => player.preload.sceneReady && player.preload.audioReady).length;
      this.lastStatusMessage = `Warmup live. ${readyCount}/${activePlayers.length} synced.`;
    }
  }

  beginCountdown(startAt: number): void {
    if (this.phase === "finished") return;
    if (this.lobbyActive) {
      this.swapLobbyToRealScene();
    }
    this.pendingStartAt = startAt;
    this.phase = "countdown";
    this.countdownStarted = false;
    if (this.launch.mode === "multiplayer") {
      this.vehicleController.forceTrackState(
        this.countdownResetTrackU,
        this.countdownResetLateralOffset,
        this.countdownResetSpeed,
      );
    }
    this.statusOverlay.style.display = "flex";
    this.statusBody.style.display = "none";
    this.primaryButton.style.display = "none";
    this.secondaryButton.style.display = "none";
  }

  private swapLobbyToRealScene(): void {
    if (!this.lobbyActive || !this.deferredRaceSong) {
      console.log(`[swap] skipped (lobbyActive=${this.lobbyActive}, deferredRaceSong=${this.deferredRaceSong !== null})`);
      return;
    }
    console.log("[swap] lobby -> real scene");
    const realSong = this.deferredRaceSong;
    const realSeed = this.deferredRaceSeed;
    const realFictionId = this.deferredRaceFictionId;

    // Remove lobby track mesh + environment from the scene. We drop the
    // references; the next frame will GC them. EnvironmentRuntime has no
    // explicit dispose, and Track.meshGroup is a plain Group we can detach.
    this.scene.remove(this.track.meshGroup);
    this.scene.remove(this.environment.group);

    // Build real track + environment in place.
    const realTrack = new TrackGenerator(realSong, realSeed);
    this.track = realTrack;
    this.trackObjects = realTrack.getTrackObjects();
    this.fictionId = realFictionId;
    this.environment = new EnvironmentRuntime(
      this.scene,
      realTrack,
      realSong,
      realSeed,
      realFictionId,
    );
    this.scene.add(this.environment.group);
    this.scene.add(this.track.meshGroup);

    // Rewire the vehicle controller to the real track and drop it back on
    // the starting line so the first-frame physics read matches the real
    // geometry rather than the lobby one.
    this.vehicleController.setTrack(realTrack);
    this.vehicleController.setTrackQuery((pos, hintU) =>
      realTrack.queryNearest(pos, hintU),
    );
    this.vehicleController.forceTrackState(
      this.countdownResetTrackU > 0 ? this.countdownResetTrackU : START_TRACK_U,
      this.countdownResetLateralOffset,
      0,
    );

    // Reset pickup/trigger state so the old lobby ids do not linger. The
    // server will resend the real pickup snapshot on the next tick.
    for (const visual of this.pickupVisuals.values()) {
      this.pickupGroup.remove(visual.mesh);
    }
    this.pickupVisuals.clear();
    this.trackObjectTriggers.clear();

    this.lobbyActive = false;
    console.log(`[swap] complete. realTrack totalLength=${realTrack.totalLength}, real track getPointAt(0.02)=`, realTrack.getPointAt(0.02));
  }

  private enterRunningPhase(): void {
    this.phase = "running";
    this.countdownStarted = true;
    this.statusOverlay.style.display = "none";
    this.musicSync?.play();
  }

  applyRaceSnapshot(players: RacePlayerState[], pickups: PickupSpawnState[], checkpointCount: number): void {
    this.latestCheckpointCount = checkpointCount;

    const nextIds = new Set<string>();
    for (const player of players) {
      nextIds.add(player.clientId);
      this.serverPlayers.set(player.clientId, player);
      if (player.clientId === this.launch.localPlayerId) {
        this.countdownResetTrackU = player.trackU;
        this.countdownResetLateralOffset = player.lateralOffset;
        this.countdownResetSpeed = player.speed;
        this.localPlacement = player.placement;
        this.localCheckpointIndex = player.checkpointIndex;
        this.localOffensiveItem = player.offensiveItem;
        this.localDefensiveItem = player.defensiveItem;
        this.localTakenDownUntil = player.takenDownUntil;
        if (this.phase !== "running" || player.respawnRevision !== this.localRespawnRevision) {
          this.localRespawnRevision = player.respawnRevision;
          this.vehicleController.forceTrackState(player.trackU, player.lateralOffset, player.speed);
        }
        continue;
      }

      const remote = this.ensureRemoteCar(player.clientId);
      remote.targetTrackU = player.trackU;
      remote.targetLateralOffset = player.lateralOffset;
    }

    for (const [clientId, remote] of this.remoteCars) {
      if (!nextIds.has(clientId)) {
        this.scene.remove(remote.group);
        this.remoteCars.delete(clientId);
      }
    }

    this.syncPickupVisuals(pickups);
  }

  applyRaceEvent(event: RaceEvent): void {
    const now = performance.now();
    const localId = this.launch.localPlayerId;

    if (event.kind === "pickup" && event.actorId === localId) {
      this.lastStatusMessage = event.item === "missile"
        ? "Missile ready. Press Space/F or tap Fire."
        : "Shield ready. Press R or tap Shield.";
      return;
    }
    if (event.kind === "shield") {
      this.combatVfx.spawnShield(event.actorId, SHIELD_VISUAL_DURATION_MS, now);
      if (event.actorId === localId) {
        this.lastStatusMessage = "Shield active.";
      }
      return;
    }
    if (event.kind === "blocked") {
      this.combatVfx.spawnMissile(
        event.actorId,
        event.targetId,
        () => this.combatVfx.spawnBlock(event.targetId, performance.now()),
        now,
      );
      if (event.targetId === localId) {
        this.lastStatusMessage = "Shield cracked a missile.";
      }
      return;
    }
    if (event.kind === "takedown") {
      this.combatVfx.spawnMissile(
        event.actorId,
        event.targetId,
        () => {
          const impactNow = performance.now();
          this.combatVfx.spawnImpact(event.targetId, impactNow);
          if (event.targetId === localId) {
            this.combatVfx.flashLocalTakedown(impactNow);
          }
        },
        now,
      );
      if (event.actorId === localId) {
        this.lastStatusMessage = "Direct hit.";
      } else if (event.targetId === localId) {
        this.lastStatusMessage = "Takedown. Respawning on checkpoint.";
      }
      return;
    }
    if (event.kind === "respawn" && event.targetId === localId) {
      this.lastStatusMessage = "Recovered. Rejoining the line.";
      return;
    }
    if (event.kind === "finish" && event.actorId === localId) {
      this.lastStatusMessage = `Finish locked: P${event.placement}`;
    }
  }

  private getVehicleGroup(id: string): Group | null {
    if (id === this.launch.localPlayerId) return this.localVehicle.group;
    return this.remoteCars.get(id)?.group ?? null;
  }

  showResults(results: RaceResults): void {
    this.phase = "finished";
    this.musicSync?.stop();
    this.statusOverlay.style.display = "flex";
    this.statusBody.style.display = "";
    this.statusTitle.textContent = "Results";
    this.statusSubtitle.textContent = `${results.entries[0]?.name ?? "Winner"} takes the line first.`;
    this.statusBody.textContent = results.entries
      .map((entry) => {
        const time = entry.finishTimeMs === null ? "DNF" : formatTimeMs(entry.finishTimeMs);
        return `${entry.placement}. ${entry.name.padEnd(10, " ")} ${time}  TKD ${entry.takedowns}`;
      })
      .join("\n");
    this.primaryButton.textContent = this.launch.mode === "multiplayer" ? "Back To Lobby" : "Retry";
    this.primaryButton.style.display = "";
    this.secondaryButton.textContent = "Back To Menu";
    this.secondaryButton.style.display = this.launch.onBackToMenu ? "" : "none";
  }

  private async waitForAudioReady(): Promise<void> {
    try {
      if (this.musicReadyPromise) {
        await this.musicReadyPromise;
      }
      this.audioReady = true;
      this.launch.onAudioReady?.();
      if (this.launch.mode !== "multiplayer") {
        this.beginCountdown(Date.now() + 2500);
      } else if (this.phase === "staging") {
        this.lastStatusMessage = "Warmup lane live. Audio ready. Waiting for the room.";
      }
    } catch (error) {
      console.error("Audio preload failed:", error);
      this.setOverlayMessage("Audio Load Failed", "Track audio could not buffer.");
      this.primaryButton.textContent = "Back";
      this.primaryButton.style.display = "";
      this.secondaryButton.style.display = "none";
    }
  }

  private setupScene(): void {
    const hemi = new HemisphereLight("#62c7ff", "#080b12", 1.1);
    const ambient = new AmbientLight("#5b89c7", 0.7);
    const key = new DirectionalLight("#ff658e", 1.8);
    key.position.set(5, 9, 6);
    const rim = new DirectionalLight("#48d6ff", 1.2);
    rim.position.set(-6, 4, -8);
    this.scene.add(hemi, ambient, key, rim);
    this.scene.fog = new FogExp2("#0a1018", 0.0018);
    this.root.dataset.wsUrl = this.config.websocketUrl;
  }

  private bindEvents(): void {
    window.addEventListener("resize", this.handleResize);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.input.attach();
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) this.musicSync?.pause();
    else if (this.phase === "running") this.musicSync?.resume();
  };

  private readonly handleResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  };

  private createVehicleVisual(variant: CarVariant): RemoteCarVisual {
    const palette = paletteForVariant(variant);
    const bodyMaterial = new MeshStandardMaterial({
      color: palette.body.clone(),
      emissive: palette.bodyEmissive.clone(),
      metalness: 0.3,
      roughness: 0.5,
    });
    const body = new Mesh(new BoxGeometry(1.4, 0.5, 3.2), bodyMaterial);
    body.position.y = 0.1;

    const cockpitMaterial = new MeshStandardMaterial({
      color: palette.cockpit.clone(),
      emissive: palette.cockpitEmissive.clone(),
      metalness: 0.15,
      roughness: 0.45,
    });
    const cockpit = new Mesh(new BoxGeometry(0.8, 0.35, 1.15), cockpitMaterial);
    cockpit.position.set(0, 0.35, 0.1);

    const group = new Group();
    group.add(body, cockpit);

    return {
      id: "",
      variant,
      group,
      bodyMaterial,
      cockpitMaterial,
      targetTrackU: START_TRACK_U,
      targetLateralOffset: 0,
      currentTrackU: START_TRACK_U,
      currentLateralOffset: 0,
    };
  }

  private ensureRemoteCar(clientId: string): RemoteCarVisual {
    const existing = this.remoteCars.get(clientId);
    if (existing) return existing;
    const rosterEntry = this.latestRoster.find((candidate) => candidate.clientId === clientId);
    const remote = this.createVehicleVisual(rosterEntry?.carVariant ?? "ghost");
    remote.id = clientId;
    this.remoteCars.set(clientId, remote);
    this.scene.add(remote.group);
    return remote;
  }

  private createBoostTrailMeshes(): void {
    const trailGeometry = new BoxGeometry(1.2, 0.22, 2.8);
    for (let i = 0; i < 10; i++) {
      const material = new MeshBasicMaterial({
        color: App.BOOST_COLOR.clone(),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new Mesh(trailGeometry, material);
      mesh.visible = false;
      this.boostTrailMaterials.push(material);
      this.boostTrailMeshes.push(mesh);
      this.boostTrailGroup.add(mesh);
    }
  }

  private configureSfx(): void {
    for (const sfx of [this.winSfx, this.loseSfx]) {
      sfx.preload = "auto";
      sfx.volume = 0.92;
    }
  }

  private createHud(): HTMLDivElement {
    const hud = document.createElement("div");
    hud.style.position = "fixed";
    hud.style.inset = "0";
    hud.style.pointerEvents = "none";
    hud.style.zIndex = "10";
    hud.innerHTML = `
      <div style="position:absolute;top:16px;left:16px;display:flex;flex-direction:column;gap:8px;">
        <div class="tempo-hud-placement" style="padding:10px 12px;background:rgba(4,8,14,0.72);border:1px solid rgba(120,230,255,0.22);font:700 13px/1.25 ui-monospace,monospace;letter-spacing:0.06em;text-transform:uppercase;color:#ecfbff;">Place: 1</div>
        <div class="tempo-hud-checkpoint" style="padding:10px 12px;background:rgba(4,8,14,0.72);border:1px solid rgba(120,230,255,0.22);font:700 13px/1.25 ui-monospace,monospace;letter-spacing:0.06em;text-transform:uppercase;color:#ecfbff;">Progress: 0%</div>
        <div class="tempo-hud-inventory" style="padding:10px 12px;background:rgba(4,8,14,0.72);border:1px solid rgba(120,230,255,0.22);font:700 12px/1.6 ui-monospace,monospace;letter-spacing:0.04em;text-transform:uppercase;color:#ecfbff;">Attack: None<br>Defense: None</div>
      </div>
      <div class="tempo-hud-roster" style="position:absolute;top:16px;right:16px;min-width:260px;padding:10px 12px;background:rgba(4,8,14,0.72);border:1px solid rgba(120,230,255,0.22);font:600 12px/1.5 ui-monospace,monospace;letter-spacing:0.02em;color:#dff7ff;white-space:pre;"></div>
    `;
    return hud;
  }

  private createStatusOverlay(): {
    overlay: HTMLDivElement;
    title: HTMLDivElement;
    subtitle: HTMLDivElement;
    body: HTMLDivElement;
    primaryButton: HTMLButtonElement;
    secondaryButton: HTMLButtonElement;
  } {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.background = "rgba(2, 4, 9, 0.52)";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "15";

    const panel = document.createElement("div");
    panel.style.minWidth = "min(520px, calc(100vw - 48px))";
    panel.style.padding = "28px 28px 24px";
    panel.style.borderRadius = "20px";
    panel.style.border = "1px solid rgba(120, 230, 255, 0.18)";
    panel.style.background = "rgba(8, 12, 20, 0.9)";
    panel.style.boxShadow = "0 30px 120px rgba(0, 0, 0, 0.48)";
    panel.style.textAlign = "center";
    panel.style.pointerEvents = "auto";

    const title = document.createElement("div");
    title.style.color = "#f4fbff";
    title.style.font = "700 38px/1.02 system-ui, sans-serif";
    title.style.letterSpacing = "0.08em";
    title.style.textTransform = "uppercase";

    const subtitle = document.createElement("div");
    subtitle.style.marginTop = "10px";
    subtitle.style.color = "rgba(221, 233, 247, 0.8)";
    subtitle.style.font = "600 13px/1.45 system-ui, sans-serif";
    subtitle.style.letterSpacing = "0.08em";
    subtitle.style.textTransform = "uppercase";

    const body = document.createElement("div");
    body.style.display = "none";
    body.style.marginTop = "18px";
    body.style.color = "#d8f5ff";
    body.style.font = "600 12px/1.65 ui-monospace, monospace";
    body.style.whiteSpace = "pre";

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "center";
    actions.style.gap = "12px";
    actions.style.marginTop = "22px";

    const primaryButton = this.createOverlayButton("Retry");
    primaryButton.addEventListener("click", () => {
      if (this.launch.mode === "multiplayer") {
        this.launch.onBackToLobby?.();
      } else {
        this.launch.onRetry?.();
      }
    });

    const secondaryButton = this.createOverlayButton("Back To Menu");
    secondaryButton.addEventListener("click", () => {
      this.launch.onBackToMenu?.();
    });

    actions.append(primaryButton, secondaryButton);
    panel.append(title, subtitle, body, actions);
    overlay.appendChild(panel);

    return {
      overlay,
      title,
      subtitle,
      body,
      primaryButton,
      secondaryButton,
    };
  }

  private createOverlayButton(label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.border = "0";
    button.style.borderRadius = "999px";
    button.style.padding = "12px 18px";
    button.style.background = "linear-gradient(135deg, rgba(121, 245, 255, 0.94), rgba(119, 255, 184, 0.94))";
    button.style.color = "#071019";
    button.style.font = "800 12px/1 system-ui, sans-serif";
    button.style.letterSpacing = "0.12em";
    button.style.textTransform = "uppercase";
    button.style.cursor = "pointer";
    return button;
  }

  private setOverlayMessage(title: string, subtitle: string): void {
    this.statusOverlay.style.display = "flex";
    this.statusBody.style.display = "none";
    this.statusTitle.textContent = title;
    this.statusSubtitle.textContent = subtitle;
    this.primaryButton.style.display = "none";
    this.secondaryButton.style.display = "none";
  }

  private syncPickupVisuals(pickups: PickupSpawnState[]): void {
    if (pickups.length > 0 && this.pickupVisuals.size === 0) {
      // One-shot log per race so we can tell from DevTools whether the
      // server is actually feeding us pickups. Logs once per empty->full
      // transition, which includes after the lobby->real swap.
      console.log(`[pickups] populate: ${pickups.length} entries (phase=${this.phase}, lobbyActive=${this.lobbyActive})`);
      if (pickups.length > 0) {
        const first = pickups[0];
        const frame = this.track.getFrameAt(first.u);
        const center = this.track.getPointAt(first.u);
        console.log(`[pickups] first pickup u=${first.u} lane=${first.lane} worldPos=(${center.x.toFixed(1)}, ${center.y.toFixed(1)}, ${center.z.toFixed(1)}) frameRight=(${frame.right.x.toFixed(2)}, ${frame.right.y.toFixed(2)}, ${frame.right.z.toFixed(2)})`);
      }
    }
    const nextIds = new Set<string>();
    for (const pickup of pickups) {
      nextIds.add(pickup.id);
      let visual = this.pickupVisuals.get(pickup.id);
      if (!visual) {
        const isMissile = pickup.kind === "missile";
        const coreColor = isMissile ? "#ff3d7a" : "#39e6ff";
        const glowColor = isMissile ? "#ffb5cb" : "#bff5ff";
        // Huge core box - this is the "no way you missed it" size. Every
        // pickup reads from ~40m+ away at race speed.
        const mesh = new Mesh(
          new BoxGeometry(isMissile ? 4.8 : 5.2, 4.8, 4.8),
          new MeshStandardMaterial({
            color: coreColor,
            emissive: coreColor,
            emissiveIntensity: 5.5,
          }),
        );
        // Main beam - tall emissive column visible from across the track.
        const beam = new Mesh(
          new BoxGeometry(1.8, 40, 1.8),
          new MeshStandardMaterial({
            color: glowColor,
            emissive: coreColor,
            emissiveIntensity: 4.2,
            transparent: true,
            opacity: 0.95,
            depthWrite: false,
          }),
        );
        beam.position.y = 20;
        // Wide outer halo beam for silhouette at extreme distance.
        const haloBeam = new Mesh(
          new BoxGeometry(5.5, 44, 5.5),
          new MeshStandardMaterial({
            color: glowColor,
            emissive: coreColor,
            emissiveIntensity: 2.0,
            transparent: true,
            opacity: 0.26,
            depthWrite: false,
          }),
        );
        haloBeam.position.y = 20;
        const base = new Mesh(
          new BoxGeometry(8.0, 0.4, 8.0),
          new MeshStandardMaterial({
            color: glowColor,
            emissive: coreColor,
            emissiveIntensity: 2.4,
            transparent: true,
            opacity: 0.82,
            depthWrite: false,
          }),
        );
        base.position.y = -1.8;
        mesh.add(beam, haloBeam, base);
        visual = { mesh, kind: pickup.kind, u: pickup.u, lane: pickup.lane };
        this.pickupVisuals.set(pickup.id, visual);
        this.pickupGroup.add(mesh);
      }
      visual.u = pickup.u;
      visual.lane = pickup.lane;
      visual.mesh.visible = pickup.collectedBy === null;
    }

    for (const [pickupId, visual] of this.pickupVisuals) {
      if (nextIds.has(pickupId)) continue;
      this.pickupGroup.remove(visual.mesh);
      this.pickupVisuals.delete(pickupId);
    }
  }

  private updatePickupVisuals(timeSeconds: number): void {
    for (const visual of this.pickupVisuals.values()) {
      if (!visual.mesh.visible) continue;
      const frame = this.track.getFrameAt(visual.u);
      const center = this.track.getPointAt(visual.u);
      // Lateral offset along the track's right vector, vertical offset along
      // WORLD UP so the beam is always readable as "up" in the player's
      // frame rather than tilting into a banked surface. Old code used
      // frame.up + a left-handed orientation matrix, which both hid the
      // pickup on banked sections and produced a mirrored rotation matrix
      // that setRotationFromMatrix could not extract cleanly.
      visual.mesh.position.copy(center);
      visual.mesh.position.addScaledVector(frame.right, visual.lane * NOMINAL_HALF_WIDTH);
      visual.mesh.position.y += 4.0 + Math.sin(timeSeconds * 3 + visual.u * 17) * 0.55;
      // Just spin the core around world-up. No track-follow rotation.
      visual.mesh.rotation.set(0, timeSeconds * 1.8, 0);
      const [beam, haloBeam, base] = visual.mesh.children;
      if (beam) {
        beam.scale.y = 1 + Math.sin(timeSeconds * 2.2 + visual.u * 11) * 0.08;
      }
      if (haloBeam) {
        const haloPulse = 1 + Math.sin(timeSeconds * 1.7 + visual.u * 13) * 0.22;
        haloBeam.scale.set(haloPulse, 1, haloPulse);
      }
      if (base) {
        const pulse = 1 + Math.sin(timeSeconds * 4 + visual.u * 19) * 0.22;
        base.scale.setScalar(pulse);
      }
    }
  }

  private updateCarTransform(deltaSeconds: number): void {
    const state = this.vehicleController.state;
    const dt = Math.min(deltaSeconds, 1 / 30);
    const positionAlpha = 1 - Math.exp(-12 * dt);
    const rotationAlpha = 1 - Math.exp(-20 * dt);
    const desiredPosition = this.tempVector.copy(state.position).addScaledVector(state.up, state.visualHoverOffset);

    const negFwd = this.tempVectorB.copy(state.forward).negate();
    this.orientMat.makeBasis(state.right, state.up, negFwd);
    this.targetCarQuaternion.setFromRotationMatrix(this.orientMat);

    if (!this.visualsInitialized) {
      this.localVehicle.group.position.copy(desiredPosition);
      this.localVehicle.group.quaternion.copy(this.targetCarQuaternion);
    } else {
      this.localVehicle.group.position.lerp(desiredPosition, positionAlpha);
      this.localVehicle.group.quaternion.slerp(this.targetCarQuaternion, rotationAlpha);
    }

    const body = this.localVehicle.group.children[0];
    if (body) {
      body.rotation.set(state.visualPitch, -state.steering * 0.15, state.visualBank, "XYZ");
    }
  }

  private updateRemoteCars(deltaSeconds: number): void {
    const alpha = 1 - Math.exp(-Math.min(deltaSeconds, 1 / 20) * 8);
    const now = Date.now();
    for (const [clientId, remote] of this.remoteCars) {
      const snapshot = this.serverPlayers.get(clientId);
      if (!snapshot) continue;
      remote.group.visible = snapshot.takenDownUntil <= now;
      remote.currentTrackU = MathUtils.lerp(remote.currentTrackU, remote.targetTrackU, alpha);
      remote.currentLateralOffset = MathUtils.lerp(remote.currentLateralOffset, remote.targetLateralOffset, alpha);

      const frame = this.track.getFrameAt(remote.currentTrackU);
      const center = this.track.getPointAt(remote.currentTrackU);
      remote.group.position.copy(center)
        .addScaledVector(frame.right, remote.currentLateralOffset)
        .addScaledVector(frame.up, 0.45);
      this.orientMat.makeBasis(frame.right, frame.up, frame.tangent.clone().negate());
      remote.group.setRotationFromMatrix(this.orientMat);
    }
  }

  private updateBoostVisuals(): void {
    const boost = this.vehicleController.state.visualBoost;
    const localPalette = paletteForVariant(this.launch.carVariant ?? "vector");
    const bodyColor = localPalette.body.clone().lerp(App.BOOST_HOT_COLOR, boost);
    const bodyEmissive = localPalette.bodyEmissive.clone().lerp(App.BOOST_HOT_COLOR, boost);
    const cockpitColor = localPalette.cockpit.clone().lerp(new Color("#4a6a26"), boost * 0.48);
    const cockpitEmissive = localPalette.cockpitEmissive.clone().lerp(App.BOOST_COLOR, boost);

    this.localVehicle.bodyMaterial.color.copy(bodyColor);
    this.localVehicle.bodyMaterial.emissive.copy(bodyEmissive);
    this.localVehicle.bodyMaterial.emissiveIntensity = 0.9 + boost * 3.6;
    this.localVehicle.cockpitMaterial.color.copy(cockpitColor);
    this.localVehicle.cockpitMaterial.emissive.copy(cockpitEmissive);
    this.localVehicle.cockpitMaterial.emissiveIntensity = 0.5 + boost * 2.1;

    this.boostTrailHistory.unshift({
      position: this.localVehicle.group.position.clone(),
      quaternion: this.localVehicle.group.quaternion.clone(),
      boost,
    });
    if (this.boostTrailHistory.length > 28) this.boostTrailHistory.length = 28;

    for (let i = 0; i < this.boostTrailMeshes.length; i++) {
      const sample = this.boostTrailHistory[Math.min(this.boostTrailHistory.length - 1, 2 + i * 2)];
      const mesh = this.boostTrailMeshes[i];
      const material = this.boostTrailMaterials[i];
      if (!sample || sample.boost < 0.04) {
        mesh.visible = false;
        continue;
      }

      mesh.visible = true;
      mesh.position.copy(sample.position);
      mesh.quaternion.copy(sample.quaternion);
      mesh.scale.set(
        1 + sample.boost * (0.45 + i * 0.03),
        1 + sample.boost * 0.25,
        1.2 + sample.boost * (0.9 + i * 0.08),
      );
      material.opacity = Math.max(0, sample.boost * (0.5 - i * 0.04));
      material.color.copy(App.BOOST_COLOR).lerp(App.BOOST_HOT_COLOR, sample.boost * 0.5);
    }
  }

  private updateCamera(deltaSeconds: number): void {
    const state = this.vehicleController.state;
    const speed = Math.abs(state.speed);
    const speedRatio = Math.min(speed / 90, 1);
    const dt = Math.min(deltaSeconds, 1 / 30);
    const positionAlpha = 1 - Math.exp(-6 * dt);
    const lookAlpha = 1 - Math.exp(-8 * dt);
    const upAlpha = 1 - Math.exp(-5 * dt);

    const camBack = MathUtils.lerp(8.5, 14.5, speedRatio);
    const camUp = MathUtils.lerp(4.2, 6.4, speedRatio);
    const lookAhead = MathUtils.lerp(10, 18, speedRatio);
    const lateralLead = state.steering * MathUtils.lerp(0.35, 1.2, speedRatio);

    this.desiredCameraLookTarget.copy(state.position)
      .addScaledVector(state.forward, lookAhead)
      .addScaledVector(state.up, 1.4)
      .addScaledVector(state.right, lateralLead);

    this.desiredCameraPosition.copy(state.position)
      .addScaledVector(state.forward, -camBack)
      .addScaledVector(state.up, camUp)
      .addScaledVector(state.right, lateralLead * 0.75);

    this.resolveCameraRoadClip(this.desiredCameraPosition, state.trackU);
    this.desiredCameraUp.copy(App.WORLD_UP).lerp(state.up, 0.42).normalize();

    if (!this.visualsInitialized) {
      this.smoothedCameraPosition.copy(this.desiredCameraPosition);
      this.smoothedCameraLookTarget.copy(this.desiredCameraLookTarget);
      this.smoothedCameraUp.copy(this.desiredCameraUp);
      this.visualsInitialized = true;
    } else {
      this.smoothedCameraPosition.lerp(this.desiredCameraPosition, positionAlpha);
      this.smoothedCameraLookTarget.lerp(this.desiredCameraLookTarget, lookAlpha);
      this.smoothedCameraUp.lerp(this.desiredCameraUp, upAlpha).normalize();
      this.resolveCameraRoadClip(this.smoothedCameraPosition, state.trackU);
    }

    this.camera.position.copy(this.smoothedCameraPosition);
    this.orientMat.lookAt(this.smoothedCameraPosition, this.smoothedCameraLookTarget, this.smoothedCameraUp);
    this.targetCameraQuaternion.setFromRotationMatrix(this.orientMat);
    this.camera.quaternion.copy(this.targetCameraQuaternion);
    this.camera.fov = MathUtils.lerp(70, 95, speedRatio * speedRatio);
    this.camera.updateProjectionMatrix();
  }

  private resolveCameraRoadClip(cameraPosition: Vector3, hintU: number): void {
    const query = this.track.queryNearest(cameraPosition, hintU);
    const clearance = this.tempVectorB.copy(cameraPosition).sub(query.center).dot(query.up);
    const minClearance = 2.8;
    if (clearance < minClearance) {
      cameraPosition.addScaledVector(query.up, minClearance - clearance);
    }
  }

  private handleTrackObjects(): void {
    if (this.trackObjects.length === 0) return;

    const state = this.vehicleController.state;
    const uWindow = 14 / this.track.totalLength;
    for (const object of this.trackObjects) {
      if (this.trackObjectTriggers.has(object.id)) continue;
      if (Math.abs(object.u - state.trackU) > uWindow) continue;
      const objectHalfLengthU = object.collisionLength / this.track.totalLength;
      if (Math.abs(object.u - state.trackU) > objectHalfLengthU) continue;
      const lateralDelta = Math.abs(state.lateralOffset - object.lateralOffset);
      if (lateralDelta > object.collisionHalfWidth + 0.9) continue;
      this.trackObjectTriggers.add(object.id);
      if (object.kind === "boost") this.vehicleController.applyPickupBoost();
      else this.vehicleController.applyObstacleHit();
    }
  }

  private handleActionEdges(): void {
    if (this.phase !== "running") return;
    const firePressed = this.input.state.fire;
    const shieldPressed = this.input.state.shield;
    if (firePressed && !this.lastFirePressed) {
      this.launch.onFire?.();
    }
    if (shieldPressed && !this.lastShieldPressed) {
      this.launch.onShield?.();
    }
    this.lastFirePressed = firePressed;
    this.lastShieldPressed = shieldPressed;
  }

  private maybeReportRaceState(now: number): void {
    if (this.phase !== "running") return;
    if (this.launch.mode !== "multiplayer" || !this.launch.onRaceReport) return;
    if (now - this.lastReportedAt < 80) return;
    this.lastReportedAt = now;
    const state = this.vehicleController.state;
    this.launch.onRaceReport({
      trackU: state.trackU,
      lateralOffset: state.lateralOffset,
      speed: state.speed,
    });
  }

  private updateSoloRaceState(): void {
    if (this.phase !== "running") return;
    if (this.vehicleController.state.trackU >= 0.999) {
      this.phase = "finished";
      this.musicSync?.stop();
      this.playRaceSfx("won");
      this.showResults({
        roomCode: "SOLO",
        setup: {
          songId: "solo",
          fictionId: this.fictionId,
          seed: 0,
          playerCap: 1,
        },
        entries: [
          {
            clientId: this.launch.localPlayerId ?? "solo",
            name: "Pilot 1",
            placement: 1,
            status: "finished",
            finishTimeMs: Math.round(this.elapsedRaceTime * 1000),
            takedowns: 0,
          },
        ],
      });
      return;
    }

    const musicTime = this.musicSync?.getCurrentTime() ?? this.elapsedRaceTime;
    if (this.songDuration !== null && musicTime >= this.songDuration) {
      this.phase = "finished";
      this.musicSync?.pause();
      this.playRaceSfx("lost");
      this.showResults({
        roomCode: "SOLO",
        setup: {
          songId: "solo",
          fictionId: this.fictionId,
          seed: 0,
          playerCap: 1,
        },
        entries: [
          {
            clientId: this.launch.localPlayerId ?? "solo",
            name: "Pilot 1",
            placement: 1,
            status: "dnf",
            finishTimeMs: null,
            takedowns: 0,
          },
        ],
      });
    }
  }

  private playRaceSfx(state: "won" | "lost"): void {
    const target = state === "won" ? this.winSfx : this.loseSfx;
    target.pause();
    target.currentTime = 0;
    void target.play().catch(() => {});
  }

  private updateHud(): void {
    const progress = Math.max(0, Math.min(100, Math.round(this.vehicleController.state.trackU * 100)));
    this.placementHud.textContent = `Place: ${this.localPlacement}`;
    this.checkpointHud.textContent = `Progress: ${progress}%`;
    this.inventoryHud.innerHTML = `Attack: ${formatCombatSlot(this.localOffensiveItem, "fire")}<br>Defense: ${formatCombatSlot(this.localDefensiveItem, "shield")}`;
    this.renderRoster();
  }

  private renderRoster(): void {
    if (this.latestRoster.length === 0) {
      this.rosterHud.textContent = `Room Status\n${this.lastStatusMessage || "Warmup lane live."}`;
      return;
    }

    const lines = this.latestRoster.map((player) => {
      const state = this.serverPlayers.get(player.clientId);
      const placement = state ? `${state.placement}.` : "-.";
      const youTag = player.clientId === this.launch.localPlayerId ? " (You)" : "";
      return `${placement} ${player.name}${youTag} - ${describePlayerStatus(player)}`;
    });
    if (this.lastStatusMessage) {
      lines.unshift(this.lastStatusMessage, "");
    }
    lines.unshift("Room Status");
    this.rosterHud.textContent = lines.join("\n");
  }

  private createDebugHud(enabled: boolean): HTMLDivElement | null {
    if (!enabled) return null;
    const hud = document.createElement("div");
    hud.style.position = "fixed";
    hud.style.bottom = "16px";
    hud.style.left = "16px";
    hud.style.zIndex = "20";
    hud.style.padding = "10px 12px";
    hud.style.background = "rgba(5, 8, 14, 0.82)";
    hud.style.border = "1px solid rgba(20, 241, 255, 0.35)";
    hud.style.borderRadius = "8px";
    hud.style.color = "#d7f9ff";
    hud.style.font = "12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace";
    hud.style.whiteSpace = "pre";
    hud.style.pointerEvents = "none";
    return hud;
  }

  private updateDebugHud(): void {
    if (!this.debugHud) return;
    const state = this.vehicleController.state;
    this.debugHud.textContent = [
      `phase ${this.phase}`,
      `trackU ${state.trackU.toFixed(3)}`,
      `speed ${state.speed.toFixed(1)} m/s`,
      `place ${this.localPlacement}`,
      `cp ${this.localCheckpointIndex + 1}/${this.latestCheckpointCount}`,
      `audio ${this.audioReady ? "ready" : "loading"}`,
      `last ${this.lastStatusMessage || "--"}`,
    ].join("\n");
  }

  private readonly render = (time: number): void => {
    if (this.destroyed) return;
    const deltaSeconds = (time - this.lastFrameTime) / 1000;
    this.lastFrameTime = time;
    const now = Date.now();

    if (this.phase === "countdown") {
      const remainingMs = Math.max(0, this.pendingStartAt - now);
      const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
      this.statusTitle.textContent = seconds.toString();
      this.statusSubtitle.textContent = "Grid locked. Audio synced. Stand by.";
      if (!this.countdownStarted && remainingMs === 0) {
        this.enterRunningPhase();
      }
    } else if (this.phase === "staging") {
      this.statusOverlay.style.display = "none";
      this.vehicleController.update(deltaSeconds, this.input.state);
      this.handleTrackObjects();
      this.handleActionEdges();
    } else if (this.phase === "running") {
      const localTakenDown = this.localTakenDownUntil > now;
      if (!localTakenDown) {
        this.elapsedRaceTime += deltaSeconds;
        this.vehicleController.update(deltaSeconds, this.input.state);
        this.handleTrackObjects();
      }
      this.handleActionEdges();
      this.maybeReportRaceState(now);
      if (this.launch.mode !== "multiplayer") {
        this.updateSoloRaceState();
      }
    }

    const musicTime = this.phase === "running" ? (this.musicSync?.getCurrentTime() ?? this.elapsedRaceTime) : 0;
    this.latestReactiveBands = this.phase === "running" ? (this.musicSync?.getReactiveBands() ?? null) : null;
    this.updateCarTransform(deltaSeconds);
    this.updateRemoteCars(deltaSeconds);
    this.updateBoostVisuals();
    this.updatePickupVisuals(time / 1000);
    this.combatVfx.update(performance.now());
    this.updateCamera(deltaSeconds);
    this.environment.update(this.elapsedRaceTime, musicTime, this.vehicleController.state.trackU, this.latestReactiveBands);
    this.updateHud();
    this.updateDebugHud();
    this.composer.render();
    this.animationFrameId = window.requestAnimationFrame(this.render);
  };

  private disposeSceneGraph(): void {
    this.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.geometry.dispose();
      this.disposeMaterial(object.material);
    });
  }

  private disposeMaterial(material: Mesh["material"]): void {
    if (Array.isArray(material)) {
      for (const candidate of material) candidate.dispose();
      return;
    }
    material.dispose();
  }
}

function paletteForVariant(variant: CarVariant): CarPalette {
  switch (variant) {
    case "ember":
      return {
        body: new Color("#ff825c"),
        bodyEmissive: new Color("#7b220d"),
        cockpit: new Color("#1e1010"),
        cockpitEmissive: new Color("#4a2b1f"),
      };
    case "nova":
      return {
        body: new Color("#f6f06d"),
        bodyEmissive: new Color("#615d0e"),
        cockpit: new Color("#14161b"),
        cockpitEmissive: new Color("#393e49"),
      };
    case "ghost":
      return {
        body: new Color("#caa8ff"),
        bodyEmissive: new Color("#432667"),
        cockpit: new Color("#120f1d"),
        cockpitEmissive: new Color("#2c2550"),
      };
    case "vector":
    default:
      return {
        body: new Color("#14f1ff"),
        bodyEmissive: new Color("#0f6d74"),
        cockpit: new Color("#0e1320"),
        cockpitEmissive: new Color("#1b2744"),
      };
  }
}

function formatItemLabel(item: PickupSpawnState["kind"] | null): string {
  switch (item) {
    case "missile":
      return "Missile";
    case "shield":
      return "Shield";
    default:
      return "None";
  }
}

function formatCombatSlot(item: PickupSpawnState["kind"] | null, slot: "fire" | "shield"): string {
  const label = formatItemLabel(item);
  if (item === null) return label;
  return slot === "fire" ? `${label} [Space/F]` : `${label} [R]`;
}

function describePlayerStatus(player: RoomPlayerState): string {
  if (player.isActiveRacer) {
    if (player.preload.sceneReady && player.preload.audioReady) {
      return "Ready";
    }
    if (player.preload.audioReady) {
      return "Waiting for other players";
    }
    return "Loading track";
  }
  if (player.ready) {
    return "Ready in lobby";
  }
  return "In lobby";
}

function formatTimeMs(value: number): string {
  const minutes = Math.floor(value / 60000);
  const seconds = (value % 60000) / 1000;
  return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}
