import { Vector3 } from "three";
import type { ItemKind, InventorySlot, PickupSpawnState } from "./network-types.js";

export const RACE_SIM = {
  START_TRACK_U: 0.001,
  PICKUP_WORLD_RADIUS: 2.0,
  MISSILE_MIN_RANGE_U: 0.0,
  MISSILE_MAX_RANGE_U: 0.75,
  SHIELD_DURATION_MS: 10000,
  TAKEDOWN_DURATION_MS: 1800,
  NOMINAL_HALF_WIDTH: 11,
  VEHICLE_HOVER_HEIGHT: 0.45,
  FINISH_TRACK_U: 0.999,
} as const;

export type RaceSimRacer = {
  clientId: string;
  trackU: number;
  lateralOffset: number;
  speed: number;
  checkpointIndex: number;
  placement: number;
  offensiveItem: ItemKind | null;
  defensiveItem: ItemKind | null;
  shieldUntil: number;
  takenDownUntil: number;
  respawnRevision: number;
  finishedAt: number | null;
  takedowns: number;
  respawnAt: number;
  respawnTrackU: number;
  respawnLateralOffset: number;
};

export type RaceSimTrack = {
  getFrameAt(u: number): { right: Vector3; up: Vector3 };
  getPointAt(u: number): Vector3;
};

export type PickupSimEvent = {
  kind: "pickup";
  actorId: string;
  item: ItemKind;
  slot: InventorySlot;
};

export type FireSimEvent = {
  kind: "fire";
  actorId: string;
  targetId: string | null;
  outcome: "miss" | "blocked" | "takedown";
};

export type BlockedSimEvent = { kind: "blocked"; actorId: string; targetId: string };
export type TakedownSimEvent = { kind: "takedown"; actorId: string; targetId: string };
export type ShieldSimEvent = { kind: "shield"; actorId: string };
export type RespawnSimEvent = { kind: "respawn"; targetId: string };

export type RaceSimEvent =
  | PickupSimEvent
  | FireSimEvent
  | BlockedSimEvent
  | TakedownSimEvent
  | ShieldSimEvent
  | RespawnSimEvent;

export function computeTrackWorldPosition(
  track: RaceSimTrack,
  u: number,
  lateralOffset: number,
  out: Vector3 = new Vector3(),
): Vector3 {
  const frame = track.getFrameAt(u);
  const center = track.getPointAt(u);
  return out
    .copy(center)
    .addScaledVector(frame.right, lateralOffset)
    .addScaledVector(frame.up, RACE_SIM.VEHICLE_HOVER_HEIGHT);
}

/**
 * Detect whether a racer's movement path across the current tick grabs any
 * uncollected pickup. Mutates pickup.collectedBy and racer inventory on hit.
 * Returns a pickup event, or null if none grabbed.
 */
export function maybeCollectPickups(
  track: RaceSimTrack,
  pickups: PickupSpawnState[],
  racer: RaceSimRacer,
  previousTrackU: number,
  previousLateralOffset: number,
): PickupSimEvent | null {
  const sampleCount = Math.max(
    1,
    Math.min(
      8,
      Math.ceil(Math.max(
        Math.abs(racer.trackU - previousTrackU) / 0.0025,
        Math.abs(racer.lateralOffset - previousLateralOffset) / 1.5,
      )),
    ),
  );

  let bestPickup: PickupSpawnState | null = null;
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  const pickupPosition = new Vector3();
  const playerPosition = new Vector3();

  for (const pickup of pickups) {
    if (pickup.collectedBy) continue;
    computeTrackWorldPosition(track, pickup.u, pickup.lane * RACE_SIM.NOMINAL_HALF_WIDTH, pickupPosition);
    let pickupDistanceSq = Number.POSITIVE_INFINITY;
    for (let step = 0; step <= sampleCount; step++) {
      const t = step / sampleCount;
      const sampleU = previousTrackU + (racer.trackU - previousTrackU) * t;
      const sampleLat = previousLateralOffset + (racer.lateralOffset - previousLateralOffset) * t;
      computeTrackWorldPosition(track, sampleU, sampleLat, playerPosition);
      pickupDistanceSq = Math.min(pickupDistanceSq, pickupPosition.distanceToSquared(playerPosition));
    }
    if (pickupDistanceSq > RACE_SIM.PICKUP_WORLD_RADIUS * RACE_SIM.PICKUP_WORLD_RADIUS) continue;
    if (pickupDistanceSq >= bestDistanceSq) continue;
    bestDistanceSq = pickupDistanceSq;
    bestPickup = pickup;
  }

  if (!bestPickup) return null;

  bestPickup.collectedBy = racer.clientId;
  if (bestPickup.slot === "offensive") {
    racer.offensiveItem = bestPickup.kind;
  } else {
    racer.defensiveItem = bestPickup.kind;
  }
  return {
    kind: "pickup",
    actorId: racer.clientId,
    item: bestPickup.kind,
    slot: bestPickup.slot,
  };
}

