import {
  AdditiveBlending,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
} from "three";

// Combat visual effects: short-lived Three.js meshes plus one persistent DOM
// overlay for the local takedown flash. Decoupled from the physics/combat
// logic - the server already decided what happened, this layer just makes
// the decisions visible.
//
// The server resolves missile hits instantaneously but now broadcasts a
// fire event for every launch, including misses. The client uses that
// event to animate a short projectile flight from a captured start/end
// position so respawns, disconnects, or scene transitions do not corrupt
// the missile path mid-flight.

const MISSILE_FLIGHT_MS = 360;
const BLOCK_DURATION_MS = 520;
const SHIELD_COLOR = "#6afcff";
const MISSILE_COLOR = "#ff5db8";
const BLOCK_COLOR = "#7ce7ff";

type GetVehicleGroup = (id: string) => Group | null;

type MissileEffect = {
  kind: "missile";
  mesh: Mesh;
  startPosition: Vector3;
  endPosition: Vector3;
  startTime: number;
  duration: number;
  onImpact: () => void;
};

type ImpactEffect = {
  kind: "impact";
  mesh: Mesh;
  material: MeshStandardMaterial;
  startTime: number;
  duration: number;
  fromScale: number;
  toScale: number;
};

type RingEffect = {
  kind: "ring";
  mesh: Mesh;
  material: MeshBasicMaterial;
  startTime: number;
  duration: number;
  fromScale: number;
  toScale: number;
};

type ShieldEffect = {
  kind: "shield";
  mesh: Mesh;
  material: MeshStandardMaterial;
  attachedTo: Group;
  startTime: number;
  duration: number;
};

type CombatEffect = MissileEffect | ImpactEffect | ShieldEffect | RingEffect;

export class CombatVfx {
  private readonly group = new Group();
  private readonly effects: CombatEffect[] = [];
  private readonly flashOverlay: HTMLDivElement;
  private flashDeadline = 0;
  private readonly tmpStart = new Vector3();
  private readonly tmpEnd = new Vector3();
  private readonly tmpDir = new Vector3();
  private readonly tmpQuaternion = new Quaternion();
  private readonly defaultForward = new Vector3(0, 1, 0);

  constructor(
    private readonly scene: Scene,
    private readonly getVehicleGroup: GetVehicleGroup,
    mountRoot: HTMLElement,
  ) {
    this.scene.add(this.group);
    this.flashOverlay = document.createElement("div");
    Object.assign(this.flashOverlay.style, {
      position: "absolute",
      inset: "0",
      background: "radial-gradient(circle at center, rgba(255,60,60,0.55), rgba(255,10,10,0.85))",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 180ms ease-out",
      mixBlendMode: "screen",
      zIndex: "40",
    });
    mountRoot.appendChild(this.flashOverlay);
  }

  dispose(): void {
    for (const effect of this.effects) {
      effect.mesh.removeFromParent();
      if (effect.kind === "missile") {
        (effect.mesh.material as MeshStandardMaterial).dispose();
        effect.mesh.geometry.dispose();
      } else {
        effect.material.dispose();
        effect.mesh.geometry.dispose();
      }
    }
    this.effects.length = 0;
    this.scene.remove(this.group);
    this.flashOverlay.remove();
  }

  spawnMissile(startPosition: Vector3, endPosition: Vector3, onImpact: () => void, now: number): void {
    const geometry = new CapsuleGeometry(0.38, 1.6, 6, 12);
    const material = new MeshStandardMaterial({
      color: MISSILE_COLOR,
      emissive: MISSILE_COLOR,
      emissiveIntensity: 3.2,
      transparent: true,
      opacity: 0.95,
    });
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(startPosition);
    this.group.add(mesh);
    this.effects.push({
      kind: "missile",
      mesh,
      startPosition: startPosition.clone(),
      endPosition: endPosition.clone(),
      startTime: now,
      duration: MISSILE_FLIGHT_MS,
      onImpact,
    });
  }

