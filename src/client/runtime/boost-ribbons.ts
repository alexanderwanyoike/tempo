import { Color, Group, Vector3 } from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

const HISTORY_LENGTH = 28;
const BASE_LINEWIDTH = 3.2;
const PEAK_LINEWIDTH = 7.8;
const BASE_OPACITY = 0.0;
const PEAK_OPACITY = 0.86;
const LATERAL_OFFSET = 0.48;
const TAIL_DROP = 0.02;
const TAIL_BACK = 0.75;
const BOOST_VISIBLE_THRESHOLD = 0.05;
const BOOST_FADE_RATE = 4.8;

/**
 * Neon-green afterimage streak that trails the player while boosting.
 * Two thick polylines sampled from recent car positions, one offset to
 * each side. Only appears when the local car is boosting and fades out
 * over a short window once the boost ends, so the affordance is always
 * tied to the boost state.
 */
export class BoostRibbons {
  readonly group = new Group();
  private readonly history: Vector3[] = [];
  private readonly historyRight: Vector3[] = [];
  private readonly positionsLeft: Float32Array;
  private readonly positionsRight: Float32Array;
  private readonly leftLine: Line2;
  private readonly rightLine: Line2;
  private readonly leftMaterial: LineMaterial;
  private readonly rightMaterial: LineMaterial;
  private readonly tempRight = new Vector3();
  private readonly tempUp = new Vector3(0, 1, 0);
  private readonly tempForward = new Vector3(0, 0, 1);
  private visibleBoost = 0;

  constructor(color: Color, viewportSize: { width: number; height: number }) {
    this.positionsLeft = new Float32Array(HISTORY_LENGTH * 3);
    this.positionsRight = new Float32Array(HISTORY_LENGTH * 3);
    for (let i = 0; i < HISTORY_LENGTH; i += 1) {
      this.history.push(new Vector3());
      this.historyRight.push(new Vector3());
    }

    this.leftMaterial = new LineMaterial({
      color: color.clone(),
      linewidth: BASE_LINEWIDTH,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      worldUnits: false,
      dashed: false,
    });
    this.rightMaterial = new LineMaterial({
      color: color.clone(),
      linewidth: BASE_LINEWIDTH,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      worldUnits: false,
      dashed: false,
    });
    this.leftMaterial.resolution.set(viewportSize.width, viewportSize.height);
    this.rightMaterial.resolution.set(viewportSize.width, viewportSize.height);

    const leftGeometry = new LineGeometry();
    leftGeometry.setPositions(this.positionsLeft);
    const rightGeometry = new LineGeometry();
    rightGeometry.setPositions(this.positionsRight);

    this.leftLine = new Line2(leftGeometry, this.leftMaterial);
    this.rightLine = new Line2(rightGeometry, this.rightMaterial);
    this.leftLine.frustumCulled = false;
    this.rightLine.frustumCulled = false;
    this.leftLine.renderOrder = 3;
    this.rightLine.renderOrder = 3;
    this.leftLine.visible = false;
    this.rightLine.visible = false;
    this.group.add(this.leftLine, this.rightLine);
  }

  setViewportSize(width: number, height: number): void {
    this.leftMaterial.resolution.set(width, height);
    this.rightMaterial.resolution.set(width, height);
  }

  reset(): void {
    this.visibleBoost = 0;
    for (const v of this.history) v.set(0, 0, 0);
    for (const v of this.historyRight) v.set(0, 0, 0);
  }

  /**
   * Samples the car's current position + orientation into the ribbon
   * history. Expected to be called each frame, even when not boosting,
   * so that the tail lags behind the car's recent path and not just a
   * straight line the moment boost kicks in.
   */
  sample(
    carPosition: Vector3,
    carForward: Vector3,
    carUp: Vector3,
  ): void {
    this.tempForward.copy(carForward).normalize();
    this.tempUp.copy(carUp).normalize();
    this.tempRight.crossVectors(this.tempForward, this.tempUp).normalize();

    for (let i = HISTORY_LENGTH - 1; i > 0; i -= 1) {
      this.history[i].copy(this.history[i - 1]);
      this.historyRight[i].copy(this.historyRight[i - 1]);
    }
    const head = this.history[0];
    const headRight = this.historyRight[0];
    head.copy(carPosition)
      .addScaledVector(this.tempForward, -TAIL_BACK)
      .addScaledVector(this.tempUp, -TAIL_DROP)
      .addScaledVector(this.tempRight, -LATERAL_OFFSET);
    headRight.copy(carPosition)
      .addScaledVector(this.tempForward, -TAIL_BACK)
      .addScaledVector(this.tempUp, -TAIL_DROP)
      .addScaledVector(this.tempRight, LATERAL_OFFSET);
  }

  /**
   * Updates ribbon opacity + thickness to match the current boost state.
   * visibleBoost damps toward boostIntensity so the ribbons fade in on
   * boost start and fade out gracefully after the boost ends.
   */
  update(deltaSeconds: number, boostIntensity: number): void {
    const dt = Math.min(deltaSeconds, 1 / 20);
    const target = Math.max(0, Math.min(1, boostIntensity));
    const k = 1 - Math.exp(-BOOST_FADE_RATE * dt);
    this.visibleBoost += (target - this.visibleBoost) * k;

    if (this.visibleBoost < BOOST_VISIBLE_THRESHOLD) {
      this.leftLine.visible = false;
      this.rightLine.visible = false;
      return;
    }
    this.leftLine.visible = true;
    this.rightLine.visible = true;

    for (let i = 0; i < HISTORY_LENGTH; i += 1) {
      const leftSample = this.history[i];
      const rightSample = this.historyRight[i];
      const ix = i * 3;
      this.positionsLeft[ix] = leftSample.x;
      this.positionsLeft[ix + 1] = leftSample.y;
      this.positionsLeft[ix + 2] = leftSample.z;
      this.positionsRight[ix] = rightSample.x;
      this.positionsRight[ix + 1] = rightSample.y;
      this.positionsRight[ix + 2] = rightSample.z;
    }
    (this.leftLine.geometry as LineGeometry).setPositions(this.positionsLeft);
    (this.rightLine.geometry as LineGeometry).setPositions(this.positionsRight);

    const linewidth = BASE_LINEWIDTH + this.visibleBoost * (PEAK_LINEWIDTH - BASE_LINEWIDTH);
    const opacity = BASE_OPACITY + this.visibleBoost * (PEAK_OPACITY - BASE_OPACITY);
    this.leftMaterial.linewidth = linewidth;
    this.rightMaterial.linewidth = linewidth;
    this.leftMaterial.opacity = opacity;
    this.rightMaterial.opacity = opacity;
  }

  setColor(color: Color): void {
    this.leftMaterial.color.copy(color);
    this.rightMaterial.color.copy(color);
  }

  dispose(): void {
    this.leftLine.geometry.dispose();
    this.rightLine.geometry.dispose();
    this.leftMaterial.dispose();
    this.rightMaterial.dispose();
  }
}
