import { Color, Mesh, MeshStandardMaterial, Object3D } from "three";

type MaterialSnapshot = {
  material: MeshStandardMaterial;
  color: Color;
  emissive: Color;
  emissiveIntensity: number;
  opacity: number;
  roughness: number;
  metalness: number;
};

type TrackMaterialChannel = "road" | "wall" | "centerline";

type MaterialTarget = {
  color: Color;
  emissive: Color;
  emissiveIntensity: number;
  opacity: number;
  roughness: number;
  metalness: number;
  blendStrength: number;
  emissiveBlendStrength: number;
};

type RhythmicUniforms = {
  uMusicTime: { value: number };
  uKick: { value: number };
  uEnergyLevel: { value: number };
  uRhythmicStrength: { value: number };
  uRibbonSpeed: { value: number };
  uRibbonWidth: { value: number };
  uChannelGain: { value: number };
};

export type RhythmicState = {
  musicTime: number;
  kick: number;
  energyLevel: number;
  strength: number;
};

const LOADING_MATERIAL_TARGETS: Record<TrackMaterialChannel, MaterialTarget> = {
  road: {
    color: new Color("#4c390f"),
    emissive: new Color("#6e4b10"),
    emissiveIntensity: 1.25,
    opacity: 0.76,
    roughness: 0.24,
    metalness: 0.22,
    blendStrength: 0.38,
    emissiveBlendStrength: 0.42,
  },
  wall: {
    color: new Color("#ffd372"),
    emissive: new Color("#ff981f"),
    emissiveIntensity: 2.05,
    opacity: 0.64,
    roughness: 0.14,
    metalness: 0.18,
    blendStrength: 0.58,
    emissiveBlendStrength: 0.72,
  },
  centerline: {
    color: new Color("#fff4c2"),
    emissive: new Color("#ffd760"),
    emissiveIntensity: 2.5,
    opacity: 1,
    roughness: 0.12,
    metalness: 0.12,
    blendStrength: 0.68,
    emissiveBlendStrength: 0.84,
  },
};

const RHYTHMIC_CHANNEL_GAIN: Record<TrackMaterialChannel, number> = {
  road: 1,
  wall: 0.4,
  centerline: 0.85,
};

const RHYTHMIC_VERTEX_DECLARATIONS = `
attribute float aTrackU;
varying float vTrackU;
`;

const RHYTHMIC_VERTEX_ASSIGN = `
vTrackU = aTrackU;
`;

const RHYTHMIC_FRAGMENT_DECLARATIONS = `
varying float vTrackU;
uniform float uMusicTime;
uniform float uKick;
uniform float uEnergyLevel;
uniform float uRhythmicStrength;
uniform float uRibbonSpeed;
uniform float uRibbonWidth;
uniform float uChannelGain;
`;

// Colour gradient that only depends on audio energy level.
// No section/phrase/song-structure input. Cool at low energy, hot at high energy.
const RHYTHMIC_FRAGMENT_BODY = `
float tempoStrength = uRhythmicStrength * uChannelGain;
if (tempoStrength > 0.0) {
  float kickStrength = clamp(uKick, 0.0, 1.0);
  float energy = clamp(uEnergyLevel, 0.0, 1.0);

  // Energy -> colour ramp, matched to the game's blue/cyan/magenta fiction palette.
  // Typical tracks sit in 0.3 - 0.55 range so the bulk of gameplay lives between
  // cruise cyan and charge magenta. Peaks push to hot pink.
  vec3 calmColor = vec3(0.14, 0.32, 0.9);
  vec3 cruiseColor = vec3(0.25, 0.9, 1.0);
  vec3 chargeColor = vec3(0.85, 0.28, 0.95);
  vec3 peakColor = vec3(1.0, 0.45, 0.75);

  vec3 energyColor;
  if (energy < 0.3) {
    energyColor = mix(calmColor, cruiseColor, energy / 0.3);
  } else if (energy < 0.6) {
    energyColor = mix(cruiseColor, chargeColor, (energy - 0.3) / 0.3);
  } else {
    energyColor = mix(chargeColor, peakColor, clamp((energy - 0.6) / 0.3, 0.0, 1.0));
  }

  // Brightness is kick-only. Energy drives colour, not brightness.
  float brightnessFactor = 0.45 + kickStrength * 0.5;
  vec3 dimmed = totalEmissiveRadiance * brightnessFactor;

  // Colour output at matched brightness, so swap is hue not exposure.
  vec3 colored = energyColor * (0.42 + kickStrength * 0.4);

  // Near-full replacement so section-agnostic colour is the dominant read.
  vec3 pulsed = mix(dimmed, colored, 0.78);

  // Narrow ribbon in the same energy colour.
  float ribbonTravel = fract(vTrackU - uMusicTime * uRibbonSpeed);
  float ribbonEdge = min(ribbonTravel, 1.0 - ribbonTravel);
  float ribbon = smoothstep(uRibbonWidth, 0.0, ribbonEdge);
  vec3 ribbonAdd = energyColor * ribbon * (0.1 + kickStrength * 0.4);

  totalEmissiveRadiance = mix(totalEmissiveRadiance, pulsed + ribbonAdd, tempoStrength);
}
`;

