import {
  BackSide,
  Color,
  DataTexture,
  Mesh,
  MeshStandardMaterial,
  MeshToonMaterial,
  NearestFilter,
  RedFormat,
  ShaderMaterial,
  type BufferGeometry,
  type Texture,
} from "three";

// Two hard bands for full comic cel shading — one dark side, one lit side, no
// in-between grey. Combined with the outline hull this gives cars a strong
// illustrated look.
const GRADIENT_STOPS = [0.32, 1.0] as const;
const OUTLINE_COLOR = new Color("#050610");
const OUTLINE_THICKNESS = 0.018;

/**
 * Build a tiny 1D gradient map used by MeshToonMaterial to quantize diffuse
 * lighting into discrete bands. NearestFilter keeps transitions hard-edged,
 * which is what produces the cel-shaded look (as opposed to a smooth toon).
 * Returned texture should be treated as shared and reused across materials.
 */
export function createToonGradientMap(): DataTexture {
  const data = new Uint8Array(GRADIENT_STOPS.length);
  for (let i = 0; i < GRADIENT_STOPS.length; i += 1) {
    data[i] = Math.round(GRADIENT_STOPS[i] * 255);
  }
  const texture = new DataTexture(data, GRADIENT_STOPS.length, 1, RedFormat);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Convert a PBR material into a toon equivalent that fits the game's neon
 * fiction. Preserves colour, emissive, opacity, and diffuse/emissive maps;
 * drops metalness/roughness/normal maps since toon lighting does not use them.
 * The caller passes a shared gradient map produced by createToonGradientMap.
 */
export function toToonMaterial(
  source: MeshStandardMaterial,
  gradientMap: Texture,
): MeshToonMaterial {
  const toon = new MeshToonMaterial({
    color: source.color.clone(),
    emissive: source.emissive.clone(),
    emissiveIntensity: source.emissiveIntensity,
    opacity: source.opacity,
    transparent: source.transparent,
    side: source.side,
    map: source.map ?? null,
    emissiveMap: source.emissiveMap ?? null,
    alphaMap: source.alphaMap ?? null,
    gradientMap,
  });
  if (source.name) toon.name = source.name;
  return toon;
}

/**
 * Shared inverted-hull outline material. Expands each vertex along its normal
 * in model space and renders only back-faces, so the swollen shell peeks
 * around the edges of the real mesh as a thin black silhouette. Cheap and
 * self-contained; no post-processing required.
 */
export function createOutlineMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uOutlineColor: { value: OUTLINE_COLOR.clone() },
      uOutlineThickness: { value: OUTLINE_THICKNESS },
    },
    vertexShader: `
      uniform float uOutlineThickness;
      void main() {
        vec3 outlinePosition = position + normal * uOutlineThickness;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(outlinePosition, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uOutlineColor;
      void main() {
        gl_FragColor = vec4(uOutlineColor, 1.0);
      }
    `,
    side: BackSide,
    depthWrite: true,
    depthTest: true,
  });
}

/**
 * Build an outline shell mesh for a source mesh. The shell shares the same
 * BufferGeometry (no duplication) and uses the shared outline material.
 */
export function createOutlineMesh(
  sourceGeometry: BufferGeometry,
  outlineMaterial: ShaderMaterial,
): Mesh {
  const shell = new Mesh(sourceGeometry, outlineMaterial);
  shell.renderOrder = -1;
  shell.frustumCulled = false;
  shell.name = "tempo-car-outline";
  return shell;
}

