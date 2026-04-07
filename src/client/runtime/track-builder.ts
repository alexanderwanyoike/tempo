import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from "three";

const UP = new Vector3(0, 1, 0);
const TRACK_WIDTH = 30;
const HALF_WIDTH = TRACK_WIDTH / 2;
const WALL_HEIGHT = 2.0;
const SAMPLE_COUNT = 600;
const CENTER_DASH_WIDTH = 0.25;

export interface TrackQuery {
  center: Vector3;
  tangent: Vector3;
  right: Vector3;
  lateralOffset: number;
  u: number;
  hasWalls: boolean;
}

export class TestTrack {
  readonly meshGroup: Group;
  readonly totalLength: number;

  private readonly centerline: CatmullRomCurve3;
  private readonly samples: Vector3[];
  private readonly tangents: Vector3[];
  private readonly rights: Vector3[];
  private readonly ups: Vector3[];

  constructor() {
    // Long sprint track - roller coaster style with elevation changes
    // Starts at origin heading into -Z, no loop
    const controlPoints = [
      // Start zone - flat straight, build speed
      new Vector3(0, 0, 0),
      new Vector3(0, 0, -180),

      // JUMP RAMP 1 - launch off a steep rise
      new Vector3(0, 12, -280),
      new Vector3(0, 0, -360),

      // Sweeping right descent
      new Vector3(60, -8, -460),
      new Vector3(160, -15, -500),

      // Valley floor sharp left
      new Vector3(240, -18, -460),
      new Vector3(260, -15, -360),

      // Big climb - roller coaster hill
      new Vector3(300, 15, -280),
      new Vector3(320, 35, -200),

      // JUMP RAMP 2 - hilltop launch into the void
      new Vector3(310, 45, -140),
      new Vector3(280, 20, -80),

      // Stomach drop into hairpin
      new Vector3(240, -10, -20),
      new Vector3(160, -20, 10),
      new Vector3(80, -15, -20),

      // S-curve through valley
      new Vector3(30, -10, -100),
      new Vector3(-30, -8, -170),
      new Vector3(-80, -8, -110),

      // Climb with JUMP RAMP 3
      new Vector3(-110, 8, -30),
      new Vector3(-100, 25, 40),
      new Vector3(-80, 10, 90),

      // Final sweeping right at elevation
      new Vector3(-20, 15, 130),
      new Vector3(60, 18, 110),

      // Finish straight - downhill sprint
      new Vector3(100, 10, 50),
      new Vector3(100, 5, -40),
    ];

    this.centerline = new CatmullRomCurve3(controlPoints, false, "centripetal", 0.5);
    this.totalLength = this.centerline.getLength();

    this.samples = this.centerline.getSpacedPoints(SAMPLE_COUNT);
    this.tangents = [];
    this.rights = [];
    this.ups = [];

    for (let i = 0; i < this.samples.length; i++) {
      const u = i / SAMPLE_COUNT;
      const tangent = this.centerline.getTangentAt(Math.min(u, 0.9999)).normalize();
      // For a flat-ish track, right = tangent x UP, then up = right x tangent
      const right = new Vector3().crossVectors(tangent, UP).normalize();
      const up = new Vector3().crossVectors(right, tangent).normalize();
      this.tangents.push(tangent);
      this.rights.push(right);
      this.ups.push(up);
    }

    this.meshGroup = new Group();
    this.meshGroup.add(this.buildRoad());
    this.meshGroup.add(this.buildWall(-1));
    this.meshGroup.add(this.buildWall(1));
    this.meshGroup.add(this.buildCenterLine());
  }

  getStartPosition(): { position: Vector3; yaw: number } {
    const pos = this.samples[0].clone();
    pos.y += 0.45; // hover height above track surface
    const t = this.tangents[0];
    const yaw = Math.atan2(-t.x, -t.z);
    return { position: pos, yaw };
  }

  /** Get a respawn position at the given u parameter (or nearest safe point) */
  getRespawnAt(u: number): { position: Vector3; yaw: number } {
    const clampedU = Math.max(0, Math.min(u, 1));
    const pos = this.centerline.getPointAt(clampedU);
    pos.y += 0.45;
    const t = this.centerline.getTangentAt(Math.min(clampedU, 0.9999)).normalize();
    const yaw = Math.atan2(-t.x, -t.z);
    return { position: pos, yaw };
  }

  queryNearest(position: Vector3): TrackQuery {
    let bestDist = Infinity;
    let bestIdx = 0;

    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      const dx = position.x - s.x;
      const dy = position.y - s.y;
      const dz = position.z - s.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    // Refine between bestIdx and its closer neighbor
    const len = this.samples.length;
    const prevIdx = Math.max(0, bestIdx - 1);
    const nextIdx = Math.min(len - 1, bestIdx + 1);

    const distPrev = this.distSq(position, this.samples[prevIdx]);
    const distNext = this.distSq(position, this.samples[nextIdx]);

    const neighborIdx = distPrev < distNext ? prevIdx : nextIdx;
    let uLow = Math.min(bestIdx, neighborIdx) / SAMPLE_COUNT;
    let uHigh = Math.max(bestIdx, neighborIdx) / SAMPLE_COUNT;

    for (let step = 0; step < 4; step++) {
      const uMid = (uLow + uHigh) / 2;
      const pLow = this.centerline.getPointAt(Math.min(uLow, 0.9999));
      const pHigh = this.centerline.getPointAt(Math.min(uHigh, 0.9999));
      if (this.distSq(position, pLow) < this.distSq(position, pHigh)) {
        uHigh = uMid;
      } else {
        uLow = uMid;
      }
    }

    const uFinal = Math.min((uLow + uHigh) / 2, 0.9999);
    const center = this.centerline.getPointAt(uFinal);
    const tangent = this.centerline.getTangentAt(uFinal).normalize();
    const right = new Vector3().crossVectors(tangent, UP).normalize();

    const toPos = position.clone().sub(center);
    const lateralOffset = toPos.dot(right);

    // Determine if this section has walls (most do, but some gaps could be added later)
    const hasWalls = true;

    return { center, tangent, right, lateralOffset, u: uFinal, hasWalls };
  }

