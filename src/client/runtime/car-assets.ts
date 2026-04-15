import { Box3, Group, Mesh, Vector3 } from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CarVariant } from "../../../shared/network-types";
import type { ClientConfig } from "./config";
import { resolveAssetUrl } from "./config";

export type CarPreviewSpec = {
  accent: string;
  trim: string;
  canopy: string;
  silhouette: "dart" | "muscle" | "wedge" | "phantom";
};

export type CarPaletteSpec = {
  body: string;
  bodyEmissive: string;
  cockpit: string;
  cockpitEmissive: string;
};

export type CarAssetTransform = {
  scale: number;
  position: [number, number, number];
  rotation: [number, number, number];
};

export type CarAssetDefinition = {
  variant: CarVariant;
  displayName: string;
  assetSlug: string;
  assetPath: string;
  sourceUuid: string;
  previewTransform: CarAssetTransform;
  raceTransform: CarAssetTransform;
  fallbackPreviewSpec: CarPreviewSpec;
  fallbackPalette: CarPaletteSpec;
};

const BASE_PREVIEW_TRANSFORM: CarAssetTransform = {
  scale: 3.7,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
};

const BASE_RACE_TRANSFORM: CarAssetTransform = {
  scale: 3.15,
  position: [0, 0.02, 0],
  rotation: [0, 0, 0],
};

export const carAssetDefinitions: readonly CarAssetDefinition[] = [
  {
    variant: "vector",
    displayName: "Needle",
    assetSlug: "needle",
    assetPath: "/cars/needle/v1.glb",
    sourceUuid: "019d914e-8c0d-7768-98f0-a311d749fdc8",
    previewTransform: BASE_PREVIEW_TRANSFORM,
    raceTransform: BASE_RACE_TRANSFORM,
    fallbackPreviewSpec: {
      accent: "#14f1ff",
      trim: "#0f6d74",
      canopy: "#0e1320",
      silhouette: "dart",
    },
    fallbackPalette: {
      body: "#14f1ff",
      bodyEmissive: "#0f6d74",
      cockpit: "#0e1320",
      cockpitEmissive: "#1b2744",
    },
  },
  {
    variant: "ember",
    displayName: "Outlaw",
    assetSlug: "outlaw",
    assetPath: "/cars/outlaw/v1.glb",
    sourceUuid: "019d9150-1797-71f6-82bb-7862a9876551",
    previewTransform: {
      ...BASE_PREVIEW_TRANSFORM,
      position: [0, -0.08, 0],
    },
    raceTransform: {
      ...BASE_RACE_TRANSFORM,
      position: [0, 0.06, 0],
    },
    fallbackPreviewSpec: {
      accent: "#ff825c",
      trim: "#7b220d",
      canopy: "#1e1010",
      silhouette: "muscle",
    },
    fallbackPalette: {
      body: "#ff825c",
      bodyEmissive: "#7b220d",
      cockpit: "#1e1010",
      cockpitEmissive: "#4a2b1f",
    },
  },
  {
    variant: "nova",
    displayName: "Kestrel",
    assetSlug: "kestrel",
    assetPath: "/cars/kestrel/v1.glb",
    sourceUuid: "019d91b7-37d4-7425-95ac-8d8fd88e0cd3",
    previewTransform: BASE_PREVIEW_TRANSFORM,
    raceTransform: BASE_RACE_TRANSFORM,
    fallbackPreviewSpec: {
      accent: "#f6f06d",
      trim: "#615d0e",
      canopy: "#14161b",
      silhouette: "wedge",
    },
    fallbackPalette: {
      body: "#f6f06d",
      bodyEmissive: "#615d0e",
      cockpit: "#14161b",
      cockpitEmissive: "#393e49",
    },
  },
  {
    variant: "ghost",
    displayName: "Specter",
    assetSlug: "specter",
    assetPath: "/cars/specter/v1.glb",
    sourceUuid: "019d914f-4f4a-7b88-a1ec-ed04e7f9579e",
    previewTransform: {
      ...BASE_PREVIEW_TRANSFORM,
      position: [0, -0.12, 0],
    },
    raceTransform: {
      ...BASE_RACE_TRANSFORM,
      position: [0, 0.04, 0],
    },
    fallbackPreviewSpec: {
      accent: "#caa8ff",
      trim: "#432667",
      canopy: "#120f1d",
      silhouette: "phantom",
    },
    fallbackPalette: {
      body: "#caa8ff",
      bodyEmissive: "#432667",
      cockpit: "#120f1d",
      cockpitEmissive: "#2c2550",
    },
  },
] as const;

