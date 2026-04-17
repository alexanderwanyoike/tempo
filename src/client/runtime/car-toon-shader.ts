import {
  DataTexture,
  MeshStandardMaterial,
  MeshToonMaterial,
  NearestFilter,
  RedFormat,
  type Texture,
} from "three";

// Brightness stops for the 3-band shading ramp. Tuned for subtle cel shading —
// the darkest band (35% brightness) still reads clearly against the neon
// environment; mid and hot bands give the car a flattened but readable form.
const GRADIENT_STOPS = [0.35, 0.7, 1.0] as const;

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
