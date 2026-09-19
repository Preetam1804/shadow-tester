/**
 * Bake every world through the *shipping* code path — Universe.addBody →
 * Factory.makeBody → the painters — at each quality tier, with a canvas stub
 * that enforces the browser's error contract.
 *
 * This exists because the loader once froze at 49% in a real browser while every
 * headless check was green: bakeRing allocated w*4 bytes but filled 4 rows, so
 * `new ImageData(d, 1024, 4)` threw IndexSizeError. preview.mjs called the
 * painters directly and never met that line, and the permissive stub let the
 * size mismatch pass silently. So: drive the real call graph, and fail on
 * throws, on ignored paints, and on any map that is not the size its tier asked for.
 */
import { installDomStub, violations } from './dom-stub.mjs';
installDomStub();

const THREE = await import('three');
const { QUALITY } = await import('../src/three/Engine.js');
const { Universe } = await import('../src/three/Universe.js');
const { BODIES } = await import('../src/config/solar.js');
const { RING_TEX } = await import('../src/lib/textures.js');

const problems = [];
const rows = [];

const readCanvas = (tex) => {
  const cv = tex?.image ?? tex?.source?.data;
  if (!cv || !cv.width) return null;
  const cx = cv.getContext?.('2d');
  if (!cx) return { w: cv.width, h: cv.height, data: null };
  const img = cx.getImageData(0, 0, cv.width, cv.height);
  return { w: cv.width, h: cv.height, data: img.data };
};

