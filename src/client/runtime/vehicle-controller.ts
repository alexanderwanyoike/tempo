import { MathUtils, Vector3 } from "three";
import type { VehicleInputState } from "./input";
import type { TrackQuery } from "./track-builder";

export type TrackQueryFn = (position: Vector3, hintU?: number) => TrackQuery;
export type RespawnFn = (u: number) => { position: Vector3; yaw: number };

const HALF_WIDTH = 15; // must match track-builder TRACK_WIDTH / 2

export type VehicleTuning = {
  hoverHeight: number;

  thrust: number;
  topSpeed: number;
  dragCoefficient: number;

  steeringRate: number;
  steeringResponse: number;

  lateralGrip: number;

  airbrakeYawBoost: number;
  airbrakeDrag: number;

  brakeForce: number;

  visualHoverAmplitude: number;
  visualHoverFrequency: number;
  visualBankAngle: number;
  visualPitchAngle: number;
};

export type VehicleState = {
  position: Vector3;
  velocity: Vector3;
  forwardSpeed: number;
  speed: number;
  yaw: number;
  steering: number;
  visualHoverOffset: number;
  visualBank: number;
  visualPitch: number;
  boostMultiplier: number;
};

export const defaultVehicleTuning: VehicleTuning = {
  hoverHeight: 0.45,

  thrust: 120,
  topSpeed: 90,
  dragCoefficient: 1.3,

  steeringRate: 2.8,
  steeringResponse: 12,

  lateralGrip: 4.0,

  airbrakeYawBoost: 2.2,
  airbrakeDrag: 0.4,

  brakeForce: 35,

  visualHoverAmplitude: 0.06,
  visualHoverFrequency: 5.5,
  visualBankAngle: 0.45,
  visualPitchAngle: 0.08,
};

export class VehicleController {
  readonly state: VehicleState = {
    position: new Vector3(0, defaultVehicleTuning.hoverHeight, 0),
    velocity: new Vector3(),
    forwardSpeed: 0,
    speed: 0,
    yaw: 0,
    steering: 0,
    visualHoverOffset: 0,
    visualBank: 0,
    visualPitch: 0,
    boostMultiplier: 1,
  };

  private elapsedTime = 0;
  private trackQuery: TrackQueryFn | null = null;
  private respawnFn: RespawnFn | null = null;
  lastSafeU = 0;
  private airborne = false;
  private verticalVelocity = 0;
  private lastTrackY = 0;
  private landingCooldown = 0;

  constructor(readonly tuning: VehicleTuning = defaultVehicleTuning) {}

  setTrackQuery(fn: TrackQueryFn): void {
    this.trackQuery = fn;
  }

  setRespawnFn(fn: RespawnFn): void {
    this.respawnFn = fn;
  }

