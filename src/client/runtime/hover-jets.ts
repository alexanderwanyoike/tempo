import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  NormalBlending,
  Points,
  ShaderMaterial,
  type Object3D,
} from "three";

// Local-space positions of the four hover engines relative to the car's
// bodyPivot. Particles spawn at these points and stream downward.
const HOVER_EMITTERS: Array<[number, number, number]> = [
  [-0.72, -0.3, 1.35],
  [0.72, -0.3, 1.35],
  [-0.72, -0.3, -1.35],
  [0.72, -0.3, -1.35],
];

// Deliberately sparse: with additive blending + scene bloom the old dense
// cloud saturated into a single white blob. Fewer, smaller particles read as
// discrete droplets streaming down from the engines.
const PARTICLES_PER_EMITTER = 10;
const PARTICLE_COUNT = HOVER_EMITTERS.length * PARTICLES_PER_EMITTER;
const PARTICLE_LIFETIME_MIN = 0.22;
const PARTICLE_LIFETIME_MAX = 0.38;
const BASE_DOWNWARD_SPEED = 3.4;
const LATERAL_SPREAD = 0.22;
const GRAVITY_Y = -3.5;
const POINT_BASE_SIZE = 10;

const HOVER_VERTEX = `
  attribute float aLife;
  uniform float uPointSize;
  varying float vLife;
  void main() {
    vLife = clamp(aLife, 0.0, 1.0);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float distScale = 300.0 / -mvPosition.z;
    gl_PointSize = uPointSize * vLife * distScale;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const HOVER_FRAGMENT = `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying float vLife;
  void main() {
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord) * 2.0;
    if (dist > 1.0) discard;
    float core = pow(1.0 - dist, 1.6);
    float alpha = core * vLife * uIntensity;
    // Hot centre, cooler toward the outside, so each particle reads as a
    // droplet with a visible rim rather than a fuzzy glow.
    vec3 tint = mix(uColor, vec3(1.0), core * 0.5);
    gl_FragColor = vec4(tint, alpha);
  }
`;

/**
 * Particle-jet exhaust under each of a car's four hover engines. Each
 * particle spawns at a random emitter, drifts downward with a little lateral
 * spread, and fades as it ages. Tinted with the car variant's accent colour
 * so each car has its own signature hover plume.
 */
export class HoverJets {
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly points: Points;
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly lives: Float32Array;
  private readonly ageSeconds: Float32Array;
  private readonly lifetimeSeconds: Float32Array;
  private readonly emitterIndices: Uint8Array;

  constructor(color: Color) {
    this.positions = new Float32Array(PARTICLE_COUNT * 3);
    this.velocities = new Float32Array(PARTICLE_COUNT * 3);
    this.lives = new Float32Array(PARTICLE_COUNT);
    this.ageSeconds = new Float32Array(PARTICLE_COUNT);
    this.lifetimeSeconds = new Float32Array(PARTICLE_COUNT);
    this.emitterIndices = new Uint8Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      this.emitterIndices[i] = i % HOVER_EMITTERS.length;
      // Stagger lifetimes so particles don't all respawn on the same frame.
      this.lifetimeSeconds[i] = randRange(PARTICLE_LIFETIME_MIN, PARTICLE_LIFETIME_MAX);
      this.ageSeconds[i] = Math.random() * this.lifetimeSeconds[i];
      this.respawn(i);
    }

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("aLife", new BufferAttribute(this.lives, 1));
    this.geometry.boundingSphere = null;
    this.geometry.boundingBox = null;

    this.material = new ShaderMaterial({
      uniforms: {
        uColor: { value: color.clone() },
        uIntensity: { value: 1 },
        uPointSize: { value: POINT_BASE_SIZE },
      },
      vertexShader: HOVER_VERTEX,
      fragmentShader: HOVER_FRAGMENT,
      transparent: true,
      depthWrite: false,
      // NormalBlending (not additive) so overlapping particles don't stack
      // into a saturated white blob once bloom post-processing hits them.
      blending: NormalBlending,
    });

    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  get object(): Object3D {
    return this.points;
  }

  attachTo(parent: Group): void {
    parent.add(this.points);
  }

  detachFrom(parent: Group): void {
    parent.remove(this.points);
  }

  /**
   * Per-frame update. Advances each particle's age, recycles expired ones
   * back to their emitter, and refreshes the GPU buffers.
   */
  update(deltaSeconds: number, speedRatio: number, boostMultiplier: number): void {
    const dt = Math.min(deltaSeconds, 1 / 20);
    const boost = Math.max(0, boostMultiplier - 1);
    // Keep intensity modest — NormalBlending + bloom still amplifies these.
    this.material.uniforms.uIntensity.value = 0.55 + speedRatio * 0.2 + boost * 0.5;
    this.material.uniforms.uPointSize.value = POINT_BASE_SIZE + speedRatio * 3 + boost * 6;

    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      this.ageSeconds[i] += dt;
      if (this.ageSeconds[i] >= this.lifetimeSeconds[i]) {
        this.respawn(i);
        continue;
      }
      const ix = i * 3;
      this.velocities[ix + 1] += GRAVITY_Y * dt;
      this.positions[ix] += this.velocities[ix] * dt;
      this.positions[ix + 1] += this.velocities[ix + 1] * dt;
      this.positions[ix + 2] += this.velocities[ix + 2] * dt;
      // Life = 1 at spawn, decaying to 0 at end of lifetime.
      this.lives[i] = 1 - this.ageSeconds[i] / this.lifetimeSeconds[i];
    }

    (this.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("aLife") as BufferAttribute).needsUpdate = true;
  }

  setColor(color: Color): void {
    (this.material.uniforms.uColor.value as Color).copy(color);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private respawn(index: number): void {
    const emitterIndex = this.emitterIndices[index];
    const [ex, ey, ez] = HOVER_EMITTERS[emitterIndex];
    const ix = index * 3;
    // Slight jitter around the emitter so particles don't all emit from a
    // single point.
    const jitterX = (Math.random() - 0.5) * 0.12;
    const jitterZ = (Math.random() - 0.5) * 0.12;
    this.positions[ix] = ex + jitterX;
    this.positions[ix + 1] = ey;
    this.positions[ix + 2] = ez + jitterZ;
    // Velocity is mostly downward with a little lateral / rearward spread.
    this.velocities[ix] = (Math.random() - 0.5) * LATERAL_SPREAD;
    this.velocities[ix + 1] = -BASE_DOWNWARD_SPEED - Math.random() * 0.6;
    this.velocities[ix + 2] = (Math.random() - 0.5) * LATERAL_SPREAD;
    this.lifetimeSeconds[index] = randRange(PARTICLE_LIFETIME_MIN, PARTICLE_LIFETIME_MAX);
    this.ageSeconds[index] = 0;
    this.lives[index] = 1;
  }
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
