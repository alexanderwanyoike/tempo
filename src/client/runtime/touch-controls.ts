import type { VehicleInputState } from "./input";

type TouchRole = "stick" | "brake" | "fire" | "shield";

export class TouchControls {
  private overlay: HTMLDivElement | null = null;
  private stickBase: HTMLDivElement | null = null;
  private stickKnob: HTMLDivElement | null = null;
  private readonly touches = new Map<number, TouchRole>();

  constructor(
    private readonly inputState: VehicleInputState,
    private readonly steeringSensitivity = 1,
  ) {}

  attach(root: HTMLElement): void {
    if (this.overlay) return;
    this.overlay = this.createOverlayDom();
    root.appendChild(this.overlay);
    this.overlay.addEventListener("touchstart", this.handleTouchStart, { passive: false });
    this.overlay.addEventListener("touchmove", this.handleTouchMove, { passive: false });
    this.overlay.addEventListener("touchend", this.handleTouchEnd, { passive: false });
    this.overlay.addEventListener("touchcancel", this.handleTouchEnd, { passive: false });
  }

  detach(): void {
    if (!this.overlay) return;
    this.overlay.removeEventListener("touchstart", this.handleTouchStart);
    this.overlay.removeEventListener("touchmove", this.handleTouchMove);
    this.overlay.removeEventListener("touchend", this.handleTouchEnd);
    this.overlay.removeEventListener("touchcancel", this.handleTouchEnd);
    this.overlay.remove();
    this.overlay = null;
    this.stickBase = null;
    this.stickKnob = null;
    this.resetState();
  }

  private createOverlayDom(): HTMLDivElement {
    const wrapper = document.createElement("div");
    wrapper.className = "tempo-touch";
    wrapper.style.position = "fixed";
    wrapper.style.inset = "0";
    wrapper.style.zIndex = "25";
    wrapper.style.pointerEvents = "none";

    const stickArea = document.createElement("div");
    stickArea.className = "tempo-touch-stick-area";
    stickArea.dataset.role = "stick";
    stickArea.style.position = "absolute";
    stickArea.style.left = "18px";
    stickArea.style.bottom = "18px";
    stickArea.style.width = "144px";
    stickArea.style.height = "144px";
    stickArea.style.pointerEvents = "auto";

    const stickBase = document.createElement("div");
    stickBase.className = "tempo-touch-stick-base";
    stickBase.style.position = "absolute";
    stickBase.style.inset = "0";
    stickBase.style.borderRadius = "999px";
    stickBase.style.border = "1px solid rgba(130, 232, 255, 0.24)";
    stickBase.style.background = "rgba(4, 8, 14, 0.42)";
    stickBase.style.backdropFilter = "blur(10px)";

    const stickKnob = document.createElement("div");
    stickKnob.className = "tempo-touch-stick-knob";
    stickKnob.style.position = "absolute";
    stickKnob.style.left = "50%";
    stickKnob.style.top = "50%";
    stickKnob.style.width = "64px";
    stickKnob.style.height = "64px";
    stickKnob.style.marginLeft = "-32px";
    stickKnob.style.marginTop = "-32px";
    stickKnob.style.borderRadius = "999px";
    stickKnob.style.background = "rgba(120, 230, 255, 0.24)";
    stickKnob.style.border = "1px solid rgba(160, 245, 255, 0.55)";
    stickKnob.style.boxShadow = "0 0 24px rgba(120, 230, 255, 0.2)";

    stickBase.appendChild(stickKnob);
    stickArea.appendChild(stickBase);

    const brake = document.createElement("button");
    brake.className = "tempo-touch-brake";
    brake.type = "button";
    brake.dataset.role = "brake";
    brake.textContent = "BRAKE";
    this.styleActionButton(brake, {
      right: "18px",
      bottom: "18px",
      accent: "#ff9a7a",
    });

    const fire = document.createElement("button");
    fire.type = "button";
    fire.dataset.role = "fire";
    fire.textContent = "FIRE";
    this.styleActionButton(fire, {
      right: "18px",
      bottom: "92px",
      accent: "#ff5d84",
    });

    const shield = document.createElement("button");
    shield.type = "button";
    shield.dataset.role = "shield";
    shield.textContent = "SHIELD";
    this.styleActionButton(shield, {
      right: "18px",
      bottom: "166px",
      accent: "#7ce7ff",
    });

    wrapper.appendChild(stickArea);
    wrapper.appendChild(shield);
    wrapper.appendChild(fire);
    wrapper.appendChild(brake);

    this.stickBase = stickBase;
    this.stickKnob = stickKnob;
    return wrapper;
  }

