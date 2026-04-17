import {
  BackSide,
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  DynamicDrawUsage,
  FogExp2,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  Scene,
  SphereGeometry,
  TorusGeometry,
  TorusKnotGeometry,
  Vector3,
  type BufferGeometry,
} from "three";
import type { SongDefinition, SongSectionType } from "../../../shared/song-schema";
import type { ReactiveBands } from "./music-sync";
import type { EnvironmentFictionId } from "./fiction-id";
import { mulberry32 } from "./prng";
import type { Track, TrackFrame } from "./track-builder";

type SectionInfo = {
  type: SongSectionType;
  energy: number;
  startTime: number;
  endTime: number;
};

export type ReactiveSnapshot = {
  sectionTint: Color;
  phraseColorA: Color;
  phraseColorB: Color;
  phraseBlend: number;
  beatPhase: number;
  bandLow: number;
  bandMid: number;
  bandHigh: number;
  kick: number;
  energyLevel: number;
};

type GeneratedPlacement = {
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
  energy: number;
  phase: number;
  weight: number;
  u: number;
  bobAmplitude: number;
  bobSpeed: number;
  spinAxis: Vector3;
  spinSpeed: number;
};

type ThemeSpec = {
  fictionId: EnvironmentFictionId;
  name: string;
  skyBase: string;
  skyAccent: string;
  fogBase: string;
  structureBase: string;
  skylineBase: string;
  gateBase: string;
  haloBase: string;
  accentBase: string;
  sideGeometry: "box" | "cylinder" | "spire";
  skylineGeometry: "box" | "cylinder" | "spire";
  accentGeometry: "octa" | "box" | "spire" | "dodeca" | "ico" | "knot";
  sideSpacing: number;
  skylineSpacing: number;
  accentSpacing: number;
  sideClearance: [number, number];
  skylineClearance: [number, number];
  gateScale: [number, number];
  haloScale: [number, number];
};

type EnvironmentDefinition = {
  sideStructures: GeneratedPlacement[];
  skyline: GeneratedPlacement[];
  accents: GeneratedPlacement[];
  gates: GeneratedPlacement[];
  halos: GeneratedPlacement[];
};

type LayerMotion = {
  bob: boolean;
  spin: boolean;
  scale: boolean;
  axisBiased: boolean;
};

type AmplitudeProfile = {
  scene: number;
  side: number;
  skyline: number;
  accent: number;
  gate: number;
  halo: number;
};

type LoadingCog = {
  anchor: Group;
  wheel: Group;
  basePosition: Vector3;
  baseQuaternion: Quaternion;
  baseScale: number;
  bobAmplitude: number;
  bobSpeed: number;
  spinSpeed: number;
  phase: number;
};

type LoadingSign = {
  anchor: Group;
  signRoot: Group;
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  textMaterial: MeshBasicMaterial;
  metalMaterial: MeshStandardMaterial;
  basePosition: Vector3;
  baseQuaternion: Quaternion;
  baseLocalPosition: Vector3;
  baseRotationY: number;
  baseRotationZ: number;
  side: -1 | 1;
  phase: number;
  promptIndex: number;
};

type ThemePalette = {
  skyBase: Color;
  fogBase: Color;
  structureBase: Color;
  skylineBase: Color;
  gateBase: Color;
  haloBase: Color;
  accentBase: Color;
};

const SKINNED_THEMES: Record<EnvironmentFictionId, ThemeSpec> = {
  1: {
    fictionId: 1,
    name: "Audio Reactor",
    skyBase: "#06101d",
    skyAccent: "#2dd6ff",
    fogBase: "#082130",
    structureBase: "#14b9ff",
    skylineBase: "#77ffba",
    gateBase: "#ff5a84",
    haloBase: "#ffb347",
    accentBase: "#98f7ff",
    sideGeometry: "cylinder",
    skylineGeometry: "cylinder",
    accentGeometry: "knot",
    sideSpacing: 96,
    skylineSpacing: 126,
    accentSpacing: 164,
    sideClearance: [14, 28],
    skylineClearance: [92, 165],
    gateScale: [16, 11],
    haloScale: [24, 17],
  },
  2: {
    fictionId: 2,
    name: "Signal City",
    skyBase: "#0a0f19",
    skyAccent: "#ff5c7a",
    fogBase: "#111726",
    structureBase: "#4cb1ff",
    skylineBase: "#ff8d5c",
    gateBase: "#ff5e7f",
    haloBase: "#2cf0d8",
    accentBase: "#9ab7ff",
    sideGeometry: "box",
    skylineGeometry: "spire",
    accentGeometry: "dodeca",
    sideSpacing: 84,
    skylineSpacing: 112,
    accentSpacing: 150,
    sideClearance: [16, 30],
    skylineClearance: [105, 185],
    gateScale: [18, 10],
    haloScale: [22, 15],
  },
  3: {
    fictionId: 3,
    name: "Data Cathedral",
    skyBase: "#0a0814",
    skyAccent: "#f08cff",
    fogBase: "#161126",
    structureBase: "#c58dff",
    skylineBase: "#fff0b3",
    gateBase: "#8df0ff",
    haloBase: "#ffd3f7",
    accentBase: "#f6caff",
    sideGeometry: "spire",
    skylineGeometry: "spire",
    accentGeometry: "ico",
    sideSpacing: 102,
    skylineSpacing: 136,
    accentSpacing: 172,
    sideClearance: [15, 27],
    skylineClearance: [110, 190],
    gateScale: [15, 14],
    haloScale: [26, 19],
  },
};

const SECTION_TINTS: Record<SongSectionType, string> = {
  intro: "#5db3ff",
  verse: "#4effd2",
  build: "#ffe55e",
  drop: "#ff5f8f",
  bridge: "#c999ff",
  breakdown: "#89a7c7",
  finale: "#ff9d42",
};

const MIN_ENV_CLEARANCE = 10;
const GATE_CLEARANCE_HEIGHT = 12;
const SKY_DOME_RADIUS = 520;
const PHRASE_BEATS = 32;
const LOADING_GEAR_SKY = "#160d05";
const LOADING_GEAR_FOG = "#2c1906";
const LOADING_GEAR_TINT = "#ffcf58";
const LOADING_GEAR_EMISSIVE = "#ff9f20";
const LOADING_PROMPTS = [
  {
    title: "PREPARING THE RACE...",
    body: "Why don't you warm up while the grid pretends it is not nervous?",
  },
  {
    title: "CALIBRATING COGS...",
    body: "Big wheels spin the universe. Small wheels blame the latency.",
  },
  {
    title: "ALIGNING START LIGHTS...",
    body: "Take a look around. In a minute this place becomes much less polite.",
  },
  {
    title: "HEATING THE ASPHALT...",
    body: "Stretch the steering. The track is about to act like it knows your secrets.",
  },
  {
    title: "SYNCING PILOTS...",
    body: "If you hear machinery gossiping, that just means the countdown is getting closer.",
  },
] as const;

export class EnvironmentRuntime {
  readonly group = new Group();

