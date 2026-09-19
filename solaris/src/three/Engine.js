import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GRADE_FRAG, QUAD_VERT } from './shaders.js';
import { clamp, damp } from '../lib/math.js';

export const QUALITY = {
  cinematic: { dpr: 2, msaa: 4, bloom: 0.95, bloomRes: 0.6, exposure: 1.06, tex: 1024, stars: 5200, grain: 0.035, aniso: 8, segs: [96, 64] },
  balanced: { dpr: 1.6, msaa: 0, bloom: 0.8, bloomRes: 0.5, exposure: 1.04, tex: 768, stars: 3400, grain: 0.03, aniso: 4, segs: [72, 48] },
  perf: { dpr: 1.15, msaa: 0, bloom: 0.62, bloomRes: 0.4, exposure: 1.02, tex: 512, stars: 1900, grain: 0.022, aniso: 2, segs: [48, 32] },
};

/**
 * Renderer + composer + frame loop. Owns nothing about the solar system,
 * it just boots WebGL, keeps the framebuffer honest and ticks listeners.
 */
export class Engine {
  constructor(canvas, { quality = 'cinematic', onTick = () => {} } = {}) {
    this.canvas = canvas;
    this.listeners = new Set();
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.qualityName = quality;
    this.q = { ...QUALITY[quality], name: quality };

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.q.exposure;
    this.renderer.setClearColor(0x04060c, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.35, 9000);
    this.camera.rotation.order = 'YXZ';

    this.clock = new THREE.Clock();
    this.time = 0;
    this.frame = 0;
    this.fps = 60;
    this.running = true;
    this.autoQuality = true;
    this._lowFrames = 0;

    this.composer = null;
    this._buildComposer();
    this.resize();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });
    document.addEventListener('visibilitychange', () => {
      this.running = !document.hidden;
      if (this.running) this.clock.getDelta();
    });

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _buildComposer() {
    const { renderer, scene, camera } = this;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(Math.max(2, size.x), Math.max(2, size.y), {
      type: THREE.HalfFloatType,
      samples: this.q.msaa,
    });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(Math.max(2, size.x * this.q.bloomRes), Math.max(2, size.y * this.q.bloomRes)),
      this.q.bloom,
      0.72,
      0.62
    );
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uTime: { value: 0 },
          uWarp: { value: 0 },
          uVignette: { value: 0.62 },
          uGrain: { value: this.q.grain },
          uRes: { value: new THREE.Vector2(size.x, size.y) },
          uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
          uSunVis: { value: 0 },
        },
        vertexShader: QUAD_VERT,
        fragmentShader: GRADE_FRAG,
      })
    );
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  setQuality(name) {
    if (!QUALITY[name] || name === this.qualityName) return;
    this.qualityName = name;
    this.q = { ...QUALITY[name], name };
    this.renderer.toneMappingExposure = this.q.exposure;
    this.bloom.strength = this.q.bloom;
    this.grade.material.uniforms.uGrain.value = this.q.grain;
    if (this.bloom) this.bloom.enabled = name !== 'perf';
    this.resize();
    this._lowFrames = 0;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = clamp(window.devicePixelRatio || 1, 0.75, this.q.dpr);
    this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const dw = Math.max(2, Math.floor(w * dpr));
    const dh = Math.max(2, Math.floor(h * dpr));
    // composer.setSize multiplies by its own pixelRatio, so it wants CSS px
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    const u = this.grade.material.uniforms;
    u.uRes.value.set(dw, dh);
    if (this.bloom) this.bloom.setSize(Math.max(2, dw * this.q.bloomRes), Math.max(2, dh * this.q.bloomRes));
    this.viewport = { w, h, dw, dh };
    this.listeners.forEach((fn) => fn('resize', this));
  }

  onTick(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _loop() {
    this.raf = requestAnimationFrame(this._loop);
    if (!this.running) return;
    const raw = this.clock.getDelta();
    const dt = Math.min(raw, 1 / 20); // never let a hitch fling the camera
    this.time += dt;
    this.frame++;
    if (raw > 0) this.fps = damp(this.fps, 1 / raw, 3.2, dt);

    // gentle self-healing: sustained low fps steps down once
    if (this.autoQuality) {
      if (this.fps < 42 && this.frame > 90) {
        this._lowFrames++;
        if (this._lowFrames > 140) {
          this._lowFrames = 0;
          const order = ['cinematic', 'balanced', 'perf'];
          const next = order[Math.min(order.length - 1, order.indexOf(this.qualityName) + 1)];
          if (next !== this.qualityName) {
            this.setQuality(next);
            this.listeners.forEach((fn) => fn('autoQuality', next));
          } else {
            this.autoQuality = false;
          }
        }
      } else if (this._lowFrames > 0) {
        this._lowFrames = Math.max(0, this._lowFrames - 1.5);
      }
    }

    for (const fn of [...this.listeners]) fn('tick', this, dt, this.time);
    this.composer.render(dt);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this._onResize);
    this.composer?.dispose?.();
    this.renderer.dispose();
  }
}
