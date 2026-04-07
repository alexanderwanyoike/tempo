import { MathUtils, Vector3 } from "three";
import type { VehicleInputState } from "./input";
import type { TestTrack, TrackFrame, TrackQuery } from "./track-builder";

const GRAVITY = 35;
const HALF_WIDTH = 15;

export type TrackQueryFn = (position: Vector3, hintU?: number) => TrackQuery;

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
};

export const defaultVehicleTuning: VehicleTuning = {
  hoverHeight: 0.45,
  thrust: 120,
  topSpeed: 90,
  dragCoefficient: 1.3,
  steeringRate: 45,
  steeringResponse: 12,
  lateralGrip: 5.0,
  airbrakeYawBoost: 30,
  airbrakeDrag: 0.4,
  brakeForce: 35,
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
  };

  lastSafeU = 0.001;
  private elapsedTime = 0;
  private track: TestTrack | null = null;
  private trackQueryFn: TrackQueryFn | null = null;

  constructor(readonly tuning: VehicleTuning = defaultVehicleTuning) {}

  setTrack(track: TestTrack): void {
    this.track = track;
  }

  setTrackQuery(fn: TrackQueryFn): void {
    this.trackQueryFn = fn;
  }

  update(deltaSeconds: number, input: VehicleInputState): void {
    const dt = Math.min(deltaSeconds, 1 / 30);
    if (!this.track) return;

    const s = this.state;
    const t = this.tuning;

    if (s.airborne) {
      this.updateAirborne(dt);
      this.updateVisuals(dt, input);
      return;
    }

    // 1. Steering
    const steerTarget = (input.steerRight ? 1 : 0) - (input.steerLeft ? 1 : 0);
    s.steering = MathUtils.damp(s.steering, steerTarget, t.steeringResponse, dt);

    const absSpeed = Math.abs(s.speed);
    const speedRatio = Math.min(absSpeed / t.topSpeed, 1);
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
    let drag = t.dragCoefficient;
    if (abInput !== 0) drag += t.airbrakeDrag;
    s.speed *= Math.max(0, 1 - drag * dt);

    // 7. Gravity along tangent
    const frame = this.track.getFrameAt(s.trackU);
    s.speed += GRAVITY * (-frame.tangent.y) * dt;

    // 8. Lateral grip
    s.lateralVelocity *= Math.max(0, 1 - t.lateralGrip * dt);

    // 9. Advance along track
    s.trackU += (s.speed * dt) / this.track.totalLength;
    s.trackU = MathUtils.clamp(s.trackU, 0.001, 0.999);

    // 10. Advance lateral
    s.lateralOffset += s.lateralVelocity * dt;

    // 11. Wall collision
    const boundary = HALF_WIDTH - 1.0;
    if (Math.abs(s.lateralOffset) > boundary) {
      s.lateralOffset = MathUtils.clamp(s.lateralOffset, -boundary, boundary);
      if (Math.sign(s.lateralVelocity) === Math.sign(s.lateralOffset)) {
        s.lateralVelocity *= -0.15;
        s.speed *= 0.85;
      }
    }

    // 12. Clamp near-zero
    if (Math.abs(s.speed) < 0.05) s.speed = 0;
    if (Math.abs(s.lateralVelocity) < 0.01) s.lateralVelocity = 0;

    // 13. Derive world position
    this.deriveWorldState();
    this.lastSafeU = s.trackU;

    // 14. Visuals
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

    if (Math.abs(dist) < 2.0 && velToward > 0 && Math.abs(query.lateralOffset) < HALF_WIDTH) {
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
    if (s.position.y < query.center.y - 40 || Math.abs(query.lateralOffset) > HALF_WIDTH * 4) {
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
    const vsr = Math.min(absSpeed / t.topSpeed, 1);

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
  }
}
