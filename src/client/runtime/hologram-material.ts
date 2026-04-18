import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from "three";

const VERTEX_SHADER = `
varying vec3 vWorldNormal;
varying vec3 vViewDir;
varying vec3 vWorldPosition;
varying vec3 vLocalPosition;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  vLocalPosition = position;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vViewDir = normalize(cameraPosition - worldPos.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FRAGMENT_SHADER = `
uniform float uTime;
uniform float uAlpha;
uniform vec3 uColor;
uniform float uDissolve;

varying vec3 vWorldNormal;
varying vec3 vViewDir;
varying vec3 vWorldPosition;
varying vec3 vLocalPosition;

// Classic 3D hash noise.
float hash(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p, p.yxz + 19.19);
  return fract((p.x + p.y) * p.z);
}

void main() {
  float fresnel = pow(1.0 - max(dot(vWorldNormal, vViewDir), 0.0), 2.0);
  float scan = 0.5 + 0.5 * sin(vWorldPosition.y * 18.0 - uTime * 5.5);
  float stripes = smoothstep(0.55, 0.75, scan);
  float flicker = 0.88 + 0.12 * sin(uTime * 23.0 + vWorldPosition.x * 2.7);
  float noise = hash(floor(vLocalPosition * 18.0) + floor(uTime * 1.2));
  float dissolveMask = step(uDissolve, noise);
  float scanBand = exp(-pow((vLocalPosition.y + 1.0 - mod(uTime * 0.8, 3.0)) * 2.2, 2.0));
  float rim = 0.35 + 0.65 * fresnel;
  float body = 0.55 + 0.45 * stripes;
  float intensity = rim * body * flicker + scanBand * 1.2;
  vec3 color = uColor * (1.0 + fresnel * 1.8 + scanBand * 0.9);
  float alpha = clamp(uAlpha * intensity * dissolveMask, 0.0, 1.0);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

export class HologramMaterial extends ShaderMaterial {
  constructor(options: { color?: Color | string; alpha?: number; dissolve?: number } = {}) {
    super({
      uniforms: {
        uTime: { value: 0 },
        uAlpha: { value: options.alpha ?? 1 },
        uColor: { value: new Color(options.color ?? "#6afcff") },
        uDissolve: { value: options.dissolve ?? 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
  }

  setTime(t: number): void {
    this.uniforms.uTime.value = t;
  }

  setAlpha(a: number): void {
    this.uniforms.uAlpha.value = a;
  }

  setDissolve(d: number): void {
    this.uniforms.uDissolve.value = d;
  }

  setColor(c: Color | string): void {
    this.uniforms.uColor.value.set(c);
  }
}
