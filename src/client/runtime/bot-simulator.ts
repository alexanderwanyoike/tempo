import type { CarVariant, PickupSpawnState, RacePlayerState, RoomPlayerState } from "../../../shared/network-types.js";
import { checkpointIndexForU } from "../../../shared/race-utils.js";
import {
  RACE_SIM,
  maybeCollectPickups as simMaybeCollectPickups,
  processRespawns as simProcessRespawns,
  recomputePlacements as simRecomputePlacements,
  resolveFire as simResolveFire,
  resolveShield as simResolveShield,
  type PickupSimEvent,
  type RaceSimEvent,
  type RaceSimRacer,
  type ShieldSimEvent,
} from "../../../shared/race-sim.js";
import type { VehicleInputState } from "./input.js";
import type { Track } from "./track-builder.js";
import { VehicleController, defaultVehicleTuning, type VehicleTuning } from "./vehicle-controller.js";

export type BotDifficulty = "easy" | "medium" | "hard";

type DifficultyProfile = {
  topSpeed: number;
  thrust: number;
  steeringRate: number;
  steeringResponse: number;
  lateralGrip: number;
  laneHoldMinMs: number;
  laneHoldJitterMs: number;
  fireCooldownMs: number;
  shieldCooldownMs: number;
  brakeThresholdRatio: number;
  throttleDropoutChance: number;
  // Asymmetric rubberband: only helps bots BEHIND the leader.
  // deadZoneU: gap below which no catch-up is applied. maxGapU: gap at which
  // catch-up is saturated. maxThrustMultiplier / maxTopSpeedBonus: the peak
  // catch-up applied at maxGapU.
  catchupDeadZoneU: number;
  catchupMaxGapU: number;
  catchupMaxThrustMultiplier: number;
  catchupMaxTopSpeedBonus: number;
  // Leader pressure: should this bot prioritise firing at the player / leader?
  preferLeaderTargeting: boolean;
};

// Stat deltas between difficulties stay modest because most of the challenge
// comes from asymmetric catch-up rubberband (bots behind get a speed boost,
// never a cap on leaders) and leader-targeted combat pressure. Raw topSpeed
// lives in a narrow window around the player's base 90.
const DIFFICULTY_PROFILES: Record<BotDifficulty, DifficultyProfile> = {
  easy: {
    topSpeed: 78,
    thrust: 48,
    steeringRate: 54,
    steeringResponse: 13,
    lateralGrip: 2.6,
    laneHoldMinMs: 1800,
    laneHoldJitterMs: 900,
    fireCooldownMs: 1500,
    shieldCooldownMs: 3200,
    brakeThresholdRatio: 3.5,
    throttleDropoutChance: 0.20,
    catchupDeadZoneU: 1,
    catchupMaxGapU: 1,
    catchupMaxThrustMultiplier: 1,
    catchupMaxTopSpeedBonus: 0,
    preferLeaderTargeting: false,
  },
  medium: {
    topSpeed: 88,
    thrust: 54,
    steeringRate: 62,
    steeringResponse: 15,
    lateralGrip: 3.2,
    laneHoldMinMs: 1200,
    laneHoldJitterMs: 600,
    fireCooldownMs: 700,
    shieldCooldownMs: 1800,
    brakeThresholdRatio: 3.5,
    throttleDropoutChance: 0.05,
    catchupDeadZoneU: 0.02,
    catchupMaxGapU: 0.12,
    catchupMaxThrustMultiplier: 1.15,
    catchupMaxTopSpeedBonus: 12,
    preferLeaderTargeting: false,
  },
  hard: {
    topSpeed: 90,
    thrust: 58,
    steeringRate: 66,
    steeringResponse: 17,
    lateralGrip: 3.6,
    laneHoldMinMs: 800,
    laneHoldJitterMs: 360,
    fireCooldownMs: 280,
    shieldCooldownMs: 900,
    brakeThresholdRatio: 3.5,
    throttleDropoutChance: 0,
    catchupDeadZoneU: 0.005,
    catchupMaxGapU: 0.07,
    catchupMaxThrustMultiplier: 1.3,
    catchupMaxTopSpeedBonus: 24,
    preferLeaderTargeting: true,
  },
};

const TICK_INTERVAL_MS = 100;

