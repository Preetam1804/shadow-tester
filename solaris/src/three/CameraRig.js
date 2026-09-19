import * as THREE from 'three';
import { clamp, damp, catmullRomAt, catmullRomScalar, travelEase } from '../lib/math.js';

const TMP_POS = new THREE.Vector3();
const TMP_LOOK = new THREE.Vector3();
const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();
const TMP_C = new THREE.Vector3();
const TMP_D = new THREE.Vector3();
const MAT = new THREE.Matrix4();
const QUAT = new THREE.Quaternion();
const OFF = new THREE.Quaternion();
const EUL = new THREE.Euler();

/**
 * Scroll-driven cinematic rig.
 *
 * Every chapter's pose is derived from the *live* position of the body it
 * frames, so worlds stay composed correctly even while they orbit. Poses feed
 * a uniform Catmull–Rom chain that the scroll position is mapped onto — one
 * chapter of scroll = one spline segment — so the camera is exactly on pose for
 * the middle of each chapter's text. Position, aim and focal length are damped;
 * the aim is then closed-loop corrected so the world sits on a third line
 * instead of dead centre.
 */
export class CameraRig {
  constructor(universe, chapters) {
    this.universe = universe;
    this.chapters = chapters;
    this.n = chapters.length;
    const total = this.n + 2; // prologue + one pose per chapter + epilogue

    this.posPts = Array.from({ length: total }, () => new THREE.Vector3());
    this.lookPts = Array.from({ length: total }, () => new THREE.Vector3());
    this.fovArr = new Float32Array(total);
    this.rollArr = new Float32Array(total);
    this.biasArr = new Float32Array(total);
    this.biasYArr = new Float32Array(total);

    this.anchor = new THREE.Vector3();
    this.frameOffset = new THREE.Vector3();
    this.off = { x: 0, y: 0 }; // framing solve, in NDC units
    this.lookAt = new THREE.Vector3();
    this.pos = new THREE.Vector3();
    this.prevPos = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);

    this.baseFov = 45;
    this.fov = 45;
    this.warp = 0;
    this.velocity = 0;
    this.cf = 0;
    this.t = 0;
    this.active = 0;
    this.local = 0.5;
    this.reduced = false;
    this._warmup = 0.6;
    this._bob = Math.random() * 40;

