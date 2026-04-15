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
  steeringSensitivity?: number;
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
  private readonly reducedFx: boolean;
  private readonly boostTrailSampleLimit: number;
  private readonly baseBloomStrength = 0.4;

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
    this.statusOverlay.style.display = "flex";
    this.statusBody.style.display = "";
    const winner = results.entries[0] ?? null;
    if (this.launch.mode === "multiplayer") {
      const winnerByFinishLine = winner?.status === "finished";
      this.statusTitle.textContent = "Winner";
      this.statusSubtitle.textContent = winnerByFinishLine
        ? `${winner?.name ?? "Winner"} hit the finish line first.`
        : `${winner?.name ?? "Winner"} was leading when the track ended.`;
      this.statusBody.textContent = results.entries
        .map((entry, index) => {
          const role = index === 0 ? "WINNER" : "LOSER ";
          const time = entry.finishTimeMs === null ? "DNF" : formatTimeMs(entry.finishTimeMs);
          return `${role} ${entry.placement}. ${entry.name.padEnd(10, " ")} ${time}  TKD ${entry.takedowns}`;
        })
        .join("\n");
    } else {
      this.statusTitle.textContent = "Results";
      this.statusSubtitle.textContent = `${results.entries[0]?.name ?? "Winner"} takes the line first.`;
      this.statusBody.textContent = results.entries
        .map((entry) => {
          const time = entry.finishTimeMs === null ? "DNF" : formatTimeMs(entry.finishTimeMs);
          return `${entry.placement}. ${entry.name.padEnd(10, " ")} ${time}  TKD ${entry.takedowns}`;
        })
        .join("\n");
    }
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
    const nextIds = new Set<string>();
    for (const pickup of pickups) {
      nextIds.add(pickup.id);
      let visual = this.pickupVisuals.get(pickup.id);
      if (!visual) {
        const isMissile = pickup.kind === "missile";
        const coreColor = isMissile ? "#ff2040" : "#1e3a8a";
        const emissiveColor = isMissile ? "#ff2040" : "#3b63d9";
        const mesh = new Mesh(
          new SphereGeometry(0.85, 20, 14),
          new MeshStandardMaterial({
            color: coreColor,
            emissive: emissiveColor,
            emissiveIntensity: 4.8,
          }),
        );
        const beam = new Mesh(
          new CylinderGeometry(0.45, 0.45, 16, 12, 1, true),
          new MeshBasicMaterial({
            color: emissiveColor,
            transparent: true,
            opacity: 0.88,
            depthTest: false,
            depthWrite: false,
            side: DoubleSide,
          }),
        );
        beam.position.y = 8;
        const ring = new Mesh(
          new CylinderGeometry(2.8, 2.8, 0.08, 20, 1, true),
          new MeshBasicMaterial({
            color: emissiveColor,
            transparent: true,
            opacity: 0.72,
            depthTest: false,
            depthWrite: false,
            side: DoubleSide,
          }),
        );
        ring.position.y = -0.35;
        mesh.add(beam, ring);
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
      visual.mesh.position.addScaledVector(frame.up, defaultVehicleTuning.hoverHeight);
      this.orientMat.makeBasis(frame.right, frame.up, frame.tangent.clone().negate());
      visual.mesh.setRotationFromMatrix(this.orientMat);
      const beam = visual.mesh.children[0];
      const ring = visual.mesh.children[1];
      if (beam) {
        beam.scale.y = 1 + Math.sin(timeSeconds * 3 + visual.u * 17) * 0.12;
      }
      if (ring) {
        const pulse = 1 + Math.sin(timeSeconds * 4.2 + visual.u * 23) * 0.16;
        ring.scale.setScalar(pulse);
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

    const body = this.localVehicle.group.children[0];
    if (body) {
      body.rotation.set(state.visualPitch, -state.steering * 0.15, state.visualBank, "XYZ");
    }
    if (this.localTakenDownUntil > now) {
      this.applySpinoutVisual(this.localVehicle.group, body ?? null, state.up, now, this.localTakenDownUntil);
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
      const body = remote.group.children[0] ?? null;
      if (body) {
        body.rotation.set(0, 0, 0, "XYZ");
      }
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

    this.localVehicle.bodyMaterial.color.copy(bodyColor);
    this.localVehicle.bodyMaterial.emissive.copy(bodyEmissive);
    this.localVehicle.bodyMaterial.emissiveIntensity = 0.8 + surgeBoost * 2.8 + slowdownMix * 1.2;
    this.localVehicle.cockpitMaterial.color.copy(cockpitColor);
    this.localVehicle.cockpitMaterial.emissive.copy(cockpitEmissive);
    this.localVehicle.cockpitMaterial.emissiveIntensity = 0.45 + surgeBoost * 1.9 + slowdownMix * 0.5;

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
    this.updateSpeedFeedback(deltaSeconds);

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
    this.updateSpeedTracers();
    this.updatePickupVisuals(time / 1000);
    this.combatVfx.update(performance.now());
    this.updateCamera(deltaSeconds);
    this.environment.update(this.elapsedRaceTime, musicTime, this.vehicleController.state.trackU, this.latestReactiveBands);
    this.updateHud();
    this.updateDebugHud();
    this.updatePostEffects();
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
