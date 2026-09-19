import * as THREE from 'three';
import Lenis from 'lenis';

import { Engine } from './three/Engine.js';
import { Universe } from './three/Universe.js';
import { CameraRig } from './three/CameraRig.js';
import { Interaction } from './three/Interaction.js';
import { Overlay } from './ui/Overlay.js';
import { SystemMap } from './ui/SystemMap.js';
import { Preloader } from './ui/Preloader.js';
import { CHAPTERS, BODIES } from './config/solar.js';
import { clamp, damp, smoothstep, sampleSeries } from './lib/math.js';

import './styles/global.css';

const prefersCalm = matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Yield to the browser between bakes. rAF keeps us aligned with paint, but rAF
 * stops entirely in a hidden or occluded pane — so race it against a timer, or
 * a tab opened in the background never finishes loading.
 */
const nextFrame = () =>
  new Promise((res) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      res();
    };
    requestAnimationFrame(go);
    setTimeout(go, 240);
  });
const smallScreen = Math.min(innerWidth, innerHeight) < 620;
const startQuality = prefersCalm || smallScreen ? 'balanced' : 'cinematic';

const AU = CHAPTERS.map((c) => c.au);
const canvas = document.getElementById('gl');
const pre = new Preloader();

document.documentElement.classList.add('lock');

let lenis = null;
let rig = null;
let flyTo = () => {};
let sectionH = innerHeight * 2;
let scrollRange = 1;
let cf = 0;
let lastCf = 0;
let scrolledDown = false;
let ready = false;
let focusLock = false;
let lastScroll = 0;

pre.set(0.04, 'BOOTING RENDERER');

/* ── engine ─────────────────────────────────────────────────────────── */
const engine = new Engine(canvas, { quality: startQuality });
engine.autoQuality = !prefersCalm;

const overlay = new Overlay(CHAPTERS, {
  onFly: (i) => flyTo(i),
  onDossier: (i, open) => (open ? overlay.openDossier(CHAPTERS[i]) : overlay.closeDossier()),
  onFocusWorld: (i) => {
    const ch = CHAPTERS[i];
    const info = ch.aim === 'sun' ? universe.sunInfo : universe.bodies.get(ch.aim);
    if (!info) return;
    if (rig.focus && universe.selected === info) {
      rig.clearFocus();
      universe.setSelected(null);
      focusLock = false;
    } else {
      rig.focusOn(info, engine.camera);
      universe.setSelected(info);
      focusLock = true;
    }
  },
  onQuality: (q) => {
    engine.setQuality(q);
    overlay.toast(`render quality → ${q} · dpr ${engine.dpr.toFixed(2)} · bloom ${engine.bloom.enabled ? 'on' : 'off'}`);
  },
  onMotion: (calm) => {
    if (rig) rig.reduced = calm;
    document.body.classList.toggle('no-motion', calm);
    universe.timeScale = calm ? 0.25 : 1;
    if (lenis?.options) lenis.options.duration = calm ? 0.42 : 1.32;
  },
});
overlay.build();
if (prefersCalm) document.body.classList.add('no-motion');

pre.set(0.1, 'GENERATING SYSTEM');
const universe = new Universe(engine.q);
engine.scene.add(universe.root);
universe.timeScale = prefersCalm ? 0.25 : 1;

/* ── progressive bake: real work earns the percentage ───────────────── */
const LABELS = [
  'BAKING MERCURY',
  'BAKING VENUS',
  'SEEDING EARTH',
  'RUSTING MARS',
  'COMPRESSING JUPITER',
  'SPINNING SATURN RINGS',
  'TIPPING URANUS',
  'CHARTING NEPTUNE',
];

const bootT0 = performance.now();
const failed = [];

const step = async (label, pct, fn) => {
  pre.set(pct, label);
  await nextFrame();
  const t0 = performance.now();
  try {
    fn();
    console.debug(`[sol] ${label.toLowerCase()} — ${(performance.now() - t0).toFixed(0)}ms`);
    return true;
  } catch (err) {
    // one bad world must not cost the visitor the whole site
    failed.push(`${label}: ${err?.message ?? err}`);
    console.error(`[sol] ${label} failed after ${(performance.now() - t0).toFixed(0)}ms`, err);
    return false;
  }
};