// Callsigns feel more alive than "Pilot N". Consumed via a seeded shuffle so
// the grid stays consistent for a given race seed.
const BOT_CALLSIGNS = [
  "Vex", "Nova", "Cipher", "Ghost", "Strike", "Null", "Blaze", "Echo",
  "Drift", "Viper", "Raven", "Shade", "Pyre", "Flux", "Onyx", "Hex",
  "Halo", "Rook", "Krait", "Atlas", "Helix", "Vortex", "Zenith", "Ember",
  "Quill", "Rift", "Tempo", "Talon", "Scythe", "Static", "Arc", "Mercer",
] as const;

type BotConfig = {
  clientId: string;
  name: string;
  carVariant: CarVariant;
  startTrackU: number;
  startLateralOffset: number;
  difficulty: BotDifficulty;
};

type BotAgent = {
  config: BotConfig;
  profile: DifficultyProfile;
  vehicleController: VehicleController;
  input: VehicleInputState;
  racer: RaceSimRacer;
  prevTrackU: number;
  prevLateralOffset: number;
  laneChoice: -1 | 0 | 1;
  laneHoldUntil: number;
  fireCooldownUntil: number;
  shieldCooldownUntil: number;
  pendingFire: boolean;
  pendingShield: boolean;
};

function tuningForDifficulty(profile: DifficultyProfile, _difficulty: BotDifficulty): VehicleTuning {
  return {
    ...defaultVehicleTuning,
    topSpeed: profile.topSpeed,
    thrust: profile.thrust,
    steeringRate: profile.steeringRate,
    steeringResponse: profile.steeringResponse,
    lateralGrip: profile.lateralGrip,
  };
}

function createRacer(config: BotConfig): RaceSimRacer {
  return {
    clientId: config.clientId,
    trackU: config.startTrackU,
    lateralOffset: config.startLateralOffset,
    speed: 0,
    checkpointIndex: 0,
    placement: 1,
    offensiveItem: null,
    defensiveItem: null,
    shieldUntil: 0,
    takenDownUntil: 0,
    respawnRevision: 0,
    finishedAt: null,
    takedowns: 0,
    respawnAt: 0,
    respawnTrackU: config.startTrackU,
    respawnLateralOffset: config.startLateralOffset,
  };
}

function createInput(): VehicleInputState {
  return {
    throttle: false,
    brake: false,
    steerLeft: false,
    steerRight: false,
    airbrakeLeft: false,
    airbrakeRight: false,
    boost: false,
    fire: false,
    shield: false,
  };
}

function resetInput(input: VehicleInputState): void {
  input.throttle = false;
  input.brake = false;
  input.steerLeft = false;
  input.steerRight = false;
  input.airbrakeLeft = false;
  input.airbrakeRight = false;
  input.boost = false;
  input.fire = false;
  input.shield = false;
}

export class BotSimulator {
  private readonly agents: BotAgent[];
  private readonly pickups: PickupSpawnState[];
  private readonly checkpointUs: readonly number[];
  private readonly track: Track;
  private lastTickAt = 0;
  private pendingEvents: RaceSimEvent[] = [];

  constructor(
    track: Track,
    pickups: PickupSpawnState[],
    checkpointUs: readonly number[],
    configs: BotConfig[],
  ) {
    this.track = track;
    this.pickups = pickups;
    this.checkpointUs = checkpointUs;
    this.agents = configs.map((cfg) => {
      const profile = DIFFICULTY_PROFILES[cfg.difficulty];
      const vc = new VehicleController(tuningForDifficulty(profile, cfg.difficulty));
      vc.setTrack(track);
      vc.setTrackQuery((pos, hintU) => track.queryNearest(pos, hintU));
      vc.forceTrackState(cfg.startTrackU, cfg.startLateralOffset, 0);
      const racer = createRacer(cfg);
      return {
        config: cfg,
        profile,
        vehicleController: vc,
        input: createInput(),
        racer,
        prevTrackU: racer.trackU,
        prevLateralOffset: racer.lateralOffset,
        laneChoice: 0,
        laneHoldUntil: 0,
        fireCooldownUntil: 0,
        shieldCooldownUntil: 0,
        pendingFire: false,
        pendingShield: false,
      };
    });
  }

