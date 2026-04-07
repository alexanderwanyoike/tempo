import { MathUtils, Vector3 } from "three";
import type { VehicleInputState } from "./input";

export type VehicleTuning = {
  hoverHeight: number;
  maxForwardSpeed: number;
  acceleration: number;
  drag: number;
  brakeDrag: number;
  minSteerSpeedRatio: number;
  steeringRate: number;
  steeringResponse: number;
  driftFactor: number;
  driftCorrection: number;
  visualHoverAmplitude: number;
  visualHoverFrequency: number;
  visualBankAngle: number;
  visualPitchAngle: number;
};

export type VehicleState = {
  position: Vector3;
  velocity: Vector3;
  yaw: number;
  steering: number;
  visualHoverOffset: number;
  visualBank: number;
  visualPitch: number;
  boostMultiplier: number;
};

export const defaultVehicleTuning: VehicleTuning = {
  hoverHeight: 0.45,
  maxForwardSpeed: 32,
  acceleration: 22,
  drag: 5,
  brakeDrag: 12,
  minSteerSpeedRatio: 0.2,
  steeringRate: 1.45,
  steeringResponse: 7,
  driftFactor: 0.12,
  driftCorrection: 10,
  visualHoverAmplitude: 0.06,
  visualHoverFrequency: 5.5,
  visualBankAngle: 0.28,
  visualPitchAngle: 0.1,
};

const UP = new Vector3(0, 1, 0);

export class VehicleController {
  readonly state: VehicleState = {
    position: new Vector3(0, defaultVehicleTuning.hoverHeight, 0),
    velocity: new Vector3(),
    yaw: 0,
    steering: 0,
    visualHoverOffset: 0,
    visualBank: 0,
    visualPitch: 0,
    boostMultiplier: 1,
  };

  private elapsedTime = 0;

  constructor(private readonly tuning: VehicleTuning = defaultVehicleTuning) {}

  update(deltaSeconds: number, input: VehicleInputState): void {
    const dt = Math.min(deltaSeconds, 1 / 30);
    const steerTarget = (input.steerRight ? 1 : 0) - (input.steerLeft ? 1 : 0);

    this.state.steering = MathUtils.damp(
      this.state.steering,
      steerTarget,
      this.tuning.steeringResponse,
      dt,
    );

    const forward = new Vector3(Math.sin(this.state.yaw), 0, -Math.cos(this.state.yaw));
    const right = new Vector3().crossVectors(forward, UP).normalize();

    const forwardSpeed = this.state.velocity.dot(forward);
    const throttleForce = input.throttle ? this.tuning.acceleration : 0;
    const drag = input.brake ? this.tuning.brakeDrag : this.tuning.drag;
    const nextForwardSpeed = MathUtils.clamp(
      forwardSpeed + (throttleForce - forwardSpeed * drag) * dt,
      0,
      this.tuning.maxForwardSpeed * this.state.boostMultiplier,
    );

    const speedRatio = MathUtils.clamp(nextForwardSpeed / this.tuning.maxForwardSpeed, 0, 1);
    const steeringPower = MathUtils.lerp(this.tuning.minSteerSpeedRatio, 1, speedRatio);
    const yawDelta = this.state.steering * this.tuning.steeringRate * steeringPower * dt;
    this.state.yaw += yawDelta;

    forward.set(Math.sin(this.state.yaw), 0, -Math.cos(this.state.yaw));
    right.crossVectors(forward, UP).normalize();

    const desiredLateralSpeed =
      this.state.steering * nextForwardSpeed * this.tuning.driftFactor * speedRatio;
    const currentLateralSpeed = this.state.velocity.dot(right);
    const nextLateralSpeed = MathUtils.damp(
      currentLateralSpeed,
      desiredLateralSpeed,
      this.tuning.driftCorrection,
      dt,
    );

    this.state.velocity
      .copy(forward)
      .multiplyScalar(nextForwardSpeed)
      .addScaledVector(right, nextLateralSpeed);

    this.state.position.addScaledVector(this.state.velocity, dt);

    this.elapsedTime += dt;
    this.state.visualHoverOffset =
      Math.sin(this.elapsedTime * this.tuning.visualHoverFrequency) *
      this.tuning.visualHoverAmplitude *
      (0.4 + speedRatio * 0.6);
    this.state.visualBank = -this.state.steering * this.tuning.visualBankAngle * (0.4 + speedRatio);
    this.state.visualPitch = MathUtils.clamp(
      ((input.throttle ? -1 : 0) + (input.brake ? 1 : 0)) *
        this.tuning.visualPitchAngle *
        (0.35 + speedRatio * 0.65),
      -this.tuning.visualPitchAngle,
      this.tuning.visualPitchAngle,
    );

    this.state.position.y = this.tuning.hoverHeight + this.state.visualHoverOffset;
  }
}