export class TrackPresentationController {
  private readonly roadMaterials: MaterialSnapshot[];
  private readonly wallMaterials: MaterialSnapshot[];
  private readonly centerlineMaterials: MaterialSnapshot[];
  private readonly rhythmicUniforms: RhythmicUniforms[] = [];

  constructor(roadRoot: Object3D, wallRoots: readonly Object3D[], centerLineRoot: Object3D) {
    this.roadMaterials = collectStandardMaterials(roadRoot);
    this.wallMaterials = wallRoots.flatMap((root) => collectStandardMaterials(root));
    this.centerlineMaterials = collectStandardMaterials(centerLineRoot);

    this.attachRhythmicShader(this.roadMaterials, "road");
    this.attachRhythmicShader(this.wallMaterials, "wall");
    this.attachRhythmicShader(this.centerlineMaterials, "centerline");
  }

  setLoadingBlend(blend: number, pulse = 0): void {
    const clampedBlend = clamp01(blend);
    const clampedPulse = clamp01(pulse);
    const shimmer = 0.18 + clampedPulse * 0.4;

    this.applyChannel(this.roadMaterials, "road", clampedBlend, shimmer);
    this.applyChannel(this.wallMaterials, "wall", clampedBlend, shimmer * 0.85);
    this.applyChannel(this.centerlineMaterials, "centerline", clampedBlend, shimmer * 0.7);
  }

  setRhythmicPulse(state: RhythmicState): void {
    const strength = clamp01(state.strength);
    for (const uniforms of this.rhythmicUniforms) {
      uniforms.uMusicTime.value = state.musicTime;
      uniforms.uKick.value = state.kick;
      uniforms.uEnergyLevel.value = state.energyLevel;
      uniforms.uRhythmicStrength.value = strength;
    }
  }

  private attachRhythmicShader(
    materials: readonly MaterialSnapshot[],
    channel: TrackMaterialChannel,
  ): void {
    const channelGain = RHYTHMIC_CHANNEL_GAIN[channel];
    for (const snapshot of materials) {
      const material = snapshot.material;
      const uniforms: RhythmicUniforms = {
        uMusicTime: { value: 0 },
        uKick: { value: 0 },
        uEnergyLevel: { value: 0 },
        uRhythmicStrength: { value: 0 },
        uRibbonSpeed: { value: 0.085 },
        uRibbonWidth: { value: 0.028 },
        uChannelGain: { value: channelGain },
      };
      this.rhythmicUniforms.push(uniforms);
      material.userData.rhythmicUniforms = uniforms;

      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = injectBefore(
          shader.vertexShader,
          "#include <common>",
          RHYTHMIC_VERTEX_DECLARATIONS,
        );
        shader.vertexShader = injectAfter(
          shader.vertexShader,
          "#include <begin_vertex>",
          RHYTHMIC_VERTEX_ASSIGN,
        );
        shader.fragmentShader = injectBefore(
          shader.fragmentShader,
          "#include <common>",
          RHYTHMIC_FRAGMENT_DECLARATIONS,
        );
        shader.fragmentShader = injectAfter(
          shader.fragmentShader,
          "#include <emissivemap_fragment>",
          RHYTHMIC_FRAGMENT_BODY,
        );
      };
      material.needsUpdate = true;
    }
  }

  private applyChannel(
    materials: readonly MaterialSnapshot[],
    channel: TrackMaterialChannel,
    blend: number,
    shimmer: number,
  ): void {
    const target = LOADING_MATERIAL_TARGETS[channel];
    for (const snapshot of materials) {
      snapshot.material.color.copy(snapshot.color).lerp(target.color, blend * target.blendStrength);
      snapshot.material.emissive.copy(snapshot.emissive).lerp(target.emissive, blend * target.emissiveBlendStrength);
      snapshot.material.emissiveIntensity = lerp(
        snapshot.emissiveIntensity,
        target.emissiveIntensity + shimmer,
        blend,
      );
      snapshot.material.opacity = lerp(snapshot.opacity, target.opacity, blend);
      snapshot.material.roughness = lerp(snapshot.roughness, target.roughness, blend);
      snapshot.material.metalness = lerp(snapshot.metalness, target.metalness, blend);
    }
  }
}

function collectStandardMaterials(root: Object3D): MaterialSnapshot[] {
  const snapshots: MaterialSnapshot[] = [];
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof MeshStandardMaterial)) continue;
      snapshots.push({
        material,
        color: material.color.clone(),
        emissive: material.emissive.clone(),
        emissiveIntensity: material.emissiveIntensity,
        opacity: material.opacity,
        roughness: material.roughness,
        metalness: material.metalness,
      });
    }
  });
  return snapshots;
}

function injectBefore(source: string, anchor: string, insertion: string): string {
  return source.replace(anchor, `${insertion}\n${anchor}`);
}

function injectAfter(source: string, anchor: string, insertion: string): string {
  return source.replace(anchor, `${anchor}\n${insertion}`);
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function lerp(start: number, end: number, alpha: number): number {
  return start + (end - start) * alpha;
}