  private readonly handleTouchStart = (event: TouchEvent): void => {
    let consumed = false;
    for (const touch of Array.from(event.changedTouches)) {
      const role = this.resolveRole(touch.target);
      if (role === "stick") {
        this.touches.set(touch.identifier, "stick");
        this.updateStickFromTouch(touch);
        consumed = true;
      } else if (role === "brake") {
        this.touches.set(touch.identifier, "brake");
        this.inputState.brake = true;
        consumed = true;
      } else if (role === "fire") {
        this.touches.set(touch.identifier, "fire");
        this.inputState.fire = true;
        consumed = true;
      } else if (role === "shield") {
        this.touches.set(touch.identifier, "shield");
        this.inputState.shield = true;
        consumed = true;
      }
    }
    if (consumed) event.preventDefault();
  };

  private readonly handleTouchMove = (event: TouchEvent): void => {
    let consumed = false;
    for (const touch of Array.from(event.changedTouches)) {
      const role = this.touches.get(touch.identifier);
      if (role === "stick") {
        this.updateStickFromTouch(touch);
        consumed = true;
      } else if (role === "brake") {
        consumed = true;
      }
    }
    if (consumed) event.preventDefault();
  };

  private readonly handleTouchEnd = (event: TouchEvent): void => {
    let consumed = false;
    for (const touch of Array.from(event.changedTouches)) {
      const role = this.touches.get(touch.identifier);
      if (!role) continue;
      this.touches.delete(touch.identifier);
      consumed = true;
      if (role === "stick") {
        this.inputState.steerLeft = false;
        this.inputState.steerRight = false;
        this.inputState.throttle = false;
        this.resetKnobVisual();
      } else if (role === "brake") {
        this.inputState.brake = false;
      } else if (role === "fire") {
        this.inputState.fire = false;
      } else if (role === "shield") {
        this.inputState.shield = false;
      }
    }
    if (consumed) event.preventDefault();
  };

  private resolveRole(target: EventTarget | null): TouchRole | null {
    if (!(target instanceof HTMLElement)) return null;
    const roleEl = target.closest<HTMLElement>("[data-role]");
    const value = roleEl?.dataset.role;
    return value === "stick" || value === "brake" || value === "fire" || value === "shield" ? value : null;
  }

  private updateStickFromTouch(touch: Touch): void {
    if (!this.stickBase) return;
    const rect = this.stickBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = rect.width / 2;
    const deadZoneScale = 0.3 / Math.max(0.75, Math.min(this.steeringSensitivity, 2.5));
    const deadZone = radius * Math.max(0.16, Math.min(deadZoneScale, 0.34));

    let dx = touch.clientX - cx;
    let dy = touch.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) {
      dx = (dx / dist) * radius;
      dy = (dy / dist) * radius;
    }

    this.inputState.steerLeft = dx < -deadZone;
    this.inputState.steerRight = dx > deadZone;
    this.inputState.throttle = dy < -deadZone;

    if (this.stickKnob) {
      this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  }

  private resetKnobVisual(): void {
    if (this.stickKnob) {
      this.stickKnob.style.transform = "translate(0, 0)";
    }
  }

  private resetState(): void {
    this.touches.clear();
    this.inputState.steerLeft = false;
    this.inputState.steerRight = false;
    this.inputState.throttle = false;
    this.inputState.brake = false;
    this.inputState.fire = false;
    this.inputState.shield = false;
  }

  private styleActionButton(
    button: HTMLButtonElement,
    options: { right: string; bottom: string; accent: string },
  ): void {
    button.style.position = "absolute";
    button.style.right = options.right;
    button.style.bottom = options.bottom;
    button.style.width = "112px";
    button.style.height = "58px";
    button.style.borderRadius = "18px";
    button.style.border = `1px solid ${options.accent}`;
    button.style.background = "rgba(4, 8, 14, 0.62)";
    button.style.backdropFilter = "blur(10px)";
    button.style.boxShadow = "0 0 24px rgba(0, 0, 0, 0.24)";
    button.style.color = options.accent;
    button.style.font = "800 12px/1 system-ui, sans-serif";
    button.style.letterSpacing = "0.14em";
    button.style.textTransform = "uppercase";
    button.style.pointerEvents = "auto";
  }
}
