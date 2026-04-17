import type { VehicleInputState } from "./input";

type TouchRole = "stick" | "brake" | "fire" | "shield";
type ArmableRole = "fire" | "shield";

export class TouchControls {
  private overlay: HTMLDivElement | null = null;
  private stickBase: HTMLDivElement | null = null;
  private stickKnob: HTMLDivElement | null = null;
  private readonly roleElements = new Map<TouchRole, HTMLElement>();
  private readonly touches = new Map<number, TouchRole>();
  private readonly armed: Record<ArmableRole, boolean> = { fire: false, shield: false };

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
    this.roleElements.clear();
    this.resetState();
  }

  private createOverlayDom(): HTMLDivElement {
    const wrapper = document.createElement("div");
    wrapper.className = "tempo-touch-overlay";

    const stickArea = document.createElement("div");
    stickArea.className = "tempo-touch-stick-area";
    stickArea.dataset.role = "stick";

    const stickBase = document.createElement("div");
    stickBase.className = "tempo-touch-stick-base";

    const stickKnob = document.createElement("div");
    stickKnob.className = "tempo-touch-stick-knob";

    stickBase.appendChild(stickKnob);
    stickArea.appendChild(stickBase);

    const brake = this.createActionButton("brake", "Brake");
    const fire = this.createActionButton("fire", "Fire");
    const shield = this.createActionButton("shield", "Shield");
    fire.classList.toggle("is-disarmed", !this.armed.fire);
    shield.classList.toggle("is-disarmed", !this.armed.shield);

    wrapper.appendChild(stickArea);
    wrapper.appendChild(shield);
    wrapper.appendChild(fire);
    wrapper.appendChild(brake);

    this.stickBase = stickBase;
    this.stickKnob = stickKnob;
    this.roleElements.set("stick", stickArea);
    this.roleElements.set("brake", brake);
    this.roleElements.set("fire", fire);
    this.roleElements.set("shield", shield);
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
        this.setRoleActive("brake", true);
        consumed = true;
      } else if (role === "fire") {
        if (!this.armed.fire) continue;
        this.touches.set(touch.identifier, "fire");
        this.inputState.fire = true;
        this.setRoleActive("fire", true);
        consumed = true;
      } else if (role === "shield") {
        if (!this.armed.shield) continue;
        this.touches.set(touch.identifier, "shield");
        this.inputState.shield = true;
        this.setRoleActive("shield", true);
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
        this.setRoleActive("brake", false);
      } else if (role === "fire") {
        this.inputState.fire = false;
        this.setRoleActive("fire", false);
      } else if (role === "shield") {
        this.inputState.shield = false;
        this.setRoleActive("shield", false);
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
    this.setRoleActive("stick", true);

    if (this.stickKnob) {
      this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  }

  private resetKnobVisual(): void {
    this.setRoleActive("stick", false);
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
    this.setRoleActive("stick", false);
    this.setRoleActive("brake", false);
    this.setRoleActive("fire", false);
    this.setRoleActive("shield", false);
    this.resetKnobVisual();
  }

  private createActionButton(role: Exclude<TouchRole, "stick">, label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.role = role;
    button.className = `tempo-touch-button tempo-touch-button--${role}`;
    const copy = document.createElement("span");
    copy.className = "tempo-touch-button-label";
    copy.textContent = label;
    button.appendChild(copy);
    return button;
  }

  private setRoleActive(role: TouchRole, active: boolean): void {
    const element = this.roleElements.get(role);
    if (!element) return;
    element.classList.toggle("is-active", active);
  }

  setVisible(visible: boolean): void {
    if (!this.overlay) return;
    this.overlay.style.display = visible ? "" : "none";
    if (!visible) this.resetState();
  }

  setArmed(role: ArmableRole, armed: boolean): void {
    if (this.armed[role] === armed) return;
    this.armed[role] = armed;
    const element = this.roleElements.get(role);
    element?.classList.toggle("is-disarmed", !armed);
    if (!armed) {
      for (const [id, r] of this.touches) {
        if (r === role) this.touches.delete(id);
      }
      this.inputState[role] = false;
      this.setRoleActive(role, false);
    }
  }
}
