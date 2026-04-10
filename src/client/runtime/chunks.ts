import { Vector3 } from "three";

// ---- Types ----

export type ChunkParams = {
  energy: number;   // 0-1
  density: number;  // 0-1
  trackWidth: number;
};

export type ChunkResult = {
  points: Vector3[];
  exitPos: Vector3;
  exitTangent: Vector3;
  tags: string[];
};

export type ChunkFn = (
  start: Vector3,
  tangent: Vector3,
  length: number,
  rng: () => number,
  params: ChunkParams,
) => ChunkResult;

export const chunkTypes = [
  "straight",
  "gentleCurve",
  "sharpTurn",
  "sCurve",
  "hill",
  "valley",
  "jumpRamp",
  "loop",
] as const;

export type ChunkType = (typeof chunkTypes)[number];

// ---- Helpers ----

/** Right vector from tangent (perpendicular in XZ plane). */
function rightFromTangent(tangent: Vector3): Vector3 {
  // Cross tangent with world up, giving a horizontal perpendicular
  const r = new Vector3().crossVectors(tangent, new Vector3(0, 1, 0));
  if (r.length() < 0.01) {
    // Tangent is nearly vertical - fall back
    return new Vector3(1, 0, 0);
  }
  return r.normalize();
}

/** Flatten a direction onto the XZ plane to stop non-loop chunks carrying pitch forever. */
function planarTangent(tangent: Vector3): Vector3 {
  const flat = tangent.clone();
  flat.y = 0;
  if (flat.lengthSq() < 1e-6) {
    flat.set(0, 0, -1);
  }
  return flat.normalize();
}

/** Build a result from an array of points, computing exit tangent from last two. */
function makeResult(points: Vector3[], tags: string[]): ChunkResult {
  const n = points.length;
  const exitPos = points[n - 1].clone();
  const exitTangent = exitPos.clone().sub(points[n - 2]).normalize();
  return { points, exitPos, exitTangent, tags };
}

/** Advance a point along tangent by dist. */
function advance(origin: Vector3, tangent: Vector3, dist: number): Vector3 {
  return origin.clone().addScaledVector(tangent, dist);
}

function curveScale(params: ChunkParams): number {
  return Math.sqrt(30 / params.trackWidth);
}

// ---- Chunk functions ----

export function straight(
  start: Vector3, tangent: Vector3, length: number,
  _rng: () => number, _params: ChunkParams,
): ChunkResult {
  const forward = planarTangent(tangent);
  const end = advance(start, forward, length);
  return makeResult([start.clone(), end], []);
}

export function gentleCurve(
  start: Vector3, tangent: Vector3, length: number,
  rng: () => number, params: ChunkParams,
): ChunkResult {
  const forward = planarTangent(tangent);
  const right = rightFromTangent(forward);
  const sign = rng() > 0.5 ? 1 : -1;
  const offset = length * (0.068 + params.energy * 0.048) * curveScale(params);

  const p1 = advance(start, forward, length * 0.24);
  p1.addScaledVector(right, sign * offset * 0.38);

  const p2 = advance(start, forward, length * 0.5);
  p2.addScaledVector(right, sign * offset * 0.82);

  const p3 = advance(start, forward, length * 0.78);
  p3.addScaledVector(right, sign * offset * 0.72);

  const end = advance(start, forward, length);
  end.addScaledVector(right, sign * offset * 0.28);

  return makeResult([start.clone(), p1, p2, p3, end], ["curve"]);
}

export function sharpTurn(
  start: Vector3, tangent: Vector3, length: number,
  rng: () => number, params: ChunkParams,
): ChunkResult {
  const forward = planarTangent(tangent);
  const right = rightFromTangent(forward);
  const sign = rng() > 0.5 ? 1 : -1;
  const offset = length * (0.118 + params.energy * 0.088) * curveScale(params);

  const p1 = advance(start, forward, length * 0.14);
  p1.addScaledVector(right, sign * offset * 0.2);

  const p2 = advance(start, forward, length * 0.34);
  p2.addScaledVector(right, sign * offset * 0.68);

  const p3 = advance(start, forward, length * 0.56);
  p3.addScaledVector(right, sign * offset);

  const p4 = advance(start, forward, length * 0.78);
  p4.addScaledVector(right, sign * offset * 0.82);

  const end = advance(start, forward, length);
  end.addScaledVector(right, sign * offset * 0.26);

  return makeResult([start.clone(), p1, p2, p3, p4, end], ["highCurvature"]);
}

export function sCurve(
  start: Vector3, tangent: Vector3, length: number,
  rng: () => number, params: ChunkParams,
): ChunkResult {
  const forward = planarTangent(tangent);
  const right = rightFromTangent(forward);
  const sign = rng() > 0.5 ? 1 : -1;
  const offset = length * (0.086 + params.energy * 0.068) * curveScale(params);

  const p1 = advance(start, forward, length * 0.18);
  p1.addScaledVector(right, sign * offset * 0.55);

  const p2 = advance(start, forward, length * 0.36);
  p2.addScaledVector(right, sign * offset * 0.92);

  const p3 = advance(start, forward, length * 0.52);
  p3.addScaledVector(right, sign * offset * 0.18);

  const p4 = advance(start, forward, length * 0.68);
  p4.addScaledVector(right, -sign * offset * 0.86);

  const p5 = advance(start, forward, length * 0.84);
  p5.addScaledVector(right, -sign * offset * 0.22);

  const end = advance(start, forward, length);

  return makeResult([start.clone(), p1, p2, p3, p4, p5, end], ["curve"]);
}

