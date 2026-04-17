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
};

// The human player's default VehicleController runs topSpeed 90. Keeping bots
// within a window around that floor keeps races winnable: Easy bots are
// visibly slower so the player naturally pulls ahead, Medium bots are roughly
// matched, Hard bots edge slightly above so the player has to race well to
// win, but not so far above that a takedown means the race is over.
const DIFFICULTY_PROFILES: Record<BotDifficulty, DifficultyProfile> = {
  easy: {
    topSpeed: 74,
    thrust: 48,
    steeringRate: 48,
    steeringResponse: 12,
    lateralGrip: 2.8,
    laneHoldMinMs: 1700,
    laneHoldJitterMs: 900,
    fireCooldownMs: 1200,
    shieldCooldownMs: 3200,
    brakeThresholdRatio: 1.02,
    throttleDropoutChance: 0.14,
  },
  medium: {
    topSpeed: 86,
    thrust: 56,
    steeringRate: 60,
    steeringResponse: 15,
    lateralGrip: 3.2,
    laneHoldMinMs: 1100,
    laneHoldJitterMs: 600,
    fireCooldownMs: 520,
    shieldCooldownMs: 1600,
    brakeThresholdRatio: 1.12,
    throttleDropoutChance: 0.04,
  },
  hard: {
    topSpeed: 94,
    thrust: 62,
    steeringRate: 66,
    steeringResponse: 18,
    lateralGrip: 3.5,
    laneHoldMinMs: 850,
    laneHoldJitterMs: 450,
    fireCooldownMs: 320,
    shieldCooldownMs: 900,
    brakeThresholdRatio: 1.18,
    throttleDropoutChance: 0,
  },
};

const TICK_INTERVAL_MS = 100;
const LANE_FRACTION = 0.55;

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

function tuningForDifficulty(profile: DifficultyProfile): VehicleTuning {
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
      const vc = new VehicleController(tuningForDifficulty(profile));
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
    for (const agent of this.agents) {
      if (agent.racer.finishedAt !== null || agent.racer.takenDownUntil > now) {
        resetInput(agent.input);
      } else {
        this.driveAI(agent, localRacer, now);
      }
      agent.vehicleController.update(deltaSeconds, agent.input);
      // Sync simulator racer from physics truth
      const s = agent.vehicleController.state;
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
        const events = simResolveFire(allRacers, agent.racer, now);
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
    const targetLateral = agent.laneChoice * halfWidth * LANE_FRACTION;
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

    // Fire missile at the closest valid target ahead.
    if (racer.offensiveItem === "missile" && now >= agent.fireCooldownUntil) {
      const allRacers = [localRacer, ...this.agents.map((a) => a.racer)];
      if (this.hasFireTarget(allRacers, racer, now)) {
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
    const pickupLookAheadU = 40 / trackLength;
    const obstacleLookAheadU = 24 / trackLength;
    const halfWidth = this.track.getHalfWidthAt(racer.trackU);

    const candidates: Array<-1 | 0 | 1> = [-1, 0, 1];
    let best: -1 | 0 | 1 = agent.laneChoice;
    let bestScore = -Infinity;

    for (const lane of candidates) {
      const laneLateral = lane * halfWidth * LANE_FRACTION;
      let score = 0;
      if (lane === agent.laneChoice) score += 1; // hysteresis

      for (const pickup of this.pickups) {
        if (pickup.collectedBy) continue;
        const du = pickup.u - racer.trackU;
        if (du <= 0 || du > pickupLookAheadU) continue;
        const pickupLat = pickup.lane * RACE_SIM.NOMINAL_HALF_WIDTH;
        if (Math.abs(pickupLat - laneLateral) < 4) score += 2;
      }

      for (const obj of this.track.getTrackObjects()) {
        if (obj.kind !== "obstacle") continue;
        const du = obj.u - racer.trackU;
        if (du <= 0 || du > obstacleLookAheadU) continue;
        if (Math.abs(obj.lateralOffset - laneLateral) < 2.2) score -= 6;
      }

      if (score > bestScore) {
        bestScore = score;
        best = lane;
      }
    }
    return best;
  }

  private hasFireTarget(
    racers: readonly RaceSimRacer[],
    attacker: RaceSimRacer,
    now: number,
  ): boolean {
    for (const candidate of racers) {
      if (candidate.clientId === attacker.clientId) continue;
      if (candidate.finishedAt !== null || candidate.takenDownUntil > now) continue;
      const du = candidate.trackU - attacker.trackU;
      if (du < RACE_SIM.MISSILE_MIN_RANGE_U || du > RACE_SIM.MISSILE_MAX_RANGE_U) continue;
      return true;
    }
    return false;
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
  const laneScale = 3.2;
  const rng = mulberry32(seed ^ 0xb07c0de);
  const callsignPool = [...BOT_CALLSIGNS];
  for (let i = callsignPool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [callsignPool[i], callsignPool[j]] = [callsignPool[j], callsignPool[i]];
  }
  for (let i = 0; i < count; i += 1) {
    const variant = variants[i % variants.length] ?? "vector";
    const lane = (i % 2 === 0 ? 1 : -1) * Math.ceil((i + 1) / 2);
    configs.push({
      clientId: `bot-${i + 1}`,
      name: callsignPool[i % callsignPool.length] ?? `Pilot ${i + 2}`,
      carVariant: variant,
      startTrackU,
      startLateralOffset: Math.max(-10, Math.min(10, lane * laneScale)),
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
