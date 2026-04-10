import {
  AmbientLight,
  Box3,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  PerspectiveCamera,
  Scene,
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
  edgeMaterial: LineBasicMaterial;
  ribMaterial: LineBasicMaterial;
  centerMaterial: LineBasicMaterial;
};

type FictionPalette = {
  edge: Color;
  rib: Color;
  center: Color;
};

function paletteFor(fictionId: EnvironmentFictionId): FictionPalette {
  const accent =
    fictionId === 2 ? new Color("#ff8c62") : fictionId === 3 ? new Color("#d49cff") : new Color("#4adfff");
  const dim = accent.clone().multiplyScalar(0.45);
  return { edge: accent, rib: dim.clone(), center: dim.clone() };
}

function applyPalette(build: PreviewBuild, fictionId: EnvironmentFictionId): void {
  const palette = paletteFor(fictionId);
  build.edgeMaterial.color.copy(palette.edge);
  build.ribMaterial.color.copy(palette.rib);
  build.centerMaterial.color.copy(palette.center);
}

const TARGET_PREVIEW_SPAN = 420;

export class MenuPreview {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(34, 1, 0.1, 4000);
  private readonly root = new Group();
  private readonly songCache = new Map<string, SongDefinition>();
  private readonly buildCache = new Map<string, PreviewBuild>();
  private readonly resizeObserver: ResizeObserver;
  private animationFrameId: number | null = null;
  private lastTime = 0;
  private running = false;
  private requestId = 0;
  private currentBuild: PreviewBuild | null = null;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor("#0a0c10", 1);
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
    this.lastTime = performance.now();
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
    const deltaSeconds = (time - this.lastTime) / 1000;
    this.lastTime = time;
    this.root.rotation.y += deltaSeconds * 0.1;
    this.root.rotation.x = -0.92 + Math.sin(time * 0.00055) * 0.03;
    this.root.position.y = Math.sin(time * 0.0009) * 2;
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
    this.root.rotation.set(-0.92, 0.5, 0);
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
    const verticalFov = (this.camera.fov * Math.PI) / 180;
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect);
    const fitVertical = build.radius / Math.tan(verticalFov / 2);
    const fitHorizontal = build.radius / Math.tan(horizontalFov / 2);
    const distance = Math.max(180, fitVertical, fitHorizontal) * 0.88;

    this.camera.near = Math.max(0.1, distance / 200);
    this.camera.far = Math.max(4000, distance * 8);
    this.camera.position.set(build.center.x, build.center.y + build.radius * 0.45, build.center.z + distance);
    this.camera.lookAt(build.center.x, build.center.y, build.center.z);
    this.camera.updateProjectionMatrix();
  }
}

function buildTrackPreview(track: TrackGenerator): PreviewBuild {
  const centers: Vector3[] = new Array(SAMPLE_COUNT);
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    centers[i] = track.getPointAt(i / (SAMPLE_COUNT - 1));
  }

  const rawBox = new Box3().setFromPoints(centers);
  const boxCenter = rawBox.getCenter(new Vector3());
  const size = rawBox.getSize(new Vector3());
  const maxSpan = Math.max(size.x, size.y, size.z, 1);
  const scale = TARGET_PREVIEW_SPAN / maxSpan;

  const viewHalfWidth = 11;
  const rawHalfWidth = viewHalfWidth / scale;

  const worldUp = new Vector3(0, 1, 0);
  const lefts: Vector3[] = new Array(SAMPLE_COUNT);
  const rights: Vector3[] = new Array(SAMPLE_COUNT);

  const tangent = new Vector3();
  const right = new Vector3();
  let lastValidRight = new Vector3(1, 0, 0);

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const prev = centers[Math.max(0, i - 1)];
    const next = centers[Math.min(SAMPLE_COUNT - 1, i + 1)];
    tangent.subVectors(next, prev).normalize();
    right.crossVectors(tangent, worldUp);
    const len = right.length();
    if (len < 0.001) {
      right.copy(lastValidRight);
    } else {
      right.divideScalar(len);
      lastValidRight.copy(right);
    }
    const c = centers[i];
    lefts[i] = c.clone().addScaledVector(right, -rawHalfWidth);
    rights[i] = c.clone().addScaledVector(right, rawHalfWidth);
  }

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

  const edgeMat = new LineBasicMaterial({ color: new Color("#ffffff") });
  const ribMat = new LineBasicMaterial({ color: new Color("#ffffff"), transparent: true, opacity: 0.8 });
  const centerMat = new LineBasicMaterial({ color: new Color("#ffffff"), transparent: true, opacity: 0.45 });

  const inner = new Group();
  inner.add(
    new Line(toGeometry(lefts), edgeMat),
    new Line(toGeometry(rights), edgeMat),
    new Line(toGeometry(centers), centerMat),
  );

  // Cross-stripes (ladder rungs) every N samples.
  const ribPositions: number[] = [];
  const RIB_COUNT = 90;
  const RIB_EVERY = Math.max(1, Math.floor(SAMPLE_COUNT / RIB_COUNT));
  for (let i = 0; i < SAMPLE_COUNT; i += RIB_EVERY) {
    const l = lefts[i], r = rights[i];
    ribPositions.push(l.x, l.y, l.z, r.x, r.y, r.z);
  }
  const ribGeo = new BufferGeometry();
  ribGeo.setAttribute("position", new Float32BufferAttribute(ribPositions, 3));
  inner.add(new LineSegments(ribGeo, ribMat));

  inner.position.sub(boxCenter);

  const outer = new Group();
  outer.add(inner);
  outer.scale.setScalar(scale);

  return {
    group: outer,
    center: new Vector3(0, 0, 0),
    radius: TARGET_PREVIEW_SPAN * 0.5,
    edgeMaterial: edgeMat,
    ribMaterial: ribMat,
    centerMaterial: centerMat,
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
