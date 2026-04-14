import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from "three";

export type CarPreviewSpec = {
  accent: string;
  trim: string;
  canopy: string;
  silhouette: "dart" | "muscle" | "wedge" | "phantom";
};

export class CarPreview {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(40, 1, 0.1, 100);
  private readonly root = new Group();
  private readonly resizeObserver: ResizeObserver;
  private animationFrameId: number | null = null;
  private running = false;
  private carGroup: Group | null = null;

  constructor(private readonly host: HTMLElement) {
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
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  setSpec(spec: CarPreviewSpec): void {
    this.clearCar();
    this.carGroup = buildCar(spec);
    this.root.add(this.carGroup);
    this.render();
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
    if (this.carGroup) {
      const bob = Math.sin(time * 0.0018) * 0.09;
      this.carGroup.position.y = bob;
      this.carGroup.rotation.y = time * 0.0006;
      this.carGroup.rotation.z = Math.sin(time * 0.0013) * 0.03;
    }
    this.render();
    this.animationFrameId = window.requestAnimationFrame(this.animate);
  };

  private render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private clearCar(): void {
    if (!this.carGroup) return;
    this.root.remove(this.carGroup);
    this.carGroup.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.geometry.dispose();
      if (Array.isArray(object.material)) {
        for (const material of object.material) material.dispose();
      } else {
        object.material.dispose();
      }
    });
    this.carGroup = null;
  }
}

function buildCar(spec: CarPreviewSpec): Group {
  const group = new Group();
  const accent = new Color(spec.accent);
  const trim = new Color(spec.trim);
  const canopy = new Color(spec.canopy);

  const bodyMaterial = new MeshStandardMaterial({
    color: accent,
    emissive: accent.clone().multiplyScalar(0.22),
    roughness: 0.28,
    metalness: 0.64,
  });
  const trimMaterial = new MeshStandardMaterial({
    color: trim,
    emissive: trim.clone().multiplyScalar(0.14),
    roughness: 0.42,
    metalness: 0.52,
  });
  const canopyMaterial = new MeshStandardMaterial({
    color: canopy,
    emissive: canopy.clone().multiplyScalar(0.18),
    roughness: 0.18,
    metalness: 0.35,
  });
  const glowMaterial = new MeshStandardMaterial({
    color: accent.clone().lerp(new Color("#ffffff"), 0.18),
    emissive: accent.clone().multiplyScalar(1.8),
    roughness: 0.16,
    metalness: 0.08,
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

  group.add(body, canopyMesh, nose, wingLeft, wingRight, thrusterLeft, thrusterRight);
  group.position.set(0, 0, 0);
  return group;
}
