import {
  BackSide,
  BoxGeometry,
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
import { mulberry32 } from "./prng";
import type { Track, TrackFrame } from "./track-builder";

export type EnvironmentFictionId = 1 | 2 | 3;

type SectionInfo = {
  type: SongSectionType;
  energy: number;
  startTime: number;
  endTime: number;
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

export function clampFictionId(value: number | null | undefined): EnvironmentFictionId {
  if (value === 2 || value === 3) return value;
  return 1;
}

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
  private readonly background = new Color();
  private readonly fogColor = new Color();
  private readonly tmpColorA = new Color();
  private readonly tmpColorB = new Color();
  private readonly tmpColorC = new Color();
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

    this.group.frustumCulled = false;
    this.scene.fog = new FogExp2(this.palette.fogBase.clone(), 0.0021);
    this.scene.background = this.background.copy(this.palette.skyBase);
  }

  update(elapsedTime: number, musicTime: number, trackU: number, sourceBands: ReactiveBands | null): void {
    const section = this.getSectionAtTime(musicTime);
    const bands = sourceBands ?? this.getFallbackBands(elapsedTime, section.energy);
    const amplitude = this.getAmplitudeProfile(bands, section.energy);
    const playerPos = this.track.getPointAt(trackU);
    const beatPhase = ((musicTime * this.getBpm()) / 60) % 1;
    const beatPulse = 0.5 + 0.5 * Math.sin(beatPhase * Math.PI * 2);
    const energyPulse = MathUtils.clamp(section.energy * 0.45 + beatPulse * 0.25 + bands.low * 0.3, 0, 1);

    this.skyDome.position.copy(playerPos);
    this.updateSceneColors(section.type, musicTime, energyPulse, amplitude);
    this.updateLayer(
      this.definition.sideStructures,
      this.sideMesh,
      amplitude.side,
      0.52 + section.energy * 0.16,
      elapsedTime,
      { bob: true, spin: false, scale: true, axisBiased: false },
    );
    this.updateLayer(
      this.definition.skyline,
      this.skylineMesh,
      amplitude.skyline,
      0.92 + section.energy * 0.2,
      elapsedTime,
      { bob: true, spin: false, scale: true, axisBiased: true },
    );
    this.updateLayer(
      this.definition.accents,
      this.accentMesh,
      amplitude.accent,
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
  ): void {
    const phraseA = this.getPhraseColor(musicTime, 0);
    const phraseB = this.getPhraseColor(musicTime, 1);
    const phraseProgress = this.getPhraseBlend(musicTime);
    const sectionTint = this.tmpColorA.set(SECTION_TINTS[sectionType]);
    const phraseTint = this.tmpColorB.copy(phraseA).lerp(phraseB, phraseProgress);
    const tint = this.tmpColorC.copy(sectionTint).lerp(phraseTint, 0.58);

    this.background.copy(this.palette.skyBase).lerp(tint, 0.05 + energyPulse * 0.08 + amplitude.scene * 0.07);
    this.skyMaterial.color.copy(this.background);

    if (this.scene.fog instanceof FogExp2) {
      this.fogColor.copy(this.palette.fogBase).lerp(tint, 0.08 + energyPulse * 0.12 + amplitude.scene * 0.1);
      this.scene.fog.color.copy(this.fogColor);
      this.scene.fog.density = MathUtils.lerp(0.0017, 0.0044, energyPulse * 0.42 + amplitude.scene * 0.58);
    }

    this.applyMaterialPulse(this.sideMaterial, this.palette.structureBase, tint, 0.54 + amplitude.side * 0.72);
    this.applyMaterialPulse(this.skylineMaterial, this.palette.skylineBase, tint, 0.7 + amplitude.skyline * 0.88);
    this.applyMaterialPulse(this.accentMaterial, this.palette.accentBase, tint, 0.45 + amplitude.accent * 1.2);
    this.applyMaterialPulse(this.gateMaterial, this.palette.gateBase, tint, 0.9 + amplitude.gate * 0.82);
    this.applyMaterialPulse(this.haloMaterial, this.palette.haloBase, tint, 0.96 + amplitude.halo * 0.9);
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
    return {
      low: MathUtils.clamp(low, 0, 1),
      mid: MathUtils.clamp(mid, 0, 1),
      high: MathUtils.clamp(high, 0, 1),
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
