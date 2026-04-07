import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  MathUtils,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import type { ClientConfig } from "./config";
import { VehicleInput } from "./input";
import { TestTrack } from "./track-builder";
import { VehicleController, defaultVehicleTuning } from "./vehicle-controller";

export class App {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly carRoot: Group;
  private readonly carBody: Mesh;
  private readonly input: VehicleInput;
  private readonly vehicleController: VehicleController;
  private readonly track: TestTrack;
  private lastFrameTime = 0;
  private readonly orientMat = new Matrix4();

  constructor(
    private readonly root: HTMLElement,
    private readonly config: ClientConfig,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.scene = new Scene();
    this.scene.background = new Color("#05070c");

    // Near clip at 1.0 to cull close track geometry
    this.camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 1.0, 2000);

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
    // Camera is a CHILD of carRoot - moves/rotates rigidly with the car
    carRoot.add(body, cockpit, this.camera);

    this.carRoot = carRoot;
    this.carBody = body;
    this.input = new VehicleInput();
    this.vehicleController = new VehicleController(defaultVehicleTuning);

    this.track = new TestTrack();
    this.scene.add(this.track.meshGroup);

    this.vehicleController.setTrack(this.track);
    this.vehicleController.setTrackQuery((pos, hintU) => this.track.queryNearest(pos, hintU));

    const start = this.track.getStartPosition();
    this.vehicleController.state.trackU = 0.001;
    this.vehicleController.state.lateralOffset = 0;

    this.scene.add(this.carRoot);
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

    // Position + hover bob along track up
    this.carRoot.position.copy(state.position);
    this.carRoot.position.addScaledVector(state.up, state.visualHoverOffset);

    // Orientation from track frame: makeBasis(right, up, -forward)
    const negFwd = state.forward.clone().negate();
    this.orientMat.makeBasis(state.right, state.up, negFwd);
    this.carRoot.setRotationFromMatrix(this.orientMat);

    // Body visual effects (local to car)
    const speedRatio = Math.min(Math.abs(state.speed) / 90, 1);
    const visualYaw = -state.steering * 0.15 * (0.3 + speedRatio * 0.7);
    this.carBody.rotation.set(state.visualPitch, visualYaw, state.visualBank, "XYZ");
  }

  private updateCamera(): void {
    const speed = Math.abs(this.vehicleController.state.speed);
    const speedRatio = Math.min(speed / 90, 1);

    // Camera is child of carRoot - just set local position
    // Local: X=right, Y=up, Z=backward
    const camBack = MathUtils.lerp(8, 14, speedRatio);
    const camUp = MathUtils.lerp(3.5, 5.5, speedRatio);
    this.camera.position.set(0, camUp, camBack);
    // Default orientation looks down -Z = car's forward direction
    this.camera.rotation.set(0, 0, 0);

    // Speed FOV
    this.camera.fov = MathUtils.lerp(70, 95, speedRatio * speedRatio);
    this.camera.updateProjectionMatrix();
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