  get botRacers(): readonly RaceSimRacer[] {
    return this.agents.map((a) => a.racer);
  }

  /** Reset everything for a fresh race start (called after countdown). */
  reset(now: number): void {
    this.lastTickAt = now;
    this.pendingEvents = [];
    for (const agent of this.agents) {
      agent.racer.trackU = agent.config.startTrackU;
      agent.racer.lateralOffset = agent.config.startLateralOffset;
      agent.racer.speed = 0;
      agent.racer.checkpointIndex = 0;
      agent.racer.placement = 1;
      agent.racer.offensiveItem = null;
      agent.racer.defensiveItem = null;
      agent.racer.shieldUntil = 0;
      agent.racer.takenDownUntil = 0;
      agent.racer.respawnRevision = 0;
      agent.racer.finishedAt = null;
      agent.racer.takedowns = 0;
      agent.racer.respawnAt = 0;
      agent.racer.respawnTrackU = agent.config.startTrackU;
      agent.racer.respawnLateralOffset = agent.config.startLateralOffset;
      agent.vehicleController.forceTrackState(
        agent.config.startTrackU,
        agent.config.startLateralOffset,
        0,
      );
      agent.prevTrackU = agent.racer.trackU;
      agent.prevLateralOffset = agent.racer.lateralOffset;
      agent.laneChoice = 0;
      agent.laneHoldUntil = 0;
      agent.pendingFire = false;
      agent.pendingShield = false;
      resetInput(agent.input);
    }
  }

  /**
   * Per-frame update: drive each bot's AI, advance physics, sync racer fields
   * from the vehicle controller. Runs the 100ms rules tick when due.
   * `localRacer` is the caller's view of the local player used for placement
   * and combat targeting. Pass { finishedAt, takenDownUntil } so bots respect
   * game state for the human racer.
   */
  update(deltaSeconds: number, now: number, localRacer: RaceSimRacer): void {
    // Leader trackU feeds the catch-up rubberband. Pool includes the local
    // player so a strong player pulls catch-up up on the bots that trail them.
    let leaderTrackU = localRacer.finishedAt !== null ? 1 : localRacer.trackU;
    for (const agent of this.agents) {
      const u = agent.racer.finishedAt !== null ? 1 : agent.racer.trackU;
      if (u > leaderTrackU) leaderTrackU = u;
    }

    for (const agent of this.agents) {
      if (agent.racer.finishedAt !== null || agent.racer.takenDownUntil > now) {
        resetInput(agent.input);
      } else {
        this.driveAI(agent, localRacer, now);
      }
      this.applyCatchup(agent, leaderTrackU);
      const speedBefore = agent.vehicleController.state.speed;
      agent.vehicleController.update(deltaSeconds, agent.input);
      const s = agent.vehicleController.state;
      // Fall-off rescue: vehicle-controller resets speed to 0 when a bot flies
      // off the track. Without this kick they have to rebuild speed from zero
      // while the leader pulls further away. Restore a healthy launch speed so
      // catchup can actually do its job.
      if (speedBefore > 30 && s.speed < 4
        && agent.racer.takenDownUntil <= now
        && agent.racer.finishedAt === null) {
        s.speed = Math.max(60, speedBefore * 0.55);
      }
      // Sync simulator racer from physics truth
      agent.racer.trackU = Math.min(0.9995, Math.max(RACE_SIM.START_TRACK_U, s.trackU));
      agent.racer.lateralOffset = Math.max(-14, Math.min(14, s.lateralOffset));
      agent.racer.speed = Math.max(0, Math.min(140, s.speed));
    }

    if (now - this.lastTickAt >= TICK_INTERVAL_MS) {
      this.lastTickAt = now;
      this.tick(now, localRacer);
    }
  }

  /** Drain events produced since last call. Caller plays their VFX. */
  drainEvents(): RaceSimEvent[] {
    if (this.pendingEvents.length === 0) return [];
    const out = this.pendingEvents;
    this.pendingEvents = [];
    return out;
  }

  /** Run pickup collision for the local player (solo has no server). */
  collectForLocal(
    localRacer: RaceSimRacer,
    prevTrackU: number,
    prevLateralOffset: number,
  ): PickupSimEvent | null {
    return simMaybeCollectPickups(this.track, this.pickups, localRacer, prevTrackU, prevLateralOffset);
  }

