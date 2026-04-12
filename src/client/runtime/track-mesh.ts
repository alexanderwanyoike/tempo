import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  DoubleSide,
  Group,
  MathUtils as TMath,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from "three";

import type { SongSectionType } from "../../../shared/song-schema.js";
import type { SectionBoundary } from "./track-generator.js";

const WORLD_UP = new Vector3(0, 1, 0);
const WALL_HEIGHT = 2.0;
const CENTER_DASH_WIDTH = 0.25;
const ROAD_SURFACE_LIFT = 0.02;
const ROAD_GRID_LIFT = 0.06;
const ROAD_EDGE_LIFT = 0.09;
const ROAD_GRID_WIDTH = 0.085;
const ROAD_EDGE_WIDTH = 0.26;
const WALL_HOLO_OPACITY = 0.34;

const roadSectionColors: Record<SongSectionType, { base: Color; glow: Color; edge: Color }> = {
  intro:     { base: new Color("#071019"), glow: new Color("#59d9ff"), edge: new Color("#b1f6ff") },
  verse:     { base: new Color("#07121d"), glow: new Color("#41fff0"), edge: new Color("#9dfbf5") },
  build:     { base: new Color("#110d18"), glow: new Color("#ff7ae6"), edge: new Color("#ffc7fb") },
  drop:      { base: new Color("#140b18"), glow: new Color("#ff5179"), edge: new Color("#ffb0d1") },
  bridge:    { base: new Color("#0d0d1c"), glow: new Color("#a76cff"), edge: new Color("#ddc4ff") },
  breakdown: { base: new Color("#07131a"), glow: new Color("#4bc5ff"), edge: new Color("#a8e8ff") },
  finale:    { base: new Color("#120f18"), glow: new Color("#ff9b59"), edge: new Color("#ffe0bf") },
};

// Wall color palette per section type
const sectionWallColors: Record<SongSectionType, { base: Color; stripe: Color }> = {
  intro:     { base: new Color("#4e233a"), stripe: new Color("#ff2a6d") },
  verse:     { base: new Color("#1a3a4e"), stripe: new Color("#2a9fff") },
  build:     { base: new Color("#2a4e1a"), stripe: new Color("#9fff2a") },
  drop:      { base: new Color("#4e1a1a"), stripe: new Color("#ff2a2a") },
  bridge:    { base: new Color("#2a1a4e"), stripe: new Color("#9f2aff") },
  breakdown: { base: new Color("#1a4e4e"), stripe: new Color("#2affff") },
  finale:    { base: new Color("#4e4e1a"), stripe: new Color("#ffff2a") },
};

export interface FrameTable {
  samples: Vector3[];
  tangents: Vector3[];
  rights: Vector3[];
  ups: Vector3[];
}

function sampleHalfWidth(halfWidths: readonly number[] | number, i: number): number {
  if (typeof halfWidths === "number") return halfWidths;
  return halfWidths[Math.min(i, halfWidths.length - 1)] ?? halfWidths[halfWidths.length - 1] ?? 0;
}

export function computeParallelTransportFrames(
  centerline: CatmullRomCurve3,
  sampleCount: number,
): FrameTable {
  const samples = centerline.getSpacedPoints(sampleCount);
  const tangents: Vector3[] = [];
  const rights: Vector3[] = [];
  const ups: Vector3[] = [];

  // Compute tangents
  for (let i = 0; i <= sampleCount; i++) {
    const u = i / sampleCount;
    tangents.push(
      centerline.getTangentAt(Math.min(u, 0.9999)).normalize(),
    );
  }

  // Parallel transport: initialize first frame from world up
  const r0 = new Vector3().crossVectors(tangents[0], WORLD_UP).normalize();
  const u0 = new Vector3().crossVectors(r0, tangents[0]).normalize();
  rights.push(r0);
  ups.push(u0);

  const rotMat = new Matrix4();
  for (let i = 1; i <= sampleCount; i++) {
    const prevR = rights[i - 1].clone();
    const prevU = ups[i - 1].clone();

    // Minimal rotation from previous tangent to current
    const axis = new Vector3().crossVectors(tangents[i - 1], tangents[i]);
    if (axis.length() > 1e-8) {
      axis.normalize();
      const angle = Math.acos(TMath.clamp(tangents[i - 1].dot(tangents[i]), -1, 1));
      rotMat.makeRotationAxis(axis, angle);
      prevR.applyMatrix4(rotMat);
      prevU.applyMatrix4(rotMat);
    }

    rights.push(prevR.normalize());
    ups.push(prevU.normalize());
  }

  return { samples, tangents, rights, ups };
}

