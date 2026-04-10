import { MathUtils, Vector3 } from "three";
import type { VehicleInputState } from "./input";
import type { Track, TrackQuery } from "./track-builder";

const GRAVITY = 35;
const CURVATURE_SAMPLE_DISTANCE = 8;

export type TrackQueryFn = (position: Vector3, hintU?: number) => TrackQuery;

export type VehicleTuning = {
  hoverHeight: number;
  thrust: number;
  topSpeed: number;
  dragCoefficient: number;
  steeringRate: number;
  steeringResponse: number;
  lateralGrip: number;
  curveLateralForce: number;
  airbrakeYawBoost: number;
  airbrakeDrag: number;
  brakeForce: number;
  visualHoverAmplitude: number;
  visualHoverFrequency: number;
  visualBankAngle: number;
  visualPitchAngle: number;
};

export type VehicleState = {
  // Track-relative (physics truth)
  trackU: number;
  speed: number;
  lateralOffset: number;
  lateralVelocity: number;

  // Derived world-space (for rendering)
  position: Vector3;
  forward: Vector3;
  right: Vector3;
  up: Vector3;

  // Airborne
  airborne: boolean;
  worldVelocity: Vector3;

  // Visual/input
  steering: number;
  visualHoverOffset: number;
  visualBank: number;
  visualPitch: number;
  boostMultiplier: number;
  visualBoost: number;
};

export const defaultVehicleTuning: VehicleTuning = {
  hoverHeight: 0.45,
  thrust: 58,
  topSpeed: 90,
  dragCoefficient: 0.26,
  steeringRate: 62,
  steeringResponse: 16,
  lateralGrip: 3.2,
  curveLateralForce: 0.38,
  airbrakeYawBoost: 44,
  airbrakeDrag: 0.85,
  brakeForce: 42,
  visualHoverAmplitude: 0.06,
  visualHoverFrequency: 5.5,
  visualBankAngle: 0.45,
  visualPitchAngle: 0.08,
};

export class VehicleController {
  readonly state: VehicleState = {
    trackU: 0.001,
    speed: 0,
    lateralOffset: 0,
    lateralVelocity: 0,
    position: new Vector3(),
    forward: new Vector3(0, 0, -1),
    right: new Vector3(1, 0, 0),
    up: new Vector3(0, 1, 0),
    airborne: false,
    worldVelocity: new Vector3(),
    steering: 0,
    visualHoverOffset: 0,
    visualBank: 0,
    visualPitch: 0,
    boostMultiplier: 1,
    visualBoost: 0,
  };

  lastSafeU = 0.001;
  private elapsedTime = 0;
  private track: Track | null = null;
  private trackQueryFn: TrackQueryFn | null = null;
  private effectiveTopSpeed = 90;
  private temporaryBoostTimer = 0;
  private temporaryBoostMultiplier = 1;
  private temporaryTopSpeedBonus = 0;

  get currentTopSpeed(): number {
    return this.effectiveTopSpeed;
  }

  constructor(readonly tuning: VehicleTuning = defaultVehicleTuning) {}

  setTrack(track: Track): void {
    this.track = track;
  }

  setTrackQuery(fn: TrackQueryFn): void {
    this.trackQueryFn = fn;
  }

  applyPickupBoost(multiplier = 1.55, duration = 1.1, topSpeedBonus = 14, speedImpulse = 7): void {
    const s = this.state;
    this.temporaryBoostTimer = Math.max(this.temporaryBoostTimer, duration);
    this.temporaryBoostMultiplier = Math.max(this.temporaryBoostMultiplier, multiplier);
    this.temporaryTopSpeedBonus = Math.max(this.temporaryTopSpeedBonus, topSpeedBonus);
    s.speed += speedImpulse;
  }

  applyObstacleHit(speedScale = 0.38): void {
    const s = this.state;
    s.speed *= speedScale;
    s.lateralVelocity *= -0.45;
    this.temporaryBoostTimer = 0;
    this.temporaryBoostMultiplier = 1;
    this.temporaryTopSpeedBonus = 0;
  }

