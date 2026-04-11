import type { VehicleInputState } from "./input";

type TouchRole = "stick" | "brake";

export class TouchControls {
  private overlay: HTMLDivElement | null = null;
  private stickBase: HTMLDivElement | null = null;
  private stickKnob: HTMLDivElement | null = null;
  private readonly touches = new Map<number, TouchRole>();

  constructor(private readonly inputState: VehicleInputState) {}

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

    const stickArea = document.createElement("div");
    stickArea.className = "tempo-touch-stick-area";
    stickArea.dataset.role = "stick";

    const stickBase = document.createElement("div");
    stickBase.className = "tempo-touch-stick-base";

    const stickKnob = document.createElement("div");
    stickKnob.className = "tempo-touch-stick-knob";

    stickBase.appendChild(stickKnob);
    stickArea.appendChild(stickBase);

    const brake = document.createElement("button");
    brake.className = "tempo-touch-brake";
    brake.type = "button";
    brake.dataset.role = "brake";
    brake.textContent = "BRAKE";

    wrapper.appendChild(stickArea);
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
      }
    }
    if (consumed) event.preventDefault();
  };

  private resolveRole(target: EventTarget | null): TouchRole | null {
    if (!(target instanceof HTMLElement)) return null;
    const roleEl = target.closest<HTMLElement>("[data-role]");
    const value = roleEl?.dataset.role;
    return value === "stick" || value === "brake" ? value : null;
  }

  private updateStickFromTouch(touch: Touch): void {
    if (!this.stickBase) return;
    const rect = this.stickBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = rect.width / 2;
    const deadZone = radius * 0.3;

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
  }
}
