import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import type { ClientConfig } from "./config";

export class App {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly car: Mesh;

  constructor(
    private readonly root: HTMLElement,
    private readonly config: ClientConfig,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.scene = new Scene();
    this.scene.background = new Color("#05070c");

    this.camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
    this.camera.position.set(0, 2.5, 7);

    const geometry = new BoxGeometry(1.4, 0.5, 3.2);
    const material = new MeshStandardMaterial({
      color: "#14f1ff",
      emissive: "#0f6d74",
      metalness: 0.3,
      roughness: 0.5,
    });

    this.car = new Mesh(geometry, material);
    this.car.position.y = 0.4;
  }

  start(): void {
    this.root.appendChild(this.renderer.domElement);
    this.setupScene();
    this.bindEvents();
    this.render();
  }

  private setupScene(): void {
    const ambient = new AmbientLight("#9bc7ff", 1.4);
    const sun = new DirectionalLight("#ff5f87", 2);
    sun.position.set(4, 8, 6);

    const road = new Mesh(
      new BoxGeometry(30, 0.1, 200),
      new MeshStandardMaterial({
        color: "#151922",
        emissive: "#111520",
        metalness: 0.1,
        roughness: 0.9,
      }),
    );
    road.position.z = -80;

    this.scene.add(ambient, sun, road, this.car);

    this.root.dataset.wsUrl = this.config.websocketUrl;
  }

  private bindEvents(): void {
    window.addEventListener("resize", this.handleResize);
  }

  private readonly handleResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  private render = (): void => {
    this.car.rotation.y += 0.01;
    this.renderer.render(this.scene, this.camera);
    window.requestAnimationFrame(this.render);
  };
}