(async function load() {
  for (let i = 0; i < BODIES.length; i++) {
    const spec = BODIES[i];
    pre.set(0.12 + (i / BODIES.length) * 0.6, LABELS[i] ?? `BAKING ${spec.id.toUpperCase()}`);
    await nextFrame();
    const t0 = performance.now();
    const res = universe.addBodySafe(spec);
    const ms = (performance.now() - t0).toFixed(0);
    if (res.degraded) failed.push(`${spec.id} → flat shading`);
    else if (res.skipped) failed.push(`${spec.id} skipped`);
    console.debug(`[sol] ${spec.id.padEnd(9)} ${ms}ms${res.degraded ? ' (degraded)' : res.skipped ? ' (SKIPPED)' : ''}`);
  }
  await step('LAYERING DEBRIS BELTS', 0.78, () => universe.finish());
  pre.set(0.86, 'COMPILING SHADERS');
  await nextFrame();
  // compileAsync can hang on some drivers, so it gets a deadline of its own
  await Promise.race([
    engine.renderer.compileAsync(engine.scene, engine.camera).catch(() => engine.renderer.compile(engine.scene, engine.camera)),
    new Promise((r) => setTimeout(r, 6000)),
  ]);
  if (failed.length) pre.set(0.93, `${failed.length} WORLD${failed.length > 1 ? 'S' : ''} DEGRADED`);
  pre.set(0.95, 'SPOOLING CAMERA RIG');
  await nextFrame();
  boot();
  if (failed.length) console.warn('[sol] degraded worlds:', failed.join(' · '));
  console.debug(`[sol] ready in ${(performance.now() - bootT0).toFixed(0)}ms`);
})().catch((err) => {
  // last resort: the loader curtain must never be the thing the visitor sees
  console.error('[sol] boot failed outside the bake loop', err);
  try {
    if (!rig) boot();
  } catch (e2) {
    console.error('[sol] could not start the rig either', e2);
    pre.fail(String(err?.message ?? err));
  }
});

