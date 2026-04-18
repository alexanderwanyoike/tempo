import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  MeshToonMaterial,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  type Texture,
  WebGLRenderer,
} from "three";
import type { CarVariant } from "../../../shared/network-types";
import type { ClientConfig } from "./config";
import {
  applyCarTransform,
  getCarAssetDefinition,
  isSharedCarMesh,
  loadCarMesh,
  type CarPreviewSpec,
} from "./car-assets";
import {
  createOutlineMaterial,
  createOutlineMesh,
  createToonGradientMap,
  toToonMaterial,
} from "./car-toon-shader";
import { HologramMaterial } from "./hologram-material";
import { HologramPlume } from "./hologram-plume";
import { HoverJets } from "./hover-jets";
import { NormalBlending } from "three";

const OUTLINE_MESH_NAME = "tempo-car-outline";

export class CarPreview {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(40, 1, 0.1, 100);
  private readonly root = new Group();
  private readonly resizeObserver: ResizeObserver;
  private readonly toonGradientMap = createToonGradientMap();
  private readonly outlineMaterial = createOutlineMaterial();
  private animationFrameId: number | null = null;
  private running = false;
  private carGroup: Group | null = null;
  private loadRevision = 0;
  private readonly hologramMaterials: HologramMaterial[] = [];
  private readonly plume = new HologramPlume("#6afcff");
  private readonly hoverJets = new HoverJets(new Color("#6afcff"));
  private materializeStartedAt: number | null = null;
  private readonly materializeDurationMs = 1400;
  private lastAnimateTime = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly config: ClientConfig,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor("#000000", 0);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.renderer.domElement.style.display = "block";

    this.scene.add(new AmbientLight("#ffffff", 1.1));
    const key = new DirectionalLight("#9cefff", 2.2);
    key.position.set(4, 5, 6);
    this.scene.add(key);
    const rim = new DirectionalLight("#ff9a7a", 1.4);
    rim.position.set(-5, 2, -6);
    this.scene.add(rim);
    this.scene.add(this.root);
    this.host.appendChild(this.renderer.domElement);

    this.camera.position.set(0, 1.3, 7.4);
    this.camera.lookAt(0, 0.2, 0);

    this.root.add(this.plume.mesh);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
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
    this.clearCar();
    this.plume.dispose();
    this.hoverJets.dispose();
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  setVariant(variant: CarVariant): void {
    const definition = getCarAssetDefinition(variant);
    const revision = ++this.loadRevision;
    this.clearCar();

    const accent = new Color(definition.fallbackPreviewSpec.accent);
    this.plume.setColor(accent);
    this.hoverJets.setColor(accent);
    this.materializeStartedAt = performance.now();

    const group = new Group();
    const fallback = buildFallbackCar(
      definition.fallbackPreviewSpec,
      this.toonGradientMap,
      this.outlineMaterial,
    );
    fallback.traverse((obj) => {
      if (obj instanceof Mesh && obj.material instanceof HologramMaterial) {
        this.hologramMaterials.push(obj.material);
      }
    });
    group.add(fallback);
    group.visible = false;
    this.carGroup = group;
    this.root.add(group);
    this.hoverJets.attachTo(group);
    this.render();

    void loadCarMesh(this.config, variant)
      .then((asset) => {
        if (revision !== this.loadRevision || this.carGroup !== group) return;
        applyCarTransform(asset, definition.previewTransform);
        this.toonifyAsset(asset);
        group.add(asset);
        fallback.visible = false;
        this.hoverJets.bindToMesh(asset, group);
        this.render();
      })
      .catch((error) => {
        console.error(`Failed to load preview mesh for ${variant}:`, error);
      });
  }

  private toonifyAsset(asset: Group): void {
    const converted: Mesh[] = [];
    asset.traverse((obj) => {
      if (!(obj instanceof Mesh)) return;
      if (obj.name === OUTLINE_MESH_NAME) return;
      if (Array.isArray(obj.material)) {
        obj.material = obj.material.map((mat) =>
          mat instanceof MeshStandardMaterial && !(mat instanceof MeshToonMaterial)
            ? toToonMaterial(mat, this.toonGradientMap)
            : mat,
        );
      } else if (
        obj.material instanceof MeshStandardMaterial
        && !(obj.material instanceof MeshToonMaterial)
      ) {
        obj.material = toToonMaterial(obj.material, this.toonGradientMap);
      } else {
        return;
      }
      converted.push(obj);
    });

    for (const mesh of converted) {
      const parent = mesh.parent;
      if (!parent) continue;
      const outline = createOutlineMesh(mesh.geometry, this.outlineMaterial);
      outline.position.copy(mesh.position);
      outline.quaternion.copy(mesh.quaternion);
      outline.scale.copy(mesh.scale);
      parent.add(outline);
    }
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.render();
  }

  private readonly animate = (time: number): void => {
    if (!this.running) return;
    const deltaSeconds = this.lastAnimateTime > 0 ? (time - this.lastAnimateTime) / 1000 : 0;
    this.lastAnimateTime = time;
    if (this.carGroup) {
      const bob = Math.sin(time * 0.0018) * 0.09;
      this.carGroup.position.y = bob;
      this.carGroup.rotation.y = time * 0.0006;
      this.carGroup.rotation.z = Math.sin(time * 0.0013) * 0.03;
    }
    const timeSec = time / 1000;
    for (const mat of this.hologramMaterials) mat.setTime(timeSec);
    this.plume.setTime(timeSec);
    this.updateMaterialize(time);
    this.hoverJets.update(Math.min(deltaSeconds, 1 / 30), 0.35, 1);
    this.render();
    this.animationFrameId = window.requestAnimationFrame(this.animate);
  };

