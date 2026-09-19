import * as THREE from 'three';
import {
  makeShared,
  makeSun,
  makeBody,
  makeOrbit,
  makeBelt,
  makeStars,
  makeSky,
  makeCraft,
  makeTrail,
  makeReticle,
} from './Factory.js';
import { BODIES, BELTS, SCENE, SUN, CHAPTERS } from '../config/solar.js';
import { clamp, damp } from '../lib/math.js';

const SCRATCH_A = new THREE.Vector3();
const SCRATCH_B = new THREE.Vector3();

/**
 * The simulated system: one star, eight worlds with moons and rings, two
 * debris belts, a surveying probe, orbit tracks, a starfield, a sky.
 *
 * Data-driven by design — every camera pose in the rig is derived from a
 * body's *live* world position, so worlds stay framed while they orbit.
 */
export class Universe {
  constructor(q) {
    this.q = q;
    this.shared = makeShared();
    this.root = new THREE.Group();
    this.bodies = new Map();
    this.pickables = [];
    this.time = 0;
    this.hovered = null;
    this.selected = null;
    this.timeScale = 1;
    this.sunRadius = SUN.radius;
    this._tmp = new THREE.Vector3();

    this.sky = makeSky();
    this.root.add(this.sky);

    this.stars = makeStars(q.stars, q);
    this.root.add(this.stars.group);
    this.stars.group.add(this.stars.mesh);

    this.sun = makeSun(SUN.radius, this.shared, q);
    this.sunInfo = {
      id: 'sun',
      name: 'The Star',
      isSun: true,
      type: 'G2V · 4.6 Gyr',
      radius: SUN.radius,
      color: SUN.color,
      atmo: SUN.atmo,
      chapter: 'sun',
      highlight: 0,
      mesh: this.sun.mesh,
    };
    this.sun.mesh.userData.body = this.sunInfo;
    this.root.add(this.sun.group);
    this.pickables.push(this.sun.mesh);

    this.orbits = [];
    this.belts = [];
    this.cloudSpeeds = new Map();
  }

  /** one world, baked and wired. Split out so the loader can report real progress. */
  addBody(spec) {
    const q = this.q;
    const orbitRadius = SCENE.auToUnits(spec.au);
    const body = makeBody({ ...spec, orbitRadius }, this.shared, q);
    const ch = CHAPTERS.find((c) => c.aim === spec.id);
    body.chapter = ch?.id ?? spec.id;
    body.type = ch?.type ?? 'world';
    for (const m of body.moons) {
      m.mesh.position.set(m.dist, 0, 0);
      m.pivot.rotation.z = (m.seed % 7) * 0.012;
      const label = m.name ?? m.id[0].toUpperCase() + m.id.slice(1);
      m.mesh.userData.body = { kind: 'moon', id: m.id, name: label, parent: body, radius: m.radius, color: m.color };
    }
    this.root.add(body.pivot);
    this.bodies.set(spec.id, body);
    this.pickables.push(...body.rayTargets);
    const orbit = makeOrbit(orbitRadius, spec.atmo, q);
    body.orbit = orbit;
    this.orbits.push(orbit);
    this.root.add(orbit);
    if (body.clouds) this.cloudSpeeds.set(spec.id, spec.clouds.speed);
    return body;
  }

  /** debris belts, the probe, its trail, the reticle */
  finish() {
    const q = this.q;
    for (const cfg of BELTS) {
      const b = makeBelt(cfg, q);
      b.group.add(b.mesh);
      this.root.add(b.group);
      this.belts.push(b);
    }

    const craft = makeCraft();
    this.craft = craft.root;
    this.craftGlow = craft.exhaust;
    this.craftBeacon = craft.beacon;
    this.craftDish = craft.dish;
    this.root.add(this.craft);
    this.craftPath = this._buildCraftPath();
    this.trail = makeTrail(240, '#9fd8ff');
    this.root.add(this.trail.line);

    this.reticle = makeReticle();
    this.root.add(this.reticle);
    this.reticleBase = 132;
  }

