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

const PARTICLE_COUNT = 140;
const PARTICLE_LIFETIME_MIN = 0.24;
const PARTICLE_LIFETIME_MAX = 0.42;
const EMIT_SPEED = 3.2;
const LATERAL_JITTER = 0.55;
const GRAVITY_Y = -2.2;
const POINT_BASE_SIZE = 7;
const BOTTOM_NORMAL_Y_THRESHOLD = -0.3;
const BACK_NORMAL_Z_THRESHOLD = 0.5;

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
  varying float vLife;
  void main() {
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord) * 2.0;
    if (dist > 1.0) discard;
    float core = pow(1.0 - dist, 1.8);
    float alpha = core * vLife * uIntensity;
    float whiteMix = pow(core, 4.0) * 0.6;
    vec3 tint = mix(uColor, vec3(1.0), whiteMix);
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
  private readonly samplePosition = new Vector3();
  private readonly sampleNormal = new Vector3();

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
   * After the car mesh is loaded + transformed, call this to build a surface
   * sampler. Particles will then emit from the car's down- and rear-facing
   * surface triangles instead of the hardcoded fallback points.
   */
  bindToMesh(meshRoot: Object3D, bodyPivot: Object3D): void {
    const sampler = buildSurfaceSampler(meshRoot, bodyPivot);
    if (sampler.valid) this.sampler = sampler;
  }

  update(deltaSeconds: number, speedRatio: number, boostMultiplier: number): void {
    const dt = Math.min(deltaSeconds, 1 / 20);
    const boost = Math.max(0, boostMultiplier - 1);
    this.material.uniforms.uIntensity.value = 0.78 + speedRatio * 0.22 + boost * 0.5;
    this.material.uniforms.uPointSize.value = POINT_BASE_SIZE + speedRatio * 2 + boost * 3;

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
    if (this.sampler && this.sampler.valid) {
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
    // surfaces push down, rear surfaces push rearward. Add a little random
    // spread so the jet has width.
    const speed = EMIT_SPEED + Math.random() * 0.8;
    this.velocities[ix] = this.sampleNormal.x * speed + (Math.random() - 0.5) * LATERAL_JITTER;
    this.velocities[ix + 1] = this.sampleNormal.y * speed + (Math.random() - 0.5) * 0.25;
    this.velocities[ix + 2] = this.sampleNormal.z * speed + (Math.random() - 0.5) * LATERAL_JITTER;

    this.lifetimeSeconds[index] = randRange(PARTICLE_LIFETIME_MIN, PARTICLE_LIFETIME_MAX);
    this.ageSeconds[index] = 0;
    this.lives[index] = 1;
  }
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