  /** Local pressed fire. Resolves against bots. */
  fireFromLocal(localRacer: RaceSimRacer, now: number): RaceSimEvent[] {
    const allRacers = [localRacer, ...this.agents.map((a) => a.racer)];
    return simResolveFire(allRacers, localRacer, now);
  }

  /** Local pressed shield. */
  shieldFromLocal(localRacer: RaceSimRacer, now: number): ShieldSimEvent | null {
    return simResolveShield(localRacer, now);
  }

  /** Build snapshot entries for applyRaceSnapshot consumption. */
  buildRacePlayerStates(localPlayer: RacePlayerState): RacePlayerState[] {
    const entries: RacePlayerState[] = [localPlayer];
    for (const agent of this.agents) {
      entries.push({
        clientId: agent.racer.clientId,
        trackU: agent.racer.trackU,
        lateralOffset: agent.racer.lateralOffset,
        speed: agent.racer.speed,
        checkpointIndex: agent.racer.checkpointIndex,
        placement: agent.racer.placement,
        offensiveItem: agent.racer.offensiveItem,
        defensiveItem: agent.racer.defensiveItem,
        shieldUntil: agent.racer.shieldUntil,
        takenDownUntil: agent.racer.takenDownUntil,
        respawnRevision: agent.racer.respawnRevision,
        finishedAt: agent.racer.finishedAt,
        takedowns: agent.racer.takedowns,
      });
    }
    return entries;
  }

  /** Build the lobby-style roster entries so the HUD shows bots. */
  buildRoster(localRoster: RoomPlayerState): RoomPlayerState[] {
    const entries: RoomPlayerState[] = [localRoster];
    for (const agent of this.agents) {
      entries.push({
        clientId: agent.config.clientId,
        name: agent.config.name,
        carVariant: agent.config.carVariant,
        connected: true,
        ready: true,
        isActiveRacer: true,
        isHost: false,
        preload: { sceneReady: true, audioReady: true },
      });
    }
    return entries;
  }

  private tick(now: number, localRacer: RaceSimRacer): void {
    const botRacers = this.agents.map((a) => a.racer);
    const allRacers = [localRacer, ...botRacers];

    const respawnEvents = simProcessRespawns(botRacers, now);
    for (const ev of respawnEvents) {
      const agent = this.agents.find((a) => a.racer.clientId === ev.targetId);
      if (agent) {
        agent.vehicleController.forceTrackState(
          agent.racer.trackU,
          agent.racer.lateralOffset,
          0,
        );
        agent.prevTrackU = agent.racer.trackU;
        agent.prevLateralOffset = agent.racer.lateralOffset;
      }
      this.pendingEvents.push(ev);
    }

    for (const agent of this.agents) {
      const ev = simMaybeCollectPickups(
        this.track,
        this.pickups,
        agent.racer,
        agent.prevTrackU,
        agent.prevLateralOffset,
      );
      if (ev) this.pendingEvents.push(ev);
      agent.prevTrackU = agent.racer.trackU;
      agent.prevLateralOffset = agent.racer.lateralOffset;
    }

    for (const agent of this.agents) {
      agent.racer.checkpointIndex = Math.max(
        agent.racer.checkpointIndex,
        checkpointIndexForU(agent.racer.trackU, this.checkpointUs),
      );
      if (agent.racer.trackU >= RACE_SIM.FINISH_TRACK_U && agent.racer.finishedAt === null) {
        agent.racer.finishedAt = now;
      }
    }

    for (const agent of this.agents) {
      if (agent.pendingFire) {
        agent.pendingFire = false;
        const preferredTarget = this.pickFireTarget(
          allRacers,
          agent.racer,
          now,
          agent.profile.preferLeaderTargeting,
        );
        const events = simResolveFire(allRacers, agent.racer, now, preferredTarget);
        this.pendingEvents.push(...events);
      }
      if (agent.pendingShield) {
        agent.pendingShield = false;
        const ev = simResolveShield(agent.racer, now);
        if (ev) this.pendingEvents.push(ev);
      }
    }

    simRecomputePlacements(allRacers);
  }