  spawnImpact(vehicleId: string, now: number): void {
    const target = this.getVehicleGroup(vehicleId);
    const position = target?.position.clone() ?? this.tmpStart.clone();
    const forward = target
      ? new Vector3(0, 0, -1).applyQuaternion(target.quaternion).normalize()
      : new Vector3(0, 0, -1);
    this.spawnCrashBurst(position, forward, now);
  }

  spawnLocalFireBlast(position: Vector3, now: number): void {
    this.pushBurst(position, now, 260, "#ffe27a", 0.4, 3.6, 2.6);
    this.pushRing(position, now, 220, "#fff3a0", 0.75, 3.2, 0.32);
  }

  spawnBlock(vehicleId: string, now: number): void {
    const target = this.getVehicleGroup(vehicleId);
    const position = target?.position.clone() ?? this.tmpStart.clone();
    this.pushBurst(position, now, BLOCK_DURATION_MS, BLOCK_COLOR, 0.7, 6.8, 4.8);
    this.pushBurst(position, now, BLOCK_DURATION_MS * 0.72, "#e9ffff", 0.24, 3.4, 3.6);
    this.pushRing(position, now, 260, BLOCK_COLOR, 0.9, 5.2, 0.44);
  }

  spawnPickupPulse(position: Vector3, forward: Vector3, color: string, now: number): void {
    this.pushBurst(position, now, 260, color, 0.38, 3.8, 3.8);
    this.pushBurst(position.clone().addScaledVector(forward, 1.3), now, 180, "#f6fff2", 0.18, 2.4, 5.4);
    this.pushRing(position, now, 280, color, 0.64, 4.8, 0.38);
  }

  spawnCrashBurst(position: Vector3, forward: Vector3, now: number): void {
    this.pushBurst(position, now, 170, "#fff1d0", 0.26, 2.2, 6.4);
    this.pushBurst(position, now, 340, "#ff915e", 0.28, 6.6, 4.2);
    this.pushBurst(position.clone().addScaledVector(forward, 1.1), now, 240, MISSILE_COLOR, 0.22, 3.8, 4.6);
    this.pushRing(position, now, 320, "#ff915e", 0.72, 6.1, 0.48);
  }

  spawnShield(vehicleId: string, durationMs: number, now: number): void {
    const attachedTo = this.getVehicleGroup(vehicleId);
    if (!attachedTo) return;
    // If an earlier shield is still on this car, expire it so we do not
    // accumulate overlapping bubbles.
    for (const effect of this.effects) {
      if (effect.kind === "shield" && effect.attachedTo === attachedTo) {
        effect.startTime = now - effect.duration;
      }
    }
    const geometry = new SphereGeometry(4.2, 28, 20);
    const material = new MeshStandardMaterial({
      color: SHIELD_COLOR,
      emissive: SHIELD_COLOR,
      emissiveIntensity: 2.3,
      transparent: true,
      opacity: 0.5,
      side: DoubleSide,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const mesh = new Mesh(geometry, material);
    attachedTo.add(mesh);
    this.effects.push({
      kind: "shield",
      mesh,
      material,
      attachedTo,
      startTime: now,
      duration: durationMs,
    });
  }

  clearShield(vehicleId: string): void {
    const attachedTo = this.getVehicleGroup(vehicleId);
    if (!attachedTo) return;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i];
      if (effect.kind !== "shield" || effect.attachedTo !== attachedTo) continue;
      effect.attachedTo.remove(effect.mesh);
      effect.material.dispose();
      effect.mesh.geometry.dispose();
      this.effects.splice(i, 1);
    }
  }

  flashLocalTakedown(now: number): void {
    this.flashOverlay.style.opacity = "0.7";
    this.flashDeadline = now + 220;
  }

  update(now: number): void {
    if (this.flashDeadline && now >= this.flashDeadline) {
      this.flashOverlay.style.opacity = "0";
      this.flashDeadline = 0;
    }

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i];
      const elapsed = now - effect.startTime;
      const t = Math.min(1, elapsed / effect.duration);