/* ── boot ───────────────────────────────────────────────────────────── */
function boot() {
  rig = new CameraRig(universe, CHAPTERS);
  rig.reduced = prefersCalm;

  const interaction = new Interaction(canvas, universe, engine.camera, {
    onPick: (info, hit) => {
      if (!info) {
        rig.clearFocus();
        universe.setSelected(null);
        overlay.closeDossier();
        focusLock = false;
        return;
      }
      universe.setSelected(info);
      rig.focusOn(info, engine.camera);
      focusLock = true;
      overlay.openDossier(CHAPTERS.find((c) => c.id === info.chapter) ?? info, { hit });
    },
    onKey: (what) => {
      if (what === 'escape') {
        rig.clearFocus();
        universe.setSelected(null);
        overlay.closeDossier();
        focusLock = false;
      } else if (what === 'next') flyTo(Math.min(CHAPTERS.length - 1, rig.active + 1));
      else if (what === 'prev') flyTo(Math.max(0, rig.active - 1));
      else if (what === 'home') flyTo(-1);
      else if (what === 'end') flyTo(CHAPTERS.length - 1);
    },
  });

  const map = new SystemMap(universe);

  /* smooth scroll — the entire site hangs off this one scalar */
  if (!prefersCalm) {
    lenis = new Lenis({
      duration: 1.32,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      wheelMultiplier: 0.86,
      touchMultiplier: 1.55,
      autoRaf: false,
    });
    // v1.3 emits { deltaX, deltaY, event } — read the live value off the instance
    lenis.on('scroll', () => {
      const s = lenis.scroll;
      if (focusLock && Math.abs(s - lastScroll) > 5) {
        rig.clearFocus();
        universe.setSelected(null);
        focusLock = false;
      }
      lastScroll = s;
    });
  }

  const measure = () => {
    const sec = document.querySelector('.ch');
    sectionH = sec?.offsetHeight || innerHeight * 2;
    scrollRange = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  };
  measure();
  window.addEventListener('resize', measure, { passive: true });

  flyTo = (i) => {
    rig.clearFocus();
    universe.setSelected(null);
    focusLock = false;
    const y = i < 0 ? 0 : (i + 0.5) * sectionH;
    if (lenis) lenis.scrollTo(clamp(y, 0, scrollRange), { duration: 1.9 });
    else window.scrollTo({ top: clamp(y, 0, scrollRange), behavior: 'smooth' });
  };

  /* per-frame */
  const grade = engine.grade.material.uniforms;
  const sunWorld = new THREE.Vector3(0, 0, 0);
  const proj = new THREE.Vector3();
  let flareVis = 0;
  let warpS = 0;

  engine.onTick((kind, e, rawDt, time) => {
    if (kind === 'autoQuality') overlay.toast(`dropping to ${e} quality to hold frame rate`, 2400);
    if (kind !== 'tick' || !ready) return;
    const d = Math.min(rawDt || 1 / 60, 1 / 20);

    if (lenis) lenis.raf(performance.now());
    const y = lenis ? lenis.scroll : window.scrollY;
    const raw = y / sectionH;
    scrolledDown = raw > (overlay.lastCf ?? 0);
    overlay.lastCf = raw;
    cf = clamp(raw, 0, CHAPTERS.length);

    const inter = interaction.update(d, e.viewport);
    const st = rig.update(d, e.camera, { cf, pointer: inter.pointer, drag: inter.drag });

    universe.update(d, e.camera, {
      progress: clamp(cf / Math.max(1, CHAPTERS.length - 0.5)),
      warp: warpS,
      starScale: 1 + st.warp * 0.3,
      viewportH: e.viewport.h,
      reticlePx: 126,
    });

    if (rig.active !== overlay.active) overlay.setChapter(rig.active);
    const au = sampleSeries(AU, clamp(cf - 0.5, 0, CHAPTERS.length - 1));

    // sun flare follows the star across the frame
    proj.copy(sunWorld).project(e.camera);
    const front = proj.z < 1 ? 1 : 0;
    const offCentre = Math.hypot(proj.x, proj.y);
    const radial = smoothstep(2.0, 0.12, offCentre);
    const far = 1 - smoothstep(30, 120, e.camera.position.length());
    flareVis = damp(flareVis, front * radial * (0.14 + far * 0.55) * (1 - warpS * 0.2), 5, d);

    warpS = damp(warpS, clamp(Math.abs(cf - lastCf) / d * 0.055 + st.warp * 0.5, 0, 1.1), 6, d);
    lastCf = cf;

    grade.uTime.value = time;
    grade.uWarp.value = warpS;
    grade.uSunScreen.value.set(proj.x * 0.5 + 0.5, proj.y * 0.5 + 0.5);
    grade.uSunVis.value = flareVis * (e.qualityName === 'perf' ? 0.55 : 1);
    grade.uVignette.value = 0.52 + warpS * 0.22;
    grade.uGrain.value = e.q.grain;

    overlay.tick({
      cf,
      progress: clamp(scrollRange > 0 ? y / scrollRange : 0),
      warp: warpS,
      velocity: st.velocity,
      fov: st.fov,
      fps: e.fps,
      au,
      sunScreen: { x: proj.x * 0.5 + 0.5, y: proj.y * 0.5 + 0.5 },
      sunVis: flareVis,
    });
    overlay.setScrollFlags({ scrolledDown, dragging: interaction.dragging });

    map.update(d, {
      activeId: CHAPTERS[rig.active]?.aim,
      accent: CHAPTERS[rig.active]?.accent ?? '#ff9d3c',
      camPos: e.camera.position,
      lookAt: rig.lookAt,
      fov: st.fov,
    });
  });

  // prime the rig so the first visible frame is already composed, and let the
  // arrival be a short focus pull rather than a cut
  rig.fov = 68;
  for (let i = 0; i < 4; i++) rig.update(1 / 60, engine.camera, { cf: 0 });
  universe.update(1 / 60, engine.camera, { progress: 0 });
  engine.renderer.compile(engine.scene, engine.camera);

  pre.done().then(() => {
    ready = true;
    document.documentElement.classList.remove('lock');
    document.body.classList.add('is-live');
    requestAnimationFrame(() => overlay.setChapter(0));
  });
}
