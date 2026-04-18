import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  NormalBlending,
  Object3D,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from "three";

// Fallback emitter positions used before the car mesh has hydrated or if the
// mesh sampler ends up empty. Four hover pods, matching the design of the
// production GLBs.
const FALLBACK_EMITTERS: Array<[number, number, number]> = [
  [-0.72, -0.1, 1.35],
  [0.72, -0.1, 1.35],
  [-0.72, -0.1, -1.35],
  [0.72, -0.1, -1.35],
];
const FALLBACK_NORMALS: Array<[number, number, number]> = [
  [0, -1, 0],
  [0, -1, 0],
  [0, -1, 0],
  [0, -1, 0],
];

// Prefix identifying manually-placed empty markers in Blender-authored GLBs.
// Each empty's position + local +Y direction (which is Blender's local +Z,
// i.e. the Single Arrow display direction, after the GLTF axis conversion)
// is used as an emitter origin + emit direction.
const EMITTER_NAME_PREFIX = "hover_emitter";

const PARTICLE_COUNT = 220;
const PARTICLE_LIFETIME_MIN = 0.3;
const PARTICLE_LIFETIME_MAX = 0.54;
const EMIT_SPEED = 4.2;
const LATERAL_JITTER = 0.55;
const GRAVITY_Y = -2.2;
const POINT_BASE_SIZE = 10;
const BOTTOM_NORMAL_Y_THRESHOLD = -0.3;
const BACK_NORMAL_Z_THRESHOLD = 0.5;
const EMITTER_SPAWN_RADIUS = 0.06;

// Throttle + boost response curve. Particles spawned while the car is at
// speed or mid-boost get extended lifetimes and higher launch velocity so
// the combined effect is a long, streaked trail.
const SPEED_LIFETIME_SCALE = 1.4; // +140% lifetime at full speedRatio=1
const SPEED_EMIT_SPEED_SCALE = 1.3; // 2.3x launch velocity at full speed
const BOOST_LIFETIME_SCALE = 3.6; // up to +360% lifetime on extreme boost
const BOOST_EMIT_SPEED_SCALE = 3.4; // 4.4x launch speed on extreme boost
const BOOST_GRAVITY_DAMP = 0.9; // gravity drops to ~10% during full boost
const BOOST_JITTER_DAMP = 0.5; // narrower spread during boost for streaks

type ExplicitEmitter = {
  position: Vector3;
  direction: Vector3;
};

const HOVER_VERTEX = `
  attribute float aLife;
  uniform float uPointSize;
  varying float vLife;
  void main() {
    vLife = clamp(aLife, 0.0, 1.0);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float distScale = clamp(40.0 / max(1.0, -mvPosition.z), 0.35, 2.4);
    gl_PointSize = uPointSize * vLife * distScale;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const HOVER_FRAGMENT = `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uHeat;
  varying float vLife;
  void main() {
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord) * 2.0;
    if (dist > 1.0) discard;
    float core = pow(1.0 - dist, 1.8);
    float alpha = core * vLife * uIntensity;
    float whiteMix = pow(core, 4.0) * 0.6 + uHeat * 0.4;
    vec3 tint = mix(uColor, vec3(1.0), clamp(whiteMix, 0.0, 1.0));
    gl_FragColor = vec4(tint, alpha);
  }
