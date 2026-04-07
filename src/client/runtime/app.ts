import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  MathUtils,
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
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly carRoot: Group;
  private readonly carBody: Mesh;
  private readonly input: VehicleInput;
  private readonly vehicleController: VehicleController;
  private readonly cameraForward = new Vector3(0, 0, -1);
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
    const visualYaw = -state.steering * 0.15 * (0.3 + Math.min(state.speed / 32, 1) * 0.7);
    this.carBody.rotation.set(state.visualPitch, visualYaw, state.visualBank, "XYZ");
  }

  private updateCamera(): void {
    const state = this.vehicleController.state;
    const speed = state.speed;

    // Heading direction (where the ship points)
    const headingDir = new Vector3(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));

    // Velocity direction (where the ship is actually going)
    let velocityDir: Vector3;
    if (speed > 1.0) {
      velocityDir = state.velocity.clone();
      velocityDir.y = 0;
      velocityDir.normalize();
    } else {
      velocityDir = headingDir.clone();
    }

    // Camera follows VELOCITY primarily, not heading.
    // This means when the car yaws into a turn, the camera stays aligned
    // with the travel direction and you SEE the car rotated on screen.
    const speedRatio = Math.min(speed / 32, 1);
    const velocityBias = MathUtils.clamp(speedRatio, 0, 0.75);
    const desiredForward = headingDir.clone().lerp(velocityDir, velocityBias).normalize();

    // Smooth camera direction - moderate pace so turns are readable
    this.cameraForward.lerp(desiredForward, 0.12).normalize();

    // Speed-sensitive framing
    const cameraBack = MathUtils.lerp(11, 14, speedRatio);
    const cameraUp = MathUtils.lerp(4.5, 5.5, speedRatio);
    const lookAhead = MathUtils.lerp(16, 22, speedRatio);

    const targetPosition = state.position
      .clone()
      .addScaledVector(this.cameraForward, -cameraBack)
      .add(new Vector3(0, cameraUp, 0));
    const lookTarget = state.position
      .clone()
      .addScaledVector(this.cameraForward, lookAhead)
      .add(new Vector3(0, 1.1, 0));

    this.camera.position.lerp(targetPosition, 0.15);
    this.camera.lookAt(lookTarget.x, state.position.y + 0.9, lookTarget.z);

    // Speed-based FOV
    this.camera.fov = MathUtils.lerp(70, 78, speedRatio * speedRatio);
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