  /** a slow grand tour the probe flies while you scroll */
  _buildCraftPath() {
    const pts = [];
    const n = 28;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 66 + Math.pow(i / n, 1.35) * 310;
      pts.push(new THREE.Vector3(Math.cos(a * 1.02) * r, Math.sin(a * 2.1) * 15 + Math.cos(a) * 7, Math.sin(a * 1.02) * r));
    }
    return new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.4);
  }

  /**
   * Camera anchor + framing centre for a chapter, in the body's own orbital
   * frame: `back` toward the Sun, `lat` along the orbit tangent, `up` off the
   * ecliptic. Returns fresh vectors so the rig can cache them per chapter.
   */
  poseFor(ch, outPos, outLook) {
    const body = ch.aim !== 'system' && ch.aim !== 'sun' ? this.bodies.get(ch.aim) : null;
    if (body) outLook.copy(body.pivot.position);
    else outLook.set(0, ch.aim === 'system' ? 4 : 0, 0);

    let rx, rz;
    if (body) {
      const l = Math.hypot(outLook.x, outLook.z) || 1;
      rx = outLook.x / l;
      rz = outLook.z / l;
    } else {
      const a = ch.yaw ?? 0.35;
      rx = Math.sin(a);
      rz = Math.cos(a);
    }
    // tangent = up × radial
    const tx = rz;
    const tz = -rx;
    outPos.copy(outLook);
    outPos.x += rx * -(ch.back ?? 20) + tx * (ch.lat ?? 0);
    outPos.z += rz * -(ch.back ?? 20) + tz * (ch.lat ?? 0);
    outPos.y += (ch.up ?? 0) + Math.sin(this.time * 0.11 + (body ? body.radius : 1)) * (ch.aim === 'system' ? 9 : 0.5);
    return outPos;
  }

  update(dt, camera, opts = {}) {
    const ts = this.timeScale;
    this.time += dt * ts;
    this.shared.uTime.value = this.time;

    for (const body of this.bodies.values()) {
      body.angle += dt * body.orbitSpeed * ts * 0.55;
      const a = body.angle;
      const R = body.orbitRadius;
      body.pivot.position.set(Math.cos(a) * R, Math.sin(a * 2 + (body.phase ?? 0)) * R * 0.012, Math.sin(a) * R);
      body.mesh.rotation.y += dt * body.spin * ts;
      if (body.orbit) body.orbit.material.uniforms.uPhase.value = ((a / (Math.PI * 2)) % 1 + 1) % 1;
      if (body.clouds) body.clouds.rotation.y = body.mesh.rotation.y * 0.9 + this.time * (this.cloudSpeeds.get(body.id) ?? 0.02);

      if (body.atmo) body.atmo.material.uniforms.uCenter.value.copy(body.pivot.position);
      if (body.ring) {
        SCRATCH_A.set(0, 1, 0).transformDirection(body.tilt.matrixWorld).normalize();
        body.ring.material.uniforms.uPlanetCenter.value.copy(body.pivot.position);
        body.mat.uniforms.uRingCenter.value.copy(body.pivot.position);
        body.mat.uniforms.uRingNormal.value.copy(SCRATCH_A);
      }
      for (const m of body.moons) {
        m.angle += dt * m.speed * ts;
        m.pivot.rotation.y = m.angle;
        m.mesh.rotation.y += dt * 0.35;
      }

      const want = this.hovered === body || this.selected === body ? 1 : 0;
      body.highlight = damp(body.highlight, want, 9, dt);
      body.mat.uniforms.uHighlight.value = body.highlight;
      for (const m of body.moons) m.mesh.material.uniforms.uHighlight.value = body.highlight * 0.35;
    }

    // ── star of the show
    this.sun.mesh.rotation.y += dt * 0.02;
    const pulse = 1 + Math.sin(this.time * 0.35) * 0.02 + Math.sin(this.time * 1.7) * 0.008;
    this.sun.glow.scale.setScalar(SUN.radius * 26 * pulse);
    this.sun.glow.material.opacity = 0.5 + 0.14 * Math.sin(this.time * 0.5);
    for (let i = 0; i < this.sun.shells.length; i++) this.sun.shells[i].scale.setScalar([1.045, 1.16, 1.5][i] * pulse);
    const sunWant = this.hovered === this.sunInfo || this.selected === this.sunInfo ? 1 : 0;
    this.sunInfo.highlight = damp(this.sunInfo.highlight, sunWant, 9, dt);
    this.sun.mesh.material.uniforms.uIntensity.value = 1.75 + this.sunInfo.highlight * 0.55;

    for (const b of this.belts) b.group.rotation.y += dt * b.speed * ts;

    // ── probe
    const g = clamp(opts.progress ?? 0);
    const u = (g * 0.42 + this.time * 0.004) % 1;
    const p = this.craftPath.getPointAt(u, this._tmp.set(0, 0, 0));
    const ahead = this.craftPath.getPointAt((u + 0.005) % 1, SCRATCH_B);
    this.craft.position.copy(p);
    this.craft.lookAt(ahead);
    this.craft.rotateY(Math.PI * 0.5);
    this.craft.rotateZ(Math.sin(this.time * 0.35) * 0.05);
    this.craftDish.rotation.z = Math.sin(this.time * 0.22) * 0.22;
    this.craftBeacon.material.opacity = 0.12 + Math.pow(Math.max(0, Math.sin(this.time * 2.4)), 12) * 0.9;
    this.craftGlow.material.opacity = 0.45 + Math.sin(this.time * 7.3) * 0.12;
    const tr = this.trail;
    const arr = tr.geo.attributes.position.array;
    arr.copyWithin(3, 0, (tr.n - 1) * 3);
    arr[0] = p.x;
    arr[1] = p.y;
    arr[2] = p.z;
    tr.geo.attributes.position.needsUpdate = true;

    // ── far field
    this.stars.group.position.copy(camera.position);
    this.stars.mat.uniforms.uTime.value = this.time;
    this.stars.mat.uniforms.uWarp.value = damp(this.stars.mat.uniforms.uWarp.value, opts.warp ?? 0, 6, dt);
    this.stars.mat.uniforms.uSizeScale.value = opts.starScale ?? 1;
    this.sky.material.uniforms.uTime.value = this.time;

    // ── reticle
    const target = this.hovered ?? this.selected;
    if (target?.mesh) {
      this.reticle.visible = true;
      target.mesh.getWorldPosition(SCRATCH_A);
      this.reticle.position.lerp(SCRATCH_A, 0.35);
      this.reticle.quaternion.copy(camera.quaternion);
      const dist = camera.position.distanceTo(SCRATCH_A);
      const h = 2 * Math.tan((camera.fov * Math.PI) / 360) * dist;
      const px = opts.reticlePx ?? 132;
      const s = Math.max(0.9, ((h * px) / (opts.viewportH || 900)) * 0.5);
      this.reticle.scale.setScalar(s);
      const ru = this.reticle.material.uniforms;
      ru.uTime.value = this.time;
      ru.uOpen.value = damp(ru.uOpen.value, 1, 11, dt);
      ru.uColor.value.set(target.color ?? '#ffffff');
    } else if (this.reticle.visible) {
      const ru = this.reticle.material.uniforms;
      ru.uOpen.value = damp(ru.uOpen.value, 0, 13, dt);
      ru.uTime.value = this.time;
      if (ru.uOpen.value < 0.01) this.reticle.visible = false;
    }
  }

  /** live orbital state for the 2D system map */
  mapState() {
    const list = [];
    for (const body of this.bodies.values()) {
      list.push({ id: body.id, angle: body.angle, r: body.orbitRadius, color: body.atmo, name: body.name });
    }
    return list;
  }

  /** AU travelled, interpolated across chapters so the readout is continuous */
  auAt(progress) {
    const n = CHAPTERS.length;
    const f = clamp(progress) * (n - 1);
    const i = Math.min(n - 2, Math.floor(f));
    const t = f - i;
    return THREE.MathUtils.lerp(CHAPTERS[i].au, CHAPTERS[i + 1].au, t);
  }

  setHover(info) {
    if (this.hovered === info) return false;
    this.hovered = info ?? null;
    return true;
  }

  setSelected(info) {
    this.selected = info ?? null;
  }

  dispose() {
    this.root.traverse((o) => {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        for (const k in m.uniforms ?? {}) {
          const v = m.uniforms[k].value;
          if (v?.isTexture) v.dispose();
        }
        m.dispose?.();
      }
    });
  }
}