  private distSq(a: Vector3, b: Vector3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  }

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

      // Left vertex
      positions[vi * 3] = c.x - r.x * HALF_WIDTH;
      positions[vi * 3 + 1] = c.y;
      positions[vi * 3 + 2] = c.z - r.z * HALF_WIDTH;

      // Right vertex
      positions[(vi + 1) * 3] = c.x + r.x * HALF_WIDTH;
      positions[(vi + 1) * 3 + 1] = c.y;
      positions[(vi + 1) * 3 + 2] = c.z + r.z * HALF_WIDTH;

      // Normals point up from track surface
      normals[vi * 3] = n.x;
      normals[vi * 3 + 1] = n.y;
      normals[vi * 3 + 2] = n.z;
      normals[(vi + 1) * 3] = n.x;
      normals[(vi + 1) * 3 + 1] = n.y;
      normals[(vi + 1) * 3 + 2] = n.z;

      // Two triangles per quad, correct winding for upward-facing
      if (i < count - 1) {
        const a = vi;
        const b = vi + 1;
        const c2 = vi + 2;
        const d = vi + 3;
        indices.push(a, b, c2);
        indices.push(b, d, c2);
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(positions, 3));
    geo.setAttribute("normal", new BufferAttribute(normals, 3));
    geo.setIndex(indices);

    return new Mesh(
      geo,
      new MeshStandardMaterial({
        color: "#151922",
        emissive: "#111520",
        metalness: 0.1,
        roughness: 0.9,
        side: DoubleSide,
      }),
    );
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
      const vi = i * 2;
      const edgeX = c.x + r.x * HALF_WIDTH * side;
      const edgeZ = c.z + r.z * HALF_WIDTH * side;

      // Bottom vertex (at track surface)
      positions[vi * 3] = edgeX;
      positions[vi * 3 + 1] = c.y;
      positions[vi * 3 + 2] = edgeZ;

      // Top vertex
      positions[(vi + 1) * 3] = edgeX;
      positions[(vi + 1) * 3 + 1] = c.y + WALL_HEIGHT;
      positions[(vi + 1) * 3 + 2] = edgeZ;

      // Normal points inward (toward track center)
      const nx = -r.x * side;
      const nz = -r.z * side;
      normals[vi * 3] = nx;
      normals[vi * 3 + 1] = 0;
      normals[vi * 3 + 2] = nz;
      normals[(vi + 1) * 3] = nx;
      normals[(vi + 1) * 3 + 1] = 0;
      normals[(vi + 1) * 3 + 2] = nz;

      // Alternating edge stripes
      const stripe = Math.floor(i / 8) % 2 === 0;
      const col = stripe ? colStripe : colBase;
      colors[vi * 3] = col.r;
      colors[vi * 3 + 1] = col.g;
      colors[vi * 3 + 2] = col.b;
      colors[(vi + 1) * 3] = col.r;
      colors[(vi + 1) * 3 + 1] = col.g;
      colors[(vi + 1) * 3 + 2] = col.b;

      if (i < count - 1) {
        const a = vi;
        const b = vi + 1;
        const c2 = vi + 2;
        const d = vi + 3;
        // Winding depends on which side we're on
        if (side === 1) {
          indices.push(a, b, c2);
          indices.push(b, d, c2);
        } else {
          indices.push(a, c2, b);
          indices.push(b, c2, d);
        }
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(positions, 3));
    geo.setAttribute("normal", new BufferAttribute(normals, 3));
    geo.setAttribute("color", new BufferAttribute(colors, 3));
    geo.setIndex(indices);

    return new Mesh(
      geo,
      new MeshStandardMaterial({
        vertexColors: true,
        emissive: "#3a1328",
        metalness: 0.2,
        roughness: 0.7,
        side: DoubleSide,
      }),
    );
  }

  private buildCenterLine(): Mesh {
    const count = this.samples.length;
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    let vertIdx = 0;

    for (let i = 0; i < count - 1; i++) {
      // Dashed pattern
      if (Math.floor(i / 3) % 2 === 1) continue;

      const c = this.samples[i];
      const r = this.rights[i];
      const n = this.ups[i];
      const cNext = this.samples[i + 1];
      const rNext = this.rights[i + 1];

      const hw = CENTER_DASH_WIDTH / 2;
      const liftY = 0.03; // slightly above road

      positions.push(
        c.x - r.x * hw, c.y + liftY, c.z - r.z * hw,
        c.x + r.x * hw, c.y + liftY, c.z + r.z * hw,
        cNext.x - rNext.x * hw, cNext.y + liftY, cNext.z - rNext.z * hw,
        cNext.x + rNext.x * hw, cNext.y + liftY, cNext.z + rNext.z * hw,
      );

      for (let j = 0; j < 4; j++) {
        normals.push(n.x, n.y, n.z);
      }

      indices.push(vertIdx, vertIdx + 1, vertIdx + 2);
      indices.push(vertIdx + 1, vertIdx + 3, vertIdx + 2);
      vertIdx += 4;
    }

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
    geo.setIndex(indices);

    return new Mesh(
      geo,
      new MeshStandardMaterial({
        color: "#40f2ff",
        emissive: "#1aa9b3",
        metalness: 0.1,
        roughness: 0.6,
        side: DoubleSide,
      }),
    );
  }
}