  private driveAI(agent: BotAgent, localRacer: RaceSimRacer, now: number): void {
    const racer = agent.racer;
    const profile = agent.profile;

    // Re-pick lane periodically using a simple obstacle/pickup score.
    if (now >= agent.laneHoldUntil) {
      agent.laneHoldUntil = now + profile.laneHoldMinMs + Math.random() * profile.laneHoldJitterMs;
      agent.laneChoice = this.chooseLane(agent);
    }

    const halfWidth = this.track.getHalfWidthAt(racer.trackU);
    // Bots drive around their own home lane but can commit fully to a pickup or
    // obstacle-avoidance line when chooseLane says so. laneChoice -1/0/+1 maps
    // to [home-delta, home, home+delta] with a wider delta than a simple nudge
    // so the bot actually reaches off-home pickups.
    const homeOffset = agent.config.startLateralOffset;
    const LANE_EXPLORE_DELTA = 3.2;
    // Keep bots comfortably inside the wall-proximity penalty radius. The
    // vehicle-controller zaps speed once edgeRatio crosses 0.78, so cap the
    // steered target at 0.7 * (halfWidth - 1) to leave a safety margin.
    const safeLateral = Math.max(0, halfWidth - 1) * 0.7;
    const laneShift = agent.laneChoice * LANE_EXPLORE_DELTA;
    const targetLateral = Math.max(
      -safeLateral,
      Math.min(safeLateral, homeOffset + laneShift),
    );
    const latError = targetLateral - racer.lateralOffset;
    const steerDeadband = 0.18;
    agent.input.steerLeft = latError < -steerDeadband;
    agent.input.steerRight = latError > steerDeadband;

    // Throttle on by default; brake when approaching a lower top-speed section.
    // Easy bots occasionally release throttle to feel human-paced.
    const lookAheadU = Math.min(0.999, racer.trackU + 0.012);
    const nextTopSpeed = this.track.getTopSpeedAt(lookAheadU);
    const throttleHiccup = profile.throttleDropoutChance > 0
      && Math.random() < profile.throttleDropoutChance;
    agent.input.throttle = !throttleHiccup;
    agent.input.brake = racer.speed > nextTopSpeed * profile.brakeThresholdRatio;

    // Fire missile. Difficulties that prefer leader targeting pick the best
    // placement in range before falling back to closest-ahead. That keeps
    // combat pressure on the player when they lead.
    if (racer.offensiveItem === "missile" && now >= agent.fireCooldownUntil) {
      const allRacers = [localRacer, ...this.agents.map((a) => a.racer)];
      if (this.pickFireTarget(allRacers, racer, now, profile.preferLeaderTargeting) !== null) {
        agent.pendingFire = true;
        agent.fireCooldownUntil = now + profile.fireCooldownMs;
      }
    }

    // Shield reactively: activate if holding one and shield is due.
    if (racer.defensiveItem === "shield" && now >= agent.shieldCooldownUntil) {
      agent.pendingShield = true;
      agent.shieldCooldownUntil = now + profile.shieldCooldownMs;
    }
  }

  private chooseLane(agent: BotAgent): -1 | 0 | 1 {
    const racer = agent.racer;
    const trackLength = this.track.totalLength || 1;
    const pickupLookAheadU = 60 / trackLength;
    const obstacleLookAheadU = 30 / trackLength;
    const LANE_EXPLORE_DELTA = 4.5;
    const home = agent.config.startLateralOffset;

    const candidates: Array<-1 | 0 | 1> = [-1, 0, 1];
    let best: -1 | 0 | 1 = agent.laneChoice;
    let bestScore = -Infinity;

    for (const lane of candidates) {
      const laneLateral = home + lane * LANE_EXPLORE_DELTA;
      let score = 0;
      if (lane === agent.laneChoice) score += 1; // hysteresis
      if (lane === 0) score += 0.5; // prefer sticking to home when neutral

      for (const pickup of this.pickups) {
        if (pickup.collectedBy) continue;
        const du = pickup.u - racer.trackU;
        if (du <= 0 || du > pickupLookAheadU) continue;
        const pickupLat = pickup.lane * RACE_SIM.NOMINAL_HALF_WIDTH;
        const dist = Math.abs(pickupLat - laneLateral);
        if (dist < 3.5) score += 3;
        else if (dist < 5.5) score += 1.5;
      }

      for (const obj of this.track.getTrackObjects()) {
        if (obj.kind !== "obstacle") continue;
        const du = obj.u - racer.trackU;
        if (du <= 0 || du > obstacleLookAheadU) continue;
        if (Math.abs(obj.lateralOffset - laneLateral) < 2.4) score -= 8;
      }

      if (score > bestScore) {
        bestScore = score;
        best = lane;
      }
    }
    return best;
  }

