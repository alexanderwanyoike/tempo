import {
  BoxGeometry,
  CatmullRomCurve3,
  Group,
  MathUtils as TMath,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from "three";
import type { SongDefinition, SongSection, SongSectionType } from "../../../shared/song-schema.js";
import type { ChunkType } from "./chunks.js";
import { chunkFns, type ChunkParams } from "./chunks.js";
import { mulberry32 } from "./prng.js";
import { TrackPresentationController, type RhythmicState } from "./track-presentation.js";
import { pickChunkForSection, scaleChunkParams } from "./section-rules.js";
import type { Track, TrackFeature, TrackFrame, TrackObject, TrackQuery } from "./track-builder.js";
import {
  buildCenterLineMesh,
  buildRoadMesh,
  buildSectionWallMesh,
  computeParallelTransportFrames,
  type FrameTable,
} from "./track-mesh.js";

/** Average race speed for track length calculation (m/s).
 *  This controls track LENGTH. Higher = longer track.
 *  Firestarter calibration target is a manual full-throttle run with corrections. */
const BASE_SPEED = 91;

/** Base top speed of the vehicle (m/s). */
const BASE_TOP_SPEED = 90;

/** Default chunk length range (meters). */
const MIN_CHUNK_LENGTH = 70;
const MAX_CHUNK_LENGTH = 150;
const MIN_LOOP_CHUNK_LENGTH = 220;
const MIN_BARREL_ROLL_CHUNK_LENGTH = 180;

const HALF_WIDTH = 11;
const GATE_LANE_FRACTIONS = [-0.62, 0, 0.62] as const;
const BOOST_COLLISION_HALF_WIDTH = 1.7;
const BOOST_COLLISION_LENGTH = 7.5;
const OBSTACLE_COLLISION_HALF_WIDTH = 1.8;
const OBSTACLE_COLLISION_LENGTH = 4.0;

export interface SectionBoundary {
  u: number;
  sectionIndex: number;
}

export class TrackGenerator implements Track {
  readonly meshGroup: Group;
  readonly totalLength: number;
  readonly halfWidth = HALF_WIDTH;
  readonly centerline: CatmullRomCurve3;
  readonly sectionBoundaries: SectionBoundary[] = [];

  private readonly frames: FrameTable;
  private readonly halfWidthSamples: number[];
  private readonly trackObjects: TrackObject[];
  private readonly trackFeatures: TrackFeature[];
  private readonly sampleCount: number;
  private readonly presentation: TrackPresentationController;

  constructor(
    readonly song: SongDefinition,
    seed: number,
    private readonly chunkPicker: ChunkPicker = defaultChunkPicker,
  ) {
    const targetLength = song.duration * BASE_SPEED;
    const generation = this.generateControlPoints(seed, targetLength);

    this.centerline = new CatmullRomCurve3(generation.points, false, "centripetal", 0.3);
    this.totalLength = this.centerline.getLength();

    // Scale samples with track length: ~1 sample per 2m
    this.sampleCount = Math.max(800, Math.ceil(this.totalLength / 2));
    this.frames = computeParallelTransportFrames(this.centerline, this.sampleCount);
    this.halfWidthSamples = this.frames.samples.map((_: Vector3, i: number) => this.getHalfWidthAt(i / this.sampleCount));
    this.trackFeatures = generation.features;
    this.trackObjects = this.generateTrackObjects(seed);

    // Build meshes (section-aware walls)
    const road = buildRoadMesh(this.frames, this.halfWidthSamples, song.sections, this.sectionBoundaries);
    const leftWall = buildSectionWallMesh(this.frames, this.halfWidthSamples, -1, song.sections, this.sectionBoundaries);
    const rightWall = buildSectionWallMesh(this.frames, this.halfWidthSamples, 1, song.sections, this.sectionBoundaries);
    const centerLine = buildCenterLineMesh(this.frames);

    this.meshGroup = new Group();
    this.meshGroup.add(road);
    this.meshGroup.add(leftWall);
    this.meshGroup.add(rightWall);
    this.meshGroup.add(centerLine);
    this.meshGroup.add(this.buildTrackObjectMeshes());
    this.presentation = new TrackPresentationController(road, [leftWall, rightWall], centerLine);
  }

  private generateControlPoints(seed: number, targetLength: number): { points: Vector3[]; features: TrackFeature[] } {
    const allPoints: Vector3[] = [];
    const features: TrackFeature[] = [];
    let currentPos = new Vector3(0, 0, 0);
    let currentTangent = new Vector3(0, 0, -1);
    let usedLength = 0;

    for (let si = 0; si < this.song.sections.length; si++) {
      const section = this.song.sections[si];
      const sectionFraction = (section.endTime - section.startTime) / this.song.duration;
      const sectionLength = sectionFraction * targetLength;

      // Track where this section starts in U space
      this.sectionBoundaries.push({
        u: usedLength / targetLength,
        sectionIndex: si,
      });

      // Seed per-section for determinism
      const rng = mulberry32(seed ^ (si * 7919));
      let sectionUsed = 0;
      const recentChunks: ChunkType[] = [];

      while (sectionUsed < sectionLength) {
        const remaining = sectionLength - sectionUsed;
        let chunkLen = Math.min(
          MIN_CHUNK_LENGTH + rng() * (MAX_CHUNK_LENGTH - MIN_CHUNK_LENGTH),
          remaining,
        );

        // Skip tiny leftover chunks
        if (chunkLen < MIN_CHUNK_LENGTH * 0.5 && sectionUsed > 0) break;

        let chunkType = this.chunkPicker(section, rng, recentChunks);
        if (chunkType === "loop" && remaining < MIN_LOOP_CHUNK_LENGTH) {
          chunkType = this.chunkPicker(section, rng, [...recentChunks, "loop"]);
        }
        if (chunkType === "barrelRoll" && remaining < MIN_BARREL_ROLL_CHUNK_LENGTH) {
          chunkType = this.chunkPicker(section, rng, [...recentChunks, "barrelRoll"]);
        }
        if (chunkType === "loop") {
          chunkLen = Math.max(chunkLen, MIN_LOOP_CHUNK_LENGTH);
          chunkLen = Math.min(chunkLen, remaining);
        } else if (chunkType === "barrelRoll") {
          chunkLen = Math.max(chunkLen, MIN_BARREL_ROLL_CHUNK_LENGTH);
          chunkLen = Math.min(chunkLen, remaining);
        }
        const params: ChunkParams = scaleChunkParams(section);

        const chunkFn = chunkFns[chunkType];
        const result = chunkFn(currentPos, currentTangent, chunkLen, rng, params);
        const featureU = TMath.clamp((usedLength + chunkLen * 0.5) / targetLength, 0.001, 0.995);
        this.captureTrackFeatures(features, result.tags, featureU, section, si, sectionUsed);

        // Add points (skip first if we already have points to avoid duplicates)
        const startIdx = allPoints.length > 0 ? 1 : 0;
        for (let i = startIdx; i < result.points.length; i++) {
          allPoints.push(result.points[i]);
        }

        currentPos = result.exitPos;
        currentTangent = result.exitTangent;

        // Z-monotonicity guardrail: if tangent drifted too far from -Z, correct
        if (currentTangent.z > -0.5) {
          const correctionLength = MIN_CHUNK_LENGTH;
          const correctedTangent = new Vector3(
            currentTangent.x * 0.3,
            0,
            -Math.abs(currentTangent.z) - 0.7,
          ).normalize();
          const correctionEnd = currentPos.clone().addScaledVector(correctedTangent, correctionLength);
          allPoints.push(correctionEnd);
          currentPos = correctionEnd;
          currentTangent = correctedTangent;
          sectionUsed += correctionLength;
          usedLength += correctionLength;
        }

        sectionUsed += chunkLen;
        usedLength += chunkLen;
        recentChunks.push(chunkType);
        if (recentChunks.length > 5) recentChunks.shift();
      }
    }

    // Ensure we have at least 4 control points for CatmullRom
    if (allPoints.length < 4) {
      while (allPoints.length < 4) {
        const last = allPoints[allPoints.length - 1];
        allPoints.push(last.clone().addScaledVector(currentTangent, 50));
      }
    }

    return { points: allPoints, features };
  }

  // ---- Track interface ----

  getFrameAt(u: number): TrackFrame {
    const t = TMath.clamp(u, 0, 0.9999) * this.sampleCount;
    const i = Math.floor(t);
    const frac = t - i;
    const j = Math.min(i + 1, this.sampleCount);
    return {
      tangent: this.frames.tangents[i].clone().lerp(this.frames.tangents[j], frac).normalize(),
      right: this.frames.rights[i].clone().lerp(this.frames.rights[j], frac).normalize(),
      up: this.frames.ups[i].clone().lerp(this.frames.ups[j], frac).normalize(),
    };
  }

  getPointAt(u: number): Vector3 {
    return this.centerline.getPointAt(TMath.clamp(u, 0, 0.9999));
  }

  getStartPosition(): { position: Vector3; yaw: number } {
    const pos = this.frames.samples[0].clone();
    pos.y += 0.45;
    const t = this.frames.tangents[0];
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

  getHalfWidthAt(u: number): number {
    const baseWidthAt = (sectionIndex: number): number => {
      const section = this.song.sections[sectionIndex];
      if (!section) return HALF_WIDTH;
      switch (section.type) {
        case "intro":
          return TMath.lerp(HALF_WIDTH, 10.25, section.energy * 0.35);
        case "verse":
          return TMath.lerp(9.5, 8.5, section.energy);
        case "build":
          return TMath.lerp(8.75, 7.75, section.energy);
        case "drop":
          return TMath.lerp(8.25, 7.25, section.energy);
        case "bridge":
          return TMath.lerp(10, 9, section.energy * 0.6);
        case "breakdown":
          return TMath.lerp(10.25, 9.25, section.energy * 0.4);
        case "finale":
          return TMath.lerp(8.5, 7.25, section.energy);
        default:
          return HALF_WIDTH;
      }
    };

    let sectionIndex = 0;
    for (let i = this.sectionBoundaries.length - 1; i >= 0; i--) {
      if (u >= this.sectionBoundaries[i].u) {
        sectionIndex = this.sectionBoundaries[i].sectionIndex;
        break;
      }
    }

    let width = baseWidthAt(sectionIndex);
    const transitionWindow = 0.012;
    let prevBoundary: SectionBoundary | undefined;
    for (let i = this.sectionBoundaries.length - 1; i >= 0; i--) {
      const boundary = this.sectionBoundaries[i];
      if (boundary.u < u) {
        prevBoundary = boundary;
        break;
      }
    }
    if (prevBoundary && u - prevBoundary.u < transitionWindow) {
      const blend = TMath.smoothstep((u - prevBoundary.u) / transitionWindow, 0, 1);
      width = TMath.lerp(baseWidthAt(prevBoundary.sectionIndex), width, blend);
    }

    const nextBoundary = this.sectionBoundaries.find((boundary) => boundary.u > u);
    if (nextBoundary && nextBoundary.u - u < transitionWindow) {
      const blend = TMath.smoothstep((nextBoundary.u - u) / transitionWindow, 0, 1);
      width = TMath.lerp(baseWidthAt(nextBoundary.sectionIndex), width, blend);
    }

    return width;
  }

  getBoostAt(u: number): number {
    // Boost zones at drop markers: sustained thrust increase right after major song drops.
    const time = this.uToSongTime(u);
    for (const marker of this.song.dropMarkers) {
      if (time >= marker && time < marker + 1.8) return 1.7;
    }
    return 1.0;
  }

  getTopSpeedAt(u: number): number {
    const section = this.getSectionAt(u);
    if (!section) return BASE_TOP_SPEED;
    switch (section.type) {
      case "intro":
        return TMath.lerp(72, 84, section.energy);
      case "verse":
        return TMath.lerp(80, 96, section.energy);
      case "build":
        return TMath.lerp(88, 108, section.energy);
      case "drop":
        return TMath.lerp(104, 132, section.energy);
      case "bridge":
        return TMath.lerp(76, 90, section.energy);
      case "breakdown":
        return TMath.lerp(74, 86, section.energy);
      case "finale":
        return TMath.lerp(106, 136, section.energy);
      default:
        return BASE_TOP_SPEED;
    }
  }

  getTrackObjects(): readonly TrackObject[] {
    return this.trackObjects;
  }

  getTrackFeatures(): readonly TrackFeature[] {
    return this.trackFeatures;
  }

  setLoadingBlend(blend: number, pulse = 0): void {
    this.presentation.setLoadingBlend(blend, pulse);
  }

  setRhythmicPulse(state: RhythmicState): void {
    this.presentation.setRhythmicPulse(state);
  }

  private getSectionAt(u: number): SongSection | null {
    let si = 0;
    for (let i = this.sectionBoundaries.length - 1; i >= 0; i--) {
      if (u >= this.sectionBoundaries[i].u) {
        si = this.sectionBoundaries[i].sectionIndex;
        break;
      }
    }
    return this.song.sections[si] ?? null;
  }

  queryNearest(position: Vector3, hintU?: number): TrackQuery {
    let bestDist = Infinity;
    let bestIdx = 0;

    if (hintU !== undefined) {
      const hintIdx = Math.round(hintU * this.sampleCount);
      const searchRadius = 50;
      const start = Math.max(0, hintIdx - searchRadius);
      const end = Math.min(this.frames.samples.length - 1, hintIdx + searchRadius);
      for (let i = start; i <= end; i++) {
        const s = this.frames.samples[i];
        const dx = position.x - s.x;
        const dz = position.z - s.z;
        const d = dx * dx + dz * dz;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
    } else {
      for (let i = 0; i < this.frames.samples.length; i++) {
        const s = this.frames.samples[i];
        const dx = position.x - s.x;
        const dz = position.z - s.z;
        const d = dx * dx + dz * dz;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
    }

    const prevIdx = Math.max(0, bestIdx - 1);
    const nextIdx = Math.min(this.frames.samples.length - 1, bestIdx + 1);
    const distPrev = this.xzDistSq(position, this.frames.samples[prevIdx]);
    const distNext = this.xzDistSq(position, this.frames.samples[nextIdx]);
    const neighborIdx = distPrev < distNext ? prevIdx : nextIdx;
    let uLow = Math.min(bestIdx, neighborIdx) / this.sampleCount;
    let uHigh = Math.max(bestIdx, neighborIdx) / this.sampleCount;

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

  // ---- Time mapping ----

  songTimeToU(time: number): number {
    return TMath.clamp(time / this.song.duration, 0, 0.999);
  }

  uToSongTime(u: number): number {
    return u * this.song.duration;
  }

  private generateTrackObjects(seed: number): TrackObject[] {
    const objects: TrackObject[] = [];
    let lastGateU = -1;

    for (let si = 0; si < this.song.sections.length; si++) {
      const section = this.song.sections[si];
      const rng = mulberry32(seed ^ (si * 15485863) ^ 0x6d2b79f5);
      const sectionStartTime = Math.max(section.startTime + 2.5, 5);
      const sectionEndTime = section.endTime - 2.2;
      if (sectionEndTime <= sectionStartTime) continue;

      const spacingSeconds = TMath.lerp(7.2, 4.2, section.energy);
      let gateTime = sectionStartTime + rng() * Math.min(2.4, spacingSeconds * 0.5);

      while (gateTime < sectionEndTime) {
        const gateU = this.songTimeToU(gateTime);
        if (gateU - lastGateU < 0.018) {
          gateTime += 1.8;
          continue;
        }

        const halfWidth = this.getHalfWidthAt(gateU);
        const safeLane = rng() > 0.5 ? 2 : 0;

        for (let laneIndex = 0; laneIndex < GATE_LANE_FRACTIONS.length; laneIndex++) {
          const laneFraction = GATE_LANE_FRACTIONS[laneIndex];
          const lateralOffset = halfWidth * laneFraction;
          if (laneIndex === safeLane) {
            objects.push({
              id: `boost-${si}-${gateTime.toFixed(2)}-${laneIndex}`,
              kind: "boost",
              u: gateU,
              lateralOffset,
              collisionHalfWidth: Math.min(BOOST_COLLISION_HALF_WIDTH, halfWidth * 0.24),
              collisionLength: BOOST_COLLISION_LENGTH,
            });
          } else {
            objects.push({
              id: `obstacle-${si}-${gateTime.toFixed(2)}-${laneIndex}`,
              kind: "obstacle",
              u: gateU,
              lateralOffset,
              collisionHalfWidth: Math.min(OBSTACLE_COLLISION_HALF_WIDTH, halfWidth * 0.26),
              collisionLength: OBSTACLE_COLLISION_LENGTH,
            });
          }
        }

        if (section.type === "drop" || section.type === "finale" || section.type === "build") {
          const followU = Math.min(0.995, gateU + 18 / this.totalLength);
          objects.push({
            id: `boost-follow-${si}-${gateTime.toFixed(2)}`,
            kind: "boost",
            u: followU,
            lateralOffset: halfWidth * GATE_LANE_FRACTIONS[safeLane],
            collisionHalfWidth: Math.min(BOOST_COLLISION_HALF_WIDTH, halfWidth * 0.24),
            collisionLength: BOOST_COLLISION_LENGTH,
          });
        }

        lastGateU = gateU;
        gateTime += spacingSeconds * (0.8 + rng() * 0.45);
      }
    }

    return objects;
  }

  private buildTrackObjectMeshes(): Group {
    const group = new Group();
    const orient = new Matrix4();
    const boostGeo = new BoxGeometry(3.2, 0.18, 7.5);
    const boostMat = new MeshStandardMaterial({
      color: "#8bff56",
      emissive: "#5dff1a",
      emissiveIntensity: 1.8,
      metalness: 0.2,
      roughness: 0.35,
    });
    const obstacleGeo = new BoxGeometry(3.6, 2.6, 3.2);
    const obstacleMat = new MeshStandardMaterial({
      color: "#ff6b2c",
      emissive: "#6f1900",
      emissiveIntensity: 1.0,
      metalness: 0.25,
      roughness: 0.45,
    });

    for (const object of this.trackObjects) {
      const frame = this.getFrameAt(object.u);
      const center = this.getPointAt(object.u);
      const mesh = new Mesh(
        object.kind === "boost" ? boostGeo : obstacleGeo,
        object.kind === "boost" ? boostMat : obstacleMat,
      );
      const lift = object.kind === "boost" ? 0.14 : 1.35;
      mesh.position.copy(center);
      mesh.position.addScaledVector(frame.right, object.lateralOffset);
      mesh.position.addScaledVector(frame.up, lift);
      orient.makeBasis(frame.right, frame.up, frame.tangent.clone().negate());
      mesh.setRotationFromMatrix(orient);
      group.add(mesh);
    }

    return group;
  }

  private xzDistSq(a: Vector3, b: Vector3): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return dx * dx + dz * dz;
  }

  private captureTrackFeatures(
    features: TrackFeature[],
    tags: string[],
    u: number,
    section: SongSection,
    sectionIndex: number,
    sectionUsed: number,
  ): void {
    const prefix = `feature-${sectionIndex}-${Math.round(sectionUsed)}`;
    if (tags.includes("hasLoop")) {
      features.push(this.makeTrackFeature(`${prefix}-loop`, "loop", u, section.energy, section.type));
    }
    if (tags.includes("hasJump")) {
      features.push(this.makeTrackFeature(`${prefix}-jump`, "jump", u, section.energy, section.type));
    }
    if (tags.includes("hasBarrelRoll")) {
      features.push(this.makeTrackFeature(`${prefix}-barrel`, "barrelRoll", u, section.energy, section.type));
    }
  }

  private makeTrackFeature(
    id: string,
    kind: TrackFeature["kind"],
    u: number,
    energy: number,
    sectionType: SongSectionType,
  ): TrackFeature {
    return { id, kind, u, energy, sectionType };
  }
}

export type ChunkPicker = (
  section: SongSection,
  rng: () => number,
  recentChunks: ChunkType[],
) => ChunkType;

function defaultChunkPicker(
  section: SongSection,
  rng: () => number,
  recentChunks: ChunkType[],
): ChunkType {
  return pickChunkForSection(section, rng, recentChunks);
}