/**
 * Resolve a fire attempt from attacker. Clears attacker's missile, finds the
 * closest target ahead, applies shield block or takedown, mutates both.
 * Returns the events that should be broadcast (fire, and either blocked or
 * takedown when a target was hit).
 */
export function resolveFire(
  racers: Iterable<RaceSimRacer>,
  attacker: RaceSimRacer,
  now: number,
  preferredTarget?: RaceSimRacer | null,
): RaceSimEvent[] {
  if (attacker.offensiveItem !== "missile") return [];
  if (attacker.finishedAt !== null || attacker.takenDownUntil > now) return [];

  attacker.offensiveItem = null;

  let target: RaceSimRacer | null = null;

  if (preferredTarget
    && preferredTarget.clientId !== attacker.clientId
    && preferredTarget.finishedAt === null
    && preferredTarget.takenDownUntil <= now) {
    const uDelta = preferredTarget.trackU - attacker.trackU;
    if (uDelta >= RACE_SIM.MISSILE_MIN_RANGE_U && uDelta <= RACE_SIM.MISSILE_MAX_RANGE_U) {
      target = preferredTarget;
    }
  }

  if (!target) {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of racers) {
      if (candidate.clientId === attacker.clientId) continue;
      if (candidate.finishedAt !== null || candidate.takenDownUntil > now) continue;
      const uDelta = candidate.trackU - attacker.trackU;
      if (uDelta < RACE_SIM.MISSILE_MIN_RANGE_U || uDelta > RACE_SIM.MISSILE_MAX_RANGE_U) continue;
      if (uDelta < bestDistance) {
        bestDistance = uDelta;
        target = candidate;
      }
    }
  }

  if (!target) {
    return [{ kind: "fire", actorId: attacker.clientId, targetId: null, outcome: "miss" }];
  }

  if (target.shieldUntil > now) {
    target.defensiveItem = null;
    target.shieldUntil = 0;
    return [
      { kind: "fire", actorId: attacker.clientId, targetId: target.clientId, outcome: "blocked" },
      { kind: "blocked", actorId: attacker.clientId, targetId: target.clientId },
    ];
  }

  target.takenDownUntil = now + RACE_SIM.TAKEDOWN_DURATION_MS;
  target.respawnAt = now + RACE_SIM.TAKEDOWN_DURATION_MS;
  target.respawnTrackU = clamp(target.trackU - 0.008, RACE_SIM.START_TRACK_U, 0.992);
  target.respawnLateralOffset = clamp(target.lateralOffset, -10, 10);
  target.shieldUntil = 0;
  target.speed = 0;
  attacker.takedowns += 1;
  return [
    { kind: "fire", actorId: attacker.clientId, targetId: target.clientId, outcome: "takedown" },
    { kind: "takedown", actorId: attacker.clientId, targetId: target.clientId },
  ];
}

/**
 * Activate shield on a racer. Consumes the defensive item, sets shieldUntil.
 * Returns the event, or null if the racer can't shield.
 */
export function resolveShield(racer: RaceSimRacer, now: number): ShieldSimEvent | null {
  if (racer.defensiveItem !== "shield") return null;
  if (racer.finishedAt !== null || racer.takenDownUntil > now) return null;
  racer.defensiveItem = null;
  racer.shieldUntil = now + RACE_SIM.SHIELD_DURATION_MS;
  return { kind: "shield", actorId: racer.clientId };
}

/**
 * Process due respawns across the racer pool. Mutates each respawned racer
 * and returns the respawn events to broadcast.
 */