  private readonly theme: ThemeSpec;
  private readonly palette: ThemePalette;
  private readonly definition: EnvironmentDefinition;
  private readonly skyDome: Mesh;
  private readonly sideMesh: InstancedMesh;
  private readonly skylineMesh: InstancedMesh;
  private readonly accentMesh: InstancedMesh;
  private readonly gateMesh: InstancedMesh;
  private readonly haloMesh: InstancedMesh;
  private readonly skyMaterial: MeshBasicMaterial;
  private readonly sideMaterial: MeshStandardMaterial;
  private readonly skylineMaterial: MeshStandardMaterial;
  private readonly accentMaterial: MeshStandardMaterial;
  private readonly gateMaterial: MeshStandardMaterial;
  private readonly haloMaterial: MeshStandardMaterial;
  private readonly loadingGroup = new Group();
  private readonly loadingCogMaterial: MeshStandardMaterial;
  private readonly loadingCogCoreMaterial: MeshStandardMaterial;
  private readonly loadingCogDetailMaterial: MeshStandardMaterial;
  private readonly loadingCogs: LoadingCog[];
  private readonly loadingSigns: LoadingSign[];
  private readonly background = new Color();
  private readonly fogColor = new Color();
  private readonly tmpColorA = new Color();
  private readonly tmpColorB = new Color();
  private readonly tmpColorC = new Color();
  private readonly tmpColorD = new Color();
  private readonly tmpColorE = new Color();
  private readonly snapshotSectionTint = new Color();
  private readonly snapshotPhraseA = new Color();
  private readonly snapshotPhraseB = new Color();
  private readonly reactiveSnapshot: ReactiveSnapshot = {
    sectionTint: this.snapshotSectionTint,
    phraseColorA: this.snapshotPhraseA,
    phraseColorB: this.snapshotPhraseB,
    phraseBlend: 0,
    beatPhase: 0,
    bandLow: 0,
    bandMid: 0,
    bandHigh: 0,
    kick: 0,
    energyLevel: 0,
  };
  private readonly phraseColors: Color[];
  private readonly dummy = new Object3D();
  private readonly defaultDuration: number;
  private readonly moodDarkness: number;

  constructor(
    private readonly scene: Scene,
    private readonly track: Track,
    private readonly song: SongDefinition | null,
    seed: number,
    fictionId: EnvironmentFictionId,
  ) {
    this.theme = SKINNED_THEMES[fictionId];
    this.defaultDuration = song?.duration ?? Math.max(track.totalLength / 84, 90);
    this.moodDarkness = this.estimateMoodDarkness();
    this.palette = this.buildPalette();
    this.phraseColors = this.buildPhraseColors();
    this.definition = this.generateDefinition(seed);

    this.skyMaterial = new MeshBasicMaterial({
      color: this.palette.skyBase,
      side: BackSide,
      depthWrite: false,
    });
    this.skyDome = new Mesh(new SphereGeometry(SKY_DOME_RADIUS, 24, 16), this.skyMaterial);
    this.group.add(this.skyDome);

    this.sideMaterial = this.createLitMaterial(this.palette.structureBase);
    this.sideMesh = this.createInstancedMesh(this.buildGeometry(this.theme.sideGeometry), this.sideMaterial, this.definition.sideStructures.length);
    this.group.add(this.sideMesh);

    this.skylineMaterial = this.createLitMaterial(this.palette.skylineBase);
    this.skylineMesh = this.createInstancedMesh(this.buildGeometry(this.theme.skylineGeometry), this.skylineMaterial, this.definition.skyline.length);
    this.group.add(this.skylineMesh);

    this.accentMaterial = this.createLitMaterial(this.palette.accentBase);
    this.accentMesh = this.createInstancedMesh(this.buildGeometry(this.theme.accentGeometry), this.accentMaterial, this.definition.accents.length);
    this.group.add(this.accentMesh);

    this.gateMaterial = this.createLitMaterial(this.palette.gateBase);
    this.gateMesh = this.createInstancedMesh(new TorusGeometry(1, 0.12, 12, 30), this.gateMaterial, this.definition.gates.length);
    this.group.add(this.gateMesh);

    this.haloMaterial = this.createLitMaterial(this.palette.haloBase);
    this.haloMesh = this.createInstancedMesh(new TorusGeometry(1, 0.08, 10, 26), this.haloMaterial, this.definition.halos.length);
    this.group.add(this.haloMesh);

    this.loadingCogMaterial = new MeshStandardMaterial({
      color: LOADING_GEAR_TINT,
      emissive: LOADING_GEAR_EMISSIVE,
      emissiveIntensity: 2.4,
      metalness: 0.42,
      roughness: 0.24,
      transparent: true,
      opacity: 0,
    });
    this.loadingCogCoreMaterial = new MeshStandardMaterial({
      color: "#4d2c0d",
      emissive: "#ff8b1f",
      emissiveIntensity: 1.45,
      metalness: 0.32,
      roughness: 0.38,
      transparent: true,
      opacity: 0,
    });
    this.loadingCogDetailMaterial = new MeshStandardMaterial({
      color: "#ffeeb0",
      emissive: "#ffc54d",
      emissiveIntensity: 2.8,
      metalness: 0.12,
      roughness: 0.12,
      transparent: true,
      opacity: 0,
    });
    this.loadingCogs = this.createLoadingCogs(seed);
    this.loadingSigns = this.createLoadingSigns();
    this.group.add(this.loadingGroup);

    this.group.frustumCulled = false;
    this.scene.fog = new FogExp2(this.palette.fogBase.clone(), 0.0021);
    this.scene.background = this.background.copy(this.palette.skyBase);
  }

  update(
    elapsedTime: number,
    musicTime: number,
    trackU: number,
    sourceBands: ReactiveBands | null,
    loadingBlend = 0,
  ): ReactiveSnapshot {
    const section = this.getSectionAtTime(musicTime);
    const bands = sourceBands ?? this.getFallbackBands(elapsedTime, section.energy);
    const amplitude = this.getAmplitudeProfile(bands, section.energy);
    const playerPos = this.track.getPointAt(trackU);
    const beatPhase = ((musicTime * this.getBpm()) / 60) % 1;
    const beatPulse = 0.5 + 0.5 * Math.sin(beatPhase * Math.PI * 2);
    const energyPulse = MathUtils.clamp(section.energy * 0.45 + beatPulse * 0.25 + bands.low * 0.3, 0, 1);
    const stagingBlend = MathUtils.clamp(loadingBlend, 0, 1);
    const themedAmplitudeScale = MathUtils.lerp(1, 0.42, stagingBlend);
    const phraseA = this.getPhraseColor(musicTime, 0);
    const phraseB = this.getPhraseColor(musicTime, 1);
    const phraseBlend = this.getPhraseBlend(musicTime);
    this.snapshotSectionTint.set(SECTION_TINTS[section.type]);
    this.snapshotPhraseA.copy(phraseA);
    this.snapshotPhraseB.copy(phraseB);
    this.reactiveSnapshot.phraseBlend = phraseBlend;
    this.reactiveSnapshot.beatPhase = beatPhase;
    this.reactiveSnapshot.bandLow = bands.low;
    this.reactiveSnapshot.bandMid = bands.mid;
    this.reactiveSnapshot.bandHigh = bands.high;
    this.reactiveSnapshot.kick = bands.kick;
    this.reactiveSnapshot.energyLevel = bands.energyLevel;

    this.skyDome.position.copy(playerPos);
    this.updateSceneColors(section.type, musicTime, energyPulse, amplitude, stagingBlend);
    this.updateLayer(
      this.definition.sideStructures,
      this.sideMesh,
      amplitude.side * themedAmplitudeScale,
      0.52 + section.energy * 0.16,
      elapsedTime,
      { bob: true, spin: false, scale: true, axisBiased: false },
    );
    this.updateLayer(
      this.definition.skyline,
      this.skylineMesh,
      amplitude.skyline * themedAmplitudeScale,
      0.92 + section.energy * 0.2,
      elapsedTime,
      { bob: true, spin: false, scale: true, axisBiased: true },
    );
    this.updateLayer(
      this.definition.accents,
      this.accentMesh,
      amplitude.accent * themedAmplitudeScale,
      1.05 + section.energy * 0.24,
      elapsedTime,
      { bob: true, spin: true, scale: true, axisBiased: true },
    );
    this.updateLayer(
      this.definition.gates,
      this.gateMesh,
      amplitude.gate,
      0.24,
      elapsedTime,
      { bob: false, spin: false, scale: false, axisBiased: true },
    );
    this.updateLayer(
      this.definition.halos,
      this.haloMesh,
      amplitude.halo,
      0.26,
      elapsedTime,
      { bob: false, spin: false, scale: false, axisBiased: true },
    );
    this.updateLoadingFiction(elapsedTime, playerPos, stagingBlend);
    return this.reactiveSnapshot;
  }