const carAssetByVariant = new Map(carAssetDefinitions.map((definition) => [definition.variant, definition]));
const sharedAssetFlag = "tempoSharedAsset";
const tempBox = new Box3();
const tempSize = new Vector3();
const tempCenter = new Vector3();

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderConfig({ type: "wasm" });
dracoLoader.setDecoderPath("/draco/gltf/");

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

const templateCache = new Map<CarVariant, Group>();
const pendingLoads = new Map<CarVariant, Promise<Group>>();

export function getCarAssetDefinition(variant: CarVariant): CarAssetDefinition {
  return carAssetByVariant.get(variant) ?? carAssetDefinitions[0];
}

export function prefetchCarMesh(config: ClientConfig, variant: CarVariant): void {
  void ensureCarTemplate(config, variant).catch((error) => {
    console.error(`Failed to prefetch car mesh for ${variant}:`, error);
  });
}

export async function loadCarMesh(config: ClientConfig, variant: CarVariant): Promise<Group> {
  const template = await ensureCarTemplate(config, variant);
  return cloneSharedCarAsset(template);
}

export function applyCarTransform(group: Group, transform: CarAssetTransform): void {
  group.position.set(...transform.position);
  group.rotation.set(...transform.rotation);
  group.scale.setScalar(transform.scale);
}

export function isSharedCarMesh(mesh: Mesh): boolean {
  return mesh.userData[sharedAssetFlag] === true;
}

async function ensureCarTemplate(config: ClientConfig, variant: CarVariant): Promise<Group> {
  const cached = templateCache.get(variant);
  if (cached) return cached;

  const existing = pendingLoads.get(variant);
  if (existing) return existing;

  const definition = getCarAssetDefinition(variant);
  const url = resolveAssetUrl(config, definition.assetPath);
  const loadPromise = gltfLoader.loadAsync(url)
    .then((gltf) => {
      const normalized = normalizeImportedCar(gltf.scene);
      templateCache.set(variant, normalized);
      pendingLoads.delete(variant);
      return normalized;
    })
    .catch((error) => {
      pendingLoads.delete(variant);
      throw error;
    });

  pendingLoads.set(variant, loadPromise);
  return loadPromise;
}

function normalizeImportedCar(source: Group): Group {
  const root = source;
  root.rotation.set(0, -Math.PI / 2, 0);
  root.updateMatrixWorld(true);

  tempBox.setFromObject(root);
  tempBox.getCenter(tempCenter);
  root.position.set(-tempCenter.x, -tempBox.min.y, -tempCenter.z);
  root.updateMatrixWorld(true);

  tempBox.setFromObject(root);
  tempBox.getSize(tempSize);
  const normalizedLength = Math.max(tempSize.z, 0.001);
  root.scale.setScalar(1 / normalizedLength);
  root.updateMatrixWorld(true);

  tempBox.setFromObject(root);
  tempBox.getCenter(tempCenter);
  root.position.x -= tempCenter.x;
  root.position.y -= tempBox.min.y;
  root.position.z -= tempCenter.z;
  root.updateMatrixWorld(true);

  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.userData[sharedAssetFlag] = true;
    object.frustumCulled = true;
  });

  const normalized = new Group();
  normalized.name = "tempo-car-template";
  normalized.add(root);
  return normalized;
}

function cloneSharedCarAsset(template: Group): Group {
  const clone = template.clone(true);
  clone.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.userData[sharedAssetFlag] = true;
  });
  return clone;
}