export function hill(
  start: Vector3, tangent: Vector3, length: number,
  rng: () => number, params: ChunkParams,
): ChunkResult {
  const forward = planarTangent(tangent);
  const elevation = length * 0.32 * (0.55 + params.energy * 0.45);
  const downhillDepth = elevation * (0.65 + params.energy * 0.35);
  const peakT = 0.24 + rng() * 0.12;
  const baselineY = start.y;

  const p1 = advance(start, forward, length * 0.16);
  p1.y = baselineY + elevation * 0.45;

  const peak = advance(start, forward, length * peakT);
  peak.y = baselineY + elevation;

  const plunge = advance(start, forward, length * 0.68);
  plunge.y = baselineY - downhillDepth;

  const pullout = advance(start, forward, length * 0.88);
  pullout.y = baselineY - downhillDepth * 0.55;

  const settle = advance(start, forward, length * 0.97);
  settle.y = baselineY - downhillDepth * 0.1;

  const end = advance(start, forward, length);
  end.y = baselineY;

  return makeResult([start.clone(), p1, peak, plunge, pullout, settle, end], ["elevation"]);
}

export function valley(
  start: Vector3, tangent: Vector3, length: number,
  rng: () => number, params: ChunkParams,
): ChunkResult {
  const forward = planarTangent(tangent);
  const depth = length * 0.34 * (0.55 + params.energy * 0.45);
  const troughT = 0.42 + rng() * 0.12;
  const baselineY = start.y;

  const p1 = advance(start, forward, length * 0.14);
  p1.y = baselineY - depth * 0.18;

  const trough = advance(start, forward, length * troughT);
  trough.y = baselineY - depth;

  const fastLine = advance(start, forward, length * 0.76);
  fastLine.y = baselineY - depth * 0.88;

  const pullout = advance(start, forward, length * 0.92);
  pullout.y = baselineY - depth * 0.3;

  const end = advance(start, forward, length);
  end.y = baselineY;

  return makeResult([start.clone(), p1, trough, fastLine, pullout, end], ["elevation"]);
}

export function jumpRamp(
  start: Vector3, tangent: Vector3, length: number,
  rng: () => number, params: ChunkParams,
): ChunkResult {
  const forward = planarTangent(tangent);
  const rampHeight = length * 0.28 * (0.65 + params.energy * 0.35);
  const gapFraction = 0.18 + rng() * 0.1;
  const baselineY = start.y;

  const rampStart = advance(start, forward, length * 0.2);
  rampStart.y = baselineY + rampHeight * 0.25;

  const rampTop = advance(start, forward, length * 0.36);
  rampTop.y = baselineY + rampHeight;

  const lip = advance(start, forward, length * 0.46);
  lip.y = baselineY + rampHeight * 1.08;

  const landingStart = advance(start, forward, length * (0.46 + gapFraction));
  landingStart.y = baselineY - rampHeight * 0.55;

  const rollout = advance(start, forward, length * 0.88);
  rollout.y = baselineY - rampHeight * 0.3;

  const recover = advance(start, forward, length * 0.96);
  recover.y = baselineY - rampHeight * 0.08;

  const end = advance(start, forward, length);
  end.y = baselineY;

  return makeResult([start.clone(), rampStart, rampTop, lip, landingStart, rollout, recover, end], ["hasJump"]);
}

export function loop(
  start: Vector3, tangent: Vector3, length: number,
  _rng: () => number, params: ChunkParams,
): ChunkResult {
  const forward = planarTangent(tangent);
  const right = rightFromTangent(forward);
  const radius = Math.min(Math.max(length * 0.22, params.trackWidth * 1.9, 42), 58);
  const xSpread = Math.max(params.trackWidth * 2.35, radius * 1.1);
  const loopSamples = 28;
  const baselineY = start.y;

  // Pull the approach left before the vertical circle, matching the P1 stable shape.
  const entryLead = advance(start, forward, length * 0.14);
  entryLead.addScaledVector(right, -xSpread * 0.18);

  const entryPocket = advance(start, forward, length * 0.26);
  entryPocket.addScaledVector(right, -xSpread * 0.42);
  entryPocket.y = baselineY;

  // The loop itself sits on a vertical circle in the forward/up plane.
  const bottomPos = advance(start, forward, length * 0.43);
  bottomPos.addScaledVector(right, -xSpread * 0.5);
  const cy = baselineY + radius;

  const loopPts: Vector3[] = [];
  for (let i = 0; i < loopSamples; i++) {
    const t = i / (loopSamples - 1);
    const angle = (-Math.PI / 2) + t * (Math.PI * 2 * 0.97);
    const pt = bottomPos.clone();
    pt.addScaledVector(forward, radius * Math.cos(angle));
    pt.y = cy + radius * Math.sin(angle);
    pt.addScaledVector(right, (t - 0.5) * xSpread);
    loopPts.push(pt);
  }

  // Exit on the right and settle back toward the centerline while staying level.
  const exitPocket = advance(start, forward, length * 0.78);
  exitPocket.addScaledVector(right, xSpread * 0.26);
  exitPocket.y = baselineY;

  const exitBlend = advance(start, forward, length * 0.9);
  exitBlend.addScaledVector(right, xSpread * 0.1);
  exitBlend.y = baselineY;

  const end = advance(start, forward, length);
  end.y = baselineY;

  const allPoints = [start.clone(), entryLead, entryPocket, ...loopPts, exitPocket, exitBlend, end];
  return makeResult(allPoints, ["hasLoop"]);
}

// ---- Registry ----

export const chunkFns: Record<ChunkType, ChunkFn> = {
  straight,
  gentleCurve,
  sharpTurn,
  sCurve,
  hill,
  valley,
  jumpRamp,
  loop,
};
