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
  uniform float uAberrationScale;
  uniform float uZoomScale;
  uniform int uZoomSamples;
  varying vec2 vUv;

  vec3 sampleAt(vec2 uv) {
    return texture2D(tDiffuse, uv).rgb;
  }

  void main() {
    if (uStrength <= 0.0001) {
      gl_FragColor = vec4(sampleAt(vUv), 1.0);
      return;
    }

    vec2 center = vec2(0.5);
    vec2 toCenter = vUv - center;
    float radial = length(toCenter);
    vec2 dir = radial > 0.0001 ? toCenter / radial : vec2(0.0);

    // Radial zoom blur: accumulate samples along the radial direction,
    // spaced outward so the streak reads as inertial compression.
    vec3 zoomAccum = vec3(0.0);
    float weightTotal = 0.0;
    float zoomStrength = uZoomScale * uStrength * radial;
    int samples = uZoomSamples;
    for (int i = 0; i < 12; i++) {
      if (i >= samples) break;
      float t = float(i) / float(samples - 1);
      float offset = mix(-0.5, 1.0, t) * zoomStrength;
      vec2 uv = vUv - dir * offset;
      float weight = 1.0 - abs(t - 0.4);
      zoomAccum += sampleAt(uv) * weight;
      weightTotal += weight;
    }
    vec3 blurred = zoomAccum / max(weightTotal, 0.0001);

    // Chromatic aberration: sample R and B channels offset radially.
    float ab = uAberrationScale * uStrength * radial;
    float r = texture2D(tDiffuse, vUv - dir * ab).r;
    float g = blurred.g;
    float b = texture2D(tDiffuse, vUv + dir * ab).b;

    vec3 color = mix(blurred, vec3(r, g, b), 0.65);
    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * Boost post-process pass: radial zoom blur + chromatic aberration that
 * intensifies with uStrength (0-1). At 0 it is a no-op pass-through, so
 * it is cheap to keep in the pipeline even when not boosting.
 */
export class BoostFxPass extends ShaderPass {
  constructor() {
    super(
      new ShaderMaterial({
        uniforms: {
          tDiffuse: new Uniform(null),
          uStrength: new Uniform(0),
          uAberrationScale: new Uniform(0.052),
          uZoomScale: new Uniform(0.18),
          uZoomSamples: new Uniform(10),
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
}
