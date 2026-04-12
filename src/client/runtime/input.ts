export type VehicleInputState = {
  throttle: boolean;
  brake: boolean;
  steerLeft: boolean;
  steerRight: boolean;
  airbrakeLeft: boolean;
  airbrakeRight: boolean;
  boost: boolean;
  fire: boolean;
  shield: boolean;
};

const bindings: Record<string, keyof VehicleInputState> = {
  ArrowUp: "throttle",
  KeyW: "throttle",
  ArrowDown: "brake",
  KeyS: "brake",
  ArrowLeft: "steerLeft",
  KeyA: "steerLeft",
  ArrowRight: "steerRight",
  KeyD: "steerRight",
  KeyQ: "airbrakeLeft",
  KeyE: "airbrakeRight",
  ShiftLeft: "boost",
  ShiftRight: "boost",
  Space: "fire",
  KeyF: "fire",
  KeyR: "shield",
};

export class VehicleInput {
  readonly state: VehicleInputState = {
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

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    this.setKeyState(event.code, true);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.setKeyState(event.code, false);
  };

  attach(): void {
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
  }

  detach(): void {
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
  }

  private setKeyState(code: string, isPressed: boolean): void {
    const binding = bindings[code];

    if (!binding) {
      return;
    }

    this.state[binding] = isPressed;
  }
}
