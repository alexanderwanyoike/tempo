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
  MeshBasicMaterial,
  Mesh,
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
import type { SongDefinition } from "../../../shared/song-schema";
import type { ClientConfig } from "./config";
import { EnvironmentRuntime } from "./environment";
import { clampFictionId, type EnvironmentFictionId } from "./fiction-id";
import { VehicleInput } from "./input";
import { MusicSync, type ReactiveBands } from "./music-sync";
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

type RaceState = "running" | "won" | "lost";

export type AppLaunchOptions = {
  songUrl?: string;
  musicUrl?: string | null;
  seed?: number | null;
  fictionId?: EnvironmentFictionId;
  debugHud?: boolean;
  onRetry?: (() => void) | null;
  onBackToMenu?: (() => void) | null;
};

export class App {
  private static readonly WORLD_UP = new Vector3(0, 1, 0);
  private static readonly BOOST_COLOR = new Color("#8bff56");
  private static readonly BOOST_HOT_COLOR = new Color("#d8ff8a");
  private static readonly BODY_BASE_COLOR = new Color("#14f1ff");
  private static readonly BODY_BASE_EMISSIVE = new Color("#0f6d74");
  private static readonly COCKPIT_BASE_COLOR = new Color("#0e1320");
  private static readonly COCKPIT_BASE_EMISSIVE = new Color("#1b2744");
  private static readonly WIN_SFX_URL = new URL("../../../assets/audio/Win Backspin.wav", import.meta.url).href;
  private static readonly LOSE_SFX_URL = new URL("../../../assets/audio/Lose Backspin.wav", import.meta.url).href;
  private readonly renderer: WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly carRoot: Group;
  private readonly carBody: Mesh;
  private readonly carBodyMaterial: MeshStandardMaterial;
  private readonly cockpitMaterial: MeshStandardMaterial;
  private readonly boostTrailGroup = new Group();
  private readonly boostTrailMeshes: Mesh[] = [];
  private readonly boostTrailMaterials: MeshBasicMaterial[] = [];
  private readonly boostTrailHistory: TrailSample[] = [];
  private readonly winSfx = new Audio(App.WIN_SFX_URL);
  private readonly loseSfx = new Audio(App.LOSE_SFX_URL);
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
  private readonly statusTitle: HTMLDivElement;
  private readonly statusSubtitle: HTMLDivElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly menuButton: HTMLButtonElement;
  private readonly triggeredTrackObjects = new Set<string>();
  private lastFrameTime = 0;
  private elapsedRaceTime = 0;
  private raceState: RaceState = "running";
  private latestReactiveBands: ReactiveBands | null = null;
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
  private animationFrameId: number | null = null;
  private destroyed = false;
  private visualsInitialized = false;

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
    let musicLoadPromise: Promise<void> | null = null;

