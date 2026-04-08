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
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector2,
  WebGLRenderer,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { SongDefinition } from "../../../shared/song-schema";
import type { ClientConfig } from "./config";
import { clampFictionId, EnvironmentRuntime, type EnvironmentFictionId } from "./environment";
import { VehicleInput } from "./input";
import { MusicSync, type ReactiveBands } from "./music-sync";
import { loadSongDefinition } from "./song-loader";
import type { Track, TrackObject } from "./track-builder";
import { TestTrack } from "./track-builder";
import { TrackGenerator } from "./track-generator";
import { VehicleController, defaultVehicleTuning } from "./vehicle-controller";

export class App {
  private readonly renderer: WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly carRoot: Group;
  private readonly carBody: Mesh;
  private readonly input: VehicleInput;
  private readonly vehicleController: VehicleController;
  private readonly track: Track;
  private readonly trackObjects: readonly TrackObject[];
  private readonly musicSync: MusicSync | null;
  private readonly songDuration: number | null;
  private readonly fictionId: EnvironmentFictionId;
  private readonly environment: EnvironmentRuntime;
  private readonly debugHud: HTMLDivElement | null;
  private readonly statusOverlay: HTMLDivElement;
  private readonly triggeredTrackObjects = new Set<string>();
  private lastFrameTime = 0;
  private elapsedRaceTime = 0;
  private raceState: "running" | "won" | "lost" = "running";
  private latestReactiveBands: ReactiveBands | null = null;
  private readonly orientMat = new Matrix4();

  static async create(
    root: HTMLElement,
    config: ClientConfig,
  ): Promise<App> {
    // Check URL params for song and seed
    const params = new URL(location.href).searchParams;
    const songUrl = params.get("song") ?? "/songs/firestarter.json";
    const seedParam = params.get("seed");
    const fictionParam = params.get("fiction");
    const fictionId = clampFictionId(fictionParam ? parseInt(fictionParam, 10) : null);

    let track: Track;
    let musicSync: MusicSync | null = null;
    let song: SongDefinition | null = null;
    let seed = 0;

    try {
      song = await loadSongDefinition(songUrl);
      seed = seedParam ? parseInt(seedParam, 10) : song.baseSeed;
      track = new TrackGenerator(song, seed);

      // Try to load music (non-blocking if no MP3 available)
      const musicUrl = songUrl.replace(/\.json$/, ".mp3").replace("/songs/", "/music/");
      try {
        musicSync = new MusicSync();
        await musicSync.load(musicUrl);
      } catch (e) {
        console.warn("Music load failed:", e);
        musicSync = null;
      }
    } catch {
      // Fallback to test track if song loading fails
      track = new TestTrack();
    }

    return new App(root, config, track, musicSync, song, seed, fictionId);
  }

