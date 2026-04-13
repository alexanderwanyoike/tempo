import {
  AdditiveBlending,
  AmbientLight,
  Box3,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import type { SongDefinition } from "../../../shared/song-schema";
import { clampFictionId, type EnvironmentFictionId } from "./fiction-id";
import { loadSongDefinition } from "./song-loader";
import { TrackGenerator } from "./track-generator";

export type MenuPreviewSelection = {
  songId: string;
  songUrl: string;
  fictionId: EnvironmentFictionId;
  seed: number;
};

const SAMPLE_COUNT = 800;
const BUILD_CACHE_LIMIT = 8;

type PreviewBuild = {
  group: Group;
  center: Vector3;
  radius: number;
  cameraPath: PreviewCameraKeyframe[];
  materials: Material[];
};

type PreviewCameraKeyframe = {
  position: Vector3;
  tangent: Vector3;
};

type FictionPalette = {
  lattice: Color;
  rail: Color;
  support: Color;
  ghost: Color;
  center: Color;
};

function paletteFor(fictionId: EnvironmentFictionId): FictionPalette {
  const accent =
    fictionId === 2 ? new Color("#ff9866") : fictionId === 3 ? new Color("#d49cff") : new Color("#4adfff");
  return {
    lattice: accent.clone(),
    rail: accent.clone(),
    support: accent.clone().lerp(new Color("#ffffff"), 0.18),
    ghost: accent.clone().multiplyScalar(0.3),
    center: accent.clone().lerp(new Color("#ffffff"), 0.12),
  };
}

function applyPalette(build: PreviewBuild, fictionId: EnvironmentFictionId): void {
  const palette = paletteFor(fictionId);
  const lattice = build.materials[0] as ShaderMaterial | undefined;
  const ghost = build.materials[1] as LineBasicMaterial | undefined;
  const leftRail = build.materials[2] as LineBasicMaterial | undefined;
  const rightRail = build.materials[3] as LineBasicMaterial | undefined;
  const support = build.materials[4] as LineBasicMaterial | undefined;
  const center = build.materials[5] as LineBasicMaterial | undefined;
  const colorUniform = lattice?.uniforms.uColor;
  if (colorUniform) {
    (colorUniform.value as Color).copy(palette.lattice);
  }
  ghost?.color.copy(palette.ghost);
  leftRail?.color.copy(palette.rail);
  rightRail?.color.copy(palette.rail);
  support?.color.copy(palette.support);
  center?.color.copy(palette.center);
}

const TARGET_PREVIEW_SPAN = 460;
const ROUTE_RELIEF = 0.82;
const RAIL_RELIEF = 0.92;
const INTERIOR_GUIDES = [-0.78, -0.52, -0.26, 0.26, 0.52, 0.78] as const;
const SURFACE_COLUMNS = 8;
const TARGET_LAYOUT_YAW = -0.32;
const HERO_WINDOW_RADIUS = 34;
const CAMERA_WINDOW_RADIUS = 58;
const CAMERA_PATH_STEPS = 64;
const FIXED_CAMERA_SCALE = 1.4;
const LATTICE_VERTEX = `
varying vec2 vUv;
varying vec3 vNormalWorld;
varying vec3 vViewDir;

void main() {
  vUv = uv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vNormalWorld = normalize(mat3(modelMatrix) * normal);
  vViewDir = normalize(cameraPosition - worldPos.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const LATTICE_FRAGMENT = `
uniform vec3 uColor;
uniform float uTime;
varying vec2 vUv;
varying vec3 vNormalWorld;
varying vec3 vViewDir;

float gridLine(float coord, float scale, float thickness) {
  float scaled = coord * scale;
  float line = abs(fract(scaled) - 0.5);
  float aa = fwidth(scaled) * 0.75;
  return 1.0 - smoothstep(thickness - aa, thickness + aa, line);
}

void main() {
  float longitudinal = gridLine(vUv.x, 44.0, 0.08);
  float lateral = gridLine(vUv.y, 9.0, 0.14);
  float lattice = max(longitudinal, lateral);
  float fresnel = pow(1.0 - max(dot(normalize(vNormalWorld), normalize(vViewDir)), 0.0), 2.2);
  float scan = 0.5 + 0.5 * sin(vUv.x * 13.0 - uTime * 0.0011);
  float glow = max(lattice, fresnel * 0.55);
  float alpha = lattice * (0.55 + scan * 0.18) + fresnel * 0.22 + 0.025;
  vec3 color = uColor * (0.5 + scan * 0.18 + fresnel * 0.85);
  gl_FragColor = vec4(color * glow, alpha);
}
`;

export class MenuPreview {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(48, 1, 0.1, 4000);
  private readonly root = new Group();
  private readonly songCache = new Map<string, SongDefinition>();
  private readonly buildCache = new Map<string, PreviewBuild>();
  private readonly resizeObserver: ResizeObserver;
  private animationFrameId: number | null = null;
  private running = false;
  private requestId = 0;
  private currentBuild: PreviewBuild | null = null;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor("#0a0c10", 0);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.renderer.domElement.style.display = "block";

    this.scene.add(new AmbientLight("#ffffff", 1.2));
    this.scene.add(this.root);
    this.host.appendChild(this.renderer.domElement);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
  }

  async setSelection(selection: MenuPreviewSelection): Promise<void> {
    const requestId = ++this.requestId;
    const fictionId = clampFictionId(selection.fictionId);
    const cacheKey = `${selection.songId}|${selection.seed}`;

    const cached = this.buildCache.get(cacheKey);
    if (cached) {
      this.buildCache.delete(cacheKey);
      this.buildCache.set(cacheKey, cached);
      applyPalette(cached, fictionId);
      this.replaceBuild(cached);
      this.fitCameraToBuild(cached);
      this.renderFrame();
      return;
    }

    const song = await this.loadSong(selection.songUrl);
    if (requestId !== this.requestId) return;

    const track = new TrackGenerator(song, selection.seed);
    const nextBuild = buildTrackPreview(track);
    applyPalette(nextBuild, fictionId);

    if (requestId !== this.requestId) {
      disposeBuild(nextBuild);
      return;
    }

    this.storeBuild(cacheKey, nextBuild);
    this.replaceBuild(nextBuild);
    this.fitCameraToBuild(nextBuild);
    this.renderFrame();
  }

  resize(): void {
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    if (this.currentBuild) {
      this.fitCameraToBuild(this.currentBuild);
    }
    this.renderFrame();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.animationFrameId = window.requestAnimationFrame(this.animate);
  }

  stop(): void {
    this.running = false;
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  destroy(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.clearRoot();
    for (const build of this.buildCache.values()) {
      disposeBuild(build);
    }
    this.buildCache.clear();
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  private readonly animate = (time: number): void => {
    if (!this.running) return;
    if (this.currentBuild) {
      this.positionCamera(this.currentBuild, time);
      const lattice = this.currentBuild.materials[0] as ShaderMaterial | undefined;
      if (lattice?.uniforms.uTime) {
        lattice.uniforms.uTime.value = time;
      }
    }
    this.root.rotation.set(0, 0, 0);
    this.root.position.set(0, 0, 0);
    this.renderFrame();
    this.animationFrameId = window.requestAnimationFrame(this.animate);
  };

  private renderFrame(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private async loadSong(songUrl: string): Promise<SongDefinition> {
    const cached = this.songCache.get(songUrl);
    if (cached) return cached;
    const song = await loadSongDefinition(songUrl);
    this.songCache.set(songUrl, song);
    return song;
  }

  private replaceBuild(nextBuild: PreviewBuild): void {
    const children = [...this.root.children];
    for (const child of children) {
      this.root.remove(child);
    }
    this.root.add(nextBuild.group);
    this.root.rotation.set(0, 0, 0);
    this.root.position.set(0, 0, 0);
    this.currentBuild = nextBuild;
  }

  private clearRoot(): void {
    const children = [...this.root.children];
    for (const child of children) {
      this.root.remove(child);
    }
    this.currentBuild = null;
  }

  private storeBuild(key: string, build: PreviewBuild): void {
    while (this.buildCache.size >= BUILD_CACHE_LIMIT) {
      const oldestKey = this.buildCache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.buildCache.get(oldestKey);
      this.buildCache.delete(oldestKey);
      if (oldest && oldest !== this.currentBuild) {
        disposeBuild(oldest);
      }
    }
    this.buildCache.set(key, build);
  }

  private fitCameraToBuild(build: PreviewBuild): void {
    this.positionCamera(build, 0);
    this.camera.updateProjectionMatrix();
  }

  private positionCamera(build: PreviewBuild, time: number): void {
    const travel = this.getTravel(time);
    const keyframe = sampleCameraPath(build.cameraPath, travel);
    const ahead = sampleCameraPath(build.cameraPath, travel + 0.045);
    const worldUp = new Vector3(0, 1, 0);
    const lookTarget = ahead.position.clone().lerp(keyframe.position, 0.22);
    const sideDistance = build.radius * 0.24 * FIXED_CAMERA_SCALE;
    const heightOffset = build.radius * 0.08 * FIXED_CAMERA_SCALE;
    const depthOffset = build.radius * 0.28 * FIXED_CAMERA_SCALE;

    this.camera.near = Math.max(0.1, build.radius / 220);
    this.camera.far = Math.max(4000, build.radius * 14);
    this.camera.up.copy(worldUp);
    this.camera.position.set(
      lookTarget.x + sideDistance,
      build.center.y + heightOffset,
      build.center.z + depthOffset,
    );
    this.camera.lookAt(
      lookTarget.x - build.radius * 0.015,
      lookTarget.y + build.radius * 0.01,
      lookTarget.z - build.radius * 0.02,
    );
  }

  private getTravel(time: number): number {
    return (time * 0.000018) % 1;
  }
}

function buildTrackPreview(track: TrackGenerator): PreviewBuild {
  const rawCenters: Vector3[] = new Array(SAMPLE_COUNT);
  const rawRights: Vector3[] = new Array(SAMPLE_COUNT);
  const rawTangents: Vector3[] = new Array(SAMPLE_COUNT);
  const rawHalfWidths: number[] = new Array(SAMPLE_COUNT);
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const u = i / (SAMPLE_COUNT - 1);
    rawCenters[i] = track.getPointAt(u);
    const frame = track.getFrameAt(u);
    rawRights[i] = frame.right;
    rawTangents[i] = frame.tangent;
    rawHalfWidths[i] = track.getHalfWidthAt(u);
  }

  const dominantAngle = computeDominantAngle(rawCenters);
  const rotation = new Matrix4().makeRotationY(TARGET_LAYOUT_YAW - dominantAngle);

  const centers: Vector3[] = rawCenters.map((point) => {
    const next = new Vector3(point.x, point.y * ROUTE_RELIEF, point.z);
    return next.applyMatrix4(rotation);
  });

  const lefts: Vector3[] = new Array(SAMPLE_COUNT);
  const rights: Vector3[] = new Array(SAMPLE_COUNT);
  const tangents: Vector3[] = new Array(SAMPLE_COUNT);
  let lastValidRight = new Vector3(1, 0, 0);

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const frameRight = rawRights[i].clone();
    frameRight.y *= RAIL_RELIEF;
    frameRight.applyMatrix4(rotation).normalize();
    if (frameRight.lengthSq() <= 0.0001) {
      frameRight.copy(lastValidRight);
    } else {
      lastValidRight.copy(frameRight);
    }
    const c = centers[i];
    lefts[i] = c.clone().addScaledVector(frameRight, -rawHalfWidths[i]);
    rights[i] = c.clone().addScaledVector(frameRight, rawHalfWidths[i]);
    tangents[i] = rawTangents[i]
      .clone()
      .set(rawTangents[i].x, rawTangents[i].y * ROUTE_RELIEF, rawTangents[i].z)
      .applyMatrix4(rotation)
      .normalize();
  }

  const surfacePoints: Vector3[][] = new Array(SAMPLE_COUNT);
  const previewPoints = [...lefts, ...rights, ...centers];
  const rawBox = new Box3().setFromPoints(previewPoints);
  const boxCenter = rawBox.getCenter(new Vector3());
  const size = rawBox.getSize(new Vector3());
  const maxSpan = Math.max(size.x, size.y, size.z, 1);
  const scale = TARGET_PREVIEW_SPAN / maxSpan;

  const toGeometry = (points: Vector3[]): BufferGeometry => {
    const pts = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      pts[i * 3] = points[i].x;
      pts[i * 3 + 1] = points[i].y;
      pts[i * 3 + 2] = points[i].z;
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(pts, 3));
    return geo;
  };

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const row: Vector3[] = [];
    for (let col = 0; col <= SURFACE_COLUMNS; col += 1) {
      const laneT = col / SURFACE_COLUMNS;
      row.push(lefts[i].clone().lerp(rights[i], laneT));
    }
    surfacePoints[i] = row;
  }

  const surfacePositions = new Float32Array(SAMPLE_COUNT * (SURFACE_COLUMNS + 1) * 3);
  const surfaceIndices: number[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    for (let col = 0; col <= SURFACE_COLUMNS; col += 1) {
      const vi = i * (SURFACE_COLUMNS + 1) + col;
      const point = surfacePoints[i][col];
      surfacePositions[vi * 3] = point.x;
      surfacePositions[vi * 3 + 1] = point.y;
      surfacePositions[vi * 3 + 2] = point.z;
    }
    if (i < SAMPLE_COUNT - 1) {
      const rowStart = i * (SURFACE_COLUMNS + 1);
      const nextRowStart = (i + 1) * (SURFACE_COLUMNS + 1);
      for (let col = 0; col < SURFACE_COLUMNS; col += 1) {
        const a = rowStart + col;
        const b = rowStart + col + 1;
        const c = nextRowStart + col;
        const d = nextRowStart + col + 1;
        surfaceIndices.push(a, b, c, b, d, c);
      }
    }
  }
  const surfaceGeo = new BufferGeometry();
  surfaceGeo.setAttribute("position", new Float32BufferAttribute(surfacePositions, 3));
  const surfaceUvs = new Float32BufferAttribute(SAMPLE_COUNT * (SURFACE_COLUMNS + 1) * 2, 2);
  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    for (let col = 0; col <= SURFACE_COLUMNS; col += 1) {
      const vi = i * (SURFACE_COLUMNS + 1) + col;
      surfaceUvs.setXY(vi, i / Math.max(1, SAMPLE_COUNT - 1), col / Math.max(1, SURFACE_COLUMNS));
    }
  }
  surfaceGeo.setAttribute("uv", surfaceUvs);
  surfaceGeo.setIndex(surfaceIndices);
  surfaceGeo.computeVertexNormals();

  const latticeMat = new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color("#ffffff") },
      uTime: { value: 0 },
    },
    vertexShader: LATTICE_VERTEX,
    fragmentShader: LATTICE_FRAGMENT,
    transparent: true,
    side: DoubleSide,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const ghostMat = new LineBasicMaterial({ color: new Color("#ffffff"), transparent: true, opacity: 0.14 });
  const leftRailMat = new LineBasicMaterial({ color: new Color("#ffffff"), transparent: true, opacity: 0.96 });
  const rightRailMat = new LineBasicMaterial({ color: new Color("#ffffff"), transparent: true, opacity: 0.96 });
  const supportMat = new LineBasicMaterial({ color: new Color("#ffffff"), transparent: true, opacity: 0.42 });
  const centerMat = new LineBasicMaterial({ color: new Color("#ffffff"), transparent: true, opacity: 0.22 });

  const inner = new Group();
  inner.add(new Mesh(surfaceGeo, latticeMat));
  const ghost = new Group();
  ghost.position.set(0, -10, -14);
  ghost.add(new Line(toGeometry(lefts), ghostMat), new Line(toGeometry(rights), ghostMat));
  inner.add(ghost);
  inner.add(new Line(toGeometry(lefts), leftRailMat));
  inner.add(new Line(toGeometry(rights), rightRailMat));

  for (const fraction of INTERIOR_GUIDES) {
    const guidePoints = centers.map((center, index) => {
      const halfWidth = rawHalfWidths[index] * fraction;
      const right = rights[index].clone().sub(lefts[index]).normalize();
      return center.clone().addScaledVector(right, halfWidth);
    });
    inner.add(new Line(toGeometry(guidePoints), supportMat));
  }
  inner.add(new Line(toGeometry(centers), centerMat));

  // Cross-stripes (ladder rungs) every N samples.
  const ribPositions: number[] = [];
  const RIB_COUNT = 120;
  const RIB_EVERY = Math.max(1, Math.floor(SAMPLE_COUNT / RIB_COUNT));
  for (let i = 0; i < SAMPLE_COUNT; i += RIB_EVERY) {
    const l = centers[i].clone().lerp(lefts[i], 0.95);
    const r = centers[i].clone().lerp(rights[i], 0.95);
    ribPositions.push(l.x, l.y, l.z, r.x, r.y, r.z);
  }
  const ribGeo = new BufferGeometry();
  ribGeo.setAttribute("position", new Float32BufferAttribute(ribPositions, 3));
  inner.add(new LineSegments(ribGeo, supportMat));

  inner.position.sub(boxCenter);

  const outer = new Group();
  outer.add(inner);
  outer.scale.setScalar(scale);

  const scaledCenters = centers.map((point) => point.clone().sub(boxCenter).multiplyScalar(scale));
  const scaledLefts = lefts.map((point) => point.clone().sub(boxCenter).multiplyScalar(scale));
  const scaledRights = rights.map((point) => point.clone().sub(boxCenter).multiplyScalar(scale));
  const scaledBox = new Box3().setFromObject(outer);
  const scaledCenter = scaledBox.getCenter(new Vector3());
  const scaledSize = scaledBox.getSize(new Vector3());
  const heroIndex = pickHeroSampleIndex(scaledCenters);
  const heroBounds = buildHeroBounds(scaledLefts, scaledRights, heroIndex);
  const heroCenter = heroBounds.getCenter(new Vector3());
  const heroSize = heroBounds.getSize(new Vector3());
  const heroRadius = Math.max(heroSize.x, heroSize.y, heroSize.z, TARGET_PREVIEW_SPAN * 0.2) * 0.5;
  const cameraPath = buildCameraPath(scaledCenters, heroIndex);

  return {
    group: outer,
    center: scaledCenter.clone().lerp(heroCenter, 0.22),
    radius: Math.max(
      heroRadius * 1.25,
      Math.max(scaledSize.x, scaledSize.y, scaledSize.z, TARGET_PREVIEW_SPAN) * 0.27,
      TARGET_PREVIEW_SPAN * 0.18,
    ),
    cameraPath,
    materials: [latticeMat, ghostMat, leftRailMat, rightRailMat, supportMat, centerMat],
  };
}

function computeDominantAngle(points: readonly Vector3[]): number {
  let meanX = 0;
  let meanZ = 0;
  for (const point of points) {
    meanX += point.x;
    meanZ += point.z;
  }
  meanX /= Math.max(1, points.length);
  meanZ /= Math.max(1, points.length);

  let covXX = 0;
  let covXZ = 0;
  let covZZ = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    const dz = point.z - meanZ;
    covXX += dx * dx;
    covXZ += dx * dz;
    covZZ += dz * dz;
  }
  return 0.5 * Math.atan2(2 * covXZ, covXX - covZZ);
}

function pickHeroSampleIndex(points: readonly Vector3[]): number {
  if (points.length < 3) return 0;
  let bestIndex = Math.floor(points.length * 0.5);
  let bestScore = -Infinity;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const current = points[i];
    const next = points[i + 1];
    const a = current.clone().sub(prev).normalize();
    const b = next.clone().sub(current).normalize();
    const curvature = 1 - Math.max(-1, Math.min(1, a.dot(b)));
    const elevation = Math.abs(current.y) * 0.06;
    const positionBias = 1 - Math.abs(i / (points.length - 1) - 0.5);
    const score = curvature * 3.4 + elevation + positionBias * 0.18;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function buildHeroBounds(
  lefts: readonly Vector3[],
  rights: readonly Vector3[],
  centerIndex: number,
): Box3 {
  const bounds = new Box3();
  const start = Math.max(0, centerIndex - HERO_WINDOW_RADIUS);
  const end = Math.min(lefts.length - 1, centerIndex + HERO_WINDOW_RADIUS);
  const focusPoints: Vector3[] = [];
  for (let i = start; i <= end; i += 1) {
    focusPoints.push(lefts[i], rights[i]);
  }
  return bounds.setFromPoints(focusPoints);
}

function buildCameraPath(
  centers: readonly Vector3[],
  centerIndex: number,
): PreviewCameraKeyframe[] {
  const start = Math.max(1, centerIndex - CAMERA_WINDOW_RADIUS);
  const end = Math.min(centers.length - 2, centerIndex + CAMERA_WINDOW_RADIUS);
  const path: PreviewCameraKeyframe[] = [];
  for (let step = 0; step < CAMERA_PATH_STEPS; step += 1) {
    const t = CAMERA_PATH_STEPS <= 1 ? 0 : step / (CAMERA_PATH_STEPS - 1);
    const index = Math.round(start + (end - start) * t);
    const prev = centers[Math.max(0, index - 1)];
    const next = centers[Math.min(centers.length - 1, index + 1)];
    const tangent = next.clone().sub(prev).normalize();
    path.push({
      position: centers[index].clone(),
      tangent: tangent.lengthSq() > 0.0001 ? tangent : new Vector3(0, 0, -1),
    });
  }
  return path;
}

function sampleCameraPath(path: readonly PreviewCameraKeyframe[], t: number): PreviewCameraKeyframe {
  if (path.length === 0) {
    return {
      position: new Vector3(),
      tangent: new Vector3(0, 0, -1),
    };
  }
  if (path.length === 1) {
    return {
      position: path[0].position.clone(),
      tangent: path[0].tangent.clone(),
    };
  }
  const wrapped = ((t % 1) + 1) % 1;
  const exact = wrapped * (path.length - 1);
  const index = Math.floor(exact);
  const frac = exact - index;
  const a = path[index];
  const b = path[Math.min(path.length - 1, index + 1)];
  return {
    position: a.position.clone().lerp(b.position, frac),
    tangent: a.tangent.clone().lerp(b.tangent, frac).normalize(),
  };
}

function disposeBuild(build: PreviewBuild): void {
  build.group.traverse((child) => disposeObject(child));
}

function disposeObject(object: Object3D): void {
  const line = object as Line;
  if ("geometry" in line) {
    (line.geometry as BufferGeometry).dispose();
  }

  if ("material" in line) {
    disposeMaterial(line.material as Material | Material[]);
  }
}

function disposeMaterial(material: Material | Material[]): void {
  if (Array.isArray(material)) {
    for (const candidate of material) {
      candidate.dispose();
    }
    return;
  }

  material.dispose();
}
