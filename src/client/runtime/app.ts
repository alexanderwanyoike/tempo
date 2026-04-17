import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
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
  SphereGeometry,
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
import { CombatVfx } from "./combat-vfx";
import {
  applyCarTransform,
  getCarAssetDefinition,
  isSharedCarMesh,
  loadCarMesh,
} from "./car-assets";
import { TouchControls } from "./touch-controls";
import { loadSongDefinition } from "./song-loader";
import type { Track, TrackObject } from "./track-builder";
import { TestTrack } from "./track-builder";
import { TrackGenerator } from "./track-generator";
import { VehicleController, defaultVehicleTuning, type VehicleState } from "./vehicle-controller";

type TrailSample = {
  position: Vector3;
  quaternion: Quaternion;
  boost: number;
};

type SpeedTracerLayer = {
  mesh: Mesh;
  material: MeshBasicMaterial;
  side: 1 | -1;
  lateralOffset: number;
  verticalOffset: number;
  sampleStride: number;
  sampleOffset: number;
};

type AppPhase = "staging" | "countdown" | "running" | "finished";
type AppMode = "solo" | "multiplayer";
type CameraMode = "stable" | "wild";

type RemoteCarVisual = {
  id: string;
  variant: CarVariant;
  group: Group;
  bodyPivot: Group;
  fallbackGroup: Group;
  fallbackBodyMaterial: MeshStandardMaterial;
  fallbackCockpitMaterial: MeshStandardMaterial;
  feedbackGlow: Mesh;
  feedbackGlowMaterial: MeshBasicMaterial;
  assetGroup: Group | null;
  assetRevision: number;
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

type CountdownResetTransition = {
  startedAt: number;
  durationMs: number;
  fromTrackU: number;
  fromLateralOffset: number;
  fromSpeed: number;
  toTrackU: number;
  toLateralOffset: number;
  toSpeed: number;
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
  steeringSensitivity?: number;
  mode?: AppMode;
  localPlayerId?: string | null;
  localPlayerName?: string | null;
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
const NAME_LABEL_FULL_RANGE = 110;
const NAME_LABEL_FADE_RANGE = 140;
// Mirrors server SHIELD_DURATION_MS. Purely cosmetic - the server is the
// source of truth for the actual shield window.
const SHIELD_VISUAL_DURATION_MS = 120000;

export class App {
  private static readonly WORLD_UP = new Vector3(0, 1, 0);
  private static readonly BOOST_COLOR = new Color("#57ff36");
  private static readonly BOOST_HOT_COLOR = new Color("#c8ff7a");
  private static readonly TRACER_COLOR = new Color("#7dff48");
  private static readonly TRACER_HOT_COLOR = new Color("#f9fff2");
  private static readonly SLOWDOWN_FLASH_COLOR = new Color("#ff4b4b");
  private static readonly WIN_SFX_URL = new URL("../../../assets/audio/Win Backspin.wav", import.meta.url).href;
  private static readonly LOSE_SFX_URL = new URL("../../../assets/audio/Lose Backspin.wav", import.meta.url).href;

  private readonly renderer: WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly localVehicle: RemoteCarVisual;
  private readonly combatVfx: CombatVfx;
  private readonly pickupGroup = new Group();
  private readonly boostTrailGroup = new Group();
  private readonly boostTrailMeshes: Mesh[] = [];
  private readonly boostTrailMaterials: MeshBasicMaterial[] = [];
  private readonly boostTrailHistory: TrailSample[] = [];
  private readonly speedTracerGroup = new Group();
  private readonly speedTracers: SpeedTracerLayer[] = [];
  private readonly remoteCars = new Map<string, RemoteCarVisual>();
  private readonly pickupVisuals = new Map<string, PickupVisual>();
  private readonly winSfx = new Audio(App.WIN_SFX_URL);
  private readonly loseSfx = new Audio(App.LOSE_SFX_URL);
  private readonly input: VehicleInput;
  private readonly touchControls: TouchControls | null;
  private readonly vehicleController: VehicleController;
  private readonly cameraMode: CameraMode;
  private track: Track;
  private trackObjects: readonly TrackObject[];
  private readonly musicSync: MusicSync | null;
  private environment: EnvironmentRuntime;
  private fictionId: EnvironmentFictionId;
  private readonly songDuration: number | null;
  private readonly runtimeUiStyles: HTMLStyleElement;
  private readonly debugHud: HTMLDivElement | null;
  private readonly hud: HTMLDivElement;
  private readonly placementHud: HTMLDivElement;
  private readonly checkpointHud: HTMLDivElement;
  private readonly checkpointBarHud: HTMLDivElement;
  private readonly offensiveHud: HTMLDivElement;
  private readonly defensiveHud: HTMLDivElement;
  private readonly summaryHud: HTMLDivElement;
  private readonly rosterHud: HTMLDivElement;
  private readonly rosterListHud: HTMLDivElement;
  private readonly nameLabelLayer: HTMLDivElement;
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
  private readonly stableCameraForward = new Vector3(0, 0, -1);
  private readonly stableCameraRight = new Vector3(1, 0, 0);
  private readonly stableCameraLift = new Vector3(0, 1, 0);
  private readonly smoothedCameraPosition = new Vector3();
  private readonly smoothedCameraLookTarget = new Vector3();
  private readonly smoothedCameraUp = new Vector3(0, 1, 0);
  private readonly tempVector = new Vector3();
  private readonly tempVectorB = new Vector3();
  private readonly trackObjectTriggers = new Set<string>();
  private readonly serverPlayers = new Map<string, RacePlayerState>();
  private readonly nameLabels = new Map<string, HTMLDivElement>();
  private readonly reducedFx: boolean;
  private readonly boostTrailSampleLimit: number;
  private readonly baseBloomStrength = 0.4;

  private animationFrameId: number | null = null;
  private destroyed = false;
  private visualsInitialized = false;
  private lastFrameTime = 0;
  private sceneElapsedTime = 0;
  private elapsedRaceTime = 0;
  private latestReactiveBands: ReactiveBands | null = null;
  private phase: AppPhase = "staging";
  private stagingOpenedAt = 0;
  private pendingStartAt = 0;
  private countdownDurationMs = 2500;
  private countdownResetTransition: CountdownResetTransition | null = null;
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
  private soloCountdownTimer: number | null = null;
  private latestRoster: RoomPlayerState[] = [];
  private lastStatusMessage = "";
  private boostSurge = 0;
  private pickupSurge = 0;
  private impactSurge = 0;
  private slowdownFlash = 0;

  static async create(
    root: HTMLElement,
    config: ClientConfig,
    launch: AppLaunchOptions = {},
  ): Promise<App> {
    const songUrl = launch.songUrl;
    const fictionId = clampFictionId(launch.fictionId ?? null);

    let track: Track;
    let musicSync: MusicSync | null = null;
    let song: SongDefinition | null = null;
    let seed = 0;
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
        song = await songPromise;
        seed = launch.seed ?? song.baseSeed;
        track = new TrackGenerator(song, seed);
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
      song,
      seed,
      fictionId,
      launch,
      launch.debugHud ?? false,
      musicReadyPromise,
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
  ) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.reducedFx = window.matchMedia("(pointer: coarse)").matches;
    this.boostTrailSampleLimit = this.reducedFx ? 30 : 42;

    this.scene = new Scene();
    this.scene.background = new Color("#05070c");

    this.camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 1.0, 2000);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new Vector2(window.innerWidth, window.innerHeight),
      this.baseBloomStrength,
      0.42,
      0.3,
    );
    this.composer.addPass(this.bloomPass);

    this.localVehicle = this.createVehicleVisual(launch.carVariant ?? "vector");
    this.scene.add(this.localVehicle.group);

    this.input = new VehicleInput();
    const steeringSensitivity = MathUtils.clamp(launch.steeringSensitivity ?? 1.18, 0.85, 2.5);
    this.touchControls = window.matchMedia("(pointer: coarse)").matches
      ? new TouchControls(this.input.state, steeringSensitivity)
      : null;
    this.vehicleController = new VehicleController(buildVehicleTuning(steeringSensitivity));
    this.vehicleController.forceTrackState(START_TRACK_U);
    this.musicSync = musicSync;
    this.songDuration = song?.duration ?? null;
    this.cameraMode = "wild";
    this.fictionId = fictionId;
    this.track = track;
    this.trackObjects = this.track.getTrackObjects();
    this.environment = new EnvironmentRuntime(this.scene, this.track, song, seed, fictionId);
    this.scene.add(this.environment.group);
    this.scene.add(this.track.meshGroup);
    this.scene.add(this.pickupGroup);
    this.scene.add(this.boostTrailGroup);
    this.scene.add(this.speedTracerGroup);
    this.scene.add(this.camera);
    this.combatVfx = new CombatVfx(
      this.scene,
      (id) => this.getVehicleGroup(id),
      this.root,
    );
    this.createBoostTrailMeshes();
    this.createSpeedTracerMeshes();
    this.configureSfx();

    this.vehicleController.setTrack(this.track);
    this.vehicleController.setTrackQuery((pos, hintU) => this.track.queryNearest(pos, hintU));
    this.vehicleController.forceTrackState(START_TRACK_U);

    this.latestRoster = [...(launch.roster ?? [])];
    this.runtimeUiStyles = this.createRuntimeUiStyles();
    this.debugHud = this.createDebugHud(debugHudEnabled);
    this.hud = this.createHud();
    this.placementHud = this.hud.querySelector(".tempo-hud-place-value") as HTMLDivElement;
    this.checkpointHud = this.hud.querySelector(".tempo-hud-progress-value") as HTMLDivElement;
    this.checkpointBarHud = this.hud.querySelector(".tempo-hud-progress-fill") as HTMLDivElement;
    this.offensiveHud = this.hud.querySelector(".tempo-hud-slot-value[data-slot='attack']") as HTMLDivElement;
    this.defensiveHud = this.hud.querySelector(".tempo-hud-slot-value[data-slot='defense']") as HTMLDivElement;
    this.summaryHud = this.hud.querySelector(".tempo-hud-summary") as HTMLDivElement;
    this.rosterHud = this.hud.querySelector(".tempo-hud-summary-status") as HTMLDivElement;
    this.rosterListHud = this.hud.querySelector(".tempo-hud-standings") as HTMLDivElement;
    this.nameLabelLayer = this.createNameLabelLayer();

    const statusUi = this.createStatusOverlay();
    this.statusOverlay = statusUi.overlay;
    this.statusTitle = statusUi.title;
    this.statusSubtitle = statusUi.subtitle;
    this.statusBody = statusUi.body;
    this.primaryButton = statusUi.primaryButton;
    this.secondaryButton = statusUi.secondaryButton;

    if (launch.mode === "multiplayer") {
      this.statusOverlay.style.display = "none";
      this.lastStatusMessage = "Loading lane forming. Audio buffering.";
    } else {
      this.setOverlayMessage(
        "Loading Fiction Online",
        "Spinning up the loading lane while the track audio buffers.",
      );
    }
  }

  start(): void {
    this.root.append(this.runtimeUiStyles, this.renderer.domElement, this.hud, this.nameLabelLayer, this.statusOverlay);
    if (this.debugHud) this.root.appendChild(this.debugHud);
    this.touchControls?.attach(this.root);
    this.stagingOpenedAt = Date.now();
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
    if (this.soloCountdownTimer !== null) {
      window.clearTimeout(this.soloCountdownTimer);
      this.soloCountdownTimer = null;
    }

    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.input.detach();
    this.touchControls?.detach();
    this.combatVfx.dispose();
    this.musicSync?.stop();
    this.winSfx.pause();
    this.loseSfx.pause();
    this.clearNameLabels();
    this.renderer.dispose();
    this.disposeSceneGraph();
    this.root.replaceChildren();
  }

  setRoomState(players: RoomPlayerState[], phase: AppPhase | "lobby"): void {
    this.latestRoster = [...players];
    this.syncNameLabels();
    const nextPhase = phase === "lobby" ? "staging" : phase;
    if (nextPhase === "staging" && this.phase !== "staging") {
      this.stagingOpenedAt = Date.now();
    }
    if (this.launch.mode === "multiplayer" && nextPhase === "running") {
      this.enterRunningPhase();
    } else {
      this.phase = nextPhase;
    }
    this.renderRoster();

    if (this.launch.mode !== "multiplayer") return;
    if (phase === "lobby") return;
    this.refreshMultiplayerStatusMessage();
  }

  beginCountdown(startAt: number): void {
    if (this.phase === "finished") return;
    if (this.soloCountdownTimer !== null) {
      window.clearTimeout(this.soloCountdownTimer);
      this.soloCountdownTimer = null;
    }
    this.countdownDurationMs = Math.max(1, startAt - Date.now());
    this.pendingStartAt = startAt;
    this.phase = "countdown";
    this.countdownStarted = false;
    this.beginCountdownResetTransition();
    this.touchControls?.setVisible(false);
    this.statusOverlay.dataset.overlayState = "countdown";
    this.statusOverlay.style.display = "flex";
    this.statusBody.replaceChildren();
    this.statusBody.style.display = "none";
    this.primaryButton.style.display = "none";
    this.secondaryButton.style.display = "none";
    this.refreshMultiplayerStatusMessage();
  }

  private enterRunningPhase(): void {
    this.countdownResetTransition = null;
    this.phase = "running";
    this.countdownStarted = true;
    this.statusOverlay.style.display = "none";
    this.touchControls?.setVisible(true);
    this.musicSync?.play();
    this.refreshMultiplayerStatusMessage();
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
        this.removeNameLabel(clientId);
      }
    }

    this.syncPickupVisuals(pickups);
  }

  applyRaceEvent(event: RaceEvent): void {
    const now = performance.now();
    const localId = this.launch.localPlayerId;

    if (event.kind === "pickup" && event.actorId === localId) {
      this.triggerPickupSurge(0.9);
      this.combatVfx.spawnPickupPulse(
        this.localVehicle.group.position.clone(),
        this.getVehicleForward(localId ?? ""),
        event.item === "missile" ? "#ff5db8" : "#7ce7ff",
        now,
      );
      this.lastStatusMessage = event.item === "missile"
        ? "Missile ready. Press Space/F or tap Fire."
        : "Shield ready. Press R or tap Shield.";
      return;
    }
    if (event.kind === "fire") {
      const actorPosition = this.getVehiclePosition(event.actorId);
      if (!actorPosition) return;
      const actorForward = this.getVehicleForward(event.actorId);
      const targetPosition = event.targetId
        ? this.getVehiclePosition(event.targetId)
        : null;
      const endPosition = targetPosition ?? actorPosition.clone().addScaledVector(actorForward, 18);
      this.combatVfx.spawnMissile(
        actorPosition,
        endPosition,
        () => {
          const impactNow = performance.now();
          if (event.outcome === "blocked" && event.targetId) {
            this.combatVfx.clearShield(event.targetId);
            this.combatVfx.spawnBlock(event.targetId, impactNow);
            if (event.actorId === localId || event.targetId === localId) {
              this.triggerImpactSurge(0.55);
            }
            return;
          }
          if (event.outcome === "takedown" && event.targetId) {
            this.combatVfx.clearShield(event.targetId);
            this.combatVfx.spawnImpact(event.targetId, impactNow);
            if (event.actorId === localId || event.targetId === localId) {
              this.triggerImpactSurge(0.92);
            }
            if (event.targetId === localId) {
              this.combatVfx.flashLocalTakedown(impactNow);
            }
          }
        },
        now,
      );
      if (event.actorId === localId && event.outcome === "miss") {
        this.lastStatusMessage = "Missile fired. No lock.";
      }
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
      if (event.targetId === localId) {
        this.lastStatusMessage = "Shield cracked a missile.";
      }
      return;
    }
    if (event.kind === "takedown") {
      this.combatVfx.clearShield(event.targetId);
      if (event.actorId === localId) {
        this.lastStatusMessage = "Direct hit. Target crashed.";
      } else if (event.targetId === localId) {
        this.lastStatusMessage = "Rocket hit. Crashing out.";
      }
      return;
    }
    if (event.kind === "respawn") {
      this.combatVfx.clearShield(event.targetId);
      if (event.targetId === localId) {
        this.lastStatusMessage = "Recovered. Rejoining the line.";
      }
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

  private getVehiclePosition(id: string): Vector3 | null {
    const group = this.getVehicleGroup(id);
    return group ? group.position.clone() : null;
  }

  private getVehicleForward(id: string): Vector3 {
    const group = this.getVehicleGroup(id);
    if (!group) return new Vector3(0, 0, -1);
    return new Vector3(0, 0, -1).applyQuaternion(group.quaternion).normalize();
  }

  showResults(results: RaceResults): void {
    this.phase = "finished";
    this.musicSync?.stop();
    this.touchControls?.setVisible(false);
    this.statusOverlay.dataset.overlayState = "results";
    this.statusOverlay.style.display = "flex";
    this.statusBody.style.display = "grid";
    const winner = results.entries[0] ?? null;
    if (this.launch.mode === "multiplayer") {
      const winnerByFinishLine = winner?.status === "finished";
      this.statusTitle.textContent = "Winner";
      this.statusSubtitle.textContent = winnerByFinishLine
        ? `${winner?.name ?? "Winner"} hit the finish line first.`
        : `${winner?.name ?? "Winner"} was leading when the track ended.`;
    } else {
      this.statusTitle.textContent = "Results";
      this.statusSubtitle.textContent = `${results.entries[0]?.name ?? "Winner"} takes the line first.`;
    }
    this.statusBody.replaceChildren(...results.entries.map((entry, index) => this.createResultRow(entry, index === 0)));
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
        this.scheduleSoloCountdown();
      } else if (this.phase === "staging") {
        this.refreshMultiplayerStatusMessage();
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

    const fallbackGroup = new Group();
    fallbackGroup.add(body, cockpit);

    const feedbackGlowMaterial = new MeshBasicMaterial({
      color: App.BOOST_COLOR.clone(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const feedbackGlow = new Mesh(new CylinderGeometry(0.72, 1.02, 0.08, 24), feedbackGlowMaterial);
    feedbackGlow.position.y = 0.08;

    const bodyPivot = new Group();
    bodyPivot.add(fallbackGroup, feedbackGlow);

    const group = new Group();
    group.add(bodyPivot);

    const visual: RemoteCarVisual = {
      id: "",
      variant,
      group,
      bodyPivot,
      fallbackGroup,
      fallbackBodyMaterial: bodyMaterial,
      fallbackCockpitMaterial: cockpitMaterial,
      feedbackGlow,
      feedbackGlowMaterial,
      assetGroup: null,
      assetRevision: 0,
      targetTrackU: START_TRACK_U,
      targetLateralOffset: 0,
      currentTrackU: START_TRACK_U,
      currentLateralOffset: 0,
    };
    void this.hydrateVehicleVisual(visual);
    return visual;
  }

  private async hydrateVehicleVisual(visual: RemoteCarVisual): Promise<void> {
    const definition = getCarAssetDefinition(visual.variant);
    const revision = ++visual.assetRevision;
    try {
      const asset = await loadCarMesh(this.config, visual.variant);
      if (this.destroyed || revision !== visual.assetRevision) return;
      applyCarTransform(asset, definition.raceTransform);
      if (visual.assetGroup) {
        visual.bodyPivot.remove(visual.assetGroup);
      }
      visual.assetGroup = asset;
      visual.bodyPivot.add(asset);
      visual.fallbackGroup.visible = false;
    } catch (error) {
      console.error(`Failed to load race mesh for ${visual.variant}:`, error);
    }
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
    const trailCount = this.reducedFx ? 8 : 14;
    for (let i = 0; i < trailCount; i++) {
      const material = new MeshBasicMaterial({
        color: App.BOOST_COLOR.clone(),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const mesh = new Mesh(trailGeometry, material);
      mesh.visible = false;
      this.boostTrailMaterials.push(material);
      this.boostTrailMeshes.push(mesh);
      this.boostTrailGroup.add(mesh);
    }
  }

  private createSpeedTracerMeshes(): void {
    const tracerGeometry = new BoxGeometry(0.13, 0.09, 1);
    const tracerCount = this.reducedFx ? 8 : 14;
    for (let i = 0; i < tracerCount; i++) {
      const material = new MeshBasicMaterial({
        color: App.TRACER_COLOR.clone(),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const mesh = new Mesh(tracerGeometry, material);
      mesh.visible = false;
      this.speedTracerGroup.add(mesh);
      const side: 1 | -1 = i % 2 === 0 ? 1 : -1;
      this.speedTracers.push({
        mesh,
        material,
        side,
        lateralOffset: side * (0.44 + ((i * 3) % 5) * 0.12),
        verticalOffset: 0.1 + ((i * 5) % 4) * 0.05,
        sampleStride: this.reducedFx ? 2 : 3,
        sampleOffset: 1 + i,
      });
    }
  }

  private configureSfx(): void {
    for (const sfx of [this.winSfx, this.loseSfx]) {
      sfx.preload = "auto";
      sfx.volume = 0.92;
    }
  }

  private createRuntimeUiStyles(): HTMLStyleElement {
    const style = document.createElement("style");
    style.textContent = `
      @font-face {
        font-family: "Tempo Display";
        src: url("/fonts/oxanium-600.woff2") format("woff2");
        font-style: normal;
        font-weight: 600;
        font-display: swap;
      }

      @font-face {
        font-family: "Tempo Display";
        src: url("/fonts/oxanium-700.woff2") format("woff2");
        font-style: normal;
        font-weight: 700;
        font-display: swap;
      }

      @font-face {
        font-family: "Tempo Sans";
        src: url("/fonts/rajdhani-500.woff2") format("woff2");
        font-style: normal;
        font-weight: 500;
        font-display: swap;
      }

      @font-face {
        font-family: "Tempo Sans";
        src: url("/fonts/rajdhani-600.woff2") format("woff2");
        font-style: normal;
        font-weight: 600;
        font-display: swap;
      }

      @font-face {
        font-family: "Tempo Sans";
        src: url("/fonts/rajdhani-700.woff2") format("woff2");
        font-style: normal;
        font-weight: 700;
        font-display: swap;
      }

      .tempo-runtime-hud,
      .tempo-name-label-layer,
      .tempo-runtime-overlay,
      .tempo-debug-hud {
        --tempo-hud-bg: rgba(4, 10, 18, 0.78);
        --tempo-hud-panel: linear-gradient(180deg, rgba(10, 20, 31, 0.92), rgba(3, 8, 15, 0.86));
        --tempo-hud-border: rgba(104, 231, 255, 0.28);
        --tempo-hud-glow: rgba(36, 215, 255, 0.12);
        --tempo-hud-accent: #7cf9ff;
        --tempo-hud-accent-hot: #bffcff;
        --tempo-hud-boost: #86ff56;
        --tempo-hud-danger: #ff5a6f;
        --tempo-hud-text: #f1fbff;
        --tempo-hud-muted: rgba(188, 228, 240, 0.74);
        --tempo-hud-shadow: 0 18px 64px rgba(0, 0, 0, 0.42);
      }

      .tempo-runtime-hud {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 10;
        font-family: "Tempo Sans", ui-sans-serif, sans-serif;
        color: var(--tempo-hud-text);
      }

      .tempo-hud-card {
        position: relative;
        overflow: hidden;
        background: var(--tempo-hud-panel);
        border: 1px solid var(--tempo-hud-border);
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.03),
          0 0 0 1px rgba(124, 249, 255, 0.05),
          0 10px 36px rgba(0, 0, 0, 0.35),
          0 0 40px var(--tempo-hud-glow);
        backdrop-filter: blur(10px);
      }

      .tempo-hud-card::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          linear-gradient(135deg, rgba(124, 249, 255, 0.12), transparent 42%),
          repeating-linear-gradient(
            180deg,
            rgba(255, 255, 255, 0.025) 0,
            rgba(255, 255, 255, 0.025) 1px,
            transparent 1px,
            transparent 9px
          );
        pointer-events: none;
        mix-blend-mode: screen;
      }

      .tempo-hud-card::after {
        content: "";
        position: absolute;
        inset: auto 14px 0 14px;
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(124, 249, 255, 0.6), transparent);
        pointer-events: none;
      }

      .tempo-hud-race {
        position: absolute;
        top: 16px;
        left: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: min(280px, calc(100vw - 32px));
      }

      .tempo-hud-place {
        padding: 12px 14px 13px;
        clip-path: polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 0 100%);
      }

      .tempo-hud-kicker {
        color: var(--tempo-hud-muted);
        font: 700 11px/1 "Tempo Sans", ui-sans-serif, sans-serif;
        letter-spacing: 0.22em;
        text-transform: uppercase;
      }

      .tempo-hud-place-value {
        margin-top: 6px;
        font: 700 clamp(32px, 4vw, 46px)/0.9 "Tempo Display", ui-sans-serif, sans-serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--tempo-hud-accent-hot);
        text-shadow: 0 0 22px rgba(124, 249, 255, 0.2);
      }

      .tempo-hud-progress {
        padding: 11px 14px 13px;
        clip-path: polygon(0 0, 100% 0, 100% calc(100% - 12px), calc(100% - 16px) 100%, 0 100%);
      }

      .tempo-hud-progress-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 12px;
      }

      .tempo-hud-progress-value {
        font: 700 20px/1 "Tempo Display", ui-sans-serif, sans-serif;
        letter-spacing: 0.12em;
        color: var(--tempo-hud-accent-hot);
      }

      .tempo-hud-progress-rail {
        margin-top: 10px;
        height: 6px;
        background: rgba(96, 174, 192, 0.16);
        border: 1px solid rgba(96, 174, 192, 0.18);
        overflow: hidden;
      }

      .tempo-hud-progress-fill {
        width: 100%;
        height: 100%;
        transform-origin: left center;
        transform: scaleX(0);
        background: linear-gradient(90deg, rgba(124, 249, 255, 0.2), rgba(124, 249, 255, 0.9), rgba(134, 255, 86, 0.8));
        box-shadow: 0 0 18px rgba(124, 249, 255, 0.35);
      }

      .tempo-hud-combat {
        position: absolute;
        left: 16px;
        bottom: 16px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 180px));
        gap: 10px;
        width: min(370px, calc(100vw - 32px));
      }

      .tempo-hud-slot {
        padding: 10px 12px 11px;
        clip-path: polygon(0 0, 100% 0, 100% 100%, 14px 100%, 0 calc(100% - 14px));
      }

      .tempo-hud-slot-value {
        margin-top: 7px;
        font: 700 18px/1.05 "Tempo Sans", ui-sans-serif, sans-serif;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--tempo-hud-text);
      }

      .tempo-hud-slot-value.is-empty {
        color: rgba(188, 228, 240, 0.54);
      }

      .tempo-hud-slot-value.is-active {
        color: var(--tempo-hud-accent-hot);
        text-shadow: 0 0 20px rgba(124, 249, 255, 0.14);
      }

      .tempo-hud-summary {
        position: absolute;
        top: 16px;
        right: 16px;
        width: min(312px, calc(100vw - 32px));
        padding: 12px 14px 13px;
        clip-path: polygon(16px 0, 100% 0, 100% 100%, 0 100%, 0 16px);
      }

      .tempo-hud-summary-status {
        color: var(--tempo-hud-accent-hot);
        font: 600 16px/1.1 "Tempo Sans", ui-sans-serif, sans-serif;
        letter-spacing: 0.06em;
      }

      .tempo-hud-standings {
        display: grid;
        gap: 8px;
        margin-top: 12px;
      }

      .tempo-hud-standings-row {
        display: grid;
        grid-template-columns: 36px minmax(0, 1fr);
        gap: 10px;
        align-items: center;
        padding: 8px 0 0;
        border-top: 1px solid rgba(124, 249, 255, 0.12);
      }

      .tempo-hud-standings-row.is-local {
        color: var(--tempo-hud-accent-hot);
      }

      .tempo-hud-standings-rank {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 30px;
        background: rgba(124, 249, 255, 0.1);
        border: 1px solid rgba(124, 249, 255, 0.22);
        font: 700 16px/1 "Tempo Display", ui-sans-serif, sans-serif;
        letter-spacing: 0.08em;
      }

      .tempo-hud-standings-copy {
        min-width: 0;
      }

      .tempo-hud-standings-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font: 700 18px/1 "Tempo Sans", ui-sans-serif, sans-serif;
        letter-spacing: 0.08em;
      }

      .tempo-hud-standings-meta {
        margin-top: 4px;
        color: var(--tempo-hud-muted);
        font: 600 11px/1.2 "Tempo Sans", ui-sans-serif, sans-serif;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .tempo-name-label-layer {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 11;
      }

      .tempo-name-label {
        position: absolute;
        left: 0;
        top: 0;
        padding: 5px 9px;
        border: 1px solid rgba(134, 255, 86, 0.34);
        border-radius: 999px;
        background: rgba(4, 8, 14, 0.88);
        box-shadow: 0 0 18px rgba(134, 255, 86, 0.16);
        color: #f7fffd;
        font: 700 12px/1 "Tempo Sans", ui-sans-serif, sans-serif;
        letter-spacing: 0.12em;
        white-space: nowrap;
        transform: translate(-50%, -100%);
        opacity: 0;
        display: none;
      }

      .tempo-runtime-overlay {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background:
          radial-gradient(circle at top, rgba(124, 249, 255, 0.08), transparent 42%),
          rgba(2, 4, 9, 0.62);
        pointer-events: none;
        z-index: 15;
        font-family: "Tempo Sans", ui-sans-serif, sans-serif;
      }

      .tempo-runtime-overlay-panel {
        width: min(760px, calc(100vw - 48px));
        padding: 26px 26px 24px;
        background: linear-gradient(180deg, rgba(7, 14, 24, 0.96), rgba(3, 8, 16, 0.92));
        border: 1px solid rgba(124, 249, 255, 0.24);
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.03),
          var(--tempo-hud-shadow),
          0 0 60px rgba(124, 249, 255, 0.08);
        pointer-events: auto;
        clip-path: polygon(0 0, calc(100% - 20px) 0, 100% 20px, 100% 100%, 22px 100%, 0 calc(100% - 22px));
      }

      .tempo-runtime-overlay-title {
        color: var(--tempo-hud-accent-hot);
        font: 700 clamp(40px, 8vw, 84px)/0.88 "Tempo Display", ui-sans-serif, sans-serif;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        text-shadow: 0 0 28px rgba(124, 249, 255, 0.18);
      }

      .tempo-runtime-overlay[data-overlay-state="countdown"] .tempo-runtime-overlay-title {
        font-size: clamp(78px, 18vw, 150px);
      }

      .tempo-runtime-overlay-subtitle {
        margin-top: 12px;
        color: var(--tempo-hud-muted);
        font: 600 14px/1.4 "Tempo Sans", ui-sans-serif, sans-serif;
        letter-spacing: 0.2em;
        text-transform: uppercase;
      }

      .tempo-runtime-overlay-body {
        display: none;
        margin-top: 18px;
      }

      .tempo-runtime-overlay-results {
        gap: 10px;
      }

      .tempo-runtime-result-row {
        display: grid;
        grid-template-columns: 56px minmax(0, 1fr) auto auto;
        gap: 12px;
        align-items: center;
        padding: 12px 14px;
        background: rgba(9, 20, 32, 0.78);
        border: 1px solid rgba(124, 249, 255, 0.12);
      }

      .tempo-runtime-result-row.is-winner {
        border-color: rgba(134, 255, 86, 0.32);
        box-shadow: 0 0 26px rgba(134, 255, 86, 0.08);
      }

      .tempo-runtime-result-rank {
        color: var(--tempo-hud-accent-hot);
        font: 700 26px/1 "Tempo Display", ui-sans-serif, sans-serif;
        letter-spacing: 0.1em;
      }

      .tempo-runtime-result-copy {
        min-width: 0;
      }

      .tempo-runtime-result-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font: 700 20px/1 "Tempo Sans", ui-sans-serif, sans-serif;
        letter-spacing: 0.08em;
      }

      .tempo-runtime-result-status {
        margin-top: 4px;
        color: var(--tempo-hud-muted);
        font: 600 11px/1.2 "Tempo Sans", ui-sans-serif, sans-serif;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }

      .tempo-runtime-result-time,
      .tempo-runtime-result-takedowns {
        text-align: right;
        font: 700 16px/1 "Tempo Display", ui-sans-serif, sans-serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--tempo-hud-text);
      }

      .tempo-runtime-result-takedowns {
        min-width: 56px;
      }

      .tempo-runtime-overlay-actions {
        display: flex;
        justify-content: center;
        gap: 12px;
        margin-top: 22px;
      }

      .tempo-runtime-overlay-button {
        min-width: 172px;
        padding: 12px 18px;
        border: 1px solid rgba(124, 249, 255, 0.24);
        background: linear-gradient(135deg, rgba(121, 245, 255, 0.18), rgba(134, 255, 86, 0.16));
        color: var(--tempo-hud-accent-hot);
        font: 700 14px/1 "Tempo Sans", ui-sans-serif, sans-serif;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        cursor: pointer;
        clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px));
        transition: transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
      }

      .tempo-runtime-overlay-button:hover,
      .tempo-runtime-overlay-button:focus-visible {
        transform: translateY(-1px);
        border-color: rgba(124, 249, 255, 0.46);
        box-shadow: 0 0 26px rgba(124, 249, 255, 0.14);
      }

      .tempo-debug-hud {
        position: fixed;
        bottom: 16px;
        left: 16px;
        z-index: 20;
        padding: 10px 12px;
        background: rgba(5, 8, 14, 0.82);
        border: 1px solid rgba(20, 241, 255, 0.35);
        color: #d7f9ff;
        font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre;
        pointer-events: none;
      }

      .tempo-touch-overlay {
        position: fixed;
        inset: 0;
        z-index: 25;
        pointer-events: none;
        font-family: "Tempo Sans", ui-sans-serif, sans-serif;
      }

      .tempo-touch-stick-area {
        position: absolute;
        left: 18px;
        bottom: 18px;
        width: 152px;
        height: 152px;
        pointer-events: auto;
      }

      .tempo-touch-stick-base {
        position: absolute;
        inset: 0;
        overflow: hidden;
        border: 1px solid rgba(124, 249, 255, 0.26);
        border-radius: 999px;
        background:
          radial-gradient(circle at 50% 35%, rgba(124, 249, 255, 0.16), rgba(4, 10, 18, 0.38) 55%),
          rgba(4, 8, 14, 0.5);
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.03),
          0 14px 34px rgba(0, 0, 0, 0.24),
          0 0 28px rgba(124, 249, 255, 0.08);
        backdrop-filter: blur(10px);
      }

      .tempo-touch-stick-base::before,
      .tempo-touch-stick-base::after {
        content: "";
        position: absolute;
        inset: 14px;
        border: 1px solid rgba(124, 249, 255, 0.1);
        border-radius: 999px;
        pointer-events: none;
      }

      .tempo-touch-stick-base::after {
        inset: 36px;
        border-color: rgba(124, 249, 255, 0.14);
      }

      .tempo-touch-stick-knob {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 68px;
        height: 68px;
        margin-left: -34px;
        margin-top: -34px;
        border: 1px solid rgba(191, 252, 255, 0.62);
        border-radius: 999px;
        background:
          radial-gradient(circle at 40% 35%, rgba(191, 252, 255, 0.68), rgba(124, 249, 255, 0.2) 52%, rgba(2, 8, 14, 0.54) 100%);
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.06),
          0 0 28px rgba(124, 249, 255, 0.2);
        transition: box-shadow 120ms ease, border-color 120ms ease, background 120ms ease;
      }

      .tempo-touch-stick-area.is-active .tempo-touch-stick-base {
        border-color: rgba(134, 255, 86, 0.36);
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.03),
          0 14px 34px rgba(0, 0, 0, 0.24),
          0 0 36px rgba(134, 255, 86, 0.14);
      }

      .tempo-touch-stick-area.is-active .tempo-touch-stick-knob {
        border-color: rgba(214, 255, 197, 0.8);
        background:
          radial-gradient(circle at 40% 35%, rgba(224, 255, 210, 0.8), rgba(134, 255, 86, 0.28) 55%, rgba(2, 8, 14, 0.56) 100%);
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.08),
          0 0 34px rgba(134, 255, 86, 0.22);
      }

      .tempo-touch-button {
        --tempo-touch-accent: var(--tempo-hud-accent);
        position: absolute;
        right: 18px;
        width: 118px;
        height: 60px;
        padding: 0;
        appearance: none;
        border: 1px solid color-mix(in srgb, var(--tempo-touch-accent) 58%, white 0%);
        background:
          linear-gradient(180deg, rgba(12, 22, 34, 0.9), rgba(4, 10, 18, 0.84));
        color: var(--tempo-touch-accent);
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.03),
          0 14px 34px rgba(0, 0, 0, 0.24),
          0 0 28px color-mix(in srgb, var(--tempo-touch-accent) 14%, transparent);
        backdrop-filter: blur(10px);
        clip-path: polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px));
        pointer-events: auto;
      }

      .tempo-touch-button::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          linear-gradient(135deg, color-mix(in srgb, var(--tempo-touch-accent) 16%, transparent), transparent 48%),
          repeating-linear-gradient(
            180deg,
            rgba(255, 255, 255, 0.025) 0,
            rgba(255, 255, 255, 0.025) 1px,
            transparent 1px,
            transparent 8px
          );
        pointer-events: none;
      }

      .tempo-touch-button::after {
        content: "";
        position: absolute;
        left: 14px;
        right: 14px;
        bottom: 0;
        height: 1px;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--tempo-touch-accent) 70%, white 0%), transparent);
        pointer-events: none;
      }

      .tempo-touch-button-label {
        position: relative;
        display: block;
        font: 700 14px/1 "Tempo Sans", ui-sans-serif, sans-serif;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }

      .tempo-touch-button.is-active {
        transform: translateY(-1px);
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.05),
          0 14px 34px rgba(0, 0, 0, 0.24),
          0 0 38px color-mix(in srgb, var(--tempo-touch-accent) 24%, transparent);
      }

      .tempo-touch-button.is-active .tempo-touch-button-label {
        text-shadow: 0 0 16px color-mix(in srgb, var(--tempo-touch-accent) 32%, transparent);
      }

      .tempo-touch-button.is-disarmed {
        pointer-events: none;
        opacity: 0.32;
        filter: grayscale(0.55);
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.02),
          0 14px 24px rgba(0, 0, 0, 0.18);
      }

      .tempo-touch-button.is-disarmed .tempo-touch-button-label {
        text-shadow: none;
      }

      @media (pointer: coarse) {
        .tempo-hud-combat {
          display: none;
        }
      }

      .tempo-touch-button--shield {
        --tempo-touch-accent: #7cf9ff;
        bottom: 170px;
      }

      .tempo-touch-button--fire {
        --tempo-touch-accent: #ff6b96;
        bottom: 94px;
      }

      .tempo-touch-button--brake {
        --tempo-touch-accent: #ffb27e;
        bottom: 18px;
      }

      @media (max-width: 1100px), (max-height: 760px) {
        .tempo-hud-race,
        .tempo-hud-summary {
          width: min(260px, calc(100vw - 32px));
        }

        .tempo-hud-combat {
          grid-template-columns: repeat(2, minmax(0, 156px));
          width: min(322px, calc(100vw - 32px));
        }

        .tempo-runtime-result-row {
          grid-template-columns: 46px minmax(0, 1fr) auto;
        }

        .tempo-runtime-result-takedowns {
          grid-column: 2 / -1;
          text-align: left;
          min-width: 0;
        }

        .tempo-touch-stick-area {
          width: 144px;
          height: 144px;
        }

        .tempo-touch-button {
          width: 112px;
          height: 58px;
        }
      }

      @media (max-width: 760px), (max-height: 620px) {
        .tempo-hud-race,
        .tempo-hud-summary {
          top: 12px;
        }

        .tempo-hud-race {
          left: 12px;
          width: min(232px, calc(100vw - 24px));
          gap: 8px;
        }

        .tempo-hud-summary {
          right: 12px;
          width: min(228px, calc(100vw - 24px));
          padding: 10px 12px 11px;
        }

        .tempo-hud-place,
        .tempo-hud-progress,
        .tempo-hud-slot {
          padding-inline: 12px;
        }

        .tempo-hud-place-value {
          font-size: clamp(28px, 8vw, 34px);
        }

        .tempo-hud-progress-value,
        .tempo-hud-slot-value,
        .tempo-hud-standings-name {
          font-size: 16px;
        }

        .tempo-hud-summary-status,
        .tempo-runtime-overlay-subtitle {
          font-size: 12px;
        }

        .tempo-hud-combat {
          left: 12px;
          bottom: 12px;
          width: min(300px, calc(100vw - 24px));
          gap: 8px;
        }

        .tempo-runtime-overlay {
          padding: 14px;
        }

        .tempo-runtime-overlay-panel {
          width: min(100%, calc(100vw - 28px));
          padding: 22px 18px 18px;
        }

        .tempo-runtime-overlay-actions {
          flex-direction: column;
        }

        .tempo-runtime-overlay-button {
          width: 100%;
          min-width: 0;
        }

        .tempo-runtime-result-row {
          grid-template-columns: 42px minmax(0, 1fr);
          gap: 10px;
        }

        .tempo-runtime-result-time,
        .tempo-runtime-result-takedowns {
          grid-column: 2;
          text-align: left;
        }

        .tempo-touch-stick-area {
          left: 12px;
          bottom: 12px;
          width: 136px;
          height: 136px;
        }

        .tempo-touch-stick-knob {
          width: 62px;
          height: 62px;
          margin-left: -31px;
          margin-top: -31px;
        }

        .tempo-touch-button {
          right: 12px;
          width: 104px;
          height: 56px;
        }

        .tempo-touch-button-label {
          font-size: 13px;
          letter-spacing: 0.16em;
        }

        .tempo-touch-button--shield {
          bottom: 146px;
        }

        .tempo-touch-button--fire {
          bottom: 79px;
        }

        .tempo-touch-button--brake {
          bottom: 12px;
        }
      }
    `;
    return style;
  }

  private createHud(): HTMLDivElement {
    const hud = document.createElement("div");
    hud.className = "tempo-runtime-hud";
    hud.innerHTML = `
      <div class="tempo-hud-race">
        <div class="tempo-hud-card tempo-hud-place">
          <div class="tempo-hud-kicker">Place</div>
          <div class="tempo-hud-place-value">1</div>
        </div>
        <div class="tempo-hud-card tempo-hud-progress">
          <div class="tempo-hud-progress-head">
            <div class="tempo-hud-kicker">Progress</div>
            <div class="tempo-hud-progress-value">0%</div>
          </div>
          <div class="tempo-hud-progress-rail">
            <div class="tempo-hud-progress-fill"></div>
          </div>
        </div>
      </div>
      <div class="tempo-hud-combat">
        <div class="tempo-hud-card tempo-hud-slot">
          <div class="tempo-hud-kicker">Attack</div>
          <div class="tempo-hud-slot-value is-empty" data-slot="attack">Empty</div>
        </div>
        <div class="tempo-hud-card tempo-hud-slot">
          <div class="tempo-hud-kicker">Defense</div>
          <div class="tempo-hud-slot-value is-empty" data-slot="defense">Empty</div>
        </div>
      </div>
      <div class="tempo-hud-card tempo-hud-summary">
        <div class="tempo-hud-summary-status">Warmup lane live.</div>
        <div class="tempo-hud-standings"></div>
      </div>
    `;
    hud.dataset.mode = this.launch.mode ?? "solo";
    return hud;
  }

  private createNameLabelLayer(): HTMLDivElement {
    const layer = document.createElement("div");
    layer.className = "tempo-name-label-layer";
    return layer;
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
    overlay.className = "tempo-runtime-overlay";

    const panel = document.createElement("div");
    panel.className = "tempo-runtime-overlay-panel";

    const title = document.createElement("div");
    title.className = "tempo-runtime-overlay-title";

    const subtitle = document.createElement("div");
    subtitle.className = "tempo-runtime-overlay-subtitle";

    const body = document.createElement("div");
    body.className = "tempo-runtime-overlay-body tempo-runtime-overlay-results";

    const actions = document.createElement("div");
    actions.className = "tempo-runtime-overlay-actions";

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

  private syncNameLabels(): void {
    if (this.launch.mode !== "multiplayer") {
      this.clearNameLabels();
      return;
    }

    const visibleIds = new Set(
      this.latestRoster
        .filter((player) => player.clientId !== this.launch.localPlayerId)
        .map((player) => player.clientId),
    );

    for (const player of this.latestRoster) {
      if (!visibleIds.has(player.clientId)) continue;
      const label = this.getOrCreateNameLabel(player.clientId);
      label.textContent = player.name;
    }

    for (const clientId of Array.from(this.nameLabels.keys())) {
      if (!visibleIds.has(clientId)) {
        this.removeNameLabel(clientId);
      }
    }
  }

  private getOrCreateNameLabel(clientId: string): HTMLDivElement {
    const existing = this.nameLabels.get(clientId);
    if (existing) return existing;

    const label = document.createElement("div");
    label.className = "tempo-name-label";
    this.nameLabels.set(clientId, label);
    this.nameLabelLayer.appendChild(label);
    return label;
  }

  private removeNameLabel(clientId: string): void {
    const label = this.nameLabels.get(clientId);
    if (!label) return;
    label.remove();
    this.nameLabels.delete(clientId);
  }

  private clearNameLabels(): void {
    for (const label of this.nameLabels.values()) {
      label.remove();
    }
    this.nameLabels.clear();
  }

  private createOverlayButton(label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tempo-runtime-overlay-button";
    button.textContent = label;
    return button;
  }

  private setOverlayMessage(title: string, subtitle: string): void {
    this.statusOverlay.dataset.overlayState = "message";
    this.statusOverlay.style.display = "flex";
    this.statusBody.replaceChildren();
    this.statusBody.style.display = "none";
    this.statusTitle.textContent = title;
    this.statusSubtitle.textContent = subtitle;
    this.primaryButton.style.display = "none";
    this.secondaryButton.style.display = "none";
  }

  private syncPickupVisuals(pickups: PickupSpawnState[]): void {
    const nextIds = new Set<string>();
    for (const pickup of pickups) {
      nextIds.add(pickup.id);
      let visual = this.pickupVisuals.get(pickup.id);
      if (!visual) {
        const isMissile = pickup.kind === "missile";
        const coreColor = isMissile ? "#ff3a68" : "#71ffd2";
        const emissiveColor = isMissile ? "#ff5da0" : "#98ff62";
        const mesh = new Mesh(
          new SphereGeometry(1.02, 20, 14),
          new MeshStandardMaterial({
            color: coreColor,
            emissive: emissiveColor,
            emissiveIntensity: 7.6,
            roughness: 0.24,
            metalness: 0.08,
          }),
        );
        const glowShell = new Mesh(
          new SphereGeometry(1.75, 18, 12),
          new MeshBasicMaterial({
            color: emissiveColor,
            transparent: true,
            opacity: 0.18,
            depthTest: false,
            depthWrite: false,
            blending: AdditiveBlending,
          }),
        );
        const beam = new Mesh(
          new CylinderGeometry(0.62, 0.62, 22, 12, 1, true),
          new MeshBasicMaterial({
            color: emissiveColor,
            transparent: true,
            opacity: 0.96,
            depthTest: false,
            depthWrite: false,
            blending: AdditiveBlending,
            side: DoubleSide,
          }),
        );
        beam.position.y = 11;
        const ring = new Mesh(
          new CylinderGeometry(3.7, 3.7, 0.1, 24, 1, true),
          new MeshBasicMaterial({
            color: emissiveColor,
            transparent: true,
            opacity: 0.88,
            depthTest: false,
            depthWrite: false,
            blending: AdditiveBlending,
            side: DoubleSide,
          }),
        );
        ring.position.y = -0.55;
        mesh.add(beam, ring, glowShell);
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
      visual.mesh.position.copy(center);
      visual.mesh.position.addScaledVector(frame.right, visual.lane * NOMINAL_HALF_WIDTH);
      visual.mesh.position.addScaledVector(frame.up, defaultVehicleTuning.hoverHeight + 0.65);
      this.orientMat.makeBasis(frame.right, frame.up, frame.tangent.clone().negate());
      visual.mesh.setRotationFromMatrix(this.orientMat);
      const pulse = 1 + Math.sin(timeSeconds * 4.2 + visual.u * 23) * 0.16;
      visual.mesh.scale.setScalar(pulse);
      const beam = visual.mesh.children[0];
      const ring = visual.mesh.children[1];
      const glowShell = visual.mesh.children[2];
      if (beam) {
        beam.scale.y = 1 + Math.sin(timeSeconds * 3 + visual.u * 17) * 0.18;
      }
      if (ring) {
        ring.scale.setScalar(pulse);
      }
      if (glowShell instanceof Mesh && glowShell.material instanceof MeshBasicMaterial) {
        glowShell.material.opacity = 0.16 + (pulse - 1) * 0.32;
      }
    }
  }

  private updateCarTransform(deltaSeconds: number): void {
    const state = this.vehicleController.state;
    const dt = Math.min(deltaSeconds, 1 / 30);
    const now = Date.now();
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

    const body = this.localVehicle.bodyPivot;
    body.rotation.set(state.visualPitch, -state.steering * 0.15, state.visualBank, "XYZ");
    if (this.localTakenDownUntil > now) {
      this.applySpinoutVisual(this.localVehicle.group, body, state.up, now, this.localTakenDownUntil);
    }
  }

  private updateRemoteCars(deltaSeconds: number): void {
    const alpha = 1 - Math.exp(-Math.min(deltaSeconds, 1 / 20) * 8);
    const now = Date.now();
    for (const [clientId, remote] of this.remoteCars) {
      const snapshot = this.serverPlayers.get(clientId);
      if (!snapshot) continue;
      remote.group.visible = true;
      remote.currentTrackU = MathUtils.lerp(remote.currentTrackU, remote.targetTrackU, alpha);
      remote.currentLateralOffset = MathUtils.lerp(remote.currentLateralOffset, remote.targetLateralOffset, alpha);

      const frame = this.track.getFrameAt(remote.currentTrackU);
      const center = this.track.getPointAt(remote.currentTrackU);
      remote.group.position.copy(center)
        .addScaledVector(frame.right, remote.currentLateralOffset)
        .addScaledVector(frame.up, 0.45);
      this.orientMat.makeBasis(frame.right, frame.up, frame.tangent.clone().negate());
      remote.group.setRotationFromMatrix(this.orientMat);
      const body = remote.bodyPivot;
      body.rotation.set(0, 0, 0, "XYZ");
      if (snapshot.takenDownUntil > now) {
        this.applySpinoutVisual(remote.group, body, frame.up, now, snapshot.takenDownUntil);
      }
    }
  }

  private applySpinoutVisual(
    group: Group,
    body: Group["children"][number] | null,
    up: Vector3,
    nowMs: number,
    takenDownUntil: number,
  ): void {
    const timeSeconds = nowMs / 1000;
    const remainingRatio = Math.max(0, Math.min(1, (takenDownUntil - nowMs) / 1800));
    const spinAngle = timeSeconds * 24;
    group.rotateZ(spinAngle);
    group.rotateX(Math.sin(timeSeconds * 18) * 0.35 * (0.5 + remainingRatio));
    group.position.addScaledVector(up, 0.38 + Math.abs(Math.sin(timeSeconds * 20)) * 0.12);
    if (body) {
      body.rotation.set(
        Math.sin(timeSeconds * 16) * 0.35,
        0,
        Math.cos(timeSeconds * 22) * 1.1 * (0.5 + remainingRatio),
        "XYZ",
      );
    }
  }

  private updateBoostVisuals(): void {
    const boost = this.vehicleController.state.visualBoost;
    const surgeBoost = MathUtils.clamp(boost + this.boostSurge * 0.42 + this.pickupSurge * 0.22, 0, 1.35);
    const slowdownMix = Math.min(this.slowdownFlash, 1);
    const localPalette = paletteForVariant(this.launch.carVariant ?? "vector");
    const boostMix = Math.min(surgeBoost, 1);
    const bodyColor = localPalette.body.clone()
      .lerp(App.BOOST_COLOR, boostMix * 0.72)
      .lerp(App.BOOST_HOT_COLOR, boostMix * 0.34)
      .lerp(App.SLOWDOWN_FLASH_COLOR, slowdownMix * 0.82);
    const bodyEmissive = localPalette.bodyEmissive.clone()
      .lerp(App.BOOST_COLOR, boostMix * 0.88)
      .lerp(App.BOOST_HOT_COLOR, boostMix * 0.2)
      .lerp(App.SLOWDOWN_FLASH_COLOR, slowdownMix);
    const cockpitColor = localPalette.cockpit.clone()
      .lerp(new Color("#2f540e"), boostMix * 0.62)
      .lerp(App.SLOWDOWN_FLASH_COLOR, slowdownMix * 0.3);
    const cockpitEmissive = localPalette.cockpitEmissive.clone()
      .lerp(App.BOOST_COLOR, boostMix * 0.96)
      .lerp(App.SLOWDOWN_FLASH_COLOR, slowdownMix * 0.65);

    this.localVehicle.fallbackBodyMaterial.color.copy(bodyColor);
    this.localVehicle.fallbackBodyMaterial.emissive.copy(bodyEmissive);
    this.localVehicle.fallbackBodyMaterial.emissiveIntensity = 0.8 + surgeBoost * 2.8 + slowdownMix * 1.2;
    this.localVehicle.fallbackCockpitMaterial.color.copy(cockpitColor);
    this.localVehicle.fallbackCockpitMaterial.emissive.copy(cockpitEmissive);
    this.localVehicle.fallbackCockpitMaterial.emissiveIntensity = 0.45 + surgeBoost * 1.9 + slowdownMix * 0.5;
    this.localVehicle.feedbackGlowMaterial.color.copy(
      App.BOOST_COLOR.clone().lerp(App.SLOWDOWN_FLASH_COLOR, slowdownMix * 0.9),
    );
    this.localVehicle.feedbackGlowMaterial.opacity = Math.min(surgeBoost * 0.42 + slowdownMix * 0.38, 0.72);
    const glowScale = 1 + surgeBoost * 0.55 + slowdownMix * 0.18;
    this.localVehicle.feedbackGlow.scale.set(glowScale, 1, glowScale);

    this.boostTrailHistory.unshift({
      position: this.localVehicle.group.position.clone(),
      quaternion: this.localVehicle.group.quaternion.clone(),
      boost: surgeBoost,
    });
    if (this.boostTrailHistory.length > this.boostTrailSampleLimit) {
      this.boostTrailHistory.length = this.boostTrailSampleLimit;
    }

    for (let i = 0; i < this.boostTrailMeshes.length; i++) {
      const sample = this.boostTrailHistory[Math.min(this.boostTrailHistory.length - 1, 2 + i * 3)];
      const mesh = this.boostTrailMeshes[i];
      const material = this.boostTrailMaterials[i];
      if (!sample || sample.boost < 0.04) {
        mesh.visible = false;
        continue;
      }

      mesh.visible = true;
      mesh.position.copy(sample.position);
      mesh.quaternion.copy(sample.quaternion);
      const sideSign = i % 2 === 0 ? 1 : -1;
      const spread = sample.boost * (0.25 + i * 0.012);
      this.tempVector.set(sideSign * spread, 0.02 + i * 0.004, -0.6 - i * 0.16);
      this.tempVector.applyQuaternion(sample.quaternion);
      mesh.position.add(this.tempVector);
      mesh.scale.set(
        1 + sample.boost * (0.62 + i * 0.03),
        1 + sample.boost * (0.18 + i * 0.018),
        1.55 + sample.boost * (1.2 + i * 0.1),
      );
      material.opacity = Math.max(0, sample.boost * (0.4 - i * 0.018));
      material.color.copy(App.BOOST_COLOR).lerp(App.BOOST_HOT_COLOR, Math.min(sample.boost * 0.72, 1));
    }
  }

  private updateSpeedTracers(): void {
    if (this.phase !== "running") {
      for (const tracer of this.speedTracers) {
        tracer.mesh.visible = false;
      }
      return;
    }

    const state = this.vehicleController.state;
    const speedRatio = Math.min(Math.abs(state.speed) / 90, 1);
    const baseIntensity = MathUtils.smoothstep(speedRatio, 0.36, 0.96);
    const intensity = MathUtils.clamp(
      baseIntensity * 0.68 + state.visualBoost * 0.82 + this.pickupSurge * 0.28,
      0,
      1.2,
    );
    if (intensity < 0.08 || this.boostTrailHistory.length < 3) {
      for (const tracer of this.speedTracers) {
        tracer.mesh.visible = false;
      }
      return;
    }

    for (const tracer of this.speedTracers) {
      const sampleIndex = Math.min(this.boostTrailHistory.length - 1, tracer.sampleOffset + tracer.sampleStride);
      const sample = this.boostTrailHistory[sampleIndex];
      if (!sample) {
        tracer.mesh.visible = false;
        continue;
      }

      tracer.mesh.visible = true;
      tracer.mesh.quaternion.copy(sample.quaternion);
      tracer.mesh.position.copy(sample.position);
      this.tempVector.set(
        tracer.lateralOffset * (1 + intensity * 0.12),
        tracer.verticalOffset + intensity * 0.03,
        -0.45 - tracer.sampleOffset * 0.1,
      );
      this.tempVector.applyQuaternion(sample.quaternion);
      tracer.mesh.position.add(this.tempVector);
      tracer.mesh.scale.set(
        1 + intensity * 0.12,
        1 + intensity * 0.16,
        MathUtils.lerp(2.8, 6.4, intensity) * (1 + tracer.sampleOffset * 0.035),
      );
      tracer.material.opacity = Math.max(
        0,
        intensity * (0.72 - tracer.sampleOffset * 0.028) * (0.72 + sample.boost * 0.44),
      );
      tracer.material.color.copy(App.TRACER_COLOR).lerp(
        App.TRACER_HOT_COLOR,
        Math.min(0.28 + state.visualBoost * 0.48 + this.pickupSurge * 0.18, 1),
      );
    }
  }

  private updateSpeedFeedback(deltaSeconds: number): void {
    const dt = Math.min(deltaSeconds, 1 / 20);
    this.boostSurge = MathUtils.damp(this.boostSurge, 0, 5.4, dt);
    this.pickupSurge = MathUtils.damp(this.pickupSurge, 0, 6.8, dt);
    this.impactSurge = MathUtils.damp(this.impactSurge, 0, 8.2, dt);
    this.slowdownFlash = MathUtils.damp(this.slowdownFlash, 0, 9.5, dt);
  }

  private updatePostEffects(): void {
    const state = this.vehicleController.state;
    const speedRatio = Math.min(Math.abs(state.speed) / 90, 1);
    const bloomDrive = MathUtils.clamp(
      speedRatio * 0.08
      + state.visualBoost * 0.18
      + this.boostSurge * 0.12
      + this.pickupSurge * 0.08
      + this.impactSurge * 0.16,
      0,
      1.2,
    );
    this.bloomPass.strength = this.baseBloomStrength + bloomDrive * 0.32;
    this.renderer.toneMappingExposure = 0.96 + bloomDrive * 0.04;
  }

  private triggerBoostSurge(amount = 1): void {
    this.boostSurge = Math.min(1.35, this.boostSurge + amount);
  }

  private triggerPickupSurge(amount = 1): void {
    this.pickupSurge = Math.min(1.2, this.pickupSurge + amount);
  }

  private triggerImpactSurge(amount = 1): void {
    this.impactSurge = Math.min(1.35, this.impactSurge + amount);
  }

  private triggerSlowdownFlash(amount = 1): void {
    this.slowdownFlash = Math.min(1.2, this.slowdownFlash + amount);
  }

  private updateCamera(deltaSeconds: number): void {
    const state = this.vehicleController.state;
    const speed = Math.abs(state.speed);
    const speedRatio = Math.min(speed / 90, 1);
    const dt = Math.min(deltaSeconds, 1 / 30);
    const positionAlpha = 1 - Math.exp(-6 * dt);
    const lookAlpha = 1 - Math.exp(-8 * dt);
    const upAlpha = 1 - Math.exp(-5 * dt);
    if (this.cameraMode === "wild") {
      const wildCamBack = MathUtils.lerp(9.5, 14.5, speedRatio);
      const wildCamUp = MathUtils.lerp(5.2, 7.4, speedRatio);
      const wildLookAhead = MathUtils.lerp(12, 18, speedRatio);
      const wildLateralLead = state.steering * MathUtils.lerp(0.06, 0.2, speedRatio);
      const wildAlpha = 1 - Math.exp(-10 * dt);
      this.stableCameraForward.lerp(state.forward, wildAlpha).normalize();
      this.stableCameraRight.lerp(state.right, wildAlpha).normalize();

      this.desiredCameraLookTarget.copy(state.position)
        .addScaledVector(this.stableCameraForward, wildLookAhead)
        .addScaledVector(state.up, 1.1)
        .addScaledVector(this.stableCameraRight, wildLateralLead);

      this.desiredCameraPosition.copy(state.position)
        .addScaledVector(this.stableCameraForward, -wildCamBack)
        .addScaledVector(state.up, wildCamUp)
        .addScaledVector(this.stableCameraRight, wildLateralLead * 0.15);

      this.resolveStableCameraClearance(this.desiredCameraPosition, state, state.up);
      this.resolveCameraRoadClip(this.desiredCameraPosition, state.trackU);
      this.desiredCameraUp.copy(App.WORLD_UP).lerp(state.up, 0.42).normalize();
    } else {
      const comfortBack = MathUtils.lerp(8.2, 10.8, speedRatio);
      const comfortUp = MathUtils.lerp(4.1, 5.6, speedRatio);
      const comfortLookAhead = MathUtils.lerp(9, 13, speedRatio);
      const comfortLateralLead = state.steering * MathUtils.lerp(0.012, 0.04, speedRatio);
      const comfortAlpha = 1 - Math.exp(-11 * dt);

      this.tempVector.copy(state.forward);
      this.tempVector.addScaledVector(App.WORLD_UP, -this.tempVector.dot(App.WORLD_UP));
      if (this.tempVector.lengthSq() <= 1e-4) {
        this.tempVector.crossVectors(App.WORLD_UP, state.right);
      }
      if (this.tempVector.lengthSq() > 1e-4) {
        this.tempVector.normalize();
        this.stableCameraForward.lerp(this.tempVector, comfortAlpha).normalize();
      }
      this.stableCameraRight.crossVectors(this.stableCameraForward, App.WORLD_UP).normalize();

      this.tempVectorB.copy(state.up);
      if (this.tempVectorB.dot(App.WORLD_UP) < 0) {
        this.tempVectorB.multiplyScalar(-1);
      }
      this.tempVectorB.lerp(App.WORLD_UP, 0.84).normalize();
      this.stableCameraLift.lerp(this.tempVectorB, 1 - Math.exp(-9 * dt)).normalize();

      this.desiredCameraLookTarget.copy(state.position)
        .addScaledVector(this.stableCameraForward, comfortLookAhead)
        .addScaledVector(this.stableCameraLift, 1.15)
        .addScaledVector(this.stableCameraRight, comfortLateralLead);

      this.desiredCameraPosition.copy(state.position)
        .addScaledVector(this.stableCameraForward, -comfortBack)
        .addScaledVector(this.stableCameraLift, comfortUp)
        .addScaledVector(this.stableCameraRight, comfortLateralLead * 0.12);
      this.resolveStableCameraClearance(this.desiredCameraPosition, state, this.stableCameraLift);

      this.desiredCameraUp.copy(App.WORLD_UP);
    }

    if (!this.visualsInitialized) {
      this.smoothedCameraPosition.copy(this.desiredCameraPosition);
      this.smoothedCameraLookTarget.copy(this.desiredCameraLookTarget);
      this.smoothedCameraUp.copy(this.desiredCameraUp);
      this.visualsInitialized = true;
    } else {
      this.smoothedCameraPosition.lerp(this.desiredCameraPosition, positionAlpha);
      this.smoothedCameraLookTarget.lerp(this.desiredCameraLookTarget, lookAlpha);
      this.smoothedCameraUp.lerp(this.desiredCameraUp, upAlpha).normalize();
      if (this.cameraMode === "wild") {
        this.resolveStableCameraClearance(this.smoothedCameraPosition, state, state.up);
        this.resolveCameraRoadClip(this.smoothedCameraPosition, state.trackU);
      } else {
        this.resolveStableCameraClearance(this.smoothedCameraPosition, state, this.stableCameraLift);
      }
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

  private resolveStableCameraClearance(cameraPosition: Vector3, state: VehicleState, liftAxis: Vector3): void {
    const surfaceClearance = this.tempVectorB.copy(cameraPosition).sub(state.position).dot(liftAxis);
    const minSurfaceClearance = 2.6;
    if (surfaceClearance < minSurfaceClearance) {
      cameraPosition.addScaledVector(liftAxis, minSurfaceClearance - surfaceClearance);
    }
  }

  private handleTrackObjects(): void {
    if (this.trackObjects.length === 0) return;

    const state = this.vehicleController.state;
    const now = performance.now();
    const uWindow = 14 / this.track.totalLength;
    for (const object of this.trackObjects) {
      if (this.trackObjectTriggers.has(object.id)) continue;
      if (Math.abs(object.u - state.trackU) > uWindow) continue;
      const objectHalfLengthU = object.collisionLength / this.track.totalLength;
      if (Math.abs(object.u - state.trackU) > objectHalfLengthU) continue;
      const lateralDelta = Math.abs(state.lateralOffset - object.lateralOffset);
      if (lateralDelta > object.collisionHalfWidth + 0.9) continue;
      this.trackObjectTriggers.add(object.id);
      if (object.kind === "boost") {
        this.vehicleController.applyPickupBoost();
        this.triggerBoostSurge(1);
        this.triggerPickupSurge(0.8);
        this.combatVfx.spawnPickupPulse(
          this.localVehicle.group.position.clone(),
          state.forward.clone(),
          `#${App.BOOST_COLOR.getHexString()}`,
          now,
        );
      } else {
        this.vehicleController.applyObstacleHit();
        this.triggerImpactSurge(0.28);
        this.triggerSlowdownFlash(1);
      }
    }
  }

  private handleActionEdges(): void {
    if (this.phase !== "running") return;
    const firePressed = this.input.state.fire;
    const shieldPressed = this.input.state.shield;
    if (firePressed && !this.lastFirePressed) {
      if (this.localOffensiveItem === "missile") {
        this.combatVfx.spawnLocalFireBlast(this.localVehicle.group.position.clone(), performance.now());
      }
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
            name: this.getLocalPlayerName(),
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
            name: this.getLocalPlayerName(),
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
    this.placementHud.textContent = this.localPlacement.toString();
    this.checkpointHud.textContent = `${progress}%`;
    this.checkpointBarHud.style.transform = `scaleX(${Math.max(progress / 100, 0.02).toFixed(3)})`;
    this.setSlotValue(this.offensiveHud, formatCombatSlot(this.localOffensiveItem, "fire"), this.localOffensiveItem !== null);
    this.setSlotValue(this.defensiveHud, formatCombatSlot(this.localDefensiveItem, "shield"), this.localDefensiveItem !== null);
    this.touchControls?.setArmed("fire", this.localOffensiveItem !== null);
    this.touchControls?.setArmed("shield", this.localDefensiveItem !== null);
    this.renderRoster();
  }

  private renderRoster(): void {
    if (this.launch.mode !== "multiplayer") {
      this.summaryHud.style.display = "none";
      return;
    }

    this.summaryHud.style.display = "";
    this.rosterHud.textContent = this.lastStatusMessage || "Warmup lane live.";
    this.rosterListHud.replaceChildren();
    if (this.latestRoster.length === 0) {
      return;
    }

    const sortedPlayers = [...this.latestRoster].sort((a, b) => {
      const placementA = this.serverPlayers.get(a.clientId)?.placement ?? Number.POSITIVE_INFINITY;
      const placementB = this.serverPlayers.get(b.clientId)?.placement ?? Number.POSITIVE_INFINITY;
      if (placementA !== placementB) return placementA - placementB;
      return a.name.localeCompare(b.name);
    });
    const visiblePlayers = sortedPlayers.slice(0, this.isCompactHudLayout() ? 2 : 3);
    const localPlayer = sortedPlayers.find((player) => player.clientId === this.launch.localPlayerId) ?? null;
    if (localPlayer && !visiblePlayers.some((player) => player.clientId === localPlayer.clientId)) {
      visiblePlayers.push(localPlayer);
    }
    for (const player of visiblePlayers) {
      this.rosterListHud.appendChild(this.createSummaryRow(player));
    }
  }

  private createSummaryRow(player: RoomPlayerState): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "tempo-hud-standings-row";
    if (player.clientId === this.launch.localPlayerId) {
      row.classList.add("is-local");
    }

    const rank = document.createElement("div");
    rank.className = "tempo-hud-standings-rank";
    rank.textContent = this.serverPlayers.get(player.clientId)?.placement?.toString() ?? "•";

    const copy = document.createElement("div");
    copy.className = "tempo-hud-standings-copy";

    const name = document.createElement("div");
    name.className = "tempo-hud-standings-name";
    name.textContent = player.clientId === this.launch.localPlayerId ? `${player.name} / You` : player.name;

    const meta = document.createElement("div");
    meta.className = "tempo-hud-standings-meta";
    meta.textContent = describePlayerStatus(player);

    copy.append(name, meta);
    row.append(rank, copy);
    return row;
  }

  private createResultRow(entry: RaceResults["entries"][number], isWinner: boolean): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "tempo-runtime-result-row";
    if (isWinner) {
      row.classList.add("is-winner");
    }

    const rank = document.createElement("div");
    rank.className = "tempo-runtime-result-rank";
    rank.textContent = entry.placement.toString().padStart(2, "0");

    const copy = document.createElement("div");
    copy.className = "tempo-runtime-result-copy";

    const name = document.createElement("div");
    name.className = "tempo-runtime-result-name";
    name.textContent = entry.name;

    const status = document.createElement("div");
    status.className = "tempo-runtime-result-status";
    status.textContent = entry.status === "finished"
      ? (isWinner ? "Finish leader" : "Finished")
      : "DNF";

    const time = document.createElement("div");
    time.className = "tempo-runtime-result-time";
    time.textContent = entry.finishTimeMs === null ? "DNF" : formatTimeMs(entry.finishTimeMs);

    const takedowns = document.createElement("div");
    takedowns.className = "tempo-runtime-result-takedowns";
    takedowns.textContent = `TKD ${entry.takedowns}`;

    copy.append(name, status);
    row.append(rank, copy, time, takedowns);
    return row;
  }

  private setSlotValue(target: HTMLDivElement, value: string, active: boolean): void {
    target.textContent = active ? value : "Empty";
    target.classList.toggle("is-active", active);
    target.classList.toggle("is-empty", !active);
  }

  private isCompactHudLayout(): boolean {
    return window.innerWidth <= 760 || window.innerHeight <= 620;
  }

  private updateNameLabels(): void {
    if (this.launch.mode !== "multiplayer" || this.phase === "finished") {
      for (const label of this.nameLabels.values()) {
        label.style.display = "none";
      }
      return;
    }

    const localPosition = this.localVehicle.group.position;
    for (const player of this.latestRoster) {
      if (player.clientId === this.launch.localPlayerId) continue;
      const remote = this.remoteCars.get(player.clientId);
      const label = this.nameLabels.get(player.clientId);
      if (!remote || !label) continue;

      const distance = localPosition.distanceTo(remote.group.position);
      if (distance >= NAME_LABEL_FADE_RANGE) {
        label.style.display = "none";
        continue;
      }

      this.tempVector.copy(remote.group.position);
      this.tempVector.y += 1.5;
      this.tempVectorB.copy(this.tempVector).applyMatrix4(this.camera.matrixWorldInverse);
      if (this.tempVectorB.z >= -this.camera.near) {
        label.style.display = "none";
        continue;
      }

      this.tempVectorB.copy(this.tempVector).project(this.camera);
      if (
        this.tempVectorB.x < -1
        || this.tempVectorB.x > 1
        || this.tempVectorB.y < -1
        || this.tempVectorB.y > 1
      ) {
        label.style.display = "none";
        continue;
      }

      const opacity = distance <= NAME_LABEL_FULL_RANGE
        ? 1
        : 1 - ((distance - NAME_LABEL_FULL_RANGE) / (NAME_LABEL_FADE_RANGE - NAME_LABEL_FULL_RANGE));
      label.style.display = "";
      label.style.opacity = opacity.toFixed(2);
      label.style.left = `${((this.tempVectorB.x + 1) * 0.5 * window.innerWidth).toFixed(1)}px`;
      label.style.top = `${((1 - this.tempVectorB.y) * 0.5 * window.innerHeight - 12).toFixed(1)}px`;
    }
  }

  private getLocalPlayerName(): string {
    const normalized = this.launch.localPlayerName?.trim();
    return normalized && normalized.length > 0 ? normalized : "Pilot 1";
  }

  private createDebugHud(enabled: boolean): HTMLDivElement | null {
    if (!enabled) return null;
    const hud = document.createElement("div");
    hud.className = "tempo-debug-hud";
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

  private getLoadingBlend(now: number): number {
    if (this.phase === "staging") return 1;
    if (this.phase === "countdown") {
      const remainingMs = Math.max(0, this.pendingStartAt - now);
      return MathUtils.clamp(remainingMs / Math.max(1, this.countdownDurationMs), 0, 1);
    }
    return 0;
  }

  private refreshMultiplayerStatusMessage(): void {
    if (this.launch.mode !== "multiplayer") return;

    const activePlayers = this.latestRoster.filter((player) => player.isActiveRacer);
    if (this.phase === "running") {
      if (!this.lastStatusMessage.startsWith("Finish locked")) {
        this.lastStatusMessage = "Race live. Hold the line.";
      }
      this.renderRoster();
      return;
    }

    if (this.phase === "countdown") {
      this.lastStatusMessage = "Grid lock engaged. Loading fiction dropping away.";
      this.renderRoster();
      return;
    }

    if (activePlayers.length === 0) {
      this.lastStatusMessage = this.audioReady
        ? "Loading lane armed. Waiting for pilots."
        : "Loading lane forming. Audio buffering.";
      this.renderRoster();
      return;
    }

    const readyCount = activePlayers.filter((player) => player.preload.sceneReady && player.preload.audioReady).length;
    if (!this.audioReady) {
      this.lastStatusMessage = `Loading lane forming. ${readyCount}/${activePlayers.length} synced.`;
    } else if (readyCount < activePlayers.length) {
      this.lastStatusMessage = `Audio locked. Waiting for pilots ${readyCount}/${activePlayers.length}.`;
    } else {
      this.lastStatusMessage = "All pilots synced. Grid lock imminent.";
    }

    this.renderRoster();
  }

  private beginCountdownResetTransition(): void {
    const state = this.vehicleController.state;
    const fromTrackU = state.trackU;
    const fromLateralOffset = state.lateralOffset;
    const fromSpeed = state.speed;
    const toTrackU = this.countdownResetTrackU;
    const toLateralOffset = this.countdownResetLateralOffset;
    const toSpeed = this.countdownResetSpeed;
    const needsTransition = Math.abs(fromTrackU - toTrackU) > 0.002
      || Math.abs(fromLateralOffset - toLateralOffset) > 0.15
      || Math.abs(fromSpeed - toSpeed) > 0.5;

    if (!needsTransition) {
      this.countdownResetTransition = null;
      this.vehicleController.forceTrackState(toTrackU, toLateralOffset, toSpeed);
      return;
    }

    this.countdownResetTransition = {
      startedAt: performance.now(),
      durationMs: 1450,
      fromTrackU,
      fromLateralOffset,
      fromSpeed,
      toTrackU,
      toLateralOffset,
      toSpeed,
    };
  }

  private updateCountdownResetTransition(nowMs: number): void {
    const transition = this.countdownResetTransition;
    if (!transition) return;

    const rawT = MathUtils.clamp((nowMs - transition.startedAt) / transition.durationMs, 0, 1);
    const easedT = rawT * rawT * (3 - 2 * rawT);
    this.vehicleController.forceTrackState(
      MathUtils.lerp(transition.fromTrackU, transition.toTrackU, easedT),
      MathUtils.lerp(transition.fromLateralOffset, transition.toLateralOffset, easedT),
      MathUtils.lerp(transition.fromSpeed, transition.toSpeed, easedT),
    );

    if (rawT >= 1) {
      this.vehicleController.forceTrackState(
        transition.toTrackU,
        transition.toLateralOffset,
        transition.toSpeed,
      );
      this.countdownResetTransition = null;
    }
  }

  private scheduleSoloCountdown(): void {
    if (this.launch.mode === "multiplayer") return;
    if (this.phase !== "staging") return;
    if (this.soloCountdownTimer !== null) {
      window.clearTimeout(this.soloCountdownTimer);
      this.soloCountdownTimer = null;
    }

    const minimumCountdownAt = this.stagingOpenedAt + this.config.stagingReadyDelayMs;
    const remainingHoldMs = Math.max(0, minimumCountdownAt - Date.now());
    this.soloCountdownTimer = window.setTimeout(() => {
      this.soloCountdownTimer = null;
      if (this.destroyed || this.phase !== "staging") return;
      this.beginCountdown(Date.now() + 2500);
    }, remainingHoldMs);
  }

  private readonly render = (time: number): void => {
    if (this.destroyed) return;
    const deltaSeconds = (time - this.lastFrameTime) / 1000;
    this.lastFrameTime = time;
    this.sceneElapsedTime += deltaSeconds;
    const now = Date.now();
    this.updateSpeedFeedback(deltaSeconds);

    if (this.phase === "countdown") {
      this.updateCountdownResetTransition(time);
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
    const loadingBlend = this.getLoadingBlend(now);
    const loadingPulse = 0.5 + 0.5 * Math.sin(time / 280);
    this.track.setLoadingBlend(loadingBlend, loadingPulse);
    this.updateCarTransform(deltaSeconds);
    this.updateRemoteCars(deltaSeconds);
    this.updateBoostVisuals();
    this.updateSpeedTracers();
    this.updatePickupVisuals(time / 1000);
    this.combatVfx.update(performance.now());
    this.updateCamera(deltaSeconds);
    this.environment.update(
      this.sceneElapsedTime,
      musicTime,
      this.vehicleController.state.trackU,
      this.latestReactiveBands,
      loadingBlend,
    );
    this.updateHud();
    this.updateNameLabels();
    this.updateDebugHud();
    this.updatePostEffects();
    this.composer.render();
    this.animationFrameId = window.requestAnimationFrame(this.render);
  };

  private disposeSceneGraph(): void {
    this.scene.traverse((object) => {
      if (!(object instanceof Mesh) || isSharedCarMesh(object)) return;
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
  const palette = getCarAssetDefinition(variant).fallbackPalette;
  return {
    body: new Color(palette.body),
    bodyEmissive: new Color(palette.bodyEmissive),
    cockpit: new Color(palette.cockpit),
    cockpitEmissive: new Color(palette.cockpitEmissive),
  };
}

function buildVehicleTuning(steeringSensitivity: number) {
  return {
    ...defaultVehicleTuning,
    steeringRate: defaultVehicleTuning.steeringRate * steeringSensitivity,
    steeringResponse: defaultVehicleTuning.steeringResponse * MathUtils.lerp(1, steeringSensitivity, 0.9),
  };
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
      return "Grid locked";
    }
    if (player.preload.audioReady) {
      return "Waiting on room";
    }
    if (player.preload.sceneReady) {
      return "Syncing audio";
    }
    return "Loading lane";
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