  private updateMaterialize(nowMs: number): void {
    if (this.materializeStartedAt === null) {
      this.plume.setIntensity(0);
      if (this.carGroup && !this.carGroup.visible) this.carGroup.visible = true;
      return;
    }
    const rawT = Math.min(1, (nowMs - this.materializeStartedAt) / this.materializeDurationMs);
    const riseEnd = 0.5;
    const fadeStart = 0.7;
    let intensity: number;
    if (rawT < riseEnd) {
      const r = rawT / riseEnd;
      intensity = r * r * (3 - 2 * r);
    } else if (rawT < fadeStart) {
      intensity = 1;
    } else {
      const f = (rawT - fadeStart) / (1 - fadeStart);
      intensity = 1 - f * f * (3 - 2 * f);
    }
    this.plume.setIntensity(intensity);
    if (this.carGroup) {
      const shouldShow = rawT >= 0.55;
      if (this.carGroup.visible !== shouldShow) this.carGroup.visible = shouldShow;
    }
    if (rawT >= 1) {
      this.plume.setIntensity(0);
      if (this.carGroup) this.carGroup.visible = true;
      this.materializeStartedAt = null;
    }
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private clearCar(): void {
    if (!this.carGroup) return;
    this.hoverJets.detachFrom(this.carGroup);
    this.root.remove(this.carGroup);
    this.carGroup.traverse((object) => {
      if (!(object instanceof Mesh) || isSharedCarMesh(object)) return;
      // Outline shells share geometry with a source mesh and the outline
      // material is shared across the whole preview; disposing either would
      // break subsequent previews or leak.
      if (object.name === OUTLINE_MESH_NAME) return;
      object.geometry.dispose();
      if (Array.isArray(object.material)) {
        for (const material of object.material) material.dispose();
      } else {
        object.material.dispose();
      }
    });
    this.carGroup = null;
    this.hologramMaterials.length = 0;
  }
}

function buildFallbackCar(
  spec: CarPreviewSpec,
  _toonGradientMap: Texture,
  _outlineMaterial: ShaderMaterial,
): Group {
  const group = new Group();
  const accent = new Color(spec.accent);
  const trim = new Color(spec.trim);
  const canopy = new Color(spec.canopy);

  const bodyMaterial = new HologramMaterial({ color: accent, blending: NormalBlending });
  const trimMaterial = new HologramMaterial({ color: trim, blending: NormalBlending });
  const canopyMaterial = new HologramMaterial({ color: canopy, blending: NormalBlending });
  const glowMaterial = new HologramMaterial({
    color: accent.clone().lerp(new Color("#ffffff"), 0.25),
    blending: NormalBlending,
  });

  const body = new Mesh(new BoxGeometry(3.5, 0.62, 1.55), bodyMaterial);
  const canopyMesh = new Mesh(new BoxGeometry(1.2, 0.42, 0.88), canopyMaterial);
  canopyMesh.position.set(-0.1, 0.43, 0);
  const nose = new Mesh(new BoxGeometry(0.9, 0.22, 0.66), trimMaterial);
  nose.position.set(2.1, 0.02, 0);
  const wingLeft = new Mesh(new BoxGeometry(1.05, 0.14, 0.34), trimMaterial);
  const wingRight = wingLeft.clone();
  wingLeft.position.set(-1.35, -0.05, -0.94);
  wingRight.position.set(-1.35, -0.05, 0.94);
  const thrusterLeft = new Mesh(new SphereGeometry(0.16, 18, 12), glowMaterial);
  const thrusterRight = thrusterLeft.clone();
  thrusterLeft.position.set(-1.95, 0, -0.42);
  thrusterRight.position.set(-1.95, 0, 0.42);

  if (spec.silhouette === "muscle") {
    body.scale.set(1.08, 1.12, 1.08);
    canopyMesh.scale.set(1.08, 0.96, 0.96);
    nose.scale.set(0.9, 1, 1.06);
    wingLeft.scale.set(1.2, 1, 1.1);
    wingRight.scale.copy(wingLeft.scale);
    wingLeft.position.set(-1.2, -0.03, -1.02);
    wingRight.position.set(-1.2, -0.03, 1.02);
  } else if (spec.silhouette === "wedge") {
    body.scale.set(1.02, 0.9, 0.86);
    canopyMesh.scale.set(0.9, 0.88, 0.8);
    nose.scale.set(1.36, 0.9, 0.86);
    nose.position.set(2.35, 0.03, 0);
    wingLeft.scale.set(0.78, 0.8, 0.85);
    wingRight.scale.copy(wingLeft.scale);
    wingLeft.position.set(-1.62, -0.05, -0.88);
    wingRight.position.set(-1.62, -0.05, 0.88);
  } else if (spec.silhouette === "phantom") {
    body.scale.set(0.96, 1.0, 0.78);
    canopyMesh.scale.set(1.18, 1, 0.72);
    nose.scale.set(0.82, 0.86, 0.7);
    wingLeft.scale.set(1.42, 0.56, 0.56);
    wingRight.scale.copy(wingLeft.scale);
    wingLeft.position.set(-1.5, 0.02, -1.04);
    wingRight.position.set(-1.5, 0.02, 1.04);
    thrusterLeft.position.set(-2.15, 0, -0.3);
    thrusterRight.position.set(-2.15, 0, 0.3);
  } else {
    body.scale.set(1, 0.92, 0.92);
    canopyMesh.scale.set(1, 0.94, 0.9);
    nose.scale.set(1.12, 0.92, 0.92);
  }

  const meshes = [body, canopyMesh, nose, wingLeft, wingRight, thrusterLeft, thrusterRight];
  group.add(...meshes);
  return group;
}
