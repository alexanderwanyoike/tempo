import { MathUtils, Vector3 } from "three";
import type { VehicleInputState } from "./input";

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

  thrust: 38,
  topSpeed: 32,
  dragCoefficient: 1.2,

  steeringRate: 2.5,
  steeringResponse: 10,

  lateralGrip: 3.5,

  airbrakeYawBoost: 1.8,
  airbrakeDrag: 0.35,

  brakeForce: 22,

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

  constructor(private readonly tuning: VehicleTuning = defaultVehicleTuning) {}

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

    s.visualHoverOffset =
      Math.sin(this.elapsedTime * t.visualHoverFrequency) *
      t.visualHoverAmplitude *
      (0.4 + visualSpeedRatio * 0.6);

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

    // 13. Lock Y to hover height
    s.position.y = t.hoverHeight + s.visualHoverOffset;
  }
}
