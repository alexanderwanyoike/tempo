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

const WORLD_UP = new Vector3(0, 1, 0);
const TRACK_WIDTH = 30;
const HALF_WIDTH = TRACK_WIDTH / 2;
const WALL_HEIGHT = 2.0;
const SAMPLE_COUNT = 800;
const CENTER_DASH_WIDTH = 0.25;

export interface TrackFrame {
  tangent: Vector3;
  right: Vector3;
  up: Vector3;
}

export interface TrackQuery {
  center: Vector3;
  tangent: Vector3;
  right: Vector3;
  up: Vector3;
  lateralOffset: number;
  u: number;
  hasWalls: boolean;
}

export interface TrackObject {
  id: string;
  kind: "boost" | "obstacle";
  u: number;
  lateralOffset: number;
  collisionHalfWidth: number;
  collisionLength: number;
}

export interface TrackFeature {
  id: string;
  kind: "loop" | "jump" | "barrelRoll";
  u: number;
  energy: number;
  sectionType: SongSectionType;
}

export interface Track {
  readonly meshGroup: Group;
  readonly totalLength: number;
  readonly halfWidth: number;
  readonly centerline: CatmullRomCurve3;
  getFrameAt(u: number): TrackFrame;
  getPointAt(u: number): Vector3;
  getStartPosition(): { position: Vector3; yaw: number };
  getRespawnAt(u: number): { position: Vector3; yaw: number };
  queryNearest(position: Vector3, hintU?: number): TrackQuery;
  getHalfWidthAt(u: number): number;
  getBoostAt(u: number): number;
  getTopSpeedAt(u: number): number;
  getTrackObjects(): readonly TrackObject[];
  getTrackFeatures(): readonly TrackFeature[];
}

/**
 * Generate loop: vertical circle in YZ plane.
 * Entry and exit pulled apart in X (left/right) so roads don't overlap.
 * "Cut the circle at the bottom, pull one side LEFT, one side RIGHT."
 */
function makeLoopPoints(centerX: number, bottomY: number, centerZ: number, radius: number, xSpread: number): Vector3[] {
  const pts: Vector3[] = [];
  const N = 24;
  const cy = bottomY + radius;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    // Full circle (350 deg to avoid exact overlap)
    const angle = (-Math.PI / 2) + t * (Math.PI * 2 * 0.97);
    const py = cy + radius * Math.sin(angle);
    const pz = centerZ + radius * Math.cos(angle);
    // X offset: entry pulled LEFT (-X), exit pulled RIGHT (+X)
    const px = centerX + (t - 0.5) * xSpread;
    pts.push(new Vector3(px, py, pz));
  }
  return pts;
}

export class TestTrack implements Track {
  readonly meshGroup: Group;
  readonly totalLength: number;
  readonly halfWidth = HALF_WIDTH;
  readonly centerline: CatmullRomCurve3;

  private readonly samples: Vector3[];
  private readonly tangents: Vector3[];
  private readonly rights: Vector3[];
  private readonly ups: Vector3[];
  private readonly trackFeatures: TrackFeature[];

