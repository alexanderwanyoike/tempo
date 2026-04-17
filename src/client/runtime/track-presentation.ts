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

export class TrackPresentationController {
  private readonly roadMaterials: MaterialSnapshot[];
  private readonly wallMaterials: MaterialSnapshot[];
  private readonly centerlineMaterials: MaterialSnapshot[];

  constructor(roadRoot: Object3D, wallRoots: readonly Object3D[], centerLineRoot: Object3D) {
    this.roadMaterials = collectStandardMaterials(roadRoot);
    this.wallMaterials = wallRoots.flatMap((root) => collectStandardMaterials(root));
    this.centerlineMaterials = collectStandardMaterials(centerLineRoot);
  }

  setLoadingBlend(blend: number, pulse = 0): void {
    const clampedBlend = clamp01(blend);
    const clampedPulse = clamp01(pulse);
    const shimmer = 0.18 + clampedPulse * 0.4;

    this.applyChannel(this.roadMaterials, "road", clampedBlend, shimmer);
    this.applyChannel(this.wallMaterials, "wall", clampedBlend, shimmer * 0.85);
    this.applyChannel(this.centerlineMaterials, "centerline", clampedBlend, shimmer * 0.7);
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
      snapshot.material.needsUpdate = true;
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

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function lerp(start: number, end: number, alpha: number): number {
  return start + (end - start) * alpha;
}