  private pickFireTarget(
    racers: readonly RaceSimRacer[],
    attacker: RaceSimRacer,
    now: number,
    preferLeader: boolean,
  ): RaceSimRacer | null {
    let leaderTarget: RaceSimRacer | null = null;
    let leaderPlacement = Number.POSITIVE_INFINITY;
    let closestTarget: RaceSimRacer | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of racers) {
      if (candidate.clientId === attacker.clientId) continue;
      if (candidate.finishedAt !== null || candidate.takenDownUntil > now) continue;
      const du = candidate.trackU - attacker.trackU;
      if (du < RACE_SIM.MISSILE_MIN_RANGE_U || du > RACE_SIM.MISSILE_MAX_RANGE_U) continue;
      if (du < closestDistance) {
        closestDistance = du;
        closestTarget = candidate;
      }
      if (candidate.placement < leaderPlacement) {
        leaderPlacement = candidate.placement;
        leaderTarget = candidate;
      }
    }
    if (preferLeader && leaderTarget) return leaderTarget;
    return closestTarget;
  }

  private applyCatchup(agent: BotAgent, leaderTrackU: number): void {
    const profile = agent.profile;
    const gap = leaderTrackU - agent.racer.trackU;
    if (gap <= profile.catchupDeadZoneU
      || profile.catchupMaxThrustMultiplier <= 1
      || agent.racer.finishedAt !== null
      || agent.racer.takenDownUntil > 0) {
      agent.vehicleController.setCatchupBonus(1, 0);
      return;
    }
    const span = Math.max(1e-5, profile.catchupMaxGapU - profile.catchupDeadZoneU);
    const factor = Math.min(1, (gap - profile.catchupDeadZoneU) / span);
    const thrust = 1 + (profile.catchupMaxThrustMultiplier - 1) * factor;
    const topSpeed = profile.catchupMaxTopSpeedBonus * factor;
    agent.vehicleController.setCatchupBonus(thrust, topSpeed);
  }
}

/** Build bot configs distributed across starting lanes. Callsigns are drawn
 * from BOT_CALLSIGNS via a seeded shuffle so the same race seed produces the
 * same grid each retry. */
export function buildBotConfigs(
  count: number,
  variants: readonly CarVariant[],
  startTrackU: number,
  difficulty: BotDifficulty,
  seed: number,
): BotConfig[] {
  const configs: BotConfig[] = [];
  // Grid of 4 lanes per row, rows staggered backward so cars don't overlap.
  // Local player takes pole at lane 0; bots fill the flanking lanes and rows behind.
  // Edges kept inside the wall-proximity speed-penalty zone (edgeRatio < 0.7) so
  // outer-lane bots don't bleed speed simply by holding their home lane.
  const LANE_OFFSETS = [-6.5, -2.5, 2.5, 6.5];
  const ROW_U_OFFSET = 0.00028;
  const rng = mulberry32(seed ^ 0xb07c0de);
  const callsignPool = [...BOT_CALLSIGNS];
  for (let i = callsignPool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [callsignPool[i], callsignPool[j]] = [callsignPool[j], callsignPool[i]];
  }
  for (let i = 0; i < count; i += 1) {
    const variant = variants[i % variants.length] ?? "vector";
    const row = Math.floor(i / LANE_OFFSETS.length);
    const lateralOffset = LANE_OFFSETS[i % LANE_OFFSETS.length];
    const rowTrackU = Math.max(0.0002, startTrackU - row * ROW_U_OFFSET);
    configs.push({
      clientId: `bot-${i + 1}`,
      name: callsignPool[i % callsignPool.length] ?? `Pilot ${i + 2}`,
      carVariant: variant,
      startTrackU: rowTrackU,
      startLateralOffset: lateralOffset,
      difficulty,
    });
  }
  return configs;
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

export type { BotConfig };
