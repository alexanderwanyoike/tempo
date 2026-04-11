import {
  AdditiveBlending,
  CapsuleGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
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
// The server's handleFire() resolves missile hits instantaneously, so there
// is no server "fire" event with a projectile origin. Instead the client
// animates the missile retroactively on takedown/blocked events: when the
// event arrives, a ~350ms projectile flight is spawned from the actor to
// the target, and the impact (hit burst or shield block burst) is triggered
// at the end of the flight. The tiny visual/audio lead is acceptable and
// cheaper than adding a separate fire broadcast.

const MISSILE_FLIGHT_MS = 360;
const IMPACT_DURATION_MS = 560;
const BLOCK_DURATION_MS = 320;
const SHIELD_COLOR = "#6afcff";
const MISSILE_COLOR = "#ff5db8";
const BLOCK_COLOR = "#7ce7ff";

type GetVehicleGroup = (id: string) => Group | null;

type MissileEffect = {
  kind: "missile";
  mesh: Mesh;
  actorId: string;
  targetId: string;
  startTime: number;
  duration: number;
  onImpact: () => void;
  fired: boolean;
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

type ShieldEffect = {
  kind: "shield";
  mesh: Mesh;
  material: MeshStandardMaterial;
  attachedTo: Group;
  startTime: number;
  duration: number;
};

type CombatEffect = MissileEffect | ImpactEffect | ShieldEffect;

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

  spawnMissile(actorId: string, targetId: string, onImpact: () => void, now: number): void {
    const actorGroup = this.getVehicleGroup(actorId);
    if (!actorGroup) {
      // Firer is off-scene (respawning, left the room). Fire the impact
      // immediately so the downstream feedback still plays.
      onImpact();
      return;
    }
    const geometry = new CapsuleGeometry(0.38, 1.6, 6, 12);
    const material = new MeshStandardMaterial({
      color: MISSILE_COLOR,
      emissive: MISSILE_COLOR,
      emissiveIntensity: 3.2,
      transparent: true,
      opacity: 0.95,
    });
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(actorGroup.position);
    this.group.add(mesh);
    this.effects.push({
      kind: "missile",
      mesh,
      actorId,
      targetId,
      startTime: now,
      duration: MISSILE_FLIGHT_MS,
      onImpact,
      fired: true,
    });
  }

  spawnImpact(vehicleId: string, now: number): void {
    const target = this.getVehicleGroup(vehicleId);
    const position = target?.position.clone() ?? this.tmpStart.clone();
    this.pushBurst(position, now, IMPACT_DURATION_MS, MISSILE_COLOR, 0.24, 7.0, 3.4);
  }

  // Local fire feedback fired the instant the player presses F/Space. Shows
  // a bright muzzle burst at the firer's position even when the server
  // resolves the missile to "no valid target" and broadcasts no event.
  spawnLocalFireBlast(vehicleId: string, now: number): void {
    const firer = this.getVehicleGroup(vehicleId);
    if (!firer) return;
    const position = firer.position.clone();
    this.pushBurst(position, now, 260, "#ffe27a", 0.4, 3.6, 2.6);
  }

  spawnBlock(vehicleId: string, now: number): void {
    const target = this.getVehicleGroup(vehicleId);
    const position = target?.position.clone() ?? this.tmpStart.clone();
    this.pushBurst(position, now, BLOCK_DURATION_MS, BLOCK_COLOR, 0.2, 4.2, 2.6);
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
    const geometry = new SphereGeometry(3.4, 24, 16);
    const material = new MeshStandardMaterial({
      color: SHIELD_COLOR,
      emissive: SHIELD_COLOR,
      emissiveIntensity: 1.4,
      transparent: true,
      opacity: 0.34,
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
        const actor = this.getVehicleGroup(effect.actorId);
        const target = this.getVehicleGroup(effect.targetId);
        const start = actor?.position ?? effect.mesh.position;
        const end = target?.position ?? effect.mesh.position;
        this.tmpStart.copy(start);
        this.tmpEnd.copy(end);
        // Arc upward slightly so the projectile is readable even when the
        // target is directly ahead.
        const arc = Math.sin(t * Math.PI) * 1.6;
        effect.mesh.position
          .copy(this.tmpStart)
          .lerp(this.tmpEnd, t)
          .addScaledVector(new Vector3(0, 1, 0), arc);
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

      if (effect.kind === "shield") {
        // Pulse radius slightly and fade in the last 20% of the duration.
        const pulse = 1 + Math.sin(elapsed * 0.012) * 0.04;
        effect.mesh.scale.setScalar(pulse);
        const fadeStart = 0.8;
        const opacity = t < fadeStart ? 0.34 : 0.34 * (1 - (t - fadeStart) / (1 - fadeStart));
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
}
