import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  DoubleSide,
  MathUtils as TMath,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from "three";

import type { SongSectionType } from "../../../shared/song-schema";
import type { SectionBoundary } from "./track-generator";

const WORLD_UP = new Vector3(0, 1, 0);
const WALL_HEIGHT = 2.0;
const CENTER_DASH_WIDTH = 0.25;

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
): Mesh {
  const count = frames.samples.length;
  const positions = new Float32Array(count * 2 * 3);
  const normals = new Float32Array(count * 2 * 3);
  const indices: number[] = [];

  for (let i = 0; i < count; i++) {
    const c = frames.samples[i];
    const r = frames.rights[i];
    const n = frames.ups[i];
    const vi = i * 2;
    const halfWidth = sampleHalfWidth(halfWidths, i);

    positions[vi * 3]     = c.x - r.x * halfWidth;
    positions[vi * 3 + 1] = c.y - r.y * halfWidth;
    positions[vi * 3 + 2] = c.z - r.z * halfWidth;

    positions[(vi + 1) * 3]     = c.x + r.x * halfWidth;
    positions[(vi + 1) * 3 + 1] = c.y + r.y * halfWidth;
    positions[(vi + 1) * 3 + 2] = c.z + r.z * halfWidth;

    normals[vi * 3] = n.x;     normals[vi * 3 + 1] = n.y;     normals[vi * 3 + 2] = n.z;
    normals[(vi+1)*3] = n.x;   normals[(vi+1)*3+1] = n.y;     normals[(vi+1)*3+2] = n.z;

    if (i < count - 1) {
      indices.push(vi, vi+1, vi+2);
      indices.push(vi+1, vi+3, vi+2);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("normal", new BufferAttribute(normals, 3));
  geo.setIndex(indices);

  return new Mesh(geo, new MeshStandardMaterial({
    color: "#151922", emissive: "#111520",
    metalness: 0.1, roughness: 0.9, side: DoubleSide,
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
    vertexColors: true, emissive: "#3a1328",
    metalness: 0.2, roughness: 0.7, side: DoubleSide,
  }));
}

/** Section-aware wall mesh with colors that change per song section. */
export function buildSectionWallMesh(
  frames: FrameTable,
  halfWidths: readonly number[] | number,
  side: -1 | 1,
  sections: { type: SongSectionType }[],
  boundaries: SectionBoundary[],
): Mesh {
  const count = frames.samples.length;
  const positions = new Float32Array(count * 2 * 3);
  const normals = new Float32Array(count * 2 * 3);
  const colors = new Float32Array(count * 2 * 3);
  const indices: number[] = [];

  // Precompute: for each sample, which section index?
  const sampleSection = new Uint8Array(count);
  let bi = 0;
  for (let i = 0; i < count; i++) {
    const u = i / (count - 1);
    while (bi < boundaries.length - 1 && boundaries[bi + 1].u <= u) bi++;
    sampleSection[i] = boundaries[bi].sectionIndex;
  }

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

    const si = sampleSection[i];
    const sectionType = sections[si]?.type ?? "intro";
    const palette = sectionWallColors[sectionType];
    const col = Math.floor(i / 8) % 2 === 0 ? palette.stripe : palette.base;
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
    vertexColors: true, emissive: "#3a1328",
    metalness: 0.2, roughness: 0.7, side: DoubleSide,
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
    color: "#40f2ff", emissive: "#1aa9b3",
    metalness: 0.1, roughness: 0.6, side: DoubleSide,
  }));
}
