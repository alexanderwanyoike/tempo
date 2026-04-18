import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DoubleSide,
  Mesh,
  ShaderMaterial,
} from "three";

const VERTEX_SHADER = `
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vViewDir;

void main() {
  vUv = uv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vViewDir = normalize(cameraPosition - worldPos.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FRAGMENT_SHADER = `
uniform float uTime;
uniform float uIntensity;
uniform float uScanProgress;
uniform vec3 uColor;

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vViewDir;

void main() {
  float fresnel = pow(1.0 - max(dot(vWorldNormal, vViewDir), 0.0), 2.2);
  // Vertical column stripes around the cylinder.
  float columns = 0.5 + 0.5 * sin(vUv.x * 58.0 + uTime * 1.2);
  float columnMask = smoothstep(0.55, 0.85, columns);
  // Horizontal scan band driven by uScanProgress in [0,1].
  float scanDist = vUv.y - uScanProgress;
  float scanBand = exp(-pow(scanDist * 11.0, 2.0));
  // Vertical gridlines that drift downward slowly.
  float grid = smoothstep(0.48, 0.5, fract(vUv.y * 9.0 - uTime * 0.22));
  float structure = 0.05 + 0.45 * fresnel * columnMask + 0.12 * grid;
  float bandBoost = scanBand * (1.4 + fresnel * 0.6);
  float alpha = clamp((structure + bandBoost) * uIntensity, 0.0, 1.0);
  vec3 color = uColor * (1.0 + fresnel * 0.6) + vec3(0.25, 0.4, 0.55) * scanBand;
  gl_FragColor = vec4(color, alpha);
}
`;

export class HologramPlume {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(color: Color | string) {
    const geometry = new CylinderGeometry(1.25, 1.25, 2.8, 28, 1, true);
    geometry.translate(0, 1.4, 0);

    this.material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uScanProgress: { value: 0 },
        uColor: { value: new Color(color).lerp(new Color("#6afcff"), 0.65) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });

    this.mesh = new Mesh(geometry, this.material);
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

  setScanProgress(value: number): void {
    this.material.uniforms.uScanProgress.value = value;
  }

  setColor(c: Color | string): void {
    this.material.uniforms.uColor.value.copy(new Color(c).lerp(new Color("#6afcff"), 0.65));
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
