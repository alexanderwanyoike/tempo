import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  type Texture,
} from "three";

// Local-space positions of the four hover engines relative to the car's
// bodyPivot. X is half-width, Z is forward/back, Y sits just under the car so
// discs land on the road surface. Values tuned for the ~3-unit-long race cars.
const HOVER_POINTS: Array<[number, number, number]> = [
  [-0.72, -0.35, 1.35],
  [0.72, -0.35, 1.35],
  [-0.72, -0.35, -1.35],
  [0.72, -0.35, -1.35],
];

const BASE_DISC_SIZE = 1.45;
const DISC_PULSE_AMPLITUDE = 0.12;
const DISC_PULSE_FREQUENCY_HZ = 1.4;

const HOVER_FRAGMENT = `
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
void main() {
  vec2 centered = vUv - 0.5;
  float dist = length(centered) * 2.0;
  float falloff = pow(1.0 - clamp(dist, 0.0, 1.0), 2.4);
  float ring = smoothstep(0.42, 0.58, dist) * (1.0 - smoothstep(0.58, 0.82, dist));
  float alpha = (falloff * 0.85 + ring * 1.1) * uIntensity;
  gl_FragColor = vec4(uColor * (1.4 + ring * 0.7), alpha);
}
`;

const HOVER_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Four hover-engine ground discs anchored under a car. The tint is the car's
 * accent colour so each variant gets its own signature hover glow. Discs pulse
 * gently on their own cadence and brighten with speed / boost.
 */
export class HoverJets {
  private readonly material: ShaderMaterial;
  private readonly discs: Mesh[];

  constructor(color: Color) {
    const baseColor = color.clone();
    this.material = new ShaderMaterial({
      uniforms: {
        uColor: { value: baseColor },
        uIntensity: { value: 1 },
      },
      vertexShader: HOVER_VERTEX,
      fragmentShader: HOVER_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.discs = HOVER_POINTS.map(([x, y, z], index) => {
      const geometry = new PlaneGeometry(BASE_DISC_SIZE, BASE_DISC_SIZE);
      const disc = new Mesh(geometry, this.material);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(x, y, z);
      disc.renderOrder = 2;
      disc.frustumCulled = false;
      disc.userData.hoverPhase = index * 0.37;
      return disc;
    });
  }

  attachTo(parent: Group): void {
    for (const disc of this.discs) parent.add(disc);
  }

  detachFrom(parent: Group): void {
    for (const disc of this.discs) parent.remove(disc);
  }

  /**
   * Called per frame. speedRatio [0..1] is speed/topSpeed; boostMultiplier is
   * the vehicle's current boost multiplier (1 at rest, higher during pads).
   */
  update(elapsedSeconds: number, speedRatio: number, boostMultiplier: number): void {
    const twoPi = Math.PI * 2;
    const pulse = 0.5 + 0.5 * Math.sin(elapsedSeconds * DISC_PULSE_FREQUENCY_HZ * twoPi);
    const boost = Math.max(0, boostMultiplier - 1);
    const intensity = 0.65 + pulse * 0.25 + speedRatio * 0.35 + boost * 0.9;
    this.material.uniforms.uIntensity.value = intensity;

    for (const disc of this.discs) {
      const phase = (disc.userData.hoverPhase as number) ?? 0;
      const wobble = Math.sin(elapsedSeconds * DISC_PULSE_FREQUENCY_HZ * twoPi + phase);
      const scale = 1 + wobble * DISC_PULSE_AMPLITUDE + boost * 0.08;
      disc.scale.set(scale, scale, scale);
    }
  }

  setColor(color: Color): void {
    (this.material.uniforms.uColor.value as Color).copy(color);
  }

  dispose(): void {
    for (const disc of this.discs) disc.geometry.dispose();
    this.material.dispose();
  }
}

/** Optional helper — lets callers drop in a shared radial glow texture later
 *  if the procedural shader ends up being too heavy on mobile. Kept as a type
 *  hook so callers can pass a texture later without a signature change. */
export type HoverJetsTexture = Texture | null;