      if (effect.kind === "missile") {
        this.tmpStart.copy(effect.startPosition);
        this.tmpEnd.copy(effect.endPosition);
        // Arc upward slightly so the projectile is readable even when the
        // target is directly ahead.
        const arc = Math.sin(t * Math.PI) * 1.6;
        effect.mesh.position
          .copy(this.tmpStart)
          .lerp(this.tmpEnd, t)
          .addScaledVector(this.defaultForward, arc);
        this.tmpDir.copy(this.tmpEnd).sub(this.tmpStart);
        if (this.tmpDir.lengthSq() > 1e-4) {
          this.tmpDir.normalize();
          this.tmpQuaternion.setFromUnitVectors(this.defaultForward, this.tmpDir);
          effect.mesh.quaternion.copy(this.tmpQuaternion);
        }
        if (t >= 1) {
          effect.mesh.removeFromParent();
          (effect.mesh.material as MeshStandardMaterial).dispose();
          effect.mesh.geometry.dispose();
          effect.onImpact();
          this.effects.splice(i, 1);
        }
        continue;
      }

      if (effect.kind === "impact") {
        const scale = effect.fromScale + (effect.toScale - effect.fromScale) * t;
        effect.mesh.scale.setScalar(scale);
        effect.material.opacity = (1 - t) * 0.85;
        if (t >= 1) {
          effect.mesh.removeFromParent();
          effect.material.dispose();
          effect.mesh.geometry.dispose();
          this.effects.splice(i, 1);
        }
        continue;
      }

      if (effect.kind === "ring") {
        const scale = effect.fromScale + (effect.toScale - effect.fromScale) * t;
        effect.mesh.scale.set(scale, 1, scale);
        effect.material.opacity = (1 - t) * 0.78;
        if (t >= 1) {
          effect.mesh.removeFromParent();
          effect.material.dispose();
          effect.mesh.geometry.dispose();
          this.effects.splice(i, 1);
        }
        continue;
      }

      if (effect.kind === "shield") {
        // Pulse radius slightly and fade in the last 20% of the duration.
        const pulse = 1 + Math.sin(elapsed * 0.01) * 0.08;
        effect.mesh.scale.setScalar(pulse);
        const fadeStart = 0.8;
        const opacity = t < fadeStart ? 0.5 : 0.5 * (1 - (t - fadeStart) / (1 - fadeStart));
        effect.material.opacity = Math.max(0, opacity);
        if (t >= 1) {
          effect.attachedTo.remove(effect.mesh);
          effect.material.dispose();
          effect.mesh.geometry.dispose();
          this.effects.splice(i, 1);
        }
      }
    }
  }

  private pushBurst(
    position: Vector3,
    now: number,
    duration: number,
    color: string,
    fromScale: number,
    toScale: number,
    emissiveIntensity: number,
  ): void {
    const geometry = new SphereGeometry(1, 20, 14);
    const material = new MeshStandardMaterial({
      color: new Color(color),
      emissive: new Color(color),
      emissiveIntensity,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.scale.setScalar(fromScale);
    this.group.add(mesh);
    this.effects.push({
      kind: "impact",
      mesh,
      material,
      startTime: now,
      duration,
      fromScale,
      toScale,
    });
  }

  private pushRing(
    position: Vector3,
    now: number,
    duration: number,
    color: string,
    fromScale: number,
    toScale: number,
    yOffset: number,
  ): void {
    const geometry = new CylinderGeometry(1, 1, 0.1, 24, 1, true);
    const material = new MeshBasicMaterial({
      color: new Color(color),
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.position.y += yOffset;
    mesh.scale.set(fromScale, 1, fromScale);
    this.group.add(mesh);
    this.effects.push({
      kind: "ring",
      mesh,
      material,
      startTime: now,
      duration,
      fromScale,
      toScale,
    });
  }
}