  private createLitMaterial(color: Color): MeshStandardMaterial {
    return new MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.75,
      metalness: 0.28,
      roughness: 0.28,
      transparent: true,
      opacity: 0.92,
    });
  }

  private createInstancedMesh(
    geometry: BufferGeometry,
    material: MeshStandardMaterial,
    count: number,
  ): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, Math.max(count, 1));
    mesh.count = count;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    return mesh;
  }

  private createLoadingCogs(seed: number): LoadingCog[] {
    const rng = mulberry32(seed ^ 0x51f15eed);
    const cogs: LoadingCog[] = [];
    const rimGeometry = new TorusGeometry(1.14, 0.18, 10, 22);
    const hubGeometry = new CylinderGeometry(0.34, 0.34, 0.28, 14);
    const toothGeometry = new BoxGeometry(0.26, 0.54, 0.2);
    const spokeGeometry = new BoxGeometry(1.18, 0.1, 0.14);
    const maxCogBanks = Math.max(14, Math.min(64, Math.ceil(this.track.totalLength / 220)));
    const targetSpacing = Math.max(46, this.track.totalLength / maxCogBanks);

    let distance = 36;
    while (distance < this.track.totalLength - 24 && cogs.length < maxCogBanks * 2) {
      const u = distance / this.track.totalLength;
      const frame = this.track.getFrameAt(u);
      const center = this.track.getPointAt(u);
      const sides = rng() > 0.18 ? ([-1, 1] as const) : ([rng() > 0.5 ? 1 : -1] as const);
      for (const side of sides) {
        const lateralOffset = this.track.getHalfWidthAt(u) + 11 + rng() * 10;
        const verticalOffset = 4.2 + rng() * 8.8;
        const basePosition = center.clone()
          .addScaledVector(frame.right, lateralOffset * side)
          .addScaledVector(frame.up, verticalOffset);

        const anchor = new Group();
        anchor.position.copy(basePosition);
        anchor.quaternion.copy(this.quaternionFromFrame(frame));

        const wheel = new Group();
        const scaleBand = rng();
        const scale = scaleBand < 0.2
          ? 1.15 + rng() * 1.1
          : scaleBand > 0.8
            ? 4.8 + rng() * 3.6
            : 2.2 + rng() * 2.1;
        wheel.scale.setScalar(scale);

        const rim = new Mesh(rimGeometry, this.loadingCogMaterial);
        const hub = new Mesh(hubGeometry, this.loadingCogCoreMaterial);
        hub.rotation.x = Math.PI / 2;
        wheel.add(rim, hub);

        for (let toothIndex = 0; toothIndex < 8; toothIndex += 1) {
          const angle = (toothIndex / 8) * Math.PI * 2;
          const tooth = new Mesh(toothGeometry, this.loadingCogDetailMaterial);
          tooth.position.set(Math.cos(angle) * 1.28, Math.sin(angle) * 1.28, 0);
          tooth.rotation.z = angle;
          wheel.add(tooth);
        }

        for (let spokeIndex = 0; spokeIndex < 4; spokeIndex += 1) {
          const angle = (spokeIndex / 4) * Math.PI * 2 + Math.PI / 4;
          const spoke = new Mesh(spokeGeometry, this.loadingCogCoreMaterial);
          spoke.rotation.z = angle;
          wheel.add(spoke);
        }

        anchor.add(wheel);
        this.loadingGroup.add(anchor);
        cogs.push({
          anchor,
          wheel,
          basePosition,
          baseQuaternion: anchor.quaternion.clone(),
          baseScale: scale,
          bobAmplitude: 0.3 + rng() * 0.9,
          bobSpeed: 0.55 + rng() * 0.45,
          spinSpeed: (0.55 + rng() * 1.2) * (side === 1 ? 1 : -1),
          phase: rng() * Math.PI * 2,
        });
      }
      distance += MathUtils.clamp(
        targetSpacing * (0.72 + rng() * 0.56),
        42,
        92,
      );
    }

    this.loadingGroup.visible = false;
    return cogs;
  }

  private createLoadingSigns(): LoadingSign[] {
    const signs: LoadingSign[] = [];
    const targetCount = Math.max(7, Math.min(12, Math.ceil(this.loadingCogs.length / 3.5)));
    const segmentSize = Math.max(1, Math.floor(this.loadingCogs.length / targetCount));

    for (let index = 0; index < targetCount; index += 1) {
      const start = index * segmentSize;
      const end = index === targetCount - 1
        ? this.loadingCogs.length
        : Math.min(this.loadingCogs.length, start + segmentSize);
      const sourceCog = this.loadingCogs
        .slice(start, end)
        .sort((a, b) => b.baseScale - a.baseScale)[0];
      if (!sourceCog) continue;

      const canvas = document.createElement("canvas");
      canvas.width = 1440;
      canvas.height = 720;
      const texture = new CanvasTexture(canvas);
      texture.needsUpdate = true;

      const textMaterial = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        opacity: 0,
      });
      const metalMaterial = new MeshStandardMaterial({
        color: "#241206",
        emissive: "#8a4b0d",
        emissiveIntensity: 0.5,
        metalness: 0.42,
        roughness: 0.56,
        transparent: true,
        opacity: 0,
      });

      const side = sourceCog.basePosition.x >= 0 ? 1 : -1;
      const anchor = new Group();
      const basePosition = sourceCog.basePosition.clone();
      anchor.position.copy(basePosition);
      anchor.quaternion.copy(sourceCog.baseQuaternion);

      const signRoot = new Group();
      const baseLocalPosition = new Vector3(
        side * (sourceCog.baseScale * 0.96 + 2.3 + (index % 3) * 0.45),
        sourceCog.baseScale * 0.72 + 1.9 + (index % 2) * 0.35,
        (index % 2 === 0 ? 0.22 : -0.18) * side,
      );
      const baseRotationY = (side === 1 ? -0.08 : 0.08) + (index % 2 === 0 ? -0.025 : 0.025);
      const baseRotationZ = (side === 1 ? 0.024 : -0.024) + ((index % 3) - 1) * 0.028;
      signRoot.position.copy(baseLocalPosition);
      signRoot.rotation.y = baseRotationY;
      signRoot.rotation.z = baseRotationZ;
      signRoot.scale.setScalar(MathUtils.clamp(1.08 + sourceCog.baseScale * 0.16, 1.25, 1.95));

      const backPlateA = new Mesh(new BoxGeometry(24.5, 3.2, 0.28), metalMaterial);
      backPlateA.position.set(0.15, 2.8, -0.12);
      backPlateA.rotation.z = -0.11;
      const backPlateB = new Mesh(new BoxGeometry(22.2, 3.05, 0.24), metalMaterial);
      backPlateB.position.set(-0.25, -0.05, -0.16);
      backPlateB.rotation.z = 0.07;
      const backPlateC = new Mesh(new BoxGeometry(18.6, 2.7, 0.22), metalMaterial);
      backPlateC.position.set(0.3, -2.55, -0.18);
      backPlateC.rotation.z = -0.06;
      const braceA = new Mesh(new BoxGeometry(0.24, 5.8, 0.18), metalMaterial);
      braceA.position.set(side * -6.4, 0.45, -0.42);
      braceA.rotation.z = side * 0.18;
      const braceB = new Mesh(new BoxGeometry(0.2, 4.8, 0.16), metalMaterial);
      braceB.position.set(side * -3.7, -0.2, -0.46);
      braceB.rotation.z = side * -0.16;

      const textPlane = new Mesh(new PlaneGeometry(27.2, 13.6), textMaterial);
      textPlane.position.z = 0.3;
      textPlane.renderOrder = 10;

      signRoot.add(backPlateA, backPlateB, backPlateC, braceA, braceB, textPlane);
      anchor.add(signRoot);
      this.loadingGroup.add(anchor);

      const promptIndex = index % LOADING_PROMPTS.length;
      const prompt = LOADING_PROMPTS[promptIndex] ?? LOADING_PROMPTS[0];
      this.drawLoadingPrompt(canvas, prompt.title, prompt.body);
      texture.needsUpdate = true;

      signs.push({
        anchor,
        signRoot,
        canvas,
        texture,
        textMaterial,
        metalMaterial,
        basePosition,
        baseQuaternion: sourceCog.baseQuaternion.clone(),
        baseLocalPosition,
        baseRotationY,
        baseRotationZ,
        side: side === 1 ? 1 : -1,
        phase: sourceCog.phase,
        promptIndex,
      });
    }

    return signs;
  }

  private updateLoadingFiction(elapsedTime: number, playerPos: Vector3, loadingBlend: number): void {
    const loadingAlpha = MathUtils.smoothstep(loadingBlend, 0, 1);
    const visible = loadingAlpha > 0.001;
    this.loadingGroup.visible = visible;

    const rimOpacity = (0.2 + loadingBlend * 0.62) * loadingAlpha;
    const coreOpacity = (0.18 + loadingBlend * 0.44) * loadingAlpha;
    const detailOpacity = (0.16 + loadingBlend * 0.56) * loadingAlpha;
    this.loadingCogMaterial.opacity = rimOpacity;
    this.loadingCogMaterial.emissiveIntensity = 1.9 + loadingBlend * 1.35;
    this.loadingCogCoreMaterial.opacity = coreOpacity;
    this.loadingCogCoreMaterial.emissiveIntensity = 1.1 + loadingBlend * 0.9;
    this.loadingCogDetailMaterial.opacity = detailOpacity;
    this.loadingCogDetailMaterial.emissiveIntensity = 2 + loadingBlend * 1.25;
    for (const sign of this.loadingSigns) {
      sign.textMaterial.opacity = loadingAlpha;
      sign.metalMaterial.opacity = (0.84 + loadingBlend * 0.12) * loadingAlpha;
      sign.metalMaterial.emissiveIntensity = 0.4 + loadingBlend * 0.6;
    }

    if (!visible) return;

    for (const cog of this.loadingCogs) {
      cog.anchor.position.copy(cog.basePosition);
      cog.anchor.position.y += Math.sin(elapsedTime * cog.bobSpeed + cog.phase) * cog.bobAmplitude * loadingBlend;
      cog.anchor.quaternion.copy(cog.baseQuaternion);
      cog.wheel.rotation.z = elapsedTime * cog.spinSpeed * (0.55 + loadingBlend * 1.4) + cog.phase;
      const pulse = 1 + Math.sin(elapsedTime * 1.6 + cog.phase) * 0.06 * loadingBlend;
      cog.wheel.scale.setScalar(cog.baseScale * pulse);
    }
    for (const sign of this.loadingSigns) {
      this.updateLoadingSign(sign, elapsedTime, playerPos, loadingBlend);
    }
  }

  private updateLoadingSign(
    sign: LoadingSign,
    elapsedTime: number,
    _playerPos: Vector3,
    loadingBlend: number,
  ): void {
    sign.anchor.position.copy(sign.basePosition);
    sign.anchor.quaternion.copy(sign.baseQuaternion);
    sign.anchor.position.y += Math.sin(elapsedTime * 0.8 + sign.phase) * 0.55 * loadingBlend;
    sign.signRoot.position.copy(sign.baseLocalPosition);
    sign.signRoot.position.y += Math.sin(elapsedTime * 1.1 + sign.phase) * 0.18 * loadingBlend;
    sign.signRoot.rotation.y = sign.baseRotationY
      + Math.sin(elapsedTime * 0.65 + sign.phase) * 0.022 * loadingBlend;
    sign.signRoot.rotation.z = sign.baseRotationZ
      + Math.sin(elapsedTime * 0.95 + sign.phase) * 0.018 * loadingBlend;
  }

  private drawLoadingPrompt(canvas: HTMLCanvasElement, title: string, body: string): void {
    const context = canvas.getContext("2d");
    if (!context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.textAlign = "center";
    context.textBaseline = "middle";

    const sprayBands = [
      { x: canvas.width * 0.18, y: canvas.height * 0.22, width: canvas.width * 0.62, height: 152, angle: -0.12 },
      { x: canvas.width * 0.24, y: canvas.height * 0.52, width: canvas.width * 0.52, height: 132, angle: 0.08 },
      { x: canvas.width * 0.32, y: canvas.height * 0.76, width: canvas.width * 0.42, height: 118, angle: -0.05 },
    ];
    for (const band of sprayBands) {
      this.drawPaintStrip(
        context,
        band.x,
        band.y,
        band.width,
        band.height,
        band.angle,
        "rgba(17, 8, 2, 0.94)",
      );
    }

    context.save();
    context.globalAlpha = 0.28;
    context.fillStyle = "rgba(255, 191, 85, 1)";
    for (let i = 0; i < 46; i += 1) {
      const x = 80 + ((i * 173) % (canvas.width - 160));
      const y = 54 + ((i * 127) % (canvas.height - 108));
      const radius = 4 + (i % 5) * 3;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();

    context.save();
    context.translate(canvas.width * 0.5, 220);
    context.rotate(-0.05);
    context.shadowBlur = 30;
    context.shadowColor = "rgba(255, 183, 55, 0.42)";
    context.strokeStyle = "rgba(10, 4, 1, 0.96)";
    context.lineWidth = 22;
    context.lineJoin = "round";
    context.fillStyle = "rgba(255, 244, 199, 1)";
    context.font = '900 150px Impact, Haettenschweiler, "Arial Black", sans-serif';
    wrapStencilText(context, title, 0, 0, 1080, 152, 2, true);
    context.restore();

    context.save();
    context.translate(canvas.width * 0.5, 500);
    context.rotate(0.03);
    context.shadowBlur = 22;
    context.shadowColor = "rgba(255, 170, 64, 0.28)";
    context.strokeStyle = "rgba(12, 5, 1, 0.9)";
    context.lineWidth = 15;
    context.fillStyle = "rgba(255, 235, 173, 1)";
    context.font = '900 82px Impact, Haettenschweiler, "Arial Black", sans-serif';
    wrapStencilText(context, body, 0, 0, 980, 98, 3, true);
    context.restore();

    context.save();
    context.globalCompositeOperation = "destination-out";
    context.fillStyle = "rgba(0, 0, 0, 0.26)";
    for (let i = 0; i < 24; i += 1) {
      const x = 120 + ((i * 149) % (canvas.width - 240));
      const y = 96 + ((i * 73) % (canvas.height - 192));
      context.fillRect(x, y, 20 + (i % 4) * 18, 10 + (i % 3) * 12);
    }
    context.restore();
  }

  private drawPaintStrip(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    angle: number,
    fill: string,
  ): void {
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    context.fillStyle = fill;
    context.beginPath();
    context.moveTo(-34, -height * 0.5 + 18);
    context.lineTo(width - 92, -height * 0.5 - 8);
    context.lineTo(width + 24, -height * 0.14);
    context.lineTo(width - 18, height * 0.5 + 14);
    context.lineTo(42, height * 0.5 - 4);
    context.lineTo(-18, height * 0.08);
    context.closePath();
    context.fill();
    context.restore();
  }

  private buildGeometry(kind: ThemeSpec["sideGeometry"] | ThemeSpec["skylineGeometry"] | ThemeSpec["accentGeometry"]): BufferGeometry {
    switch (kind) {
      case "cylinder":
        return new CylinderGeometry(0.9, 1.15, 1, 10);
      case "spire":
        return new ConeGeometry(1, 1, 7);
      case "dodeca":
        return new DodecahedronGeometry(1);
      case "ico":
        return new IcosahedronGeometry(1, 0);
      case "knot":
        return new TorusKnotGeometry(0.7, 0.2, 42, 8, 2, 3);
      case "octa":
        return new OctahedronGeometry(1);
      case "box":
      default:
        return new BoxGeometry(1, 1, 1);
    }
  }

  private generateDefinition(seed: number): EnvironmentDefinition {
    const rng = mulberry32(seed ^ (this.theme.fictionId * 0x45d9f3b));
    return {
      sideStructures: this.generateSidePlacements(rng),
      skyline: this.generateSkylinePlacements(rng),
      accents: this.generateAccentPlacements(rng),
      gates: this.generateGatePlacements(rng),
      halos: this.generateHaloPlacements(rng),
    };
  }

  private generateSidePlacements(rng: () => number): GeneratedPlacement[] {
    const placements: GeneratedPlacement[] = [];
    let distance = 40;
    while (distance < this.track.totalLength - 30) {
      const u = distance / this.track.totalLength;
      const section = this.getSectionAtU(u);
      const frame = this.track.getFrameAt(u);
      const center = this.track.getPointAt(u);
      const halfWidth = this.track.getHalfWidthAt(u);
      const bothSides = rng() > 0.45 || section.energy > 0.78;

      for (const side of bothSides ? ([-1, 1] as const) : ([rng() > 0.5 ? 1 : -1] as const)) {
        const sideOffset = Math.max(
          halfWidth + MIN_ENV_CLEARANCE,
          halfWidth + this.lerpRange(this.theme.sideClearance, rng()) + section.energy * 8,
        );
        const height = MathUtils.lerp(10, 34, section.energy) * (0.7 + rng() * 0.8);
        const scale = new Vector3(
          1.8 + rng() * 1.2,
          height,
          2.3 + rng() * 1.8,
        );
        const position = center.clone()
          .addScaledVector(frame.right, sideOffset * side)
          .addScaledVector(frame.up, height * 0.5);
        placements.push(this.makePlacement(position, frame, scale, section.energy, rng(), 0.9 + section.energy * 0.7, u));
      }

      distance += this.theme.sideSpacing * (0.78 + rng() * 0.46);
    }
    return placements;
  }

  private generateSkylinePlacements(rng: () => number): GeneratedPlacement[] {
    const placements: GeneratedPlacement[] = [];
    let distance = 30;
    while (distance < this.track.totalLength - 30) {
      const u = distance / this.track.totalLength;
      const section = this.getSectionAtU(u);
      const frame = this.track.getFrameAt(u);
      const center = this.track.getPointAt(u);
      const side = rng() > 0.5 ? 1 : -1;
      const farOffset = this.lerpRange(this.theme.skylineClearance, rng()) + section.energy * 18;
      const height = MathUtils.lerp(28, 110, section.energy) * (0.9 + rng() * 1.05);
      const scale = new Vector3(7 + rng() * 8, height, 7 + rng() * 12);
      const position = center.clone()
        .addScaledVector(frame.right, farOffset * side)
        .addScaledVector(frame.up, height * 0.5 - 6);
      placements.push(this.makePlacement(position, frame, scale, section.energy, rng(), 0.65 + section.energy * 0.75, u));
      distance += this.theme.skylineSpacing * (0.75 + rng() * 0.55);
    }
    return placements;
  }

  private generateAccentPlacements(rng: () => number): GeneratedPlacement[] {
    const placements: GeneratedPlacement[] = [];
    let distance = 55;
    while (distance < this.track.totalLength - 30) {
      const u = distance / this.track.totalLength;
      const section = this.getSectionAtU(u);
      const frame = this.track.getFrameAt(u);
      const center = this.track.getPointAt(u);
      const side = rng() > 0.5 ? 1 : -1;
      const offset = this.theme.skylineClearance[0] * 0.65 + 45 + rng() * 55;
      const altitude = 22 + section.energy * 42 + rng() * 28;
      const scaleValue = 2.8 + rng() * 6.2 + section.energy * 3.8;
      const position = center.clone()
        .addScaledVector(frame.right, offset * side)
        .addScaledVector(frame.up, altitude);
      placements.push(this.makePlacement(
        position,
        frame,
        new Vector3(scaleValue, scaleValue * (1.1 + rng() * 0.6), scaleValue),
        section.energy,
        rng(),
        1.25,
        u,
      ));
      distance += this.theme.accentSpacing * (0.8 + rng() * 0.6);
    }
    return placements;
  }

  private generateGatePlacements(rng: () => number): GeneratedPlacement[] {
    const placements: GeneratedPlacement[] = [];
    const sectionStarts = this.getSections().slice(1);

    for (const section of sectionStarts) {
      const u = section.startTime / this.defaultDuration;
      const frame = this.track.getFrameAt(Math.min(u, 0.995));
      const center = this.track.getPointAt(Math.min(u, 0.995));
      const halfWidth = this.track.getHalfWidthAt(Math.min(u, 0.995));
      const scale = new Vector3(
        halfWidth + this.theme.gateScale[0] + section.energy * 6,
        this.theme.gateScale[1] + section.energy * 7,
        1.2,
      );
      const position = center.clone().addScaledVector(frame.up, GATE_CLEARANCE_HEIGHT + section.energy * 4);
      placements.push(this.makePlacement(position, frame, scale, section.energy, rng(), 1.45, u));
    }

    const beatSeconds = 60 / this.getBpm();
    for (const section of this.getSections()) {
      if (section.type !== "build" && section.type !== "drop" && section.type !== "finale") continue;
      const beatStride = section.type === "build" ? 16 : 8;
      let gateTime = section.startTime + beatStride * beatSeconds;
      while (gateTime < section.endTime - beatSeconds * 2) {
        const u = gateTime / this.defaultDuration;
        const frame = this.track.getFrameAt(Math.min(u, 0.995));
        const center = this.track.getPointAt(Math.min(u, 0.995));
        const halfWidth = this.track.getHalfWidthAt(Math.min(u, 0.995));
        const scale = new Vector3(
          halfWidth + this.theme.gateScale[0] * 0.7 + section.energy * 5,
          this.theme.gateScale[1] * 0.8 + section.energy * 5,
          1,
        );
        const position = center.clone().addScaledVector(frame.up, GATE_CLEARANCE_HEIGHT + 2 + section.energy * 3);
        placements.push(this.makePlacement(position, frame, scale, section.energy, rng(), 1.1, u));
        gateTime += beatStride * beatSeconds;
      }
    }

    return placements;
  }

  private generateHaloPlacements(rng: () => number): GeneratedPlacement[] {
    const placements: GeneratedPlacement[] = [];
    for (const feature of this.track.getTrackFeatures()) {
      const frame = this.track.getFrameAt(feature.u);
      const center = this.track.getPointAt(feature.u);
      const baseScale = feature.kind === "loop"
        ? new Vector3(this.theme.haloScale[0] + feature.energy * 12, this.theme.haloScale[1] + feature.energy * 7, 1)
        : feature.kind === "barrelRoll"
          ? new Vector3(this.theme.haloScale[0] * 0.9 + feature.energy * 11, this.theme.haloScale[1] * 0.75 + feature.energy * 6, 1)
          : new Vector3(this.theme.haloScale[0] * 0.7 + feature.energy * 10, this.theme.haloScale[1] * 0.6 + feature.energy * 5, 1);
      const ringCount = feature.kind === "loop" ? 3 : feature.kind === "barrelRoll" ? 3 : 2;
      for (let i = 0; i < ringCount; i++) {
        const lift = feature.kind === "loop" ? 8 + i * 6 : feature.kind === "barrelRoll" ? 6 + i * 3.5 : 5 + i * 4;
        const forwardOffset = feature.kind === "jump" ? i * 10 : feature.kind === "barrelRoll" ? (i - 1) * 10 : (i - 1) * 6;
        const position = center.clone()
          .addScaledVector(frame.up, lift)
          .addScaledVector(frame.tangent, forwardOffset);
        const scale = baseScale.clone().multiplyScalar(1 + i * 0.14);
        if (feature.kind === "barrelRoll") {
          scale.y *= 0.8;
        }
        placements.push(this.makePlacement(position, frame, scale, feature.energy, rng(), 1.55, feature.u));
      }

      if (feature.kind === "loop") {
        placements.push(this.makePlacement(
          center.clone().addScaledVector(frame.up, 24),
          frame,
          new Vector3(baseScale.x * 0.55, baseScale.x * 0.55, 1),
          feature.energy,
          rng(),
          1.9,
          feature.u,
        ));
      } else if (feature.kind === "barrelRoll") {
        placements.push(this.makePlacement(
          center.clone().addScaledVector(frame.up, 12),
          frame,
          new Vector3(baseScale.x * 0.7, baseScale.y * 0.52, 1),
          feature.energy,
          rng(),
          1.75,
          feature.u,
        ));
      }
    }
    return placements;
  }

  private makePlacement(
    position: Vector3,
    frame: TrackFrame,
    scale: Vector3,
    energy: number,
    phaseSeed: number,
    weight: number,
    u: number,
  ): GeneratedPlacement {
    const spinAxis = new Vector3(
      Math.sin(phaseSeed * Math.PI * 2.1),
      0.45 + energy * 0.4,
      Math.cos(phaseSeed * Math.PI * 2.7),
    ).normalize();
    return {
      position,
      quaternion: this.quaternionFromFrame(frame),
      scale,
      energy,
      phase: phaseSeed * Math.PI * 2,
      weight,
      u,
      bobAmplitude: 0.5 + energy * 2.4 + phaseSeed * 0.8,
      bobSpeed: 0.45 + weight * 0.2 + energy * 0.65,
      spinAxis,
      spinSpeed: 0.1 + weight * 0.16 + energy * 0.3,
    };
  }

  private quaternionFromFrame(frame: TrackFrame): Quaternion {
    const basis = new Matrix4().makeBasis(frame.right, frame.up, frame.tangent.clone().negate());
    return new Quaternion().setFromRotationMatrix(basis);
  }

  private updateSceneColors(
    sectionType: SongSectionType,
    musicTime: number,
    energyPulse: number,
    amplitude: AmplitudeProfile,
    loadingBlend: number,
  ): void {
    const phraseA = this.getPhraseColor(musicTime, 0);
    const phraseB = this.getPhraseColor(musicTime, 1);
    const phraseProgress = this.getPhraseBlend(musicTime);
    const sectionTint = this.tmpColorA.set(SECTION_TINTS[sectionType]);
    const phraseTint = this.tmpColorB.copy(phraseA).lerp(phraseB, phraseProgress);
    const tint = this.tmpColorC.copy(sectionTint).lerp(phraseTint, 0.58);
    const loadingSky = this.tmpColorD.set(LOADING_GEAR_SKY);
    const loadingFog = this.tmpColorE.set(LOADING_GEAR_FOG);

    this.background.copy(this.palette.skyBase).lerp(tint, 0.05 + energyPulse * 0.08 + amplitude.scene * 0.07);
    this.background.lerp(loadingSky, loadingBlend * 0.88);
    this.skyMaterial.color.copy(this.background);

    if (this.scene.fog instanceof FogExp2) {
      this.fogColor.copy(this.palette.fogBase).lerp(tint, 0.08 + energyPulse * 0.12 + amplitude.scene * 0.1);
      this.fogColor.lerp(loadingFog, loadingBlend * 0.84);
      this.scene.fog.color.copy(this.fogColor);
      this.scene.fog.density = MathUtils.lerp(
        MathUtils.lerp(0.0017, 0.0027, loadingBlend),
        MathUtils.lerp(0.0044, 0.0034, loadingBlend),
        energyPulse * 0.42 + amplitude.scene * 0.58,
      );
    }

    this.applyMaterialPulse(this.sideMaterial, this.palette.structureBase, tint, 0.54 + amplitude.side * 0.72);
    this.applyMaterialPulse(this.skylineMaterial, this.palette.skylineBase, tint, 0.7 + amplitude.skyline * 0.88);
    this.applyMaterialPulse(this.accentMaterial, this.palette.accentBase, tint, 0.45 + amplitude.accent * 1.2);
    this.applyMaterialPulse(this.gateMaterial, this.palette.gateBase, tint, 0.9 + amplitude.gate * 0.82);
    this.applyMaterialPulse(this.haloMaterial, this.palette.haloBase, tint, 0.96 + amplitude.halo * 0.9);

    if (loadingBlend > 0) {
      const loadingTint = loadingSky.set(LOADING_GEAR_TINT);
      this.blendTowardLoadingPalette(this.sideMaterial, loadingTint, 1.8, loadingBlend * 0.78);
      this.blendTowardLoadingPalette(this.skylineMaterial, loadingTint, 2.15, loadingBlend * 0.68);
      this.blendTowardLoadingPalette(this.accentMaterial, loadingTint, 2.4, loadingBlend * 0.9);
      this.blendTowardLoadingPalette(this.gateMaterial, loadingTint, 2.9, loadingBlend);
      this.blendTowardLoadingPalette(this.haloMaterial, loadingTint, 3.15, loadingBlend);
    }
    this.applyFictionVisibility(loadingBlend);
  }

  private applyMaterialPulse(
    material: MeshStandardMaterial,
    baseColor: Color,
    tint: Color,
    intensity: number,
  ): void {
    material.color.copy(baseColor).lerp(tint, 0.22 + intensity * 0.24);
    material.emissive.copy(material.color);
    material.emissiveIntensity = 1.4 + intensity * 2.7;
  }

  private blendTowardLoadingPalette(
    material: MeshStandardMaterial,
    loadingColor: Color,
    emissiveIntensity: number,
    blend: number,
  ): void {
    material.color.lerp(loadingColor, blend);
    material.emissive.lerp(this.tmpColorE.set(LOADING_GEAR_EMISSIVE), blend * 0.92);
    material.emissiveIntensity = MathUtils.lerp(material.emissiveIntensity, emissiveIntensity, blend);
  }

  private applyFictionVisibility(loadingBlend: number): void {
    const revealBlend = MathUtils.clamp((1 - loadingBlend - 0.18) / 0.82, 0, 1);
    const heavyLayerBlend = revealBlend * revealBlend;
    const sideOpacity = 0.92 * revealBlend;
    const skylineOpacity = 0.92 * revealBlend;
    const accentOpacity = 0.92 * Math.pow(revealBlend, 1.15);
    const gateOpacity = 0.92 * Math.pow(revealBlend, 1.5);
    const haloOpacity = 0.92 * Math.pow(heavyLayerBlend, 0.9);

    this.sideMesh.visible = sideOpacity > 0.001;
    this.skylineMesh.visible = skylineOpacity > 0.001;
    this.accentMesh.visible = accentOpacity > 0.001;
    this.gateMesh.visible = gateOpacity > 0.001;
    this.haloMesh.visible = haloOpacity > 0.001;

    this.sideMaterial.opacity = sideOpacity;
    this.skylineMaterial.opacity = skylineOpacity;
    this.accentMaterial.opacity = accentOpacity;
    this.gateMaterial.opacity = gateOpacity;
    this.haloMaterial.opacity = haloOpacity;
  }

  private updateLayer(
    placements: readonly GeneratedPlacement[],
    mesh: InstancedMesh,
    band: number,
    amplitude: number,
    elapsedTime: number,
    motion: LayerMotion,
  ): void {
    for (let i = 0; i < placements.length; i++) {
      const placement = placements[i];
      const pulse = 1 + Math.sin(elapsedTime * (0.8 + placement.weight * 0.65) + placement.phase) * amplitude * (0.35 + band * 0.65);
      this.dummy.position.copy(placement.position);
      if (motion.bob) {
        this.dummy.position.y += Math.sin(elapsedTime * placement.bobSpeed + placement.phase) * placement.bobAmplitude * (0.18 + band * 0.82);
      }
      this.dummy.quaternion.copy(placement.quaternion);
      if (motion.spin) {
        this.dummy.quaternion.multiply(
          new Quaternion().setFromAxisAngle(placement.spinAxis, elapsedTime * placement.spinSpeed * (0.35 + band * 1.25)),
        );
      }
      this.dummy.scale.copy(placement.scale);

      if (motion.scale) {
        if (motion.axisBiased) {
          this.dummy.scale.y *= 1 + (pulse - 1) * (1.15 + placement.energy * 0.75);
          this.dummy.scale.x *= 1 + (pulse - 1) * 0.4;
          this.dummy.scale.z *= 1 + (pulse - 1) * 0.26;
        } else {
          this.dummy.scale.multiplyScalar(1 + (pulse - 1) * 0.6);
        }
      }

      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  private getSectionAtTime(time: number): SectionInfo {
    const sections = this.getSections();
    for (let i = sections.length - 1; i >= 0; i--) {
      if (time >= sections[i].startTime) return sections[i];
    }
    return sections[0];
  }

  private getSectionAtU(u: number): SectionInfo {
    return this.getSectionAtTime(u * this.defaultDuration);
  }

  private getSections(): SectionInfo[] {
    if (this.song) return this.song.sections;
    return [{
      type: "verse",
      energy: 0.52,
      startTime: 0,
      endTime: this.defaultDuration,
    }];
  }

  private getBpm(): number {
    return this.song?.bpm ?? 138;
  }

  private getFallbackBands(time: number, energy: number): ReactiveBands {
    const beatPhase = time * this.getBpm() / 60;
    const low = 0.2 + energy * 0.55 * (0.5 + 0.5 * Math.sin(beatPhase * Math.PI * 2));
    const mid = 0.16 + energy * 0.48 * (0.5 + 0.5 * Math.sin(beatPhase * Math.PI * 4 + 0.6));
    const high = 0.12 + energy * 0.42 * (0.5 + 0.5 * Math.sin(beatPhase * Math.PI * 8 + 1.2));
    const beatCycle = (beatPhase % 1);
    const kick = Math.max(0, 1 - beatCycle * 7) * energy;
    return {
      low: MathUtils.clamp(low, 0, 1),
      mid: MathUtils.clamp(mid, 0, 1),
      high: MathUtils.clamp(high, 0, 1),
      kick: MathUtils.clamp(kick, 0, 1),
      energyLevel: MathUtils.clamp(energy, 0, 1),
    };
  }

  private getAmplitudeProfile(bands: ReactiveBands, energy: number): AmplitudeProfile {
    switch (this.theme.fictionId) {
      case 2:
        return {
          scene: MathUtils.clamp(bands.low * 0.18 + bands.mid * 0.5 + bands.high * 0.22 + energy * 0.18, 0, 1),
          side: MathUtils.clamp(bands.mid * 0.62 + bands.high * 0.22 + bands.low * 0.16 + energy * 0.12, 0, 1),
          skyline: MathUtils.clamp(bands.low * 0.36 + bands.mid * 0.44 + bands.high * 0.2 + energy * 0.14, 0, 1),
          accent: MathUtils.clamp(bands.high * 0.58 + bands.mid * 0.34 + bands.low * 0.08 + energy * 0.1, 0, 1),
          gate: MathUtils.clamp(bands.mid * 0.62 + bands.high * 0.2 + energy * 0.18, 0, 1),
          halo: MathUtils.clamp(bands.low * 0.34 + bands.mid * 0.4 + energy * 0.16, 0, 1),
        };
      case 3:
        return {
          scene: MathUtils.clamp(bands.low * 0.42 + bands.mid * 0.26 + bands.high * 0.16 + energy * 0.2, 0, 1),
          side: MathUtils.clamp(bands.mid * 0.36 + bands.low * 0.34 + bands.high * 0.18 + energy * 0.16, 0, 1),
          skyline: MathUtils.clamp(bands.low * 0.58 + bands.high * 0.18 + bands.mid * 0.12 + energy * 0.14, 0, 1),
          accent: MathUtils.clamp(bands.high * 0.42 + bands.low * 0.24 + bands.mid * 0.22 + energy * 0.16, 0, 1),
          gate: MathUtils.clamp(bands.mid * 0.34 + bands.low * 0.44 + energy * 0.16, 0, 1),
          halo: MathUtils.clamp(bands.low * 0.62 + bands.mid * 0.18 + energy * 0.14, 0, 1),
        };
      case 1:
      default:
        return {
          scene: MathUtils.clamp(bands.low * 0.46 + bands.mid * 0.24 + bands.high * 0.12 + energy * 0.18, 0, 1),
          side: MathUtils.clamp(bands.mid * 0.44 + bands.low * 0.26 + bands.high * 0.18 + energy * 0.16, 0, 1),
          skyline: MathUtils.clamp(bands.low * 0.72 + bands.mid * 0.12 + energy * 0.14, 0, 1),
          accent: MathUtils.clamp(bands.high * 0.48 + bands.mid * 0.3 + bands.low * 0.12 + energy * 0.14, 0, 1),
          gate: MathUtils.clamp(bands.mid * 0.52 + bands.low * 0.18 + energy * 0.18, 0, 1),
          halo: MathUtils.clamp(bands.low * 0.68 + bands.mid * 0.14 + energy * 0.12, 0, 1),
        };
    }
  }

  private buildPalette(): ThemePalette {
    const darkness = this.moodDarkness;
    return {
      skyBase: this.darkenColor(this.theme.skyBase, 0.56 + darkness * 0.2),
      fogBase: this.darkenColor(this.theme.fogBase, 0.42 + darkness * 0.14),
      structureBase: this.neonizeColor(this.theme.structureBase, this.theme.skyAccent, 0.18, -0.08),
      skylineBase: this.neonizeColor(this.theme.skylineBase, "#ff4e79", 0.2 + darkness * 0.08, -0.06),
      gateBase: this.neonizeColor(this.theme.gateBase, "#ff3d77", 0.24, -0.05),
      haloBase: this.neonizeColor(this.theme.haloBase, "#49f6ff", 0.18, -0.04),
      accentBase: this.neonizeColor(this.theme.accentBase, "#d06dff", 0.22, -0.03),
    };
  }

  private buildPhraseColors(): Color[] {
    const bpm = this.getBpm();
    const phraseSeconds = (60 / bpm) * PHRASE_BEATS;
    const phraseCount = Math.max(1, Math.ceil(this.defaultDuration / phraseSeconds));
    const colors: Color[] = [];
    for (let i = 0; i < phraseCount; i++) {
      const sampleTime = Math.min(this.defaultDuration - 0.01, i * phraseSeconds + phraseSeconds * 0.5);
      const section = this.getSectionAtTime(sampleTime);
      const base = new Color(SECTION_TINTS[section.type]);
      const phraseColor = this.toneColor(base, this.palette.gateBase, 0.14 + section.energy * 0.18)
        .lerp(this.palette.skylineBase, 0.08 + this.moodDarkness * 0.1);
      colors.push(phraseColor);
    }
    return colors;
  }

  private getPhraseBlend(time: number): number {
    const phraseSeconds = (60 / this.getBpm()) * PHRASE_BEATS;
    const local = (time % phraseSeconds) / phraseSeconds;
    return MathUtils.smoothstep(local, 0.64, 1);
  }

  private getPhraseColor(time: number, offset: 0 | 1): Color {
    if (this.phraseColors.length === 0) return this.palette.structureBase;
    const phraseSeconds = (60 / this.getBpm()) * PHRASE_BEATS;
    const index = Math.min(this.phraseColors.length - 1, Math.floor(time / phraseSeconds) + offset);
    return this.phraseColors[index] ?? this.phraseColors[this.phraseColors.length - 1];
  }

  private estimateMoodDarkness(): number {
    if (!this.song) return 0.45;
    const avg = this.song.sections.reduce((acc, section) => {
      acc.energy += section.energy;
      acc.density += section.density;
      acc.hazard += section.hazardBias;
      acc.pickup += section.pickupBias;
      return acc;
    }, { energy: 0, density: 0, hazard: 0, pickup: 0 });
    const count = Math.max(1, this.song.sections.length);
    const titleArtist = `${this.song.title} ${this.song.artist}`.toLowerCase();
    const keywordBias = /(fire|night|dark|void|storm|rage|prodigy|starter)/.test(titleArtist) ? 0.12 : 0;
    const darkness = avg.hazard / count * 0.42
      + avg.density / count * 0.18
      + avg.energy / count * 0.22
      + (1 - avg.pickup / count) * 0.18
      + keywordBias;
    return MathUtils.clamp(darkness, 0.18, 0.92);
  }

  private toneColor(baseColor: string | Color, mixTarget: string | Color, mix = 0.2): Color {
    const base = new Color(baseColor);
    const target = new Color(mixTarget);
    return base.lerp(target, mix);
  }

  private darkenColor(baseColor: string | Color, amount: number): Color {
    return new Color(baseColor).lerp(new Color("#02040a"), amount).offsetHSL(0, 0.08, -0.1);
  }

  private neonizeColor(baseColor: string | Color, mixTarget: string | Color, mix: number, lightnessShift: number): Color {
    return this.toneColor(baseColor, mixTarget, mix).offsetHSL(0, 0.18, lightnessShift);
  }

  private lerpRange(range: [number, number], t: number): number {
    return MathUtils.lerp(range[0], range[1], t);
  }
}

function wrapStencilText(
  context: CanvasRenderingContext2D,
  body: string,
  startX: number,
  startY: number,
  maxWidth: number,
  lineHeight: number,
  maxLines = Number.POSITIVE_INFINITY,
  drawStroke = false,
): void {
  const words = body.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (currentLine && context.measureText(candidate).width > maxWidth) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = candidate;
    }
  }

  if (currentLine) lines.push(currentLine);
  const visibleLines = lines.slice(0, maxLines);
  if (lines.length > maxLines && visibleLines.length > 0) {
    const lastIndex = visibleLines.length - 1;
    visibleLines[lastIndex] = `${visibleLines[lastIndex]}...`;
  }
  visibleLines.forEach((line, index) => {
    const y = startY + index * lineHeight;
    if (drawStroke) {
      context.strokeText(line, startX, y);
    }
    context.fillText(line, startX, y);
  });
}