export function buildRoadMesh(
  frames: FrameTable,
  halfWidths: readonly number[] | number,
  sections?: { type: SongSectionType }[],
  boundaries?: SectionBoundary[],
): Group {
  const sampleSection = buildSampleSectionMap(frames.samples.length, boundaries) ?? new Uint8Array(frames.samples.length);
  const group = new Group();
  group.add(buildRoadSurfaceMesh(frames, halfWidths, sections, sampleSection));
  group.add(buildRoadMajorGridMesh(frames, halfWidths, sections, sampleSection));
  group.add(buildRoadLongitudinalGridMesh(frames, halfWidths, sections, sampleSection));
  group.add(buildRoadCrossGridMesh(frames, halfWidths, sections, sampleSection));
  group.add(buildRoadEdgeGlowMesh(frames, halfWidths, -1, sections, sampleSection));
  group.add(buildRoadEdgeGlowMesh(frames, halfWidths, 1, sections, sampleSection));
  return group;
}

function buildRoadSurfaceMesh(
  frames: FrameTable,
  halfWidths: readonly number[] | number,
  sections?: { type: SongSectionType }[],
  sampleSection?: Uint8Array,
): Mesh {
  const count = frames.samples.length;
  const positions = new Float32Array(count * 2 * 3);
  const normals = new Float32Array(count * 2 * 3);
  const colors = new Float32Array(count * 2 * 3);
  const indices: number[] = [];

  for (let i = 0; i < count; i++) {
    const c = frames.samples[i];
    const r = frames.rights[i];
    const n = frames.ups[i];
    const vi = i * 2;
    const halfWidth = sampleHalfWidth(halfWidths, i);
    const palette = getRoadPalette(sections, sampleSection, i);
    const surf = new Color().copy(palette.base).lerp(palette.glow, 0.1);

    positions[vi * 3]     = c.x - r.x * halfWidth + n.x * ROAD_SURFACE_LIFT;
    positions[vi * 3 + 1] = c.y - r.y * halfWidth + n.y * ROAD_SURFACE_LIFT;
    positions[vi * 3 + 2] = c.z - r.z * halfWidth + n.z * ROAD_SURFACE_LIFT;

    positions[(vi + 1) * 3]     = c.x + r.x * halfWidth + n.x * ROAD_SURFACE_LIFT;
    positions[(vi + 1) * 3 + 1] = c.y + r.y * halfWidth + n.y * ROAD_SURFACE_LIFT;
    positions[(vi + 1) * 3 + 2] = c.z + r.z * halfWidth + n.z * ROAD_SURFACE_LIFT;

    normals[vi * 3] = n.x;     normals[vi * 3 + 1] = n.y;     normals[vi * 3 + 2] = n.z;
    normals[(vi+1)*3] = n.x;   normals[(vi+1)*3+1] = n.y;     normals[(vi+1)*3+2] = n.z;
    colors[vi * 3] = surf.r; colors[vi * 3 + 1] = surf.g; colors[vi * 3 + 2] = surf.b;
    colors[(vi + 1) * 3] = surf.r; colors[(vi + 1) * 3 + 1] = surf.g; colors[(vi + 1) * 3 + 2] = surf.b;

    if (i < count - 1) {
      indices.push(vi, vi+1, vi+2);
      indices.push(vi+1, vi+3, vi+2);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("normal", new BufferAttribute(normals, 3));
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  geo.setIndex(indices);

  return new Mesh(geo, new MeshStandardMaterial({
    color: "#173047",
    vertexColors: true,
    emissive: "#18364f",
    emissiveIntensity: 1.5,
    metalness: 0.42,
    roughness: 0.18,
    transparent: true,
    opacity: 0.68,
    side: DoubleSide,
  }));
}

function buildRoadMajorGridMesh(
  frames: FrameTable,
  halfWidths: readonly number[] | number,
  sections?: { type: SongSectionType }[],
  sampleSection?: Uint8Array,
): Group {
  const group = new Group();
  group.add(buildRoadLongitudinalGridLayer(
    frames,
    halfWidths,
    [-0.9, -0.7, -0.5, -0.3, 0, 0.3, 0.5, 0.7, 0.9],
    0.12,
    ROAD_GRID_LIFT + 0.01,
    sections,
    sampleSection,
    0.95,
    3.05,
  ));
  group.add(buildRoadCrossGridLayer(
    frames,
    halfWidths,
    5,
    0.12,
    ROAD_GRID_LIFT + 0.01,
    sections,
    sampleSection,
    0.82,
    2.35,
  ));
  return group;
}

function buildRoadLongitudinalGridMesh(
  frames: FrameTable,
  halfWidths: readonly number[] | number,
  sections?: { type: SongSectionType }[],
  sampleSection?: Uint8Array,
): Mesh {
  return buildRoadLongitudinalGridLayer(
    frames,
    halfWidths,
    [-0.95, -0.85, -0.75, -0.65, -0.55, -0.45, -0.35, -0.25, -0.15, -0.05, 0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95],
    ROAD_GRID_WIDTH,
    ROAD_GRID_LIFT,
    sections,
    sampleSection,
    0.78,
    2.2,
  );
}

function buildRoadLongitudinalGridLayer(
  frames: FrameTable,
  halfWidths: readonly number[] | number,
  laneFractions: readonly number[],
  gridWidth: number,
  lift: number,
  sections?: { type: SongSectionType }[],
  sampleSection?: Uint8Array,
  opacity = 0.88,
  emissiveIntensity = 3.2,
): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let vertIdx = 0;

  for (let i = 0; i < frames.samples.length - 1; i++) {
    const c = frames.samples[i];
    const cN = frames.samples[i + 1];
    const r = frames.rights[i];
    const rN = frames.rights[i + 1];
    const u = frames.ups[i];
    const uN = frames.ups[i + 1];
    const halfWidth = sampleHalfWidth(halfWidths, i) * 0.9;
    const halfWidthN = sampleHalfWidth(halfWidths, i + 1) * 0.9;
    const hw = gridWidth / 2;
    const palette = getRoadPalette(sections, sampleSection, i);

    for (const fraction of laneFractions) {
      const offset = halfWidth * fraction;
      const offsetN = halfWidthN * fraction;
      positions.push(
        c.x + r.x * (offset - hw) + u.x * lift,
        c.y + r.y * (offset - hw) + u.y * lift,
        c.z + r.z * (offset - hw) + u.z * lift,
        c.x + r.x * (offset + hw) + u.x * lift,
        c.y + r.y * (offset + hw) + u.y * lift,
        c.z + r.z * (offset + hw) + u.z * lift,
        cN.x + rN.x * (offsetN - hw) + uN.x * lift,
        cN.y + rN.y * (offsetN - hw) + uN.y * lift,
        cN.z + rN.z * (offsetN - hw) + uN.z * lift,
        cN.x + rN.x * (offsetN + hw) + uN.x * lift,
        cN.y + rN.y * (offsetN + hw) + uN.y * lift,
        cN.z + rN.z * (offsetN + hw) + uN.z * lift,
      );
      for (let j = 0; j < 4; j++) normals.push(u.x, u.y, u.z);
      for (let j = 0; j < 4; j++) colors.push(palette.glow.r, palette.glow.g, palette.glow.b);
      indices.push(vertIdx, vertIdx + 1, vertIdx + 2);
      indices.push(vertIdx + 1, vertIdx + 3, vertIdx + 2);
      vertIdx += 4;
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  geo.setIndex(indices);

  return new Mesh(geo, new MeshStandardMaterial({
    color: "#7af9ff",
    vertexColors: true,
    emissive: "#55f6ff",
    emissiveIntensity,
    metalness: 0.08,
    roughness: 0.16,
    transparent: true,
    opacity,
    side: DoubleSide,
  }));
}

function buildRoadCrossGridMesh(
  frames: FrameTable,
  halfWidths: readonly number[] | number,
  sections?: { type: SongSectionType }[],
  sampleSection?: Uint8Array,
): Mesh {
  return buildRoadCrossGridLayer(
    frames,
    halfWidths,
    2,
    ROAD_GRID_WIDTH,
    ROAD_GRID_LIFT,
    sections,
    sampleSection,
    0.72,
    1.95,
  );
}

function buildRoadCrossGridLayer(
  frames: FrameTable,
  halfWidths: readonly number[] | number,
  stride: number,
  gridWidth: number,
  lift: number,
  sections?: { type: SongSectionType }[],
  sampleSection?: Uint8Array,
  opacity = 0.6,
  emissiveIntensity = 2.2,
): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let vertIdx = 0;

  for (let i = 0; i < frames.samples.length - 1; i += stride) {
    const c = frames.samples[i];
    const r = frames.rights[i];
    const t = frames.tangents[i];
    const u = frames.ups[i];
    const span = sampleHalfWidth(halfWidths, i) * 0.88;
    const halfThickness = gridWidth * 0.72;
    const palette = getRoadPalette(sections, sampleSection, i);

    positions.push(
      c.x - r.x * span - t.x * halfThickness + u.x * lift,
      c.y - r.y * span - t.y * halfThickness + u.y * lift,
      c.z - r.z * span - t.z * halfThickness + u.z * lift,
      c.x + r.x * span - t.x * halfThickness + u.x * lift,
      c.y + r.y * span - t.y * halfThickness + u.y * lift,
      c.z + r.z * span - t.z * halfThickness + u.z * lift,
      c.x - r.x * span + t.x * halfThickness + u.x * lift,
      c.y - r.y * span + t.y * halfThickness + u.y * lift,
      c.z - r.z * span + t.z * halfThickness + u.z * lift,
      c.x + r.x * span + t.x * halfThickness + u.x * lift,
      c.y + r.y * span + t.y * halfThickness + u.y * lift,
      c.z + r.z * span + t.z * halfThickness + u.z * lift,
    );
    for (let j = 0; j < 4; j++) normals.push(u.x, u.y, u.z);
    for (let j = 0; j < 4; j++) colors.push(palette.glow.r, palette.glow.g, palette.glow.b);
    indices.push(vertIdx, vertIdx + 1, vertIdx + 2);
    indices.push(vertIdx + 1, vertIdx + 3, vertIdx + 2);
    vertIdx += 4;
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  geo.setIndex(indices);

  return new Mesh(geo, new MeshStandardMaterial({
    color: "#33dfff",
    vertexColors: true,
    emissive: "#1ec8ff",
    emissiveIntensity,
    metalness: 0.06,
    roughness: 0.2,
    transparent: true,
    opacity,
    side: DoubleSide,
  }));
}

function buildRoadEdgeGlowMesh(
  frames: FrameTable,
  halfWidths: readonly number[] | number,
  side: -1 | 1,
  sections?: { type: SongSectionType }[],
  sampleSection?: Uint8Array,
): Mesh {
  const count = frames.samples.length;
  const positions = new Float32Array(count * 2 * 3);
  const normals = new Float32Array(count * 2 * 3);
  const colors = new Float32Array(count * 2 * 3);
  const indices: number[] = [];

  for (let i = 0; i < count; i++) {
    const c = frames.samples[i];
    const r = frames.rights[i];
    const u = frames.ups[i];
    const halfWidth = sampleHalfWidth(halfWidths, i);
    const vi = i * 2;
    const edgeOffset = halfWidth - ROAD_EDGE_WIDTH * 0.85;
    const inner = edgeOffset * side;
    const outer = (edgeOffset + ROAD_EDGE_WIDTH) * side;
    const palette = getRoadPalette(sections, sampleSection, i);
    const edgeColor = side === 1 ? new Color().copy(palette.glow).lerp(new Color("#ff5ea2"), 0.35) : palette.edge;

    positions[vi * 3] = c.x + r.x * inner + u.x * ROAD_EDGE_LIFT;
    positions[vi * 3 + 1] = c.y + r.y * inner + u.y * ROAD_EDGE_LIFT;
    positions[vi * 3 + 2] = c.z + r.z * inner + u.z * ROAD_EDGE_LIFT;
    positions[(vi + 1) * 3] = c.x + r.x * outer + u.x * ROAD_EDGE_LIFT;
    positions[(vi + 1) * 3 + 1] = c.y + r.y * outer + u.y * ROAD_EDGE_LIFT;
    positions[(vi + 1) * 3 + 2] = c.z + r.z * outer + u.z * ROAD_EDGE_LIFT;

    normals[vi * 3] = u.x; normals[vi * 3 + 1] = u.y; normals[vi * 3 + 2] = u.z;
    normals[(vi + 1) * 3] = u.x; normals[(vi + 1) * 3 + 1] = u.y; normals[(vi + 1) * 3 + 2] = u.z;
    colors[vi * 3] = edgeColor.r; colors[vi * 3 + 1] = edgeColor.g; colors[vi * 3 + 2] = edgeColor.b;
    colors[(vi + 1) * 3] = edgeColor.r; colors[(vi + 1) * 3 + 1] = edgeColor.g; colors[(vi + 1) * 3 + 2] = edgeColor.b;

    if (i < count - 1) {
      indices.push(vi, vi + 1, vi + 2);
      indices.push(vi + 1, vi + 3, vi + 2);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("normal", new BufferAttribute(normals, 3));
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  geo.setIndex(indices);

  return new Mesh(geo, new MeshStandardMaterial({
    color: "#8ef8ff",
    vertexColors: true,
    emissive: "#74efff",
    emissiveIntensity: 2.15,
    metalness: 0.08,
    roughness: 0.14,
    transparent: true,
    opacity: 0.9,
    side: DoubleSide,
  }));
}

export function buildWallMesh(
  frames: FrameTable,
  halfWidths: readonly number[] | number,
  side: -1 | 1,
): Mesh {
  const count = frames.samples.length;
  const positions = new Float32Array(count * 2 * 3);
  const normals = new Float32Array(count * 2 * 3);
  const colors = new Float32Array(count * 2 * 3);
  const indices: number[] = [];
  const colBase = new Color("#4e233a");
  const colStripe = new Color("#ff2a6d");

  for (let i = 0; i < count; i++) {
    const c = frames.samples[i];
    const r = frames.rights[i];
    const u = frames.ups[i];
    const vi = i * 2;
    const halfWidth = sampleHalfWidth(halfWidths, i);

    const ex = c.x + r.x * halfWidth * side;
    const ey = c.y + r.y * halfWidth * side;
    const ez = c.z + r.z * halfWidth * side;

    positions[vi*3] = ex;           positions[vi*3+1] = ey;           positions[vi*3+2] = ez;
    positions[(vi+1)*3] = ex+u.x*WALL_HEIGHT; positions[(vi+1)*3+1] = ey+u.y*WALL_HEIGHT; positions[(vi+1)*3+2] = ez+u.z*WALL_HEIGHT;

    const nx = -r.x * side, ny = -r.y * side, nz = -r.z * side;
    normals[vi*3]=nx; normals[vi*3+1]=ny; normals[vi*3+2]=nz;
    normals[(vi+1)*3]=nx; normals[(vi+1)*3+1]=ny; normals[(vi+1)*3+2]=nz;

    const col = Math.floor(i / 8) % 2 === 0 ? colStripe : colBase;
    colors[vi*3]=col.r; colors[vi*3+1]=col.g; colors[vi*3+2]=col.b;
    colors[(vi+1)*3]=col.r; colors[(vi+1)*3+1]=col.g; colors[(vi+1)*3+2]=col.b;

    if (i < count - 1) {
      if (side === 1) { indices.push(vi,vi+1,vi+2); indices.push(vi+1,vi+3,vi+2); }
      else { indices.push(vi,vi+2,vi+1); indices.push(vi+1,vi+2,vi+3); }
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("normal", new BufferAttribute(normals, 3));
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  geo.setIndex(indices);

  return new Mesh(geo, new MeshStandardMaterial({
    vertexColors: true,
    emissive: "#4ee8ff",
    emissiveIntensity: 1.45,
    metalness: 0.12,
    roughness: 0.18,
    transparent: true,
    opacity: WALL_HOLO_OPACITY,
    side: DoubleSide,
  }));
}

/** Section-aware wall mesh with colors that change per song section. */
export function buildSectionWallMesh(
  frames: FrameTable,
  halfWidths: readonly number[] | number,
  side: -1 | 1,
  sections: { type: SongSectionType }[],
  boundaries: SectionBoundary[],
): Group {
  const sampleSection = buildSampleSectionMap(frames.samples.length, boundaries) ?? new Uint8Array(frames.samples.length);
  const group = new Group();
  group.add(buildSectionWallSurfaceMesh(frames, halfWidths, side, sections, sampleSection));
  group.add(buildSectionWallRailMesh(frames, halfWidths, side, sections, sampleSection, 0.18, 0.09));
  group.add(buildSectionWallRailMesh(frames, halfWidths, side, sections, sampleSection, 0.58, 0.07));
  group.add(buildSectionWallRailMesh(frames, halfWidths, side, sections, sampleSection, 0.92, 0.12));
  return group;
}

function buildSectionWallSurfaceMesh(
  frames: FrameTable,
  halfWidths: readonly number[] | number,
  side: -1 | 1,
  sections: { type: SongSectionType }[],
  sampleSection: Uint8Array,
): Mesh {
  const count = frames.samples.length;
  const positions = new Float32Array(count * 2 * 3);
  const normals = new Float32Array(count * 2 * 3);
  const colors = new Float32Array(count * 2 * 3);
  const indices: number[] = [];

  for (let i = 0; i < count; i++) {
    const c = frames.samples[i];
    const r = frames.rights[i];
    const u = frames.ups[i];
    const vi = i * 2;
    const halfWidth = sampleHalfWidth(halfWidths, i);

    const ex = c.x + r.x * halfWidth * side;
    const ey = c.y + r.y * halfWidth * side;
    const ez = c.z + r.z * halfWidth * side;

    positions[vi*3] = ex;           positions[vi*3+1] = ey;           positions[vi*3+2] = ez;
    positions[(vi+1)*3] = ex+u.x*WALL_HEIGHT; positions[(vi+1)*3+1] = ey+u.y*WALL_HEIGHT; positions[(vi+1)*3+2] = ez+u.z*WALL_HEIGHT;

    const nx = -r.x * side, ny = -r.y * side, nz = -r.z * side;
    normals[vi*3]=nx; normals[vi*3+1]=ny; normals[vi*3+2]=nz;
    normals[(vi+1)*3]=nx; normals[(vi+1)*3+1]=ny; normals[(vi+1)*3+2]=nz;

    const palette = sectionWallColors[sections[sampleSection[i]]?.type ?? "intro"];
    const base = new Color().copy(palette.base).lerp(palette.stripe, 0.28);
    const top = new Color().copy(palette.stripe).lerp(new Color("#ffffff"), 0.22);
    colors[vi*3]=base.r; colors[vi*3+1]=base.g; colors[vi*3+2]=base.b;
    colors[(vi+1)*3]=top.r; colors[(vi+1)*3+1]=top.g; colors[(vi+1)*3+2]=top.b;

    if (i < count - 1) {
      if (side === 1) { indices.push(vi,vi+1,vi+2); indices.push(vi+1,vi+3,vi+2); }
      else { indices.push(vi,vi+2,vi+1); indices.push(vi+1,vi+2,vi+3); }
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("normal", new BufferAttribute(normals, 3));
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  geo.setIndex(indices);

  return new Mesh(geo, new MeshStandardMaterial({
    vertexColors: true,
    emissive: "#77e9ff",
    emissiveIntensity: 1.6,
    metalness: 0.08,
    roughness: 0.16,
    transparent: true,
    opacity: WALL_HOLO_OPACITY,
    side: DoubleSide,
  }));
}

function buildSectionWallRailMesh(
  frames: FrameTable,
  halfWidths: readonly number[] | number,
  side: -1 | 1,
  sections: { type: SongSectionType }[],
  sampleSection: Uint8Array,
  heightFraction: number,
  thickness: number,
): Mesh {
  const count = frames.samples.length;
  const positions = new Float32Array(count * 2 * 3);
  const normals = new Float32Array(count * 2 * 3);
  const colors = new Float32Array(count * 2 * 3);
  const indices: number[] = [];

  for (let i = 0; i < count; i++) {
    const c = frames.samples[i];
    const r = frames.rights[i];
    const u = frames.ups[i];
    const vi = i * 2;
    const halfWidth = sampleHalfWidth(halfWidths, i);

    const ex = c.x + r.x * halfWidth * side;
    const ey = c.y + r.y * halfWidth * side;
    const ez = c.z + r.z * halfWidth * side;
    const offsetA = WALL_HEIGHT * heightFraction;
    const offsetB = WALL_HEIGHT * Math.min(1, heightFraction + thickness);

    positions[vi*3] = ex + u.x * offsetA;           positions[vi*3+1] = ey + u.y * offsetA;           positions[vi*3+2] = ez + u.z * offsetA;
    positions[(vi+1)*3] = ex+u.x*offsetB; positions[(vi+1)*3+1] = ey+u.y*offsetB; positions[(vi+1)*3+2] = ez+u.z*offsetB;

    const nx = -r.x * side, ny = -r.y * side, nz = -r.z * side;
    normals[vi*3]=nx; normals[vi*3+1]=ny; normals[vi*3+2]=nz;
    normals[(vi+1)*3]=nx; normals[(vi+1)*3+1]=ny; normals[(vi+1)*3+2]=nz;

    const si = sampleSection[i];
    const sectionType = sections[si]?.type ?? "intro";
    const palette = sectionWallColors[sectionType];
    const col = Math.floor(i / 4) % 2 === 0 ? palette.stripe : new Color().copy(palette.stripe).lerp(new Color("#ffffff"), 0.28);
    colors[vi*3]=col.r; colors[vi*3+1]=col.g; colors[vi*3+2]=col.b;
    colors[(vi+1)*3]=col.r; colors[(vi+1)*3+1]=col.g; colors[(vi+1)*3+2]=col.b;

    if (i < count - 1) {
      if (side === 1) { indices.push(vi,vi+1,vi+2); indices.push(vi+1,vi+3,vi+2); }
      else { indices.push(vi,vi+2,vi+1); indices.push(vi+1,vi+2,vi+3); }
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("normal", new BufferAttribute(normals, 3));
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  geo.setIndex(indices);

  return new Mesh(geo, new MeshStandardMaterial({
    vertexColors: true,
    emissive: "#b0f1ff",
    emissiveIntensity: 2.1,
    metalness: 0.05,
    roughness: 0.12,
    transparent: true,
    opacity: 0.92,
    side: DoubleSide,
  }));
}

export function buildCenterLineMesh(frames: FrameTable): Mesh {
  const count = frames.samples.length;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let vertIdx = 0;

  for (let i = 0; i < count - 1; i++) {
    if (Math.floor(i / 3) % 2 === 1) continue;

    const c = frames.samples[i];
    const r = frames.rights[i];
    const u = frames.ups[i];
    const cN = frames.samples[i + 1];
    const rN = frames.rights[i + 1];
    const hw = CENTER_DASH_WIDTH / 2;
    const lift = 0.03;

    positions.push(
      c.x - r.x*hw + u.x*lift, c.y - r.y*hw + u.y*lift, c.z - r.z*hw + u.z*lift,
      c.x + r.x*hw + u.x*lift, c.y + r.y*hw + u.y*lift, c.z + r.z*hw + u.z*lift,
      cN.x - rN.x*hw + u.x*lift, cN.y - rN.y*hw + u.y*lift, cN.z - rN.z*hw + u.z*lift,
      cN.x + rN.x*hw + u.x*lift, cN.y + rN.y*hw + u.y*lift, cN.z + rN.z*hw + u.z*lift,
    );
    for (let j = 0; j < 4; j++) normals.push(u.x, u.y, u.z);
    indices.push(vertIdx, vertIdx+1, vertIdx+2);
    indices.push(vertIdx+1, vertIdx+3, vertIdx+2);
    vertIdx += 4;
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
  geo.setIndex(indices);

  return new Mesh(geo, new MeshStandardMaterial({
    color: "#b5faff",
    emissive: "#44dfff",
    emissiveIntensity: 1.7,
    metalness: 0.08,
    roughness: 0.22,
    transparent: true,
    opacity: 0.96,
    side: DoubleSide,
  }));
}

function buildSampleSectionMap(count: number, boundaries?: SectionBoundary[]): Uint8Array | undefined {
  if (!boundaries || boundaries.length === 0) return undefined;
  const sampleSection = new Uint8Array(count);
  let bi = 0;
  for (let i = 0; i < count; i++) {
    const u = i / Math.max(1, count - 1);
    while (bi < boundaries.length - 1 && boundaries[bi + 1].u <= u) bi++;
    sampleSection[i] = boundaries[bi]?.sectionIndex ?? 0;
  }
  return sampleSection;
}

function getRoadPalette(
  sections: { type: SongSectionType }[] | undefined,
  sampleSection: Uint8Array | undefined,
  index: number,
): { base: Color; glow: Color; edge: Color } {
  const sectionType = sections?.[sampleSection?.[index] ?? 0]?.type ?? "verse";
  return roadSectionColors[sectionType];
}
