import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  ShaderMaterial,
} from "three";

const PARTICLE_COUNT = 220;

const VERTEX_SHADER = `
attribute float aPhase;
attribute float aAngle;
attribute float aRadiusMul;
uniform float uTime;
uniform float uIntensity;
uniform float uRadius;
uniform float uHeight;
uniform float uPixelRatio;
varying float vAlpha;
varying float vLifetime;

void main() {
  float t = fract(aPhase + uTime * 0.8);
  float radialFade = 1.0 - t * 0.2;
  float r = uRadius * aRadiusMul * radialFade;
  float y = t * uHeight;
  vec3 local = vec3(cos(aAngle) * r, y, sin(aAngle) * r);
  vec4 mvPosition = modelViewMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float size = (14.0 + uIntensity * 34.0) * uPixelRatio;
  gl_PointSize = size * (55.0 / max(0.1, -mvPosition.z));
  float shimmer = 0.7 + 0.3 * sin(aAngle * 4.0 + uTime * 6.0);
  vAlpha = uIntensity * (1.0 - t * 0.7) * shimmer;
  vLifetime = t;
}
`;

const FRAGMENT_SHADER = `
uniform vec3 uColor;
varying float vAlpha;
varying float vLifetime;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard;
  float falloff = pow(1.0 - r2 * 4.0, 1.4);
  vec3 tinted = uColor * (1.6 + vLifetime * 1.2) + vec3(0.25, 0.35, 0.45) * vLifetime;
  float alpha = clamp(falloff * vAlpha * 1.4, 0.0, 1.0);
  gl_FragColor = vec4(tinted, alpha);
}
`;

export class HologramPlume {
  readonly mesh: Points;
  private readonly material: ShaderMaterial;

  constructor(color: Color | string) {
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const phases = new Float32Array(PARTICLE_COUNT);
    const angles = new Float32Array(PARTICLE_COUNT);
    const radii = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      phases[i] = Math.random();
      angles[i] = Math.random() * Math.PI * 2;
      radii[i] = 0.35 + Math.random() * 0.9;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("aPhase", new BufferAttribute(phases, 1));
    geometry.setAttribute("aAngle", new BufferAttribute(angles, 1));
    geometry.setAttribute("aRadiusMul", new BufferAttribute(radii, 1));
    geometry.boundingSphere = null;
    geometry.computeBoundingSphere();

    this.material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uRadius: { value: 1.6 },
        uHeight: { value: 3.2 },
        uColor: { value: new Color(color) },
        uPixelRatio: { value: Math.min(window.devicePixelRatio ?? 1, 2) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.mesh = new Points(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  setTime(seconds: number): void {
    this.material.uniforms.uTime.value = seconds;
  }

  setIntensity(value: number): void {
    this.material.uniforms.uIntensity.value = value;
    this.mesh.visible = value > 0.01;
  }

  setColor(c: Color | string): void {
    this.material.uniforms.uColor.value.set(c);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