  update(deltaSeconds: number, input: VehicleInputState): void {
    const dt = Math.min(deltaSeconds, 1 / 30);
    if (!this.track) return;

    const s = this.state;
    const t = this.tuning;

    if (this.temporaryBoostTimer > 0) {
      this.temporaryBoostTimer = Math.max(0, this.temporaryBoostTimer - dt);
      if (this.temporaryBoostTimer === 0) {
        this.temporaryBoostMultiplier = 1;
        this.temporaryTopSpeedBonus = 0;
      }
    }

    const trackBoost = this.track.getBoostAt(s.trackU);
    const activeBoostMultiplier = Math.max(
      trackBoost,
      this.temporaryBoostTimer > 0 ? this.temporaryBoostMultiplier : 1,
    );
    s.boostMultiplier = activeBoostMultiplier;

    // Energy-based effective top speed
    this.effectiveTopSpeed = this.track.getTopSpeedAt(s.trackU)
      + (this.temporaryBoostTimer > 0 ? this.temporaryTopSpeedBonus : 0);

    if (s.airborne) {
      this.updateAirborne(dt);
      this.updateVisuals(dt, input);
      return;
    }

    // 1. Steering
    const steerTarget = (input.steerRight ? 1 : 0) - (input.steerLeft ? 1 : 0);
    s.steering = MathUtils.damp(s.steering, steerTarget, t.steeringResponse, dt);

    const absSpeed = Math.abs(s.speed);
    const speedRatio = Math.min(absSpeed / this.effectiveTopSpeed, 1);
    const steeringPower = MathUtils.lerp(1.0, 0.35, speedRatio);

    // 2. Steering -> lateral velocity
    s.lateralVelocity += s.steering * t.steeringRate * steeringPower * dt;

    // 3. Airbrakes
    const abInput = (input.airbrakeLeft ? -1 : 0) + (input.airbrakeRight ? 1 : 0);
    if (abInput !== 0) {
      s.lateralVelocity += abInput * t.airbrakeYawBoost * dt;
      s.speed *= Math.max(0, 1 - t.airbrakeDrag * dt);
    }

    // 4. Thrust
    if (input.throttle) {
      s.speed += t.thrust * s.boostMultiplier * dt;
    }

    // 5. Brake
    if (input.brake && absSpeed > 0.01) {
      s.speed -= Math.sign(s.speed) * Math.min(t.brakeForce * dt, absSpeed);
    }

    // 6. Drag
    let drag = input.throttle ? t.dragCoefficient * 0.42 : t.dragCoefficient;
    if (abInput !== 0) drag += t.airbrakeDrag;
    const speedDrag = drag * (0.45 + Math.abs(s.speed) * 0.016);
    s.speed *= Math.max(0, 1 - speedDrag * dt);

    // 7. Gravity along tangent
    const frame = this.track.getFrameAt(s.trackU);
    s.speed += GRAVITY * (-frame.tangent.y) * dt;

    // 8. Curve pressure
    const curveAccel = MathUtils.clamp(
      s.speed * s.speed * this.getSignedHorizontalCurvature(s.trackU) * t.curveLateralForce,
      -120,
      120,
    );
    s.lateralVelocity += curveAccel * dt;

    // 9. Lateral grip
    s.lateralVelocity *= Math.max(0, 1 - t.lateralGrip * dt);

    // 10. Advance along track
    s.trackU += (s.speed * dt) / this.track.totalLength;
    s.trackU = MathUtils.clamp(s.trackU, 0.001, 0.999);

    // 11. Advance lateral
    s.lateralOffset += s.lateralVelocity * dt;

    // 12. Wall collision (dynamic width)
    const currentHalfWidth = this.track.getHalfWidthAt(s.trackU);
    const boundary = currentHalfWidth - 1.0;
    const edgeRatio = Math.abs(s.lateralOffset) / Math.max(boundary, 1);
    if (edgeRatio > 0.78) {
      s.speed *= Math.max(0, 1 - (edgeRatio - 0.78) * 2.2 * dt);
    }
    if (Math.abs(s.lateralOffset) > boundary) {
      s.lateralOffset = MathUtils.clamp(s.lateralOffset, -boundary, boundary);
      if (Math.sign(s.lateralVelocity) === Math.sign(s.lateralOffset)) {
        s.lateralVelocity *= -0.3;
        s.speed *= 0.55;
      }
    }

    // 13. Clamp near-zero
    if (Math.abs(s.speed) < 0.05) s.speed = 0;
    if (Math.abs(s.lateralVelocity) < 0.01) s.lateralVelocity = 0;

    // 14. Derive world position
    this.deriveWorldState();
    this.lastSafeU = s.trackU;

    // 15. Visuals
    this.updateVisuals(dt, input);
  }

  private deriveWorldState(): void {
    const s = this.state;
    if (!this.track) return;
    const frame = this.track.getFrameAt(s.trackU);
    const center = this.track.getPointAt(s.trackU);

    s.position.copy(center);
    s.position.addScaledVector(frame.right, s.lateralOffset);
    s.position.addScaledVector(frame.up, this.tuning.hoverHeight);

    s.forward.copy(frame.tangent);
    s.right.copy(frame.right);
    s.up.copy(frame.up);
  }

