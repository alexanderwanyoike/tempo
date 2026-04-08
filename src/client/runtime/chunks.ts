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

// ---- Chunk functions ----

export function straight(
  start: Vector3, tangent: Vector3, length: number,
  _rng: () => number, _params: ChunkParams,
): ChunkResult {
  const end = advance(start, tangent, length);
  return makeResult([start.clone(), end], []);
}

export function gentleCurve(
  start: Vector3, tangent: Vector3, length: number,
  rng: () => number, params: ChunkParams,
): ChunkResult {
  const right = rightFromTangent(tangent);
  const sign = rng() > 0.5 ? 1 : -1;
  const offset = length * 0.1 * (0.3 + params.energy * 0.7);

  const mid = advance(start, tangent, length * 0.5);
  mid.addScaledVector(right, sign * offset);

  const end = advance(start, tangent, length);
  // Slight residual lateral shift for natural feel
  end.addScaledVector(right, sign * offset * 0.2);

  return makeResult([start.clone(), mid, end], ["curve"]);
}

export function sharpTurn(
  start: Vector3, tangent: Vector3, length: number,
  rng: () => number, params: ChunkParams,
): ChunkResult {
  const right = rightFromTangent(tangent);
  const sign = rng() > 0.5 ? 1 : -1;
  const offset = length * 0.25 * (0.5 + params.energy * 0.5);

  const p1 = advance(start, tangent, length * 0.3);
  const p2 = advance(start, tangent, length * 0.5);
  p2.addScaledVector(right, sign * offset);
  const p3 = advance(start, tangent, length * 0.75);
  p3.addScaledVector(right, sign * offset * 0.6);
  const end = advance(start, tangent, length);

  return makeResult([start.clone(), p1, p2, p3, end], ["highCurvature"]);
}

export function sCurve(
  start: Vector3, tangent: Vector3, length: number,
  rng: () => number, params: ChunkParams,
): ChunkResult {
  const right = rightFromTangent(tangent);
  const sign = rng() > 0.5 ? 1 : -1;
  const offset = length * 0.15 * (0.4 + params.energy * 0.6);

  const p1 = advance(start, tangent, length * 0.25);
  p1.addScaledVector(right, sign * offset);

  const mid = advance(start, tangent, length * 0.5);

  const p3 = advance(start, tangent, length * 0.75);
  p3.addScaledVector(right, -sign * offset);

  const end = advance(start, tangent, length);

  return makeResult([start.clone(), p1, mid, p3, end], ["curve"]);
}

export function hill(
  start: Vector3, tangent: Vector3, length: number,
  rng: () => number, params: ChunkParams,
): ChunkResult {
  const elevation = length * 0.12 * (0.3 + params.energy * 0.7);
  const peakT = 0.35 + rng() * 0.3; // peak between 35-65%

  const p1 = advance(start, tangent, length * peakT);
  p1.y += elevation;

  const end = advance(start, tangent, length);
  // Slight height variation at exit
  end.y += elevation * 0.1;

  return makeResult([start.clone(), p1, end], ["elevation"]);
}

export function valley(
  start: Vector3, tangent: Vector3, length: number,
  rng: () => number, params: ChunkParams,
): ChunkResult {
  const depth = length * 0.1 * (0.3 + params.energy * 0.7);
  const troughT = 0.35 + rng() * 0.3;

  const p1 = advance(start, tangent, length * troughT);
  p1.y -= depth;

  const end = advance(start, tangent, length);
  end.y -= depth * 0.1;

  return makeResult([start.clone(), p1, end], ["elevation"]);
}

export function jumpRamp(
  start: Vector3, tangent: Vector3, length: number,
  rng: () => number, params: ChunkParams,
): ChunkResult {
  const rampHeight = length * 0.15 * (0.5 + params.energy * 0.5);
  const gapFraction = 0.15 + rng() * 0.1; // 15-25% of length is airborne

  // Ramp up
  const rampTop = advance(start, tangent, length * 0.35);
  rampTop.y += rampHeight;

  // Lip (launch point)
  const lip = advance(start, tangent, length * 0.45);
  lip.y += rampHeight * 1.1;

  // Landing (after gap)
  const landingStart = advance(start, tangent, length * (0.45 + gapFraction));
  landingStart.y += rampHeight * 0.3;

  // Run-out
  const end = advance(start, tangent, length);

  return makeResult([start.clone(), rampTop, lip, landingStart, end], ["hasJump"]);
}

export function loop(
  start: Vector3, tangent: Vector3, length: number,
  _rng: () => number, _params: ChunkParams,
): ChunkResult {
  // Loop radius sized to fit within allocated length
  // The loop occupies roughly 2*radius in the forward direction
  const radius = Math.min(length * 0.25, 60);
  const N = 24;

  // Loop center is ahead of start by length*0.4, elevated by radius
  const loopCenterForward = length * 0.4;
  const centerPos = advance(start, tangent, loopCenterForward);
  const cy = centerPos.y + radius;

  // Entry approach point
  const approach = advance(start, tangent, loopCenterForward - radius * 1.2);

  // Build circle points in the plane defined by tangent (forward) and up
  // The circle is in the forward-up plane
  const right = rightFromTangent(tangent);
  const forward2d = tangent.clone().normalize();
  const xSpread = radius * 0.5; // pull entry/exit apart in the right direction

  const loopPts: Vector3[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    // Circle: start at bottom (-PI/2), go around 97% to avoid exact overlap
    const angle = (-Math.PI / 2) + t * (Math.PI * 2 * 0.97);
    const py = cy + radius * Math.sin(angle);
    // Forward offset from center based on cos
    const fwdOffset = radius * Math.cos(angle);
    const pt = centerPos.clone();
    pt.addScaledVector(forward2d, fwdOffset);
    pt.y = py;
    // Spread entry/exit in the right direction
    pt.addScaledVector(right, (t - 0.5) * xSpread);
    loopPts.push(pt);
  }

  // Exit run-out
  const exit = advance(start, tangent, length * 0.85);
  exit.addScaledVector(right, xSpread * 0.25);
  const end = advance(start, tangent, length);

  const allPoints = [start.clone(), approach, ...loopPts, exit, end];
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
