/**
 * Headless simulation of the real scene graph + camera rig over the whole
 * scroll range. Catches the failure modes a screenshot cannot see: NaNs, the
 * camera clipping through the star, worlds framed off-screen, broken uniforms.
 *
 *   node tools/scene-check.mjs
 */
import { installDomStub } from './dom-stub.mjs';
installDomStub();

const THREE = await import('three');
const { QUALITY } = await import('../src/three/Engine.js');
const { Universe } = await import('../src/three/Universe.js');
const { CameraRig } = await import('../src/three/CameraRig.js');
const { CHAPTERS, BODIES, SUN } = await import('../src/config/solar.js');

const q = { ...QUALITY.perf, name: 'perf', tex: 256, stars: 400 };
const universe = new Universe(q);
for (const b of BODIES) universe.addBody(b);
universe.finish();

const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.35, 9000);
camera.position.set(0, 0, 500);
const rig = new CameraRig(universe, CHAPTERS);
const viewportH = 900;

const problems = [];
const bad = (v, label) => {
  if (!Number.isFinite(v)) problems.push(`non-finite ${label}: ${v}`);
};

const rows = [];
let minSunDist = Infinity;
let maxCamDist = 0;
const dt = 1 / 60;
const N = CHAPTERS.length;

// scrub the entire page, 40 frames per chapter
for (let f = 0; f <= N * 40; f++) {
  const cf = f / 40;
  universe.update(dt, camera, { progress: Math.min(1, cf / (N - 0.5)), warp: 0.2, viewportH });
  const st = rig.update(dt, camera, { cf, pointer: { x: Math.sin(f * 0.11) * 0.6, y: Math.cos(f * 0.09) * 0.4 }, drag: { x: 0, y: 0 } });
  const p = camera.position;
  bad(p.x, 'cam.x');
  bad(p.y, 'cam.y');
  bad(p.z, 'cam.z');
  bad(camera.quaternion.x, 'quat');
  bad(st.fov, 'fov');
  bad(rig.lookAt.x, 'lookAt');
  bad(st.velocity, 'velocity');
  bad(st.warp, 'warp');
  for (const b of universe.bodies.values()) {
    bad(b.pivot.position.x, `${b.id}.x`);
    bad(b.mat.uniforms.uHighlight.value, `${b.id}.highlight`);
    if (b.ring) bad(b.ring.material.uniforms.uPlanetCenter.value.y, `${b.id}.ringCenter`);
    for (const m of b.moons) bad(m.mesh.position.x, `${b.id}:${m.id}.x`);
  }
  bad(universe.craft.position.y, 'craft.y');
  bad(universe.reticle.position.x, 'reticle');

  const sunDist = p.length();
  minSunDist = Math.min(minSunDist, sunDist);
  maxCamDist = Math.max(maxCamDist, sunDist);

  // at a chapter centre, let the damped rig settle, then sample the framing
  const local = cf - Math.floor(cf);
  if (Math.abs(local - 0.5) < 1 / 80 && f % 2 === 0) {
    const i = Math.floor(cf);
    for (let k = 0; k < 50; k++) {
      universe.update(dt, camera, { progress: Math.min(1, cf / (N - 0.5)), viewportH });
      rig.update(dt, camera, { cf, pointer: { x: 0, y: 0 }, drag: { x: 0, y: 0 } });
    }
    if (i >= 0 && i < N) {
      const ch = CHAPTERS[i];
      const body = universe.bodies.get(ch.aim);
      const anchor = new THREE.Vector3(0, 0, 0);
      if (body) anchor.copy(body.pivot.position);
      const ndc = anchor.clone().project(camera);
      const dist = camera.position.distanceTo(anchor);
      const angR = ((body?.radius ?? SUN.radius) / Math.max(dist, 0.001)) * (viewportH / 2 / Math.tan((st.fov * Math.PI) / 360));
      rows.push({
        ch: ch.id,
        ndcX: +ndc.x.toFixed(2),
        ndcY: +ndc.y.toFixed(2),
        wantBias: +Math.max(-0.85, Math.min(0.85, ch.bias ?? 0)).toFixed(2),
        dist: dist.toFixed(0),
        sizePx: angR.toFixed(0),
        behind: ndc.z > 1 ? 'YES' : '',
      });
      if (ndc.z > 1) problems.push(`${ch.id}: body is behind the camera at its own chapter`);
      if (Math.abs(ndc.x) > 1.25 || Math.abs(ndc.y) > 1.25) problems.push(`${ch.id}: body off-frame at chapter centre (${ndc.x.toFixed(2)},${ndc.y.toFixed(2)})`);
      if (angR < 8) problems.push(`${ch.id}: body too small to read (${angR.toFixed(1)}px)`);
      if (angR > viewportH * 0.75) problems.push(`${ch.id}: body overflows the frame (${angR.toFixed(0)}px)`);
      if (dist < (body?.radius ?? SUN.radius) * 1.9) problems.push(`${ch.id}: camera inside/near the body (d=${dist.toFixed(1)})`);
    }
  }
}

if (minSunDist < SUN.radius * 1.25) problems.push(`camera gets too close to the star: ${minSunDist.toFixed(1)} (radius ${SUN.radius})`);

console.log('chapter framing (ndc.x should track wantBias):');
console.table(rows);
console.log(`camera range: ${minSunDist.toFixed(0)} … ${maxCamDist.toFixed(0)} units from the star`);
if (problems.length) {
  console.log('\nPROBLEMS:');
  problems.forEach((p) => console.log('  ✗ ' + p));
  process.exitCode = 1;
} else {
  console.log('\n✓ rig + scene clean across all', N, 'chapters');
}