  private constructor(
    private readonly root: HTMLElement,
    private readonly config: ClientConfig,
    track: Track,
    musicSync: MusicSync | null,
    song: SongDefinition | null,
    seed: number,
    fictionId: EnvironmentFictionId,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new Scene();
    this.scene.background = new Color("#05070c");

    // Near clip at 1.0 to cull close track geometry
    this.camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 1.0, 2000);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(
      new Vector2(window.innerWidth, window.innerHeight),
      0.44,
      0.42,
      0.36,
    ));

    const body = new Mesh(
      new BoxGeometry(1.4, 0.5, 3.2),
      new MeshStandardMaterial({
        color: "#14f1ff",
        emissive: "#0f6d74",
        metalness: 0.3,
        roughness: 0.5,
      }),
    );
    body.position.y = 0.1;

    const cockpit = new Mesh(
      new BoxGeometry(0.8, 0.35, 1.15),
      new MeshStandardMaterial({
        color: "#0e1320",
        emissive: "#1b2744",
        metalness: 0.15,
        roughness: 0.45,
      }),
    );
    cockpit.position.set(0, 0.35, 0.1);

    const carRoot = new Group();
    // Camera is a CHILD of carRoot - moves/rotates rigidly with the car
    carRoot.add(body, cockpit, this.camera);

    this.carRoot = carRoot;
    this.carBody = body;
    this.input = new VehicleInput();
    this.vehicleController = new VehicleController(defaultVehicleTuning);
    this.musicSync = musicSync;
    this.songDuration = song?.duration ?? null;
    this.fictionId = fictionId;
    this.debugHud = this.createDebugHud();
    this.statusOverlay = this.createStatusOverlay();

    this.track = track;
    this.trackObjects = this.track.getTrackObjects();
    this.environment = new EnvironmentRuntime(this.scene, this.track, song, seed, fictionId);
    this.scene.add(this.environment.group);
    this.scene.add(this.track.meshGroup);

    this.vehicleController.setTrack(this.track);
    this.vehicleController.setTrackQuery((pos, hintU) => this.track.queryNearest(pos, hintU));

    this.vehicleController.state.trackU = 0.001;
    this.vehicleController.state.lateralOffset = 0;

    this.scene.add(this.carRoot);
  }

  start(): void {
    this.root.appendChild(this.renderer.domElement);
    if (this.debugHud) this.root.appendChild(this.debugHud);
    this.root.appendChild(this.statusOverlay);
    this.setupScene();
    this.bindEvents();
    this.musicSync?.play();
    this.lastFrameTime = performance.now();
    this.render(this.lastFrameTime);
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
    // Resume audio context on visibility change
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.musicSync?.pause();
      else this.musicSync?.resume();
    });
    this.input.attach();
  }

  private readonly handleResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  };

  private updateCarTransform(): void {
    const state = this.vehicleController.state;

    // Position + hover bob along track up
    this.carRoot.position.copy(state.position);
    this.carRoot.position.addScaledVector(state.up, state.visualHoverOffset);

    // Orientation from track frame: makeBasis(right, up, -forward)
    const negFwd = state.forward.clone().negate();
    this.orientMat.makeBasis(state.right, state.up, negFwd);
    this.carRoot.setRotationFromMatrix(this.orientMat);

    // Body visual effects (local to car)
    const speedRatio = Math.min(Math.abs(state.speed) / 90, 1);
    const visualYaw = -state.steering * 0.15 * (0.3 + speedRatio * 0.7);
    this.carBody.rotation.set(state.visualPitch, visualYaw, state.visualBank, "XYZ");
  }

  private updateCamera(): void {
    const speed = Math.abs(this.vehicleController.state.speed);
    const speedRatio = Math.min(speed / 90, 1);

    // Camera is child of carRoot - just set local position
    // Local: X=right, Y=up, Z=backward
    const camBack = MathUtils.lerp(8, 14, speedRatio);
    const camUp = MathUtils.lerp(3.5, 5.5, speedRatio);
    this.camera.position.set(0, camUp, camBack);
    // Default orientation looks down -Z = car's forward direction
    this.camera.rotation.set(0, 0, 0);

    // Speed FOV
    this.camera.fov = MathUtils.lerp(70, 95, speedRatio * speedRatio);
    this.camera.updateProjectionMatrix();
  }

  private createDebugHud(): HTMLDivElement | null {
    const params = new URL(location.href).searchParams;
    if (params.get("debugHud") !== "1") return null;

    const hud = document.createElement("div");
    hud.style.position = "fixed";
    hud.style.top = "16px";
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

  private createStatusOverlay(): HTMLDivElement {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.display = "none";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.background = "rgba(2, 4, 9, 0.56)";
    overlay.style.color = "#f4fbff";
    overlay.style.font = "700 42px/1.1 system-ui, sans-serif";
    overlay.style.letterSpacing = "0.08em";
    overlay.style.textTransform = "uppercase";
    overlay.style.textAlign = "center";
    overlay.style.pointerEvents = "none";
    return overlay;
  }

  private setRaceState(state: "won" | "lost"): void {
    if (this.raceState !== "running") return;
    this.raceState = state;
    this.statusOverlay.style.display = "flex";
    this.statusOverlay.textContent = state === "won" ? "Track Cleared" : "Music Ended\nYou Lose";
    this.statusOverlay.style.whiteSpace = "pre";
    this.musicSync?.pause();
  }

  private handleTrackObjects(): void {
    if (this.trackObjects.length === 0) return;

    const state = this.vehicleController.state;
    const uWindow = 14 / this.track.totalLength;

    for (const object of this.trackObjects) {
      if (this.triggeredTrackObjects.has(object.id)) continue;
      if (Math.abs(object.u - state.trackU) > uWindow) continue;

      const objectHalfLengthU = object.collisionLength / this.track.totalLength;
      if (Math.abs(object.u - state.trackU) > objectHalfLengthU) continue;

      const lateralDelta = Math.abs(state.lateralOffset - object.lateralOffset);
      if (lateralDelta > object.collisionHalfWidth + 0.9) continue;

      this.triggeredTrackObjects.add(object.id);
      if (object.kind === "boost") {
        this.vehicleController.applyPickupBoost();
      } else {
        this.vehicleController.applyObstacleHit();
      }
    }
  }

  private updateRaceState(): void {
    if (this.raceState !== "running") return;

    if (this.vehicleController.state.trackU >= 0.999) {
      this.setRaceState("won");
      return;
    }

    const musicTime = this.musicSync?.getCurrentTime() ?? this.elapsedRaceTime;
    if (this.songDuration !== null && musicTime >= this.songDuration) {
      this.setRaceState("lost");
    }
  }

  private updateDebugHud(): void {
    if (!this.debugHud) return;

    const state = this.vehicleController.state;
    const musicTime = this.musicSync?.getCurrentTime() ?? 0;
    const projectedFinish = state.trackU > 0.01 ? this.elapsedRaceTime / state.trackU : null;
    const finishDelta = projectedFinish !== null && this.songDuration !== null
      ? projectedFinish - this.songDuration
      : null;
    this.debugHud.textContent = [
      `fiction ${this.fictionId}`,
      `race ${this.formatSeconds(this.elapsedRaceTime)}`,
      `music ${this.formatSeconds(musicTime)}`,
      `song ${this.songDuration !== null ? this.formatSeconds(this.songDuration) : "--:--.--"}`,
      `trackU ${state.trackU.toFixed(3)}`,
      `speed ${state.speed.toFixed(1)} m/s`,
      `proj ${projectedFinish !== null ? this.formatSeconds(projectedFinish) : "--:--.--"}`,
      `delta ${finishDelta !== null ? `${finishDelta >= 0 ? "+" : ""}${finishDelta.toFixed(2)}s` : "--"}`,
      `bands ${this.latestReactiveBands ? `${this.latestReactiveBands.low.toFixed(2)} ${this.latestReactiveBands.mid.toFixed(2)} ${this.latestReactiveBands.high.toFixed(2)}` : "-- -- --"}`,
    ].join("\n");
  }

  private formatSeconds(value: number): string {
    const minutes = Math.floor(value / 60);
    const seconds = value - minutes * 60;
    return `${minutes.toString().padStart(2, "0")}:${seconds.toFixed(2).padStart(5, "0")}`;
  }

  private render = (time: number): void => {
    const deltaSeconds = (time - this.lastFrameTime) / 1000;
    this.lastFrameTime = time;
    if (this.raceState === "running") {
      this.elapsedRaceTime += deltaSeconds;
      this.vehicleController.update(deltaSeconds, this.input.state);
      this.handleTrackObjects();
      this.updateRaceState();
    }
    const musicTime = this.musicSync?.getCurrentTime() ?? this.elapsedRaceTime;
    this.latestReactiveBands = this.musicSync?.getReactiveBands() ?? null;
    this.updateCarTransform();
    this.updateCamera();
    this.environment.update(
      this.elapsedRaceTime,
      musicTime,
      this.vehicleController.state.trackU,
      this.latestReactiveBands,
    );
    this.updateDebugHud();
    this.composer.render();
    window.requestAnimationFrame(this.render);
  };
}