`;

/**
 * Surface sampler that walks a mesh tree and collects triangles whose normals
 * face downward or rearward in the car's local space. Sampling yields a point
 * on the collected surface plus its normal so particles emit outward along
 * the actual car geometry.
 */
class SurfaceSampler {
  private readonly trianglePositions: Float32Array;
  private readonly triangleNormals: Float32Array;
  private readonly cumulativeArea: Float32Array;
  private readonly totalArea: number;

  constructor(trianglePositions: number[], triangleNormals: number[], cumulativeArea: number[]) {
    this.trianglePositions = new Float32Array(trianglePositions);
    this.triangleNormals = new Float32Array(triangleNormals);
    this.cumulativeArea = new Float32Array(cumulativeArea);
    this.totalArea = cumulativeArea[cumulativeArea.length - 1] ?? 0;
  }

  get valid(): boolean {
    return this.totalArea > 0;
  }

  sample(positionOut: Vector3, normalOut: Vector3): void {
    if (!this.valid) {
      positionOut.set(0, 0, 0);
      normalOut.set(0, -1, 0);
      return;
    }
    const target = Math.random() * this.totalArea;
    let lo = 0;
    let hi = this.cumulativeArea.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cumulativeArea[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const triangleIndex = lo;
    const pIndex = triangleIndex * 9;
    const nIndex = triangleIndex * 3;

    // Barycentric random point. Fold u>1-v reflection to distribute uniformly.
    let u = Math.random();
    let v = Math.random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const w = 1 - u - v;

    const ax = this.trianglePositions[pIndex];
    const ay = this.trianglePositions[pIndex + 1];
    const az = this.trianglePositions[pIndex + 2];
    const bx = this.trianglePositions[pIndex + 3];
    const by = this.trianglePositions[pIndex + 4];
    const bz = this.trianglePositions[pIndex + 5];
    const cx = this.trianglePositions[pIndex + 6];
    const cy = this.trianglePositions[pIndex + 7];
    const cz = this.trianglePositions[pIndex + 8];

    positionOut.set(
      u * ax + v * bx + w * cx,
      u * ay + v * by + w * cy,
      u * az + v * bz + w * cz,
    );
    normalOut.set(
      this.triangleNormals[nIndex],
      this.triangleNormals[nIndex + 1],
      this.triangleNormals[nIndex + 2],
    );
  }
}

/**
 * Walks the loaded car graph looking for `hover_emitter_*` empties (nodes with
 * no mesh). Returns each one's position + emit direction in the bodyPivot's
 * local space. Emit direction is the empty's local +Y axis in three.js space,
 * which corresponds to Blender's local +Z (Single Arrow display direction)
 * after the Y-up axis conversion performed on GLTF export.
 */
function collectExplicitEmitters(root: Object3D, bodyPivot: Object3D): ExplicitEmitter[] {
  root.updateMatrixWorld(true);
  bodyPivot.updateMatrixWorld(true);
  const pivotInverse = new Matrix4().copy(bodyPivot.matrixWorld).invert();
  const worldPos = new Vector3();
  const worldQuat = new Quaternion();
  const worldScale = new Vector3();
  const emitters: ExplicitEmitter[] = [];

  root.traverse((obj) => {
    if (!obj.name.startsWith(EMITTER_NAME_PREFIX)) return;
    if (obj instanceof Mesh) return;

    obj.matrixWorld.decompose(worldPos, worldQuat, worldScale);
    const positionLocal = worldPos.clone().applyMatrix4(pivotInverse);
    const directionLocal = new Vector3(0, 1, 0).applyQuaternion(worldQuat);
    const rotateOnly = new Matrix4().extractRotation(pivotInverse);
    directionLocal.applyMatrix4(rotateOnly).normalize();
    emitters.push({ position: positionLocal, direction: directionLocal });
  });

  return emitters;
}

function buildSurfaceSampler(root: Object3D, bodyPivot: Object3D): SurfaceSampler {
  root.updateMatrixWorld(true);
  bodyPivot.updateMatrixWorld(true);
  const pivotInverse = new Matrix4().copy(bodyPivot.matrixWorld).invert();

  const triangleToPivot = new Matrix4();
  const normalMatrix = new Matrix3();
  const vA = new Vector3();
  const vB = new Vector3();
  const vC = new Vector3();
  const edgeAB = new Vector3();
  const edgeAC = new Vector3();
  const normal = new Vector3();

  const trianglePositions: number[] = [];
  const triangleNormals: number[] = [];
  const cumulativeArea: number[] = [];
  let areaSoFar = 0;

  root.traverse((obj) => {
    if (!(obj instanceof Mesh)) return;
    if (obj.name === "tempo-car-outline") return;
    const geometry = obj.geometry;
    if (!geometry.attributes.position) return;

    triangleToPivot.multiplyMatrices(pivotInverse, obj.matrixWorld);
    normalMatrix.getNormalMatrix(triangleToPivot);

    const posAttr = geometry.attributes.position;
    const indexAttr = geometry.index;
    const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;

    for (let t = 0; t < triCount; t += 1) {
      const i0 = indexAttr ? indexAttr.getX(t * 3) : t * 3;
      const i1 = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

      vA.fromBufferAttribute(posAttr, i0).applyMatrix4(triangleToPivot);
      vB.fromBufferAttribute(posAttr, i1).applyMatrix4(triangleToPivot);
      vC.fromBufferAttribute(posAttr, i2).applyMatrix4(triangleToPivot);

      edgeAB.subVectors(vB, vA);
      edgeAC.subVectors(vC, vA);
      normal.crossVectors(edgeAB, edgeAC);
      const areaTwice = normal.length();
      if (areaTwice < 1e-6) continue;
      const area = areaTwice * 0.5;
      normal.multiplyScalar(1 / areaTwice);

      const facesDown = normal.y < BOTTOM_NORMAL_Y_THRESHOLD;
      const facesBack = normal.z > BACK_NORMAL_Z_THRESHOLD;
      if (!facesDown && !facesBack) continue;

      trianglePositions.push(vA.x, vA.y, vA.z, vB.x, vB.y, vB.z, vC.x, vC.y, vC.z);
      triangleNormals.push(normal.x, normal.y, normal.z);
      areaSoFar += area;
      cumulativeArea.push(areaSoFar);
    }
  });

  return new SurfaceSampler(trianglePositions, triangleNormals, cumulativeArea);
}

/**
 * Particle-jet exhaust anchored to the car. Before the GLB loads, particles
 * emit from four fallback points; once bindToMesh runs they emit from random
 * points on the car's down- and rear-facing surfaces, pushed outward along
 * the surface normal so the jet feels attached to the mesh.
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
  private sampler: SurfaceSampler | null = null;
  private explicitEmitters: ExplicitEmitter[] | null = null;
  private readonly samplePosition = new Vector3();
  private readonly sampleNormal = new Vector3();
  private currentSpeedRatio = 0;
  private currentBoostFactor = 0;

  constructor(color: Color) {
    this.positions = new Float32Array(PARTICLE_COUNT * 3);
    this.velocities = new Float32Array(PARTICLE_COUNT * 3);
    this.lives = new Float32Array(PARTICLE_COUNT);
    this.ageSeconds = new Float32Array(PARTICLE_COUNT);
    this.lifetimeSeconds = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
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
        uHeat: { value: 0 },
      },
      vertexShader: HOVER_VERTEX,
      fragmentShader: HOVER_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    });

    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  attachTo(parent: Group): void {
    parent.add(this.points);
  }

  detachFrom(parent: Group): void {
    parent.remove(this.points);
  }

  /**
   * After the car mesh is loaded + transformed, call this to pick up emitter
   * anchors. Preference order:
   *   1. Manually-placed `hover_emitter_*` empties from the GLB (position +
   *      local +Y direction, which is the Blender Single Arrow direction).
   *   2. Surface sampler over the car's down/rear-facing geometry.
   * If neither yields anything, the hardcoded fallback emitters continue.
   */
  bindToMesh(meshRoot: Object3D, bodyPivot: Object3D): void {
    const explicit = collectExplicitEmitters(meshRoot, bodyPivot);
    if (explicit.length > 0) {
      this.explicitEmitters = explicit;
      this.sampler = null;
      return;
    }
    const sampler = buildSurfaceSampler(meshRoot, bodyPivot);
    if (sampler.valid) this.sampler = sampler;
  }

  update(deltaSeconds: number, speedRatio: number, boostMultiplier: number): void {
    const dt = Math.min(deltaSeconds, 1 / 20);
    const clampedSpeed = Math.min(1, Math.max(0, speedRatio));
    const boostFactor = Math.min(1, Math.max(0, boostMultiplier - 1));
    this.currentSpeedRatio = clampedSpeed;
    this.currentBoostFactor = boostFactor;

    this.material.uniforms.uIntensity.value = 0.9 + clampedSpeed * 0.5 + boostFactor * 1.1;
    this.material.uniforms.uPointSize.value = POINT_BASE_SIZE
      + clampedSpeed * 4
      + boostFactor * 8;
    this.material.uniforms.uHeat.value = boostFactor;

    const gravityScale = 1 - boostFactor * BOOST_GRAVITY_DAMP;
    const gravityPerFrame = GRAVITY_Y * gravityScale * dt;

    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      this.ageSeconds[i] += dt;
      if (this.ageSeconds[i] >= this.lifetimeSeconds[i]) {
        this.respawn(i);
        continue;
      }
      const ix = i * 3;
      this.velocities[ix + 1] += gravityPerFrame;
      this.positions[ix] += this.velocities[ix] * dt;
      this.positions[ix + 1] += this.velocities[ix + 1] * dt;
      this.positions[ix + 2] += this.velocities[ix + 2] * dt;
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
    if (this.explicitEmitters && this.explicitEmitters.length > 0) {
      const emitter = this.explicitEmitters[index % this.explicitEmitters.length];
      const jitterX = (Math.random() - 0.5) * EMITTER_SPAWN_RADIUS;
      const jitterY = (Math.random() - 0.5) * EMITTER_SPAWN_RADIUS;
      const jitterZ = (Math.random() - 0.5) * EMITTER_SPAWN_RADIUS;
      this.samplePosition.set(
        emitter.position.x + jitterX,
        emitter.position.y + jitterY,
        emitter.position.z + jitterZ,
      );
      this.sampleNormal.copy(emitter.direction);
    } else if (this.sampler && this.sampler.valid) {
      this.sampler.sample(this.samplePosition, this.sampleNormal);
    } else {
      const fallbackIndex = index % FALLBACK_EMITTERS.length;
      const [fx, fy, fz] = FALLBACK_EMITTERS[fallbackIndex];
      const [nx, ny, nz] = FALLBACK_NORMALS[fallbackIndex];
      this.samplePosition.set(fx, fy, fz);
      this.sampleNormal.set(nx, ny, nz);
    }

    const ix = index * 3;
    this.positions[ix] = this.samplePosition.x;
    this.positions[ix + 1] = this.samplePosition.y;
    this.positions[ix + 2] = this.samplePosition.z;

    // Emit along the surface normal so particles shoot OUT of the car: bottom
    // surfaces push down, rear surfaces push rearward. Lifetime + launch speed
    // scale with current throttle and boost so the trail stretches when the
    // driver is accelerating and becomes extreme when a boost pad fires.
    const speedBoost = 1
      + this.currentSpeedRatio * SPEED_EMIT_SPEED_SCALE
      + this.currentBoostFactor * BOOST_EMIT_SPEED_SCALE;
    const lifetimeBoost = 1
      + this.currentSpeedRatio * SPEED_LIFETIME_SCALE
      + this.currentBoostFactor * BOOST_LIFETIME_SCALE;
    const jitterScale = 1 - this.currentBoostFactor * BOOST_JITTER_DAMP;

    const launch = (EMIT_SPEED + Math.random() * 0.8) * speedBoost;
    const lateral = LATERAL_JITTER * jitterScale;
    this.velocities[ix] = this.sampleNormal.x * launch + (Math.random() - 0.5) * lateral;
    this.velocities[ix + 1] = this.sampleNormal.y * launch + (Math.random() - 0.5) * 0.25 * jitterScale;
    this.velocities[ix + 2] = this.sampleNormal.z * launch + (Math.random() - 0.5) * lateral;

    this.lifetimeSeconds[index] = randRange(PARTICLE_LIFETIME_MIN, PARTICLE_LIFETIME_MAX) * lifetimeBoost;
    this.ageSeconds[index] = 0;
    this.lives[index] = 1;
  }
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
