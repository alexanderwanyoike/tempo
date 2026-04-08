import {
  CatmullRomCurve3,
  Group,
  MathUtils as TMath,
  Vector3,
} from "three";
import type { SongDefinition } from "../../../shared/song-schema";
import type { ChunkType } from "./chunks";
import { chunkFns, type ChunkParams } from "./chunks";
import { mulberry32 } from "./prng";
import type { Track, TrackFrame, TrackQuery } from "./track-builder";
import {
  buildCenterLineMesh,
  buildRoadMesh,
  buildSectionWallMesh,
  computeParallelTransportFrames,
  type FrameTable,
} from "./track-mesh";

/** Average race speed for track length calculation (m/s). */
const BASE_SPEED = 55;

/** Default chunk length range (meters). */
const MIN_CHUNK_LENGTH = 80;
const MAX_CHUNK_LENGTH = 200;

const HALF_WIDTH = 15;

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
  private readonly sampleCount: number;

  constructor(
    readonly song: SongDefinition,
    seed: number,
    private readonly chunkPicker: ChunkPicker = defaultChunkPicker,
  ) {
    const targetLength = song.duration * BASE_SPEED;
    const allPoints = this.generateControlPoints(seed, targetLength);

    this.centerline = new CatmullRomCurve3(allPoints, false, "centripetal", 0.3);
    this.totalLength = this.centerline.getLength();

    // Scale samples with track length: ~1 sample per 2m
    this.sampleCount = Math.max(800, Math.ceil(this.totalLength / 2));
    this.frames = computeParallelTransportFrames(this.centerline, this.sampleCount);

    // Build meshes (section-aware walls)
    this.meshGroup = new Group();
    this.meshGroup.add(buildRoadMesh(this.frames, HALF_WIDTH));
    this.meshGroup.add(buildSectionWallMesh(this.frames, HALF_WIDTH, -1, song.sections, this.sectionBoundaries));
    this.meshGroup.add(buildSectionWallMesh(this.frames, HALF_WIDTH, 1, song.sections, this.sectionBoundaries));
    this.meshGroup.add(buildCenterLineMesh(this.frames));
  }

  private generateControlPoints(seed: number, targetLength: number): Vector3[] {
    const allPoints: Vector3[] = [];
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
        const chunkLen = Math.min(
          MIN_CHUNK_LENGTH + rng() * (MAX_CHUNK_LENGTH - MIN_CHUNK_LENGTH),
          remaining,
        );

        // Skip tiny leftover chunks
        if (chunkLen < MIN_CHUNK_LENGTH * 0.5 && sectionUsed > 0) break;

        const chunkType = this.chunkPicker(section, rng, recentChunks);
        const params: ChunkParams = {
          energy: section.energy,
          density: section.density,
          trackWidth: HALF_WIDTH * 2,
        };

        const chunkFn = chunkFns[chunkType];
        const result = chunkFn(currentPos, currentTangent, chunkLen, rng, params);

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
            currentTangent.y * 0.5,
            -Math.abs(currentTangent.z) - 0.7,
          ).normalize();
          const correctionEnd = currentPos.clone().addScaledVector(correctedTangent, correctionLength);
          allPoints.push(correctionEnd);
          currentPos = correctionEnd;
          currentTangent = correctedTangent;
          sectionUsed += correctionLength;
        }

        sectionUsed += chunkLen;
        usedLength += chunkLen;
        recentChunks.push(chunkType);
        if (recentChunks.length > 3) recentChunks.shift();
      }
    }

    // Ensure we have at least 4 control points for CatmullRom
    if (allPoints.length < 4) {
      while (allPoints.length < 4) {
        const last = allPoints[allPoints.length - 1];
        allPoints.push(last.clone().addScaledVector(currentTangent, 50));
      }
    }

    return allPoints;
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
    const section = this.getSectionAt(u);
    if (!section) return HALF_WIDTH;
    // Build: narrows. Drop: narrow then wide. Breakdown: full width.
    switch (section.type) {
      case "build":
        return TMath.lerp(HALF_WIDTH, 11, section.energy);
      case "drop":
        return TMath.lerp(11, HALF_WIDTH, Math.min(1, section.energy * 1.2));
      case "breakdown":
        return HALF_WIDTH;
      default:
        return TMath.lerp(HALF_WIDTH, 11, section.energy * 0.3);
    }
  }

  getBoostAt(u: number): number {
    // Boost zones at drop markers: 1.5x in a small window around each marker
    const time = this.uToSongTime(u);
    for (const marker of this.song.dropMarkers) {
      // Boost window: 1 second after drop marker
      if (time >= marker && time < marker + 1.0) return 1.5;
    }
    return 1.0;
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

  private xzDistSq(a: Vector3, b: Vector3): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return dx * dx + dz * dz;
  }
}

// ---- Chunk picker (default: simple alternation, replaced by P2-04 section-rules) ----

import type { SongSection } from "../../../shared/song-schema";
import { pickChunkForSection } from "./section-rules";

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
