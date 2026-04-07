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
  Vector3,
  WebGLRenderer,
} from "three";
import type { ClientConfig } from "./config";
import { VehicleInput } from "./input";
import { VehicleController, defaultVehicleTuning } from "./vehicle-controller";

export class App {
  private static readonly UP = new Vector3(0, 1, 0);
  private static readonly CAMERA_SIDE_OFFSET = 2.1;
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly carRoot: Group;
  private readonly carBody: Mesh;
  private readonly input: VehicleInput;
  private readonly vehicleController: VehicleController;
  private lastFrameTime = 0;

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

    const body = new Mesh(
      new BoxGeometry(1.4, 0.5, 3.2),
      new MeshStandardMaterial({
        color: "#14f1ff",
        emissive: "#0f6d74",
        metalness: 0.3,
        roughness: 0.5,
      }),
    );
    body.position.y = 0.1;

    const cockpit = new Mesh(
      new BoxGeometry(0.8, 0.35, 1.15),
      new MeshStandardMaterial({
        color: "#0e1320",
        emissive: "#1b2744",
        metalness: 0.15,
        roughness: 0.45,
      }),
    );
    cockpit.position.set(0, 0.35, 0.1);

    const carRoot = new Group();
    carRoot.add(body, cockpit);

    this.carRoot = carRoot;
    this.carBody = body;
    this.input = new VehicleInput();
    this.vehicleController = new VehicleController(defaultVehicleTuning);

    const road = new Mesh(
      new BoxGeometry(30, 0.1, 400),
      new MeshStandardMaterial({
        color: "#151922",
        emissive: "#111520",
        metalness: 0.1,
        roughness: 0.9,
      }),
    );
    road.position.z = -160;

    const laneMarkers = new Mesh(
      new BoxGeometry(0.16, 0.02, 400),
      new MeshStandardMaterial({
        color: "#40f2ff",
        emissive: "#1aa9b3",
        metalness: 0.1,
        roughness: 0.6,
      }),
    );
    laneMarkers.position.set(0, 0.07, -160);

    const leftRail = new Mesh(
      new BoxGeometry(0.2, 0.35, 400),
      new MeshStandardMaterial({
        color: "#4e233a",
        emissive: "#3a1328",
        metalness: 0.2,
        roughness: 0.7,
      }),
    );
    leftRail.position.set(-14.6, 0.22, -160);

    const rightRail = new Mesh(
      new BoxGeometry(0.2, 0.35, 400),
      new MeshStandardMaterial({
        color: "#4e233a",
        emissive: "#3a1328",
        metalness: 0.2,
        roughness: 0.7,
      }),
    );
    rightRail.position.set(14.6, 0.22, -160);

    this.scene.add(road, laneMarkers, leftRail, rightRail, this.carRoot);
  }

  start(): void {
    this.root.appendChild(this.renderer.domElement);
    this.setupScene();
    this.bindEvents();
    this.lastFrameTime = performance.now();
    this.render(this.lastFrameTime);
  }

  private setupScene(): void {
    const ambient = new AmbientLight("#9bc7ff", 1.4);
    const sun = new DirectionalLight("#ff5f87", 2);
    sun.position.set(4, 8, 6);

    this.scene.add(ambient, sun);

    this.root.dataset.wsUrl = this.config.websocketUrl;
  }

  private bindEvents(): void {
    window.addEventListener("resize", this.handleResize);
    this.input.attach();
  }

  private readonly handleResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  private updateCarTransform(): void {
    const state = this.vehicleController.state;

    this.carRoot.position.copy(state.position);
    this.carRoot.rotation.set(0, state.yaw, 0, "XYZ");
    this.carBody.rotation.set(state.visualPitch, 0, state.visualBank, "XYZ");
  }

  private updateCamera(): void {
    const state = this.vehicleController.state;
    const forward = new Vector3(Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    const right = new Vector3().crossVectors(forward, App.UP).normalize();
    const targetPosition = state.position
      .clone()
      .addScaledVector(forward, -10.5)
      .addScaledVector(right, App.CAMERA_SIDE_OFFSET)
      .add(new Vector3(0, 4.6, 0));
    const lookTarget = state.position
      .clone()
      .addScaledVector(forward, 16)
      .addScaledVector(right, state.steering * 2.2)
      .add(new Vector3(0, 1.2, 0));

    this.camera.position.lerp(targetPosition, 0.09);
    this.camera.lookAt(lookTarget.x, state.position.y + 0.9, lookTarget.z);
  }

  private render = (time: number): void => {
    const deltaSeconds = (time - this.lastFrameTime) / 1000;
    this.lastFrameTime = time;

    this.vehicleController.update(deltaSeconds, this.input.state);
    this.updateCarTransform();
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
    window.requestAnimationFrame(this.render);
  };
}