    this.focus = null;
    this.focusBlend = 0;
  }

  /** rebuild the pose chain from the (moving) solar system */
  buildPoses() {
    const { chapters, universe, posPts, lookPts } = this;
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const ch = chapters[i];
      universe.poseFor(ch, TMP_POS, TMP_LOOK);
      posPts[i + 1].copy(TMP_POS);
      lookPts[i + 1].copy(TMP_LOOK);
      this.fovArr[i + 1] = ch.fov ?? 45;
      this.rollArr[i + 1] = ch.roll ?? 0;
      this.biasArr[i + 1] = clamp(ch.bias ?? 0, -0.85, 0.85);
      this.biasYArr[i + 1] = clamp(ch.biasY ?? (ch.side === 'center' ? 0.0 : 0.06), -0.4, 0.4);
    }

    // prologue: ease in from further out so the hero has an approach
    TMP_POS.copy(posPts[1]).sub(lookPts[1]).multiplyScalar(1.9).add(lookPts[1]);
    TMP_POS.y += 24;
    posPts[0].copy(TMP_POS);
    lookPts[0].copy(lookPts[1]);
    this.fovArr[0] = this.fovArr[1] + 6;
    this.rollArr[0] = this.rollArr[1];

    // epilogue: keep drifting outward past the final pose
    TMP_POS.copy(posPts[n]).sub(lookPts[n]).multiplyScalar(1.45).add(lookPts[n]);
    TMP_POS.y += 46;
    posPts[n + 1].copy(TMP_POS);
    lookPts[n + 1].copy(lookPts[n]);
    this.fovArr[n + 1] = this.fovArr[n] - 4;
    this.rollArr[n + 1] = this.rollArr[n];
  }

  /** hold a slow orbit around a picked world, starting from the live camera */
  focusOn(info, camera) {
    if (!info?.mesh || !camera) return;
    info.mesh.getWorldPosition(TMP_A);
    const offset = new THREE.Vector3().copy(camera.position).sub(TMP_A);
    const want = (info.radius ?? 4) * 5.5;
    if (offset.lengthSq() < 1) offset.set(0, want * 0.25, want);
    offset.setLength(clamp(offset.length(), want * 0.65, want * 2.4));
    this.focus = { info, offset, spin: 0 };
  }

  clearFocus() {
    this.focus = null;
  }

  /**
   * @param cf chapter-float, 0 … n (scrollY / section height)
   */
  update(dt, camera, { cf = 0, pointer = { x: 0, y: 0 }, drag = { x: 0, y: 0 } } = {}) {
    const n = this.n;
    this.cf = cf;
    this._camPos = camera.position;

    const total = n + 1; // spline segments
    const tt = clamp(cf + 0.5, 0, total);
    let seg = Math.min(total - 1, Math.floor(tt));
    const localRaw = clamp(tt - seg, 0, 1);
    const local = travelEase(localRaw, this.reduced ? 0.25 : 0.62);
    const t = (seg + local) / total;
    this.t = t;

    this.buildPoses();
    catmullRomAt(this.posPts, t, TMP_POS);
    catmullRomAt(this.lookPts, t, TMP_LOOK);
    this.baseFov = catmullRomScalar(this.fovArr, t);
    const roll = catmullRomScalar(this.rollArr, t);
    const bias = catmullRomScalar(this.biasArr, t);
    const biasY = catmullRomScalar(this.biasYArr, t);

    const prevActive = this.active;
    this.active = clamp(Math.round(cf - 0.5), 0, n - 1);
    // a new chapter inherits half the previous solve, then corrects it
    if (prevActive !== this.active) {
      this.off.x *= 0.6;
      this.off.y *= 0.6;
    }
    this.local = clamp(cf - this.active - 0.5, -0.5, 0.5);

    // idle breathing so a held frame is never dead still
    if (!this.reduced) {
      this._bob += dt;
      const b = this._bob;
      TMP_POS.x += Math.sin(b * 0.31) * 0.5 + Math.sin(b * 0.13) * 0.85;
      TMP_POS.y += Math.cos(b * 0.24) * 0.4;
      TMP_POS.z += Math.sin(b * 0.19 + 1.7) * 0.45;
    }

    // ── focus mode: hold a slow orbit around the picked world
    this.focusBlend = damp(this.focusBlend, this.focus ? 1 : 0, 3.4, dt);
    if (this.focus && this.focusBlend > 0.001) {
      this.focus.info.mesh.getWorldPosition(TMP_A);
      this.focus.spin += dt * 0.075;
      TMP_B.copy(this.focus.offset).applyAxisAngle(UP, this.focus.spin);
      TMP_C.copy(TMP_A).add(TMP_B);
      TMP_POS.lerp(TMP_C, this.focusBlend);
      TMP_D.copy(TMP_A);
      TMP_LOOK.lerp(TMP_D, this.focusBlend);
    }

    const posLambda = this._warmup > 0 ? 16 : this.focus ? 8 : 7;
    this._warmup -= dt;
    this.prevPos.copy(camera.position);
    this.pos.copy(TMP_POS);
    camera.position.set(
      damp(camera.position.x, TMP_POS.x, posLambda, dt),
      damp(camera.position.y, TMP_POS.y, posLambda, dt),
      damp(camera.position.z, TMP_POS.z, posLambda, dt)
    );
    camera.updateMatrixWorld();

    // star collision guard — the spline dips near the photosphere between the
    // hero and Mercury chapters, so keep a hard floor under the radius
    const fromStar = camera.position.length();
    const safeR = this.universe.sunRadius * 1.5;
    if (fromStar < safeR) camera.position.multiplyScalar(safeR / Math.max(fromStar, 0.001));

    const moved = camera.position.distanceTo(this.prevPos);
    this.velocity = damp(this.velocity, dt > 0 ? moved / dt : 0, 5, dt);
    this.warp = clamp(this.velocity / 150, 0, 1.2);
    const warpK = this.reduced ? 0 : 1;

    /* ── closed-loop framing ------------------------------------------------
     * We want the anchor on a third line rather than dead centre. Aiming at
     * `anchor + offset` slides the subject by −offset, so a proportional solve
     * would keep half the error; integrating the residual in NDC units
     * converges exactly, and settling over a few frames keeps it hand-posed.
     */
    this.anchor.copy(TMP_LOOK);
    const dist = Math.max(2, camera.position.distanceTo(this.anchor));
    const halfH = Math.tan((camera.fov * Math.PI) / 360) * dist;
    const halfW = halfH * camera.aspect;
    TMP_A.copy(this.anchor).project(camera);
    const behind = TMP_A.z > 1 ? 1 : 0;
    const ex = behind ? 0 : clamp(TMP_A.x - bias, -1.6, 1.6);
    const ey = behind ? 0 : clamp(TMP_A.y - biasY, -1.6, 1.6);
    this.off.x = clamp(this.off.x + ex * 0.55, -1.2, 1.2);
    this.off.y = clamp(this.off.y + ey * 0.55, -0.9, 0.9);
    TMP_B.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    TMP_C.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    this.frameOffset
      .set(0, 0, 0)
      .addScaledVector(TMP_B, this.off.x * halfW)
      .addScaledVector(TMP_C, this.off.y * halfH);
    this.lookAt.copy(this.anchor).add(this.frameOffset);

    // ── orientation: roll + pointer parallax + drag, all damped
    const px = this.reduced ? 0 : pointer.x;
    const py = this.reduced ? 0 : pointer.y;
    this.up.set(Math.sin(roll), Math.cos(roll), Math.sin(roll) * 0.12).normalize();
    MAT.lookAt(camera.position, this.lookAt, this.up);
    QUAT.setFromRotationMatrix(MAT);
    EUL.set(py * 0.045 + drag.y, px * 0.07 + drag.x, 0, 'YXZ');
    OFF.setFromEuler(EUL);
    QUAT.multiply(OFF);
    if (this._warmup > 0) camera.quaternion.copy(QUAT);
    else camera.quaternion.slerp(QUAT, 1 - Math.exp(-(this.focus ? 8 : 10) * dt));

    // ── focal length, widened while warping
    this.fov = damp(this.fov, this.baseFov + this.warp * 8.5 * warpK, 6, dt);
    if (Math.abs(camera.fov - this.fov) > 0.008) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();

    return {
      warp: this.warp * warpK,
      t,
      active: this.active,
      local: this.local,
      cf,
      velocity: this.velocity,
      fov: this.fov,
      bias,
      focusing: this.focusBlend,
    };
  }
}

const UP = new THREE.Vector3(0, 1, 0);