    if (songUrl) {
      const requestedMusicUrl = launch.musicUrl === null
        ? null
        : (launch.musicUrl ?? songUrl.replace(/\.json$/, ".mp3").replace("/songs/", "/music/"));
      const songPromise = loadSongDefinition(songUrl);

      if (requestedMusicUrl) {
        musicSync = new MusicSync();
        musicLoadPromise = musicSync.load(requestedMusicUrl);
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

    if (musicLoadPromise) {
      musicLoadPromise.catch((e) => {
        console.warn("Music load failed:", e);
      });
    }

    return new App(
      root,
      config,
      track,
      musicSync,
      musicLoadPromise,
      song,
      seed,
      fictionId,
      launch.debugHud ?? false,
      launch.onRetry ?? null,
      launch.onBackToMenu ?? null,
    );
  }

  private readonly musicLoadPromise: Promise<void> | null;

  private constructor(
    private readonly root: HTMLElement,
    private readonly config: ClientConfig,
    track: Track,
    musicSync: MusicSync | null,
    musicLoadPromise: Promise<void> | null,
    song: SongDefinition | null,
    seed: number,
    fictionId: EnvironmentFictionId,
    debugHudEnabled: boolean,
    private readonly onRetry: (() => void) | null,
    private readonly onBackToMenu: (() => void) | null,
  ) {
    this.musicLoadPromise = musicLoadPromise;
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

    const bodyMaterial = new MeshStandardMaterial({
      color: App.BODY_BASE_COLOR.clone(),
      emissive: App.BODY_BASE_EMISSIVE.clone(),
      metalness: 0.3,
      roughness: 0.5,
    });
    const body = new Mesh(new BoxGeometry(1.4, 0.5, 3.2), bodyMaterial);
    body.position.y = 0.1;

    const cockpitMaterial = new MeshStandardMaterial({
      color: App.COCKPIT_BASE_COLOR.clone(),
      emissive: App.COCKPIT_BASE_EMISSIVE.clone(),
      metalness: 0.15,
      roughness: 0.45,
    });
    const cockpit = new Mesh(new BoxGeometry(0.8, 0.35, 1.15), cockpitMaterial);
    cockpit.position.set(0, 0.35, 0.1);

    const carRoot = new Group();
    carRoot.add(body, cockpit);

    this.carRoot = carRoot;
    this.carBody = body;
    this.carBodyMaterial = bodyMaterial;
    this.cockpitMaterial = cockpitMaterial;
    this.input = new VehicleInput();
    this.vehicleController = new VehicleController(defaultVehicleTuning);
    this.musicSync = musicSync;
    this.songDuration = song?.duration ?? null;
    this.fictionId = fictionId;
    this.debugHud = this.createDebugHud(debugHudEnabled);
    const statusUi = this.createStatusOverlay();
    this.statusOverlay = statusUi.overlay;
    this.statusTitle = statusUi.title;
    this.statusSubtitle = statusUi.subtitle;
    this.retryButton = statusUi.retryButton;
    this.menuButton = statusUi.menuButton;

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
    this.scene.add(this.boostTrailGroup);
    this.scene.add(this.camera);
    this.createBoostTrailMeshes();
    this.configureSfx();
  }

  start(): void {
    this.root.appendChild(this.renderer.domElement);
    if (this.debugHud) this.root.appendChild(this.debugHud);
    this.root.appendChild(this.statusOverlay);
    this.setupScene();
    this.bindEvents();
    if (this.musicLoadPromise) {
      this.musicLoadPromise
        .then(() => {
          if (!this.destroyed) this.musicSync?.play();
        })
        .catch(() => {});
    } else {
      this.musicSync?.play();
    }
    this.lastFrameTime = performance.now();
    this.render(this.lastFrameTime);
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
    this.musicSync?.stop();
    this.winSfx.pause();
    this.loseSfx.pause();
    this.renderer.dispose();
    this.disposeSceneGraph();
    this.root.replaceChildren();
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
    else this.musicSync?.resume();
  };

  private readonly handleResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  };

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
      this.carRoot.position.copy(desiredPosition);
      this.carRoot.quaternion.copy(this.targetCarQuaternion);
    } else {
      this.carRoot.position.lerp(desiredPosition, positionAlpha);
      const currentUpDot = this.tempVector.copy(App.WORLD_UP).applyQuaternion(this.carRoot.quaternion).dot(state.up);
      const currentForwardDot = this.tempVectorB.set(0, 0, -1).applyQuaternion(this.carRoot.quaternion).dot(state.forward);
      const quaternionDot = Math.abs(this.carRoot.quaternion.dot(this.targetCarQuaternion));
      const shouldSnapOrientation = currentUpDot < 0.15 || currentForwardDot < 0.1 || quaternionDot < 0.2;
      if (shouldSnapOrientation) {
        this.carRoot.quaternion.copy(this.targetCarQuaternion);
      } else {
        this.carRoot.quaternion.slerp(this.targetCarQuaternion, rotationAlpha);
      }
    }

    // Body visual effects (local to car)
    const speedRatio = Math.min(Math.abs(state.speed) / 90, 1);
    const visualYaw = -state.steering * 0.15 * (0.3 + speedRatio * 0.7);
    this.carBody.rotation.set(state.visualPitch, visualYaw, state.visualBank, "XYZ");
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

  private updateBoostVisuals(): void {
    const boost = this.vehicleController.state.visualBoost;
    const bodyColor = App.BODY_BASE_COLOR.clone().lerp(App.BOOST_HOT_COLOR, boost);
    const bodyEmissive = App.BODY_BASE_EMISSIVE.clone().lerp(App.BOOST_HOT_COLOR, boost);
    const cockpitColor = App.COCKPIT_BASE_COLOR.clone().lerp(new Color("#4a6a26"), boost * 0.48);
    const cockpitEmissive = App.COCKPIT_BASE_EMISSIVE.clone().lerp(App.BOOST_COLOR, boost);

    this.carBodyMaterial.color.copy(bodyColor);
    this.carBodyMaterial.emissive.copy(bodyEmissive);
    this.carBodyMaterial.emissiveIntensity = 0.9 + boost * 3.6;
    this.cockpitMaterial.color.copy(cockpitColor);
    this.cockpitMaterial.emissive.copy(cockpitEmissive);
    this.cockpitMaterial.emissiveIntensity = 0.5 + boost * 2.1;

    this.boostTrailHistory.unshift({
      position: this.carRoot.position.clone(),
      quaternion: this.carRoot.quaternion.clone(),
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

  private playRaceSfx(state: "won" | "lost"): void {
    const target = state === "won" ? this.winSfx : this.loseSfx;
    const other = state === "won" ? this.loseSfx : this.winSfx;
    other.pause();
    other.currentTime = 0;
    target.pause();
    target.currentTime = 0;
    void target.play().catch((error) => {
      console.warn(`Failed to play ${state} SFX:`, error);
    });
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

    // Speed FOV
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

    const lateral = Math.abs(query.lateralOffset);
    const safeHalfWidth = Math.max(this.track.getHalfWidthAt(query.u) - 1.2, 2);
    if (lateral < safeHalfWidth) {
      const push = 1 - lateral / safeHalfWidth;
      cameraPosition.addScaledVector(query.up, push * 0.8);
    }
  }

  private createDebugHud(enabled: boolean): HTMLDivElement | null {
    if (!enabled) return null;

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

  private createStatusOverlay(): {
    overlay: HTMLDivElement;
    title: HTMLDivElement;
    subtitle: HTMLDivElement;
    retryButton: HTMLButtonElement;
    menuButton: HTMLButtonElement;
  } {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.display = "none";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.background = "rgba(2, 4, 9, 0.68)";
    overlay.style.pointerEvents = "none";

    const panel = document.createElement("div");
    panel.style.minWidth = "min(420px, calc(100vw - 48px))";
    panel.style.padding = "28px 28px 24px";
    panel.style.borderRadius = "20px";
    panel.style.border = "1px solid rgba(120, 230, 255, 0.18)";
    panel.style.background = "rgba(8, 12, 20, 0.88)";
    panel.style.boxShadow = "0 30px 120px rgba(0, 0, 0, 0.48)";
    panel.style.textAlign = "center";
    panel.style.pointerEvents = "auto";

    const title = document.createElement("div");
    title.style.color = "#f4fbff";
    title.style.font = "700 40px/1.02 system-ui, sans-serif";
    title.style.letterSpacing = "0.08em";
    title.style.textTransform = "uppercase";

    const subtitle = document.createElement("div");
    subtitle.style.marginTop = "10px";
    subtitle.style.color = "rgba(221, 233, 247, 0.8)";
    subtitle.style.font = "600 13px/1.45 system-ui, sans-serif";
    subtitle.style.letterSpacing = "0.08em";
    subtitle.style.textTransform = "uppercase";

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "center";
    actions.style.gap = "12px";
    actions.style.marginTop = "22px";

    const retryButton = this.createOverlayButton("Retry");
    retryButton.addEventListener("click", () => {
      this.onRetry?.();
    });

    const menuButton = this.createOverlayButton("Back To Menu");
    menuButton.addEventListener("click", () => {
      this.onBackToMenu?.();
    });

    actions.append(retryButton, menuButton);
    panel.append(title, subtitle, actions);
    overlay.appendChild(panel);

    return {
      overlay,
      title,
      subtitle,
      retryButton,
      menuButton,
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

  private setRaceState(state: "won" | "lost"): void {
    if (this.raceState !== "running") return;
    this.raceState = state;
    this.statusOverlay.style.display = "flex";
    this.statusTitle.textContent = state === "won" ? "Track Cleared" : "Music Ended";
    this.statusSubtitle.textContent = state === "won"
      ? "Beat the song. Retry this seed or head back to the menu."
      : "The tune ended before the finish. Retry or switch tracks.";
    this.retryButton.style.display = this.onRetry ? "inline-flex" : "none";
    this.menuButton.style.display = this.onBackToMenu ? "inline-flex" : "none";
    if (state === "won") this.musicSync?.stop();
    else this.musicSync?.pause();
    this.playRaceSfx(state);
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
    if (this.destroyed) return;
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
    this.updateCarTransform(deltaSeconds);
    this.updateBoostVisuals();
    this.updateCamera(deltaSeconds);
    this.environment.update(
      this.elapsedRaceTime,
      musicTime,
      this.vehicleController.state.trackU,
      this.latestReactiveBands,
    );
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