export function processRespawns(racers: Iterable<RaceSimRacer>, now: number): RespawnSimEvent[] {
  const events: RespawnSimEvent[] = [];
  for (const racer of racers) {
    if (racer.respawnAt > 0 && now >= racer.respawnAt) {
      racer.respawnAt = 0;
      racer.takenDownUntil = 0;
      racer.respawnRevision += 1;
      racer.trackU = racer.respawnTrackU;
      racer.lateralOffset = racer.respawnLateralOffset;
      racer.speed = 0;
      events.push({ kind: "respawn", targetId: racer.clientId });
    }
  }
  return events;
}

/**
 * Sort racers in place by finish time -> checkpointIndex -> trackU -> clientId
 * and assign placement fields (1-based).
 */
export function recomputePlacements(racers: RaceSimRacer[]): void {
  racers.sort((a, b) => {
    if (a.finishedAt !== null || b.finishedAt !== null) {
      if (a.finishedAt !== null && b.finishedAt !== null) return a.finishedAt - b.finishedAt;
      return a.finishedAt !== null ? -1 : 1;
    }
    if (a.checkpointIndex !== b.checkpointIndex) return b.checkpointIndex - a.checkpointIndex;
    if (Math.abs(a.trackU - b.trackU) > 1e-5) return b.trackU - a.trackU;
    return a.clientId.localeCompare(b.clientId);
  });
  racers.forEach((racer, index) => {
    racer.placement = index + 1;
  });
}

export type PickupGenTrack = {
  totalLength: number;
  getTrackObjects(): readonly { u: number; collisionLength: number }[];
  getTrackFeatures(): readonly { u: number; kind: "loop" | "jump" | "barrelRoll" }[];
};

const LANE_FRACTIONS_READONLY = [-0.45, 0, 0.45] as const;
const WINDOW_LANE_DU_READONLY = [-0.0012, 0, 0.0012] as const;

export function buildPickups(track: PickupGenTrack, seed: number): PickupSpawnState[] {
  const rng = mulberry32(seed ^ 0x51f15e);
  const pickups: PickupSpawnState[] = [];
  const WINDOW_COUNT = 96;
  const windowStart = 0.07;
  const windowEnd = 0.95;
  const windowSpan = windowEnd - windowStart;
  const blockedObjects = track.getTrackObjects();
  const blockedFeatures = track.getTrackFeatures();
  const trackLength = Math.max(1, track.totalLength);

  const overlapsBlockedZone = (u: number): boolean => {
    for (const object of blockedObjects) {
      const objectPaddingU = (object.collisionLength + 12) / trackLength;
      if (Math.abs(object.u - u) <= objectPaddingU) return true;
    }
    for (const feature of blockedFeatures) {
      const featurePaddingU = feature.kind === "jump" ? 0.008 : 0.014;
      if (Math.abs(feature.u - u) <= featurePaddingU) return true;
    }
    return false;
  };

  const appendPickupWindow = (windowId: string, u: number): void => {
    const missileCenter = rng() > 0.5;
    const windowPickups: Array<Pick<PickupSpawnState, "kind" | "slot" | "lane">> = missileCenter
      ? [
          { kind: "shield", slot: "defensive", lane: LANE_FRACTIONS_READONLY[0] },
          { kind: "missile", slot: "offensive", lane: LANE_FRACTIONS_READONLY[1] },
          { kind: "shield", slot: "defensive", lane: LANE_FRACTIONS_READONLY[2] },
        ]
      : [
          { kind: "missile", slot: "offensive", lane: LANE_FRACTIONS_READONLY[0] },
          { kind: "shield", slot: "defensive", lane: LANE_FRACTIONS_READONLY[1] },
          { kind: "missile", slot: "offensive", lane: LANE_FRACTIONS_READONLY[2] },
        ];

    for (const [laneIndex, pickup] of windowPickups.entries()) {
      const pickupU = clamp(u + WINDOW_LANE_DU_READONLY[laneIndex], 0.01, 0.99);
      pickups.push({
        id: `pickup-${windowId}-${laneIndex}`,
        kind: pickup.kind,
        slot: pickup.slot,
        u: pickupU,
        lane: pickup.lane,
        collectedBy: null,
      });
    }
  };

  for (let i = 0; i < WINDOW_COUNT; i += 1) {
    const u = windowStart + ((i + 0.5) / WINDOW_COUNT) * windowSpan;
    if (overlapsBlockedZone(u)) continue;
    appendPickupWindow(`main-${i}`, u);
  }
  return pickups;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