  private getSignedHorizontalCurvature(u: number): number {
    if (!this.track) return 0;

    const sampleU = Math.min(CURVATURE_SAMPLE_DISTANCE / this.track.totalLength, 0.03);
    const u0 = Math.max(0.001, u - sampleU);
    const u1 = Math.min(0.999, u + sampleU);
    const prev = this.track.getFrameAt(u0).tangent;
    const next = this.track.getFrameAt(u1).tangent;
    const up = this.track.getFrameAt(u).up;

    const prevFlat = prev.clone();
    prevFlat.y = 0;
    const nextFlat = next.clone();
    nextFlat.y = 0;
    if (prevFlat.lengthSq() < 1e-6 || nextFlat.lengthSq() < 1e-6) return 0;

    prevFlat.normalize();
    nextFlat.normalize();

    const dot = MathUtils.clamp(prevFlat.dot(nextFlat), -1, 1);
    const angle = Math.acos(dot);
    if (angle < 1e-4) return 0;

    const turnSign = Math.sign(prevFlat.clone().cross(nextFlat).dot(up));
    const arcLength = Math.max((u1 - u0) * this.track.totalLength, CURVATURE_SAMPLE_DISTANCE);
    return turnSign * angle / arcLength;
  }

  private updateAirborne(dt: number): void {
    const s = this.state;
    if (!this.track || !this.trackQueryFn) return;

    s.worldVelocity.y -= GRAVITY * dt;
    s.worldVelocity.multiplyScalar(Math.max(0, 1 - 0.2 * dt));
    s.position.addScaledVector(s.worldVelocity, dt);

    s.speed = s.worldVelocity.length();

    // Try to reattach to track
    const query = this.trackQueryFn(s.position, this.lastSafeU);
    const frame = this.track.getFrameAt(query.u);
    const surfacePos = query.center.clone()
      .addScaledVector(frame.up, this.tuning.hoverHeight);
    const dist = s.position.clone().sub(surfacePos).dot(frame.up);
    const velToward = -s.worldVelocity.dot(frame.up);

    const airHalfWidth = this.track.getHalfWidthAt(query.u);
    if (Math.abs(dist) < 2.0 && velToward > 0 && Math.abs(query.lateralOffset) < airHalfWidth) {
      s.airborne = false;
      s.trackU = query.u;
      s.lateralOffset = query.lateralOffset;
      s.speed = s.worldVelocity.dot(frame.tangent);
      s.lateralVelocity = s.worldVelocity.dot(frame.right);
      this.lastSafeU = query.u;
      this.deriveWorldState();
      return;
    }

    // Fall-off respawn
    if (s.position.y < query.center.y - 40 || Math.abs(query.lateralOffset) > airHalfWidth * 4) {
      s.trackU = this.lastSafeU;
      s.speed = 0;
      s.lateralVelocity = 0;
      s.lateralOffset = 0;
      s.airborne = false;
      s.worldVelocity.set(0, 0, 0);
      this.deriveWorldState();
    }

    // Update orientation for airborne (roughly follow velocity)
    if (s.worldVelocity.length() > 1) {
      s.forward.copy(s.worldVelocity).normalize();
      const tempR = new Vector3().crossVectors(s.forward, new Vector3(0, 1, 0));
      if (tempR.length() > 0.1) {
        s.right.copy(tempR.normalize());
        s.up.crossVectors(s.right, s.forward).normalize();
      }
    }
  }

  private updateVisuals(dt: number, input: VehicleInputState): void {
    const s = this.state;
    const t = this.tuning;
    this.elapsedTime += dt;

    const absSpeed = Math.abs(s.speed);
    const vsr = Math.min(absSpeed / this.effectiveTopSpeed, 1);

    const bobScale = 1 - vsr * 0.85;
    s.visualHoverOffset = Math.sin(this.elapsedTime * t.visualHoverFrequency) * t.visualHoverAmplitude * bobScale;

    const abInput = (input.airbrakeLeft ? -1 : 0) + (input.airbrakeRight ? 1 : 0);
    const isAB = input.airbrakeLeft || input.airbrakeRight;
    const bankInput = s.steering + (isAB ? abInput * 0.6 : 0);
    s.visualBank = -MathUtils.clamp(bankInput, -1.3, 1.3) * t.visualBankAngle * (0.4 + vsr);

    s.visualPitch = MathUtils.clamp(
      ((input.throttle ? -1 : 0) + (input.brake ? 1 : 0)) * t.visualPitchAngle * (0.35 + vsr * 0.65),
      -t.visualPitchAngle, t.visualPitchAngle,
    );

    const boostTarget = this.temporaryBoostTimer > 0 ? 1 : 0;
    s.visualBoost = MathUtils.damp(s.visualBoost, boostTarget, boostTarget > s.visualBoost ? 18 : 7, dt);
  }
}