  constructor() {
    const controlPoints = [
      // ---- START ZONE ----
      new Vector3(0, 0, 0),
      new Vector3(0, 0, -180),

      // ---- JUMP RAMP 1 ----
      new Vector3(0, 12, -280),
      new Vector3(0, 0, -360),

      // ---- Sweeping right descent ----
      new Vector3(60, -8, -460),
      new Vector3(160, -15, -500),

      // ---- Valley floor, approach from LEFT side ----
      new Vector3(220, -18, -460),
      new Vector3(230, -20, -380),
      new Vector3(235, -20, -320),  // approach at x=235 (left of loop center x=260)

      // ---- LOOP DE LOOP ----
      // Circle radius 60, center at x=260. xSpread=60 pulls entry to x=230, exit to x=290
      // Entry on LEFT, exit on RIGHT. 60m apart - no overlap.
      ...makeLoopPoints(260, -20, -280, 60, 60),

      // ---- Exit loop - follow the tangent direction (right, slightly down, toward +Z) ----
      new Vector3(310, -22, -270),
      new Vector3(340, -18, -250),
      new Vector3(365, -5, -225),

      // ---- JUMP RAMP 2 - hilltop ----
      new Vector3(360, 35, -130),
      new Vector3(340, 20, -80),

      // ---- Sweeping left descent ----
      new Vector3(300, 5, -40),
      new Vector3(240, -8, -10),
      new Vector3(170, -15, -20),

      // ---- S-curve (kept away from start corridor at x~0, z=0 to -180) ----
      new Vector3(110, -10, -60),
      new Vector3(80, -8, -120),
      new Vector3(120, -8, -180),

      // ---- Climb with JUMP RAMP 3 ----
      new Vector3(150, 8, -240),
      new Vector3(140, 25, -300),
      new Vector3(120, 10, -350),

      // ---- Final sweeping left ----
      new Vector3(80, 12, -400),
      new Vector3(40, 10, -420),

      // ---- Finish straight ----
      new Vector3(-20, 5, -400),
      new Vector3(-60, 3, -360),
    ];

    this.centerline = new CatmullRomCurve3(controlPoints, false, "centripetal", 0.3);
    this.totalLength = this.centerline.getLength();
    this.trackFeatures = [
      { id: "test-jump-1", kind: "jump", u: 0.11, energy: 0.78, sectionType: "build" },
      { id: "test-loop-1", kind: "loop", u: 0.34, energy: 0.95, sectionType: "drop" },
      { id: "test-jump-2", kind: "jump", u: 0.58, energy: 0.82, sectionType: "drop" },
      { id: "test-jump-3", kind: "jump", u: 0.81, energy: 0.88, sectionType: "finale" },
    ];

    // Sample points along the curve
    this.samples = this.centerline.getSpacedPoints(SAMPLE_COUNT);
    this.tangents = [];
    this.rights = [];
    this.ups = [];

    // Compute tangents
    for (let i = 0; i <= SAMPLE_COUNT; i++) {
      const u = i / SAMPLE_COUNT;
      this.tangents.push(
        this.centerline.getTangentAt(Math.min(u, 0.9999)).normalize(),
      );
    }

    // ---- PARALLEL TRANSPORT FRAMES ----
    // (not tangent x worldUp which fails on loops)
    // Initialize first frame from world up
    const r0 = new Vector3().crossVectors(this.tangents[0], WORLD_UP).normalize();
    const u0 = new Vector3().crossVectors(r0, this.tangents[0]).normalize();
    this.rights.push(r0);
    this.ups.push(u0);

    const rotMat = new Matrix4();
    for (let i = 1; i <= SAMPLE_COUNT; i++) {
      const prevR = this.rights[i - 1].clone();
      const prevU = this.ups[i - 1].clone();

      // Minimal rotation from previous tangent to current
      const axis = new Vector3().crossVectors(this.tangents[i - 1], this.tangents[i]);
      if (axis.length() > 1e-8) {
        axis.normalize();
        const angle = Math.acos(TMath.clamp(this.tangents[i - 1].dot(this.tangents[i]), -1, 1));
        rotMat.makeRotationAxis(axis, angle);
        prevR.applyMatrix4(rotMat);
        prevU.applyMatrix4(rotMat);
      }

      this.rights.push(prevR.normalize());
      this.ups.push(prevU.normalize());
    }

    // Build meshes
    this.meshGroup = new Group();
    this.meshGroup.add(this.buildRoad());
    this.meshGroup.add(this.buildWall(-1));
    this.meshGroup.add(this.buildWall(1));
    this.meshGroup.add(this.buildCenterLine());
  }

  getFrameAt(u: number): TrackFrame {
    const t = TMath.clamp(u, 0, 0.9999) * SAMPLE_COUNT;
    const i = Math.floor(t);
    const frac = t - i;
    const j = Math.min(i + 1, SAMPLE_COUNT);
    return {
      tangent: this.tangents[i].clone().lerp(this.tangents[j], frac).normalize(),
      right: this.rights[i].clone().lerp(this.rights[j], frac).normalize(),
      up: this.ups[i].clone().lerp(this.ups[j], frac).normalize(),
    };
  }

  getPointAt(u: number): Vector3 {
    return this.centerline.getPointAt(TMath.clamp(u, 0, 0.9999));
  }

  getStartPosition(): { position: Vector3; yaw: number } {
    const pos = this.samples[0].clone();
    pos.y += 0.45;
    const t = this.tangents[0];
    const yaw = Math.atan2(-t.x, -t.z);
    return { position: pos, yaw };
  }

  getRespawnAt(u: number): { position: Vector3; yaw: number } {
    const clampedU = Math.max(0, Math.min(u, 1));
    const pos = this.centerline.getPointAt(clampedU);
    pos.y += 0.45;
    const t = this.centerline.getTangentAt(Math.min(clampedU, 0.9999)).normalize();
    const yaw = Math.atan2(-t.x, -t.z);
    return { position: pos, yaw };
  }