for (const name of ['cinematic', 'balanced', 'perf']) {
  const q = { ...QUALITY[name], name };
  const wantW = q.tex | 0;
  const wantH = q.tex >> 1;
  const universe = new Universe(q);
  const t0 = Date.now();

  for (const spec of BODIES) {
    const before = violations.length;
    const res = universe.addBodySafe(spec);
    const ms = Date.now() - t0;
    if (res.error) problems.push(`${name}/${spec.id}: ${res.skipped ? 'SKIPPED' : 'DEGRADED'} — ${res.error?.message}`);
    const body = res.body;
    if (!body) continue;

    // the record Universe.update indexes into must be complete
    for (const prop of ['pivot', 'mesh', 'mat', 'moons']) {
      if (!body[prop]) problems.push(`${name}/${spec.id}: missing body.${prop}`);
    }
    for (const num of ['radius', 'orbitRadius', 'spin', 'angle', 'orbitSpeed']) {
      if (!Number.isFinite(body[num])) problems.push(`${name}/${spec.id}: body.${num} is ${body[num]}`);
    }
    if (!(body.radius > 0)) problems.push(`${name}/${spec.id}: radius not positive`);

    // every map must exist, be the tier's size, and carry the right alpha story
    const mats = [
      { mat: body.mesh?.material, label: 'albedo', alpha: 'pinned' },
      // the cloud shell is transparent *by design*: its alpha channel is the
      // weather, so it must vary — a flat 255 there would be a paper bag planet
      { mat: body.clouds?.material, label: 'clouds', alpha: 'varying' },
    ].filter((m) => m.mat);
    for (const { mat, label, alpha } of mats) {
      const t = mat.uniforms?.uMap?.value;
      if (!t || !t.isTexture) {
        if (label === 'albedo') problems.push(`${name}/${spec.id}: albedo texture missing`);
        continue;
      }
      const img = readCanvas(t);
      if (!img || img.w !== wantW || img.h !== wantH) {
        problems.push(`${name}/${spec.id}: ${label} is ${img ? `${img.w}×${img.h}` : 'empty'}, tier wants ${wantW}×${wantH}`);
        continue;
      }
      if (!img.data) continue;
      let lo = 255;
      let hi = 0;
      let off = 0;
      for (let i = 3; i < img.data.length; i += 4) {
        const a = img.data[i];
        if (a < lo) lo = a;
        if (a > hi) hi = a;
        if (a !== 255) off++;
      }
      if (alpha === 'pinned' && off) {
        problems.push(`${name}/${spec.id}: ${label} alpha dips to ${lo} — a canvas upload premultiplies, so the rgb gets eaten (black world)`);
      }
      if (alpha === 'varying' && lo === 255) {
        problems.push(`${name}/${spec.id}: cloud alpha is uniformly opaque — no transparent sky`);
      }
      if (alpha === 'varying' && hi < 120) {
        problems.push(`${name}/${spec.id}: cloud alpha peaks at ${hi} — the layer is nearly invisible`);
      }
    }

    // rings: the buffer that used to be 4x too small
    if (spec.rings) {
      const t = body.ring?.material?.uniforms?.uMap?.value ?? body.ringTex;
      const img = t && readCanvas(t);
      if (!img) problems.push(`${name}/${spec.id}: ring material has no texture`);
      else {
        if (img.w !== RING_TEX.w || img.h !== RING_TEX.h) problems.push(`${name}/${spec.id}: ring map is ${img.w}×${img.h}, expected ${RING_TEX.w}×${RING_TEX.h}`);
        if (img.data) {
          // the shader samples the middle row; it must carry real density
          const row = (RING_TEX.h >> 1) * RING_TEX.w * 4;
          let maxA = 0;
          let filled = 0;
          for (let x = 0; x < RING_TEX.w; x++) {
            const a = img.data[row + x * 4 + 3];
            maxA = Math.max(maxA, a);
            if (a > 40) filled++;
          }
          if (maxA < 30) problems.push(`${name}/${spec.id}: ring alpha ramp is empty in the sampled row (transparent rings)`);
          if (filled < RING_TEX.w * 0.15) problems.push(`${name}/${spec.id}: ring row only ${filled} opaque texels`);
          rows.push({ tier: name, id: spec.id, ringMaxA: maxA, ringFill: `${((filled / RING_TEX.w) * 100).toFixed(0)}%` });
        }
      }
    }

    // moons must be textured too
    for (const m of body.moons ?? []) {
      const t = m.mesh?.material?.uniforms?.uMap?.value;
      const img = t && readCanvas(t);
      if (!img) problems.push(`${name}/${spec.id}:${m.id}: moon has no texture`);
      else if (img.data) {
        let bad = 0;
        for (let i = 3; i < img.data.length; i += 4 * 29) if (img.data[i] !== 255) bad++;
        if (bad) problems.push(`${name}/${spec.id}:${m.id}: moon alpha has ${bad} non-opaque samples`);
      }
      if (!m.mesh?.userData?.body?.name) problems.push(`${name}/${spec.id}:${m.id}: moon has no pickable userData`);
    }

    if (violations.length > before) problems.push(`${name}/${spec.id}: ${violations.length - before} ignored canvas paint(s)`);
  }

  try {
    universe.finish();
  } catch (e) {
    problems.push(`${name}: finish() threw — ${e.message}\n${String(e.stack).split('\n').slice(1, 4).join('\n')}`);
  }
  const total = Date.now() - t0;
  const moonCount = [...universe.bodies.values()].reduce((n, b) => n + (b.moons?.length ?? 0), 0);
  rows.push({ tier: name, id: `— ${universe.bodies.size} worlds + ${moonCount} moons`, ringMaxA: `${total}ms`, ringFill: `${(total / 1000).toFixed(1)}s bake` });
}

console.table(rows);
if (violations.length) {
  console.log(`\n${violations.length} canvas violation(s) the browser would also complain about:`);
  [...new Set(violations)].slice(0, 10).forEach((v) => console.log('  · ' + v));
}
if (problems.length) {
  console.log('\nPROBLEMS:');
  [...new Set(problems)].forEach((p) => console.log('  ✗ ' + p));
  process.exitCode = 1;
} else {
  console.log(`\n✓ all ${BODIES.length} worlds + moons bake through Factory at every tier (${violations.length} ignored paints)`);
}
process.exit(process.exitCode ?? 0);