  update(deltaSeconds: number, input: VehicleInputState): void {
    const dt = Math.min(deltaSeconds, 1 / 30);
    const t = this.tuning;
    const s = this.state;

    // 1. Steering input smoothing
    const steerTarget = (input.steerRight ? 1 : 0) - (input.steerLeft ? 1 : 0);
    s.steering = MathUtils.damp(s.steering, steerTarget, t.steeringResponse, dt);

    // 2. Speed-dependent steering: full at low speed, reduced at high speed
    const currentSpeed = s.velocity.length();
    const speedRatio = Math.min(currentSpeed / t.topSpeed, 1);
    const steeringPower = MathUtils.lerp(1.0, 0.35, speedRatio);

    // 3. Airbrake yaw boost
    const airbrakeInput = (input.airbrakeLeft ? -1 : 0) + (input.airbrakeRight ? 1 : 0);
    const isAirbraking = input.airbrakeLeft || input.airbrakeRight;

    let yawRate = s.steering * t.steeringRate * steeringPower;
    if (isAirbraking) {
      yawRate += airbrakeInput * t.airbrakeYawBoost;
    }
    s.yaw -= yawRate * dt;

    // 4. Heading vector
    const forward = new Vector3(-Math.sin(s.yaw), 0, -Math.cos(s.yaw));

    // 5. Thrust along heading
    if (input.throttle) {
      s.velocity.addScaledVector(forward, t.thrust * s.boostMultiplier * dt);
    }

    // 6. Drag (speed-proportional, creates natural terminal velocity)
    let totalDrag = t.dragCoefficient;
    if (isAirbraking) {
      totalDrag += t.airbrakeDrag;
    }
    const dragFactor = Math.max(0, 1 - totalDrag * dt);
    s.velocity.multiplyScalar(dragFactor);

    // 7. Lateral grip - THE KEY CHANGE
    // Decompose velocity into forward and lateral components
    const forwardDot = s.velocity.dot(forward);
    const forwardComponent = forward.clone().multiplyScalar(forwardDot);
    const lateralComponent = s.velocity.clone().sub(forwardComponent);

    // Dampen lateral component - creates drift/carve feel
    const gripFactor = Math.max(0, 1 - t.lateralGrip * dt);
    lateralComponent.multiplyScalar(gripFactor);

    // Reconstruct velocity
    s.velocity.copy(forwardComponent).add(lateralComponent);

    // 8. Brake along actual velocity direction
    if (input.brake) {
      const speed = s.velocity.length();
      if (speed > 0.01) {
        const reduction = Math.min(t.brakeForce * dt, speed);
        s.velocity.addScaledVector(s.velocity.clone().normalize(), -reduction);
      }
    }

    // 9. Integrate position
    s.position.addScaledVector(s.velocity, dt);

    // 9b. Track interaction: physics-based surface follow, jumps, walls, respawn
    if (this.trackQuery) {
      // Local search using last known u to prevent snapping to wrong segment
      const query = this.trackQuery(s.position, this.lastSafeU);
      const trackSurfaceY = query.center.y + t.hoverHeight;
      const GRAVITY = 35;

      if (this.airborne) {
        // In the air: gravity pulls down
        this.verticalVelocity -= GRAVITY * dt;
        s.position.y += this.verticalVelocity * dt;

        // Land when we drop to track surface (and falling)
        if (s.position.y <= trackSurfaceY && this.verticalVelocity <= 0 &&
            Math.abs(query.lateralOffset) < HALF_WIDTH) {
          this.airborne = false;
          this.verticalVelocity = 0;
          s.position.y = trackSurfaceY;
          this.lastTrackY = trackSurfaceY;
          this.landingCooldown = 0.4; // prevent re-launch on downhill
          this.lastSafeU = query.u;
        }
      } else {
        // Tick down landing cooldown
        if (this.landingCooldown > 0) {
          this.landingCooldown -= dt;
        }

        // On track: compute how fast the surface rises/falls under us
        const surfaceDelta = trackSurfaceY - this.lastTrackY;
        const surfaceVelocity = surfaceDelta / Math.max(dt, 0.001);

        // Go airborne if surface drops away sharply (and not in cooldown)
        if (surfaceVelocity < -15 && s.speed > 15 && this.landingCooldown <= 0) {
          this.airborne = true;
          this.verticalVelocity = Math.max(-surfaceVelocity * 0.3, 5);
        } else {
          // Stick to surface - physics Y is exact, no bob
          s.position.y = trackSurfaceY;
          this.lastSafeU = query.u;
        }

        // Wall collision (only when grounded)
        const boundary = 14.0;
        if (query.hasWalls) {
          const penetration = Math.abs(query.lateralOffset) - boundary;
          if (penetration > 0) {
            const pushDir = query.lateralOffset > 0 ? -1 : 1;
            s.position.addScaledVector(query.right, pushDir * penetration);

            const wallNormal = query.right.clone().multiplyScalar(pushDir);
            const velIntoWall = s.velocity.dot(wallNormal);
            if (velIntoWall < 0) {
              s.velocity.addScaledVector(wallNormal, -velIntoWall);
              s.velocity.multiplyScalar(0.85);
            }
          }
        }
      }

      this.lastTrackY = trackSurfaceY;

      // Fall-off: too far below track or way off to the side
      const tooFarBelow = s.position.y < query.center.y - 30;
      const tooFarAway = Math.abs(query.lateralOffset) > HALF_WIDTH * 3;

      if ((tooFarBelow || tooFarAway) && this.respawnFn) {
        const spawn = this.respawnFn(this.lastSafeU);
        s.position.copy(spawn.position);
        s.yaw = spawn.yaw;
        s.velocity.set(0, 0, 0);
        s.speed = 0;
        s.forwardSpeed = 0;
        this.airborne = false;
        this.verticalVelocity = 0;
        this.landingCooldown = 0;
      }
    }

    // 10. Derive speed values
    s.forwardSpeed = s.velocity.dot(forward);
    s.speed = s.velocity.length();

    // 11. Clamp near-zero to prevent infinite micro-drift
    if (s.speed < 0.05) {
      s.velocity.set(0, 0, 0);
      s.speed = 0;
      s.forwardSpeed = 0;
    }

    // 12. Visual effects
    this.elapsedTime += dt;
    const visualSpeedRatio = Math.min(s.speed / t.topSpeed, 1);

    // Hover bob fades out at high speed to prevent shaking
    const bobScale = 1 - visualSpeedRatio * 0.85;
    s.visualHoverOffset =
      Math.sin(this.elapsedTime * t.visualHoverFrequency) *
      t.visualHoverAmplitude *
      bobScale;

    // Bank: blend steering and airbrake input
    const totalBankInput = s.steering + (isAirbraking ? airbrakeInput * 0.6 : 0);
    s.visualBank =
      -MathUtils.clamp(totalBankInput, -1.3, 1.3) *
      t.visualBankAngle *
      (0.4 + visualSpeedRatio);

    s.visualPitch = MathUtils.clamp(
      ((input.throttle ? -1 : 0) + (input.brake ? 1 : 0)) *
        t.visualPitchAngle *
        (0.35 + visualSpeedRatio * 0.65),
      -t.visualPitchAngle,
      t.visualPitchAngle,
    );

    // 13. Lock Y to hover height (fallback when no track query)
    if (!this.trackQuery) {
      s.position.y = t.hoverHeight;
    }
  }
}