  queryNearest(position: Vector3, hintU?: number): TrackQuery {
    let bestDist = Infinity;
    let bestIdx = 0;

    if (hintU !== undefined) {
      const hintIdx = Math.round(hintU * SAMPLE_COUNT);
      const searchRadius = 50;
      const start = Math.max(0, hintIdx - searchRadius);
      const end = Math.min(this.samples.length - 1, hintIdx + searchRadius);
      for (let i = start; i <= end; i++) {
        const s = this.samples[i];
        const dx = position.x - s.x;
        const dz = position.z - s.z;
        const d = dx * dx + dz * dz;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
    } else {
      for (let i = 0; i < this.samples.length; i++) {
        const s = this.samples[i];
        const dx = position.x - s.x;
        const dz = position.z - s.z;
        const d = dx * dx + dz * dz;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
    }

    const prevIdx = Math.max(0, bestIdx - 1);
    const nextIdx = Math.min(this.samples.length - 1, bestIdx + 1);
    const distPrev = this.xzDistSq(position, this.samples[prevIdx]);
    const distNext = this.xzDistSq(position, this.samples[nextIdx]);
    const neighborIdx = distPrev < distNext ? prevIdx : nextIdx;
    let uLow = Math.min(bestIdx, neighborIdx) / SAMPLE_COUNT;
    let uHigh = Math.max(bestIdx, neighborIdx) / SAMPLE_COUNT;

    for (let step = 0; step < 4; step++) {
      const uMid = (uLow + uHigh) / 2;
      const pLow = this.centerline.getPointAt(Math.min(uLow, 0.9999));
      const pHigh = this.centerline.getPointAt(Math.min(uHigh, 0.9999));
      if (this.xzDistSq(position, pLow) < this.xzDistSq(position, pHigh)) {
        uHigh = uMid;
      } else {
        uLow = uMid;
      }
    }

    const uFinal = Math.min((uLow + uHigh) / 2, 0.9999);
    const center = this.centerline.getPointAt(uFinal);
    const frame = this.getFrameAt(uFinal);
    const toPos = position.clone().sub(center);
    const lateralOffset = toPos.dot(frame.right);

    return {
      center,
      tangent: frame.tangent,
      right: frame.right,
      up: frame.up,
      lateralOffset,
      u: uFinal,
      hasWalls: true,
    };
  }

  getHalfWidthAt(_u: number): number {
    return HALF_WIDTH;
  }

  getBoostAt(_u: number): number {
    return 1.0;
  }

  getTopSpeedAt(_u: number): number {
    return 90;
  }

  getTrackObjects(): readonly TrackObject[] {
    return [];
  }

  getTrackFeatures(): readonly TrackFeature[] {
    return this.trackFeatures;
  }

  private xzDistSq(a: Vector3, b: Vector3): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return dx * dx + dz * dz;
  }

  // ---- MESH GENERATION (full 3D offsets for loops) ----

  private buildRoad(): Mesh {
    const count = this.samples.length;
    const positions = new Float32Array(count * 2 * 3);
    const normals = new Float32Array(count * 2 * 3);
    const indices: number[] = [];

    for (let i = 0; i < count; i++) {
      const c = this.samples[i];
      const r = this.rights[i];
      const n = this.ups[i];
      const vi = i * 2;

      // FULL 3D: offset by right vector including Y component
      positions[vi * 3]     = c.x - r.x * HALF_WIDTH;
      positions[vi * 3 + 1] = c.y - r.y * HALF_WIDTH;
      positions[vi * 3 + 2] = c.z - r.z * HALF_WIDTH;

      positions[(vi + 1) * 3]     = c.x + r.x * HALF_WIDTH;
      positions[(vi + 1) * 3 + 1] = c.y + r.y * HALF_WIDTH;
      positions[(vi + 1) * 3 + 2] = c.z + r.z * HALF_WIDTH;

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

  private buildWall(side: -1 | 1): Mesh {
    const count = this.samples.length;
    const positions = new Float32Array(count * 2 * 3);
    const normals = new Float32Array(count * 2 * 3);
    const colors = new Float32Array(count * 2 * 3);
    const indices: number[] = [];
    const colBase = new Color("#4e233a");
    const colStripe = new Color("#ff2a6d");

    for (let i = 0; i < count; i++) {
      const c = this.samples[i];
      const r = this.rights[i];
      const u = this.ups[i];
      const vi = i * 2;

      // Edge position: full 3D
      const ex = c.x + r.x * HALF_WIDTH * side;
      const ey = c.y + r.y * HALF_WIDTH * side;
      const ez = c.z + r.z * HALF_WIDTH * side;

      // Bottom at edge, top offset along track up
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

  private buildCenterLine(): Mesh {
    const count = this.samples.length;
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    let vertIdx = 0;

    for (let i = 0; i < count - 1; i++) {
      if (Math.floor(i / 3) % 2 === 1) continue;

      const c = this.samples[i];
      const r = this.rights[i];
      const u = this.ups[i];
      const cN = this.samples[i + 1];
      const rN = this.rights[i + 1];
      const hw = CENTER_DASH_WIDTH / 2;
      const lift = 0.03;

      // Full 3D offsets
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
}
