import { MathUtils, Vector3 } from "three";
import type { VehicleInputState } from "./input";

export type VehicleTuning = {
  hoverHeight: number;
  maxForwardSpeed: number;
  acceleration: number;
  coastDeceleration: number;
  brakeDeceleration: number;
  minSteerSpeedRatio: number;
  steeringRate: number;
  steeringResponse: number;
  visualHoverAmplitude: number;
  visualHoverFrequency: number;
  visualBankAngle: number;
  visualPitchAngle: number;
};

export type VehicleState = {
  position: Vector3;
  velocity: Vector3;
  forwardSpeed: number;
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
  acceleration: 28,
  coastDeceleration: 6,
  brakeDeceleration: 16,
  minSteerSpeedRatio: 0.18,
  steeringRate: 1.85,
  steeringResponse: 10,
  visualHoverAmplitude: 0.06,
  visualHoverFrequency: 5.5,
  visualBankAngle: 0.4,
  visualPitchAngle: 0.08,
};

export class VehicleController {
  readonly state: VehicleState = {
    position: new Vector3(0, defaultVehicleTuning.hoverHeight, 0),
    velocity: new Vector3(),
    forwardSpeed: 0,
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

    let nextForwardSpeed = this.state.forwardSpeed;

    if (input.throttle) {
      nextForwardSpeed += this.tuning.acceleration * dt;
    } else {
      nextForwardSpeed = Math.max(
        0,
        nextForwardSpeed - this.tuning.coastDeceleration * dt,
      );
    }

    if (input.brake) {
      nextForwardSpeed = Math.max(
        0,
        nextForwardSpeed - this.tuning.brakeDeceleration * dt,
      );
    }

    nextForwardSpeed = Math.min(
      nextForwardSpeed,
      this.tuning.maxForwardSpeed * this.state.boostMultiplier,
    );

    const speedRatio = MathUtils.clamp(nextForwardSpeed / this.tuning.maxForwardSpeed, 0, 1);
    const steeringPower = MathUtils.lerp(this.tuning.minSteerSpeedRatio, 1, speedRatio);
    const yawDelta = this.state.steering * this.tuning.steeringRate * steeringPower * dt;
    this.state.yaw += yawDelta;

    const forward = new Vector3(Math.sin(this.state.yaw), 0, -Math.cos(this.state.yaw));

    this.state.velocity
      .copy(forward)
      .multiplyScalar(nextForwardSpeed);
    this.state.forwardSpeed = nextForwardSpeed;

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
