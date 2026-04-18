import { ShaderMaterial, Uniform } from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

const VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = `
  uniform sampler2D tDiffuse;
  uniform float uStrength;
  uniform float uTime;
  varying vec2 vUv;

  float hash11(float x) {
    return fract(sin(x * 43758.5453) * 12345.6789);
  }

  void main() {
    vec4 base = texture2D(tDiffuse, vUv);

    if (uStrength <= 0.001) {
      gl_FragColor = base;
      return;
    }

    vec2 toCenter = vUv - vec2(0.5);
    // Slight aspect correction so streaks are radial in screen, not stretched.
    toCenter.x *= 1.78;
    float r = length(toCenter);
    float angle = atan(toCenter.y, toCenter.x);

    // Divide the screen into angular slots. Each slot streams radially with
    // a per-slot phase so lines do not crawl in lockstep.
    float slotCount = 42.0;
    float slotId = floor(angle * slotCount / 6.2831853);
    float slotPhase = hash11(slotId);
    float slotWidth = 0.26 + hash11(slotId + 13.0) * 0.12;

    float slotPos = fract(angle * slotCount / 6.2831853) - 0.5;
    float lineMask = smoothstep(slotWidth, slotWidth * 0.3, abs(slotPos));

    // Radial envelope: no streaks near the screen center, strongest at edges.
    float radialEnv = smoothstep(0.18, 0.55, r);

    // Streaks flow radially outward over time. Using mod to loop.
    float flow = fract(r * 1.8 - uTime * 1.8 + slotPhase);
    float streakCore = smoothstep(0.45, 0.75, flow) * (1.0 - smoothstep(0.85, 1.0, flow));

    float streak = streakCore * lineMask * radialEnv;
    float darken = uStrength * streak * 0.55;
    vec3 color = base.rgb * (1.0 - darken);

    // Soft edge vignette that intensifies with strength, sells the tunneling feel.
    float vignette = smoothstep(0.35, 0.95, r) * uStrength * 0.22;
    color *= 1.0 - vignette;

    gl_FragColor = vec4(color, base.a);
  }
`;

/**
 * High-speed post-process pass: radial speed lines that stream outward
 * from the screen center and darken the edges. Drives with a 0-1
 * strength that ramps in when the car is above ~75% of top speed.
 */
export class SpeedLinesPass extends ShaderPass {
  constructor() {
    super(
      new ShaderMaterial({
        uniforms: {
          tDiffuse: new Uniform(null),
          uStrength: new Uniform(0),
          uTime: new Uniform(0),
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
      }),
      "tDiffuse",
    );
  }

  setStrength(strength: number): void {
    this.uniforms.uStrength.value = Math.max(0, Math.min(1, strength));
  }

  setTime(seconds: number): void {
    this.uniforms.uTime.value = seconds;
  }
}
